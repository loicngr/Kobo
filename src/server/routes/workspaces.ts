import { execFile as execFileCb, execFileSync, spawn } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFileCb)

import fs from 'node:fs'
import path from 'node:path'
import { Hono } from 'hono'
import {
  AUTO_LOOP_HARD_RULES,
  buildAutoLoopGroomingSteps,
  PREP_AUTOLOOP_INTRO,
} from '../../shared/auto-loop-prompts.js'
import { getDb } from '../db/index.js'
import { migrationGuard } from '../middleware/migration-guard.js'
import { listEngines } from '../services/agent/engines/registry.js'
import * as agentManager from '../services/agent/orchestrator.js'
import * as autoLoopService from '../services/auto-loop-service.js'
import * as devServerService from '../services/dev-server-service.js'
import * as notionService from '../services/notion-service.js'
import { renderPrTemplate } from '../services/pr-template-service.js'
import { getAllPrStates } from '../services/pr-watcher-service.js'
import * as sentryService from '../services/sentry-service.js'
import * as settingsService from '../services/settings-service.js'
import { runSetupScript } from '../services/setup-script-service.js'
import * as terminalService from '../services/terminal-service.js'
import * as wakeupService from '../services/wakeup-service.js'
import * as wsService from '../services/websocket-service.js'
import type { AgentPermissionMode, WorkspaceStatus } from '../services/workspace-service.js'
import * as workspaceService from '../services/workspace-service.js'
import * as worktreeService from '../services/worktree-service.js'
import * as gitOps from '../utils/git-ops.js'

/** Hono sub-router for workspace CRUD, tasks, agent lifecycle, git operations, and PR creation. */
const app = new Hono()

/** Tracks workspaces currently running a setup script to prevent concurrent executions. */
const setupScriptRunning = new Set<string>()

const VALID_AGENT_PERMISSION_MODES: AgentPermissionMode[] = ['plan', 'bypass', 'strict', 'interactive']

function isAgentPermissionMode(value: unknown): value is AgentPermissionMode {
  return typeof value === 'string' && (VALID_AGENT_PERMISSION_MODES as string[]).includes(value)
}

/**
 * Resolve the unified permission mode for a new workspace.
 *
 * Cascade: explicit body field → global default (validated) → 'bypass'.
 *
 * Legacy `defaultPermissionMode` values ('plan' / 'auto-accept') are honored:
 * 'plan' stays 'plan'; 'auto-accept' falls through to 'bypass' (the safest
 * non-plan default — matches the pre-refactor "skip prompts" behaviour).
 */
function resolveCreateAgentPermissionMode(
  bodyValue: unknown,
  _projectPath: string,
  globalSettings: { defaultPermissionMode?: string },
): AgentPermissionMode {
  if (isAgentPermissionMode(bodyValue)) return bodyValue
  const global = globalSettings.defaultPermissionMode
  if (isAgentPermissionMode(global)) return global
  if (global === 'plan') return 'plan'
  return 'bypass'
}

app.get('/', (c) => {
  try {
    const workspaces = workspaceService.listWorkspaces()
    return c.json(workspaces)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 500)
  }
})

// POST /api/workspaces — create workspace
app.post('/', migrationGuard, async (c) => {
  try {
    const body = await c.req.json<{
      name: string
      projectPath: string
      sourceBranch: string
      workingBranch: string
      notionUrl?: string
      notionPageId?: string
      sentryUrl?: string
      model?: string
      reasoningEffort?: string
      tasks?: string[]
      acceptanceCriteria?: string[]
      skipSetupScript?: boolean
      description?: string
      agentPermissionMode?: 'plan' | 'bypass' | 'strict' | 'interactive'
      engine?: string
      autoLoop?: boolean
      worktreePath?: string
    }>()

    // workingBranch is derived from git when worktreePath is provided, so
    // it's not required in that flow. The other 3 fields stay mandatory.
    if (!body.name || !body.projectPath || !body.sourceBranch) {
      return c.json({ error: 'Missing required fields: name, projectPath, sourceBranch' }, 400)
    }
    if (!body.worktreePath && !body.workingBranch) {
      return c.json({ error: 'Missing required field: workingBranch' }, 400)
    }

    // Validate the engine id (if provided) against the registry. An unknown
    // engine is rejected up-front so we don't create orphan workspaces that
    // can't spawn an agent.
    if (body.engine) {
      const validEngineIds = listEngines().map((e) => e.id as string)
      if (!validEngineIds.includes(body.engine)) {
        return c.json({ error: `Unknown engine '${body.engine}'. Valid engines: ${validEngineIds.join(', ')}` }, 400)
      }
    }

    // Fetch the source branch from origin first — if this fails, block creation
    // immediately (no DB records created, user stays on the create page).
    try {
      gitOps.fetchSourceBranch(body.projectPath, body.sourceBranch)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return c.json({ error: message }, 422)
    }

    // Reuse-existing-worktree path. When the caller passes `worktreePath`,
    // Kobo "attaches" to a pre-existing worktree on disk instead of creating
    // a new one. We validate four invariants up-front (path exists, belongs
    // to this repo, is on a real branch, isn't already attached) and derive
    // the working branch from git itself — the body.workingBranch is ignored.
    let useReusedWorktree = false
    let reusedDerivedBranch: string | null = null
    if (body.worktreePath) {
      if (!fs.existsSync(body.worktreePath)) {
        return c.json({ error: `Worktree path does not exist: ${body.worktreePath}` }, 422)
      }
      try {
        const commonDir = execFileSync('git', ['-C', body.worktreePath, 'rev-parse', '--git-common-dir'], {
          encoding: 'utf-8',
        }).trim()
        const expectedCommonDir = path.join(body.projectPath, '.git')
        if (path.resolve(commonDir) !== path.resolve(expectedCommonDir)) {
          return c.json({ error: `Worktree '${body.worktreePath}' belongs to a different repository` }, 422)
        }
        const branch = execFileSync('git', ['-C', body.worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD'], {
          encoding: 'utf-8',
        }).trim()
        if (!branch || branch === 'HEAD') {
          return c.json({ error: 'Worktree is in detached HEAD state and cannot be attached' }, 422)
        }
        reusedDerivedBranch = branch
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return c.json({ error: `Failed to inspect worktree: ${message}` }, 422)
      }
      // Validate the worktree isn't already attached to another workspace.
      const dbForCheck = getDb()
      const existing = dbForCheck.prepare('SELECT id FROM workspaces WHERE worktree_path = ?').get(body.worktreePath)
      if (existing) {
        return c.json({ error: 'This worktree is already attached to another Kōbō workspace' }, 422)
      }
      useReusedWorktree = true
    }

    // Pre-flight: extract Notion / Sentry before any DB write. A throw here
    // must not leave a half-built workspace behind, so we run extraction
    // before createWorkspace and surface failures as 422.
    let notionContent: notionService.NotionPageContent | null = null
    if (body.notionUrl) {
      try {
        notionContent = await notionService.extractNotionPage(body.notionUrl)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return c.json({ error: `Failed to extract Notion page: ${message}` }, 422)
      }
    }

    let sentryContent: sentryService.SentryIssueContent | null = null
    if (body.sentryUrl) {
      try {
        sentryContent = await sentryService.extractSentryIssue(body.sentryUrl)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return c.json({ error: `Failed to extract Sentry issue: ${message}` }, 422)
      }
    }

    // Create workspace record
    const globalSettings = settingsService.getGlobalSettings()
    // workingBranch may be updated after Notion extraction to inject the ticket ID,
    // OR overridden by the branch derived from the existing worktree (reuse mode).
    let workingBranch = useReusedWorktree && reusedDerivedBranch ? reusedDerivedBranch : body.workingBranch

    // Inject ticket ID into the working branch BEFORE creating the workspace,
    // so the worktree_path recorded in the DB reflects the FINAL branch name.
    // Works with or without Notion: ticket ID comes from Notion extraction first,
    // then Sentry, then falls back to a TK-XXXX pattern anywhere in the body.name.
    // Skip when reusing an existing worktree — its branch is already real on disk
    // and we MUST NOT rename it.
    if (!useReusedWorktree) {
      // Sentry's canonical identifier is the issue short-ID (e.g. "ACME-API-3"),
      // which is what Sentry auto-close recognises in commit messages.
      const detectedTicketId = notionContent?.ticketId || sentryContent?.issueId || body.name.match(/[A-Z]+-\d+/i)?.[0]
      if (detectedTicketId && !workingBranch.toLowerCase().includes(detectedTicketId.toLowerCase())) {
        const ticketPrefix = detectedTicketId.toUpperCase()
        const slashIdx = workingBranch.indexOf('/')
        const typePrefix = slashIdx >= 0 ? workingBranch.slice(0, slashIdx + 1) : 'feature/'
        // Use Notion/Sentry title or body name for the slug — all have proper accented
        // characters that NFD normalization can transliterate (é→e, ç→c, etc.)
        const titleSource = notionContent?.title || sentryContent?.title || body.name
        const titleSlug = titleSource
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '')
          .substring(0, 50)
        workingBranch = `${typePrefix}${ticketPrefix}--${titleSlug}`
      }
    }

    let workspace = workspaceService.createWorkspace({
      name: body.name,
      projectPath: body.projectPath,
      sourceBranch: body.sourceBranch,
      workingBranch,
      notionUrl: body.notionUrl,
      notionPageId: body.notionPageId,
      sentryUrl: body.sentryUrl,
      ...(useReusedWorktree ? { worktreePath: body.worktreePath, worktreeOwned: false } : {}),
      model: body.model,
      reasoningEffort: body.reasoningEffort,
      agentPermissionMode: resolveCreateAgentPermissionMode(body.agentPermissionMode, body.projectPath, globalSettings),
      engine: body.engine,
    })

    // Auto-tag the workspace based on its creation source — `notion` when
    // imported from a Notion page, `sentry` when bootstrapped from a Sentry
    // issue URL. Pre-seeded in the global tag catalogue via migration v9.
    // Skip any tag the user has removed from the catalogue so we respect
    // their choice (they may have pruned "notion"/"sentry" on purpose).
    const catalogTags = new Set(globalSettings.tags ?? [])
    const autoTags: string[] = []
    if (body.notionUrl && catalogTags.has('notion')) autoTags.push('notion')
    if (body.sentryUrl && catalogTags.has('sentry')) autoTags.push('sentry')
    if (autoTags.length > 0) {
      try {
        const tagged = workspaceService.setWorkspaceTags(workspace.id, autoTags)
        if (tagged) workspace = tagged
      } catch (err) {
        console.error('[workspaces] Failed to apply auto tags:', err)
      }
    }

    // Update workspace name with Sentry issue title if the user did not provide
    // a custom name and Notion hasn't already filled it. Prefix with the Sentry
    // short-id (e.g. "SEKUR-IOS-9 | TypeError: …") so the workspace stays
    // identifiable in the sidebar without opening the panel.
    if (sentryContent?.title && !notionContent?.title && workspace.name === 'workspace') {
      const prefix = sentryContent.issueId ? `${sentryContent.issueId} | ` : ''
      workspace = workspaceService.updateWorkspaceName(workspace.id, `${prefix}${sentryContent.title}`)
    }

    // Create tasks from extracted Notion data
    if (notionContent) {
      let sortOrder = 0

      for (const todo of notionContent.todos) {
        workspaceService.createTask(workspace.id, {
          title: todo.title,
          isAcceptanceCriterion: false,
          sortOrder: sortOrder++,
        })
      }

      for (const feature of notionContent.gherkinFeatures) {
        workspaceService.createTask(workspace.id, {
          title: feature,
          isAcceptanceCriterion: true,
          sortOrder: sortOrder++,
        })
      }

      // Update workspace name with Notion page title only if user didn't
      // provide a custom name. Prefix with the Notion unique-id (e.g.
      // "TK-123 | …") when the page has one — it makes the workspace
      // immediately scannable in the sidebar.
      if (notionContent.title && workspace.name === 'workspace') {
        const prefix = notionContent.ticketId ? `${notionContent.ticketId} | ` : ''
        workspace = workspaceService.updateWorkspaceName(workspace.id, `${prefix}${notionContent.title}`)
      }
    }

    // Create manual tasks/criteria if no Notion content was extracted
    if (!notionContent && (Array.isArray(body.tasks) || Array.isArray(body.acceptanceCriteria))) {
      let sortOrder = 0
      if (Array.isArray(body.tasks)) {
        for (const title of body.tasks) {
          if (typeof title === 'string' && title.trim()) {
            workspaceService.createTask(workspace.id, {
              title: title.trim(),
              isAcceptanceCriterion: false,
              sortOrder: sortOrder++,
            })
          }
        }
      }
      if (Array.isArray(body.acceptanceCriteria)) {
        for (const title of body.acceptanceCriteria) {
          if (typeof title === 'string' && title.trim()) {
            workspaceService.createTask(workspace.id, {
              title: title.trim(),
              isAcceptanceCriterion: true,
              sortOrder: sortOrder++,
            })
          }
        }
      }
    }

    // Create git worktree for the working branch — unless we're reusing an
    // existing one, in which case the path is taken straight from the body.
    let worktreePath: string
    if (useReusedWorktree) {
      worktreePath = body.worktreePath as string
    } else {
      try {
        worktreePath = worktreeService.createWorktree(body.projectPath, workingBranch, body.sourceBranch)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        workspaceService.updateWorkspaceStatus(workspace.id, 'error')
        return c.json({ error: `Failed to create worktree: ${message}` }, 500)
      }
    }

    // Ensure Kobo-generated files are gitignored. Check both the root
    // .gitignore and .ai/.gitignore to avoid duplicate entries.
    try {
      const rootGitignorePath = path.join(worktreePath, '.gitignore')
      const aiGitignorePath = path.join(worktreePath, '.ai', '.gitignore')

      const rootContent = fs.existsSync(rootGitignorePath) ? fs.readFileSync(rootGitignorePath, 'utf-8') : ''
      const rootLines = rootContent.split('\n').map((l: string) => l.trim())
      const aiContent = fs.existsSync(aiGitignorePath) ? fs.readFileSync(aiGitignorePath, 'utf-8') : ''
      const aiLines = aiContent.split('\n').map((l: string) => l.trim())

      // Each entry: [pattern for root .gitignore, equivalent pattern in .ai/.gitignore]
      const entries: [string, string][] = [
        ['.ai/.git-conventions.md', '.git-conventions.md'],
        ['.ai/thoughts/', 'thoughts/'],
        ['.ai/images/', 'images/'],
        ['.ai/.setup-script.tmp', '.setup-script.tmp'],
        ['.mcp.json', ''],
      ]

      const toAdd: string[] = []
      for (const [rootPattern, aiPattern] of entries) {
        const inRoot = rootLines.includes(rootPattern)
        const inAi = aiPattern && aiLines.includes(aiPattern)
        if (!inRoot && !inAi) toAdd.push(rootPattern)
      }

      if (toAdd.length > 0) {
        const separator = rootContent.length > 0 && !rootContent.endsWith('\n') ? '\n' : ''
        fs.appendFileSync(rootGitignorePath, `${separator}${toAdd.join('\n')}\n`, 'utf-8')
      }
    } catch (err) {
      console.error('[workspaces] Failed to update .gitignore:', err)
    }

    // Write git conventions to the worktree if configured
    const effectiveSettings = settingsService.getEffectiveSettings(body.projectPath)
    if (effectiveSettings.gitConventions) {
      try {
        const aiDir = path.join(worktreePath, '.ai')
        fs.mkdirSync(aiDir, { recursive: true })
        const conventionsPath = path.join(aiDir, '.git-conventions.md')
        fs.writeFileSync(conventionsPath, effectiveSettings.gitConventions, 'utf-8')
      } catch (err) {
        console.error('[workspaces] Failed to write .git-conventions.md:', err)
      }
    }

    // Run setup script if configured and not skipped
    let setupScriptFailed = false
    // Skip the setup script when reusing an existing worktree — the user
    // already has the environment set up there and rerunning it could be
    // destructive (drop a node_modules they curated, etc.).
    if (effectiveSettings.setupScript && !body.skipSetupScript && !useReusedWorktree) {
      workspaceService.updateWorkspaceStatus(workspace.id, 'extracting')
      wsService.emit(workspace.id, 'setup:output', { text: '[kobo] Running setup script...' })
      try {
        const result = await runSetupScript(workspace.id, worktreePath, effectiveSettings.setupScript, {
          workspaceName: workspace.name,
          branchName: workingBranch,
          sourceBranch: body.sourceBranch,
          projectPath: body.projectPath,
        })
        if (result.exitCode !== 0) {
          workspaceService.updateWorkspaceStatus(workspace.id, 'error')
          setupScriptFailed = true
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.error(`[workspaces] Setup script error: ${message}`)
        workspaceService.updateWorkspaceStatus(workspace.id, 'error')
        setupScriptFailed = true
      }
    }

    // Save Notion content as markdown in worktree
    let notionFilePath: string | null = null
    if (notionContent && body.notionUrl) {
      try {
        const thoughtsDir = path.join(worktreePath, '.ai', 'thoughts')
        fs.mkdirSync(thoughtsDir, { recursive: true })

        // Derive filename from Notion ticket ID, or fallback to branch/name pattern
        const notionTicketId = notionContent.ticketId
        const fallbackMatch = `${workspace.name} ${workingBranch}`.match(/TK-\d+/i)
        const filename = notionTicketId
          ? `${notionTicketId.toUpperCase()}.md`
          : fallbackMatch
            ? `${fallbackMatch[0].toUpperCase()}.md`
            : `PAGE-${notionService.parseNotionUrl(body.notionUrl).replace(/-/g, '')}.md`
        notionFilePath = path.join(thoughtsDir, filename)

        const today = new Date().toISOString().split('T')[0]
        let md = `# ${workspace.name}\n\n`
        md += `## Source\n\n`
        md += `- Notion: ${body.notionUrl}\n`
        md += `- Retrieved: ${today}\n\n`

        // Persist the user's initial instructions (typed in the "Description"
        // field at creation time) so the agent can refer back to them later —
        // e.g. additional Notion sub-pages, parent PRs, constraints, etc.
        if (body.description?.trim()) {
          md += `## User instructions\n\n${body.description.trim()}\n\n`
        }

        if (notionContent.goal) {
          md += `## Goal\n\n${notionContent.goal}\n\n`
        }

        if (notionContent.todos.length > 0) {
          md += `## Tasks\n\n`
          for (const todo of notionContent.todos) {
            md += `- [${todo.checked ? 'x' : ' '}] ${todo.title}\n`
          }
          md += '\n'
        }

        if (notionContent.gherkinFeatures.length > 0) {
          md += `## Acceptance Criteria\n\n`
          for (const feature of notionContent.gherkinFeatures) {
            md += `${feature}\n\n`
          }
        }

        fs.writeFileSync(notionFilePath, md, 'utf-8')
      } catch (err) {
        console.error('[workspaces] Failed to save Notion content:', err)
      }
    }

    // --- Sentry file + task (extraction already done before worktree creation) --
    let sentryFilePath: string | null = null

    if (sentryContent) {
      try {
        const thoughtsDir = path.join(worktreePath, '.ai', 'thoughts')
        fs.mkdirSync(thoughtsDir, { recursive: true })
        // File is named SENTRY-<shortId>.md (e.g. SENTRY-ACME-API-3.md) — the
        // Short-ID is the canonical Sentry identifier. Falls back to the numeric
        // ID if the Short-ID could not be parsed from the MCP response.
        const idForFile = sentryContent.issueId || sentryContent.issueNumericId
        sentryFilePath = path.join(thoughtsDir, `SENTRY-${idForFile}.md`)

        const today = new Date().toISOString().split('T')[0]
        const tags = sentryContent.tags
        const env = tags.environment ?? 'unknown'
        const tagsBlock =
          Object.entries(tags)
            .map(([k, v]) => `- ${k}: ${v}`)
            .join('\n') || '- (none)'
        const spansBlock =
          sentryContent.offendingSpans.length > 0 ? sentryContent.offendingSpans.map((s) => `- ${s}`).join('\n') : 'N/A'
        const extra = sentryContent.extraContext || 'N/A'

        const md =
          `# Fix: ${sentryContent.title || sentryContent.issueId || sentryContent.issueNumericId}\n\n` +
          `## Source\n` +
          `- Sentry: ${body.sentryUrl}\n` +
          `- Issue Short-ID: ${sentryContent.issueId} (use in commit messages for auto-close)\n` +
          `- Issue numeric ID: ${sentryContent.issueNumericId}\n` +
          `- Retrieved: ${today}\n\n` +
          `## Summary\n` +
          `- **Culprit**: ${sentryContent.culprit}\n` +
          `- **Platform**: ${sentryContent.platform}\n` +
          `- **Environment**: ${env}\n` +
          `- **Occurrences**: ${sentryContent.occurrences} (first: ${sentryContent.firstSeen}, last: ${sentryContent.lastSeen})\n\n` +
          `## Tags\n${tagsBlock}\n\n` +
          `## Error Detail / Offending Spans\n${spansBlock}\n\n` +
          `## Additional Context\n${extra}\n\n` +
          `## MCP Tools for deeper analysis\n` +
          `If you need more context, the following Sentry MCP tools are available:\n` +
          `- \`mcp__sentry__get_sentry_resource(url, resourceType)\` — fetch the issue, breadcrumbs, replay, or trace\n` +
          `- \`mcp__sentry__search_issue_events(organizationSlug, issueId='${sentryContent.issueId}')\` — recent events for this issue\n` +
          `- \`mcp__sentry__get_issue_tag_values(organizationSlug, issueId='${sentryContent.issueId}', key)\` — filter by tag (environment, user, browser, …)\n`

        fs.writeFileSync(sentryFilePath, md, 'utf-8')

        workspaceService.createTask(workspace.id, {
          title: `Fix: ${sentryContent.title || sentryContent.issueId || `Sentry #${sentryContent.issueNumericId}`}`,
          isAcceptanceCriterion: false,
          sortOrder: 9999,
        })
      } catch (err) {
        console.error('[workspaces] Failed to save Sentry content:', err)
        sentryFilePath = null
      }
    }
    // ------------------------------------------------------------------------

    // Update Notion status if both property name and value are configured
    const notionStatusProp = effectiveSettings.notionStatusProperty
    const notionTargetStatus = effectiveSettings.notionInProgressStatus
    if (
      notionContent &&
      body.notionUrl &&
      notionStatusProp &&
      notionTargetStatus &&
      notionContent.status !== notionTargetStatus
    ) {
      notionService.updateNotionStatus(body.notionUrl, notionStatusProp, notionTargetStatus).catch((err) => {
        console.error('[workspaces] Failed to update Notion status:', err)
      })
    }

    // Skip agent launch if setup script failed — workspace stays in 'error' status
    if (!setupScriptFailed) {
      // Transition to brainstorming and build the initial agent prompt
      workspaceService.updateWorkspaceStatus(workspace.id, 'brainstorming')

      // Build prompt with tasks and acceptance criteria
      const allTasks = workspaceService.listTasks(workspace.id)
      const todos = allTasks.filter((t) => !t.isAcceptanceCriterion)
      const criteria = allTasks.filter((t) => t.isAcceptanceCriterion)

      let brainstormPrompt = `You are working on: ${workspace.name}\n`

      // Include ticket ID if found so the agent uses the correct reference
      const ticketId = notionContent?.ticketId || `${workspace.name} ${workingBranch}`.match(/TK-\d+/i)?.[0]
      if (ticketId) {
        brainstormPrompt += `Ticket: ${ticketId.toUpperCase()}\n`
      }

      if (body.description) {
        brainstormPrompt += `\nUser instructions:\n${body.description}\n`
      }

      if (notionContent?.goal) {
        brainstormPrompt += `\nGoal: ${notionContent.goal}\n`
      }

      brainstormPrompt += `\nBranch: ${workingBranch}\nSource branch: ${body.sourceBranch}\nIMPORTANT: When creating a pull request, always use --base ${body.sourceBranch} to target the correct source branch.\n`

      if (notionFilePath) {
        brainstormPrompt += `\nNotion ticket: ${body.notionUrl}`
        brainstormPrompt += `\nLocal copy: ${notionFilePath}\n`
      }

      if (sentryFilePath && sentryContent) {
        brainstormPrompt += `\nSentry issue: ${body.sentryUrl}`
        brainstormPrompt += `\nIssue Short-ID: ${sentryContent.issueId} (canonical, use in commit messages for auto-close)`
        brainstormPrompt += `\nIssue numeric ID: ${sentryContent.issueNumericId}`
        brainstormPrompt += `\nLocal copy: ${sentryFilePath}\n`
        brainstormPrompt +=
          `\nFix workflow:\n` +
          `1. Read the local Sentry file above for full context\n` +
          `2. Locate the bug from the stacktrace / culprit\n` +
          `3. Write a failing test that reproduces the bug (TDD)\n` +
          `4. Implement the minimal fix\n` +
          `5. Confirm the test passes, run related tests\n` +
          `6. Commit referencing the Sentry Short-ID (e.g. "fix(scope): description (${sentryContent.issueId})") — Sentry auto-closes the issue when the commit is merged\n` +
          `\nIf you need more context, Sentry MCP tools are available:\n` +
          `- mcp__sentry__get_sentry_resource(url, resourceType) — fetch the issue, breadcrumbs, replay or trace\n` +
          `- mcp__sentry__search_issue_events(organizationSlug, issueId='${sentryContent.issueId}') — recent events\n` +
          `- mcp__sentry__get_issue_tag_values(organizationSlug, issueId='${sentryContent.issueId}', key) — filter by tag\n`
      }

      if (todos.length > 0) {
        brainstormPrompt += `\nTasks:\n${todos.map((t) => `- [${t.status === 'done' ? 'x' : ' '}] ${t.title}`).join('\n')}\n`
      }

      if (criteria.length > 0) {
        brainstormPrompt += `\nAcceptance criteria:\n${criteria.map((t) => `- [${t.status === 'done' ? 'x' : ' '}] ${t.title}`).join('\n')}\n`
      }

      brainstormPrompt += `\nYou have access to MCP tools via the 'kobo-tasks' server:\n`
      if (criteria.length > 0 || todos.length > 0) {
        brainstormPrompt += `- list_tasks() — list all tasks and criteria with their IDs and current status\n`
        brainstormPrompt += `- mark_task_done(task_id) — mark a task or criterion as done\n`
        brainstormPrompt += `\nAs you work, keep the task list up to date: call mark_task_done(task_id) as soon as you complete a task or validate a criterion — don't wait until the end. Call list_tasks() first to see the current IDs.\n`
      }
      if (body.notionUrl) {
        brainstormPrompt += `- get_notion_ticket() — retrieve the Notion ticket info (URL, ticket ID, extracted content)\n`
      }

      if (effectiveSettings.gitConventions) {
        brainstormPrompt += `\n# Git conventions\nIMPORTANT: Before any git operation (commit, branch, rebase, merge, push), read and apply the conventions defined in \`.ai/.git-conventions.md\`. They are project-specific and override any default behavior. Re-read this file if you're unsure or if context was compacted.\n`
      }

      brainstormPrompt += `\nIMPORTANT: Start by reading CLAUDE.md and/or AGENTS.md at the project root if they exist — they contain project conventions and instructions you must follow.`

      if (body.autoLoop === true) {
        // Auto-loop is armed — brainstorm must end with task seeding + mark-ready,
        // NOT with implementation. The auto-loop will drive implementation after.
        // The grooming steps + hard rules are shared with the PREP_AUTOLOOP_PROMPT
        // sent by the "Prepare for auto-loop" button (src/shared/auto-loop-prompts.ts).
        // Read per-project E2E settings so the grooming steps can include the
        // E2E review pass when configured. We deliberately use
        // `getProjectSettings` (NOT `getEffectiveSettings`) here because only
        // project-level settings carry the `e2e` shape; if the project hasn't
        // been registered yet, the empty default below is correct.
        const projectSettingsForE2e = settingsService.getProjectSettings(body.projectPath)
        const e2eSettings = projectSettingsForE2e?.e2e ?? { framework: '', skill: '', prompt: '' }
        const finalizationSettings = projectSettingsForE2e?.finalization ?? { prompt: '' }
        brainstormPrompt += `\n\nThen brainstorm the implementation approach. Explore the codebase to understand the existing structure. Ask clarifying questions if needed. When you have a clear plan, create a plan file.

Auto-loop mode is active for this workspace. After the plan is ready, DO NOT implement anything. Instead:

${buildAutoLoopGroomingSteps(e2eSettings, finalizationSettings)}

When the steps above are complete, output [BRAINSTORM_COMPLETE] on its own line and end your turn cleanly.

${AUTO_LOOP_HARD_RULES}`
      } else {
        brainstormPrompt += `\n\nThen brainstorm the implementation approach. Explore the codebase to understand the existing structure. Ask clarifying questions if needed. When you're done brainstorming and have a clear plan, create a plan file and proceed with implementation. Once you have completed the brainstorming phase, output [BRAINSTORM_COMPLETE] on its own line.`
      }

      try {
        const agent = agentManager.startAgent(
          workspace.id,
          worktreePath,
          brainstormPrompt,
          workspace.model,
          false,
          workspace.agentPermissionMode,
          undefined,
          workspace.reasoningEffort,
        )
        // Persist the initial prompt in the feed so it's visible in the chat,
        // tagged with the freshly created session id so the strict session filter shows it.
        wsService.emit(
          workspace.id,
          'user:message',
          { content: brainstormPrompt, sender: 'system-prompt' },
          agent.agentSessionId,
        )
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.error(`[workspaces] Failed to start agent: ${message}`)
        try {
          workspaceService.updateWorkspaceStatus(workspace.id, 'error')
        } catch {
          /* already logged */
        }
      }
    }

    // Apply the auto-loop checkbox from CreatePage. Notion-imported workspaces
    // with both todos AND gherkin features auto-unlock `auto_loop_ready=1` —
    // they're considered good enough to drive the loop without grooming.
    if (body.autoLoop === true) {
      const notionProducedTasks =
        body.notionUrl !== undefined &&
        notionContent != null &&
        notionContent.todos.length > 0 &&
        notionContent.gherkinFeatures.length > 0
      const db = getDb()
      db.prepare('UPDATE workspaces SET auto_loop = 1, auto_loop_ready = ? WHERE id = ?').run(
        notionProducedTasks ? 1 : 0,
        workspace.id,
      )
      // Emit events so the frontend refreshes autoLoopStates without F5.
      wsService.emitEphemeral(workspace.id, 'autoloop:enabled', {})
      if (notionProducedTasks) {
        wsService.emitEphemeral(workspace.id, 'autoloop:ready-flipped', {})
      }
    }

    // Return created workspace with tasks
    const workspaceWithTasks = workspaceService.getWorkspaceWithTasks(workspace.id)
    return c.json(workspaceWithTasks, 201)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 500)
  }
})

// POST /api/workspaces/:id/sessions — create a new idle agent session
app.post('/:id/sessions', migrationGuard, (c) => {
  try {
    const id = c.req.param('id')
    const workspace = workspaceService.getWorkspace(id)
    if (!workspace) {
      return c.json({ error: `Workspace '${id}' not found` }, 404)
    }
    if (workspace.archivedAt) {
      return c.json({ error: `Workspace '${id}' is archived` }, 400)
    }
    if (agentManager.getAgentStatus(id) !== null) {
      return c.json({ error: 'An agent is already running for this workspace' }, 409)
    }
    const session = workspaceService.createIdleSession(id)
    return c.json(session, 201)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 500)
  }
})

// GET /api/workspaces/:id/sessions — list sessions for a workspace
app.get('/:id/sessions', (c) => {
  try {
    const id = c.req.param('id')
    const workspace = workspaceService.getWorkspace(id)
    if (!workspace) return c.json({ error: `Workspace '${id}' not found` }, 404)
    const sessions = workspaceService.listSessions(id)
    return c.json(sessions)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 500)
  }
})

// GET /api/workspaces/pr-states — batch snapshot of PR states known to the
// pr-watcher service, keyed by workspace id. Used by the drawer to show a
// small PR indicator without N separate `gh pr view` calls. Workspaces
// without a PR are absent from the response (do NOT assume keys are
// exhaustive over the workspace list).
app.get('/pr-states', (c) => {
  try {
    return c.json(getAllPrStates())
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 500)
  }
})

// GET /api/workspaces/auto-loop-states — batch snapshot keyed by workspace id.
// Used by the drawer + Pinia store. Static path — must be BEFORE /:id.
app.get('/auto-loop-states', (c) => {
  try {
    const db = getDb()
    const rows = db
      .prepare('SELECT id, auto_loop, auto_loop_ready, no_progress_streak FROM workspaces WHERE archived_at IS NULL')
      .all() as Array<{ id: string; auto_loop: number; auto_loop_ready: number; no_progress_streak: number }>
    const out: Record<string, { auto_loop: boolean; auto_loop_ready: boolean; no_progress_streak: number }> = {}
    for (const r of rows) {
      out[r.id] = {
        auto_loop: r.auto_loop === 1,
        auto_loop_ready: r.auto_loop_ready === 1,
        no_progress_streak: r.no_progress_streak,
      }
    }
    return c.json(out)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 500)
  }
})

// GET /api/workspaces/:id/auto-loop — current auto-loop status for one workspace.
app.get('/:id/auto-loop', (c) => {
  try {
    return c.json(autoLoopService.getStatus(c.req.param('id')))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 500)
  }
})

// POST /api/workspaces/:id/auto-loop — enable the loop (user toggle ON).
app.post('/:id/auto-loop', (c) => {
  try {
    autoLoopService.enable(c.req.param('id'))
    return c.json({ ok: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 400)
  }
})

// DELETE /api/workspaces/:id/auto-loop — disable the loop (user toggle OFF).
app.delete('/:id/auto-loop', (c) => {
  try {
    autoLoopService.disable(c.req.param('id'), 'user-action')
    return c.json({ ok: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 500)
  }
})

// POST /api/workspaces/:id/auto-loop-ready — force auto_loop_ready=true.
// Used by the "Force ready (skip grooming)" UI button AND by the MCP tool
// `kobo__mark_auto_loop_ready` at the end of a grooming session. Emits a
// WS event so any live frontend refreshes the toggle state immediately.
app.post('/:id/auto-loop-ready', (c) => {
  try {
    const id = c.req.param('id')
    const ws = workspaceService.getWorkspace(id)
    if (!ws) return c.json({ error: `Workspace '${id}' not found` }, 404)
    workspaceService.setAutoLoopReady(id, true)
    wsService.emitEphemeral(id, 'autoloop:ready-flipped', {})
    autoLoopService.onAutoLoopReadySet(id)
    return c.json({ ok: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 500)
  }
})

// GET /api/workspaces/:id/pending-wakeup — returns the pending wakeup or null.
app.get('/:id/pending-wakeup', (c) => {
  try {
    const id = c.req.param('id')
    const pending = wakeupService.getPending(id)
    return c.json(pending)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 500)
  }
})

// DELETE /api/workspaces/:id/pending-wakeup — user-initiated cancel ("×" button).
app.delete('/:id/pending-wakeup', (c) => {
  try {
    const id = c.req.param('id')
    wakeupService.cancel(id, 'manual')
    return c.json({ ok: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 500)
  }
})

// PATCH /api/workspaces/:id/sessions/:sessionId — rename a session
app.patch('/:id/sessions/:sessionId', async (c) => {
  try {
    const id = c.req.param('id')
    const sessionId = c.req.param('sessionId')

    const workspace = workspaceService.getWorkspace(id)
    if (!workspace) {
      return c.json({ error: `Workspace '${id}' not found` }, 404)
    }

    const body = await c.req.json<{ name?: string }>().catch(() => ({}) as { name?: string })
    if (!body.name?.trim()) {
      return c.json({ error: 'name is required and must not be empty' }, 400)
    }

    const updated = workspaceService.renameSession(sessionId, id, body.name.trim())
    if (!updated) {
      return c.json({ error: `Session '${sessionId}' not found` }, 404)
    }

    return c.json(updated)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 500)
  }
})

// POST /api/workspaces/:id/deferred-tool-use/answer — resume a deferred
// AskUserQuestion call by feeding the user's answers back to the SDK.
app.post('/:id/deferred-tool-use/answer', async (c) => {
  try {
    const id = c.req.param('id')
    const body = await c.req
      .json<{ answers?: Record<string, string>; toolCallId?: string }>()
      .catch(() => ({}) as { answers?: Record<string, string>; toolCallId?: string })
    if (!body?.answers || typeof body.answers !== 'object') {
      return c.json({ error: 'answers payload required' }, 400)
    }
    await agentManager.answerPendingQuestion(id, body.answers, body.toolCallId)
    return c.json({ ok: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown'
    return c.json({ error: message }, 400)
  }
})

// POST /api/workspaces/:id/deferred-tool-use/cancel — cancel a deferred
// AskUserQuestion. The SDK callback resolves with deny + a message; the
// agent sees an error tool_result and adapts. Does NOT abort the session.
app.post('/:id/deferred-tool-use/cancel', async (c) => {
  try {
    const id = c.req.param('id')
    const body = await c.req
      .json<{ reason?: string; toolCallId?: string }>()
      .catch(() => ({}) as { reason?: string; toolCallId?: string })
    await agentManager.cancelPendingQuestion(id, body.reason, body.toolCallId)
    return c.json({ ok: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown'
    return c.json({ error: message }, 400)
  }
})

// POST /api/workspaces/:id/deferred-permission/decision — resume a deferred
// interactive permission request with the user's allow/deny decision.
app.post('/:id/deferred-permission/decision', async (c) => {
  try {
    const id = c.req.param('id')
    const body = await c.req
      .json<{ toolCallId?: string; decision?: 'allow' | 'deny'; reason?: string }>()
      .catch(() => ({}) as { toolCallId?: string; decision?: 'allow' | 'deny'; reason?: string })
    if (!body?.toolCallId || typeof body.toolCallId !== 'string') {
      return c.json({ error: 'toolCallId required' }, 400)
    }
    if (body.decision !== 'allow' && body.decision !== 'deny') {
      return c.json({ error: "decision must be 'allow' or 'deny'" }, 400)
    }
    await agentManager.answerPendingPermission(id, {
      toolCallId: body.toolCallId,
      decision: body.decision,
      reason: typeof body.reason === 'string' ? body.reason : undefined,
    })
    return c.json({ ok: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown'
    return c.json({ error: message }, 400)
  }
})

// DELETE /api/workspaces/:id/events/:eventId — permanently dismiss a single
// persisted ws_events row (used today by the agent error banner so a closed
// error doesn't replay on F5 / reconnect). Defensive: only deletes if the row
// exists in this workspace; idempotent on missing row (returns 200).
app.delete('/:id/events/:eventId', (c) => {
  try {
    const workspaceId = c.req.param('id')
    const eventId = c.req.param('eventId')
    if (!workspaceService.getWorkspace(workspaceId)) {
      return c.json({ error: `Workspace '${workspaceId}' not found` }, 404)
    }
    const db = getDb()
    db.prepare('DELETE FROM ws_events WHERE id = ? AND workspace_id = ?').run(eventId, workspaceId)
    return c.json({ ok: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown'
    return c.json({ error: message }, 500)
  }
})

// POST /api/workspaces/:id/tasks — create a new task
app.post('/:id/tasks', async (c) => {
  try {
    const id = c.req.param('id')
    const workspace = workspaceService.getWorkspace(id)
    if (!workspace) {
      return c.json({ error: `Workspace '${id}' not found` }, 404)
    }

    const body = await c.req.json<{ title?: string; isAcceptanceCriterion?: boolean }>()
    if (!body.title?.trim()) {
      return c.json({ error: 'Title is required' }, 400)
    }

    const existing = workspaceService.listTasks(id)
    const nextSortOrder = existing.length > 0 ? Math.max(...existing.map((t) => t.sortOrder)) + 1 : 0
    const task = workspaceService.createTask(id, {
      title: body.title.trim(),
      isAcceptanceCriterion: !!body.isAcceptanceCriterion,
      sortOrder: nextSortOrder,
    })
    return c.json(task, 201)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 500)
  }
})

// PATCH /api/workspaces/:id/tasks/:taskId — update task status and/or title
app.patch('/:id/tasks/:taskId', async (c) => {
  try {
    const id = c.req.param('id')
    const taskId = c.req.param('taskId')

    const workspace = workspaceService.getWorkspace(id)
    if (!workspace) {
      return c.json({ error: `Workspace '${id}' not found` }, 404)
    }

    const task = workspaceService.getTask(taskId, id)
    if (!task) {
      return c.json({ error: `Task '${taskId}' not found in workspace '${id}'` }, 404)
    }

    const body = await c.req.json<{ status?: string; title?: string }>()

    if (body.status === undefined && body.title === undefined) {
      return c.json({ error: 'At least one of status or title is required' }, 400)
    }

    if (body.title !== undefined) {
      if (!body.title.trim()) {
        return c.json({ error: 'Title cannot be empty' }, 400)
      }
      workspaceService.updateTaskTitle(taskId, body.title.trim())
    }

    if (body.status !== undefined) {
      const validStatuses = ['pending', 'in_progress', 'done']
      if (!validStatuses.includes(body.status)) {
        return c.json({ error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` }, 400)
      }
      workspaceService.updateTaskStatus(taskId, body.status as workspaceService.TaskStatus)
    }

    return c.json({ ok: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 500)
  }
})

// DELETE /api/workspaces/:id/tasks/:taskId — delete a task
app.delete('/:id/tasks/:taskId', (c) => {
  try {
    const id = c.req.param('id')
    const taskId = c.req.param('taskId')
    const workspace = workspaceService.getWorkspace(id)
    if (!workspace) {
      return c.json({ error: `Workspace '${id}' not found` }, 404)
    }

    const task = workspaceService.getTask(taskId, id)
    if (!task) {
      return c.json({ error: `Task '${taskId}' not found in workspace '${id}'` }, 404)
    }

    workspaceService.deleteTask(taskId)
    return new Response(null, { status: 204 })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 500)
  }
})

// POST /api/workspaces/:id/tasks/notify-updated — broadcast generic task list change
// Must be declared BEFORE /:id/tasks/:taskId/notify-done so Hono doesn't capture
// "notify-updated" as a :taskId parameter.
app.post('/:id/tasks/notify-updated', (c) => {
  try {
    const id = c.req.param('id')
    const workspace = workspaceService.getWorkspace(id)
    if (!workspace) {
      return c.json({ error: `Workspace '${id}' not found` }, 404)
    }
    wsService.emit(id, 'task:updated', {})
    return new Response(null, { status: 204 })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 500)
  }
})

// POST /api/workspaces/:id/tasks/:taskId/notify-done — broadcast task:updated event
app.post('/:id/tasks/:taskId/notify-done', (c) => {
  try {
    const id = c.req.param('id')
    const taskId = c.req.param('taskId')
    const workspace = workspaceService.getWorkspace(id)
    if (!workspace) {
      return c.json({ error: `Workspace '${id}' not found` }, 404)
    }
    wsService.emit(id, 'task:updated', { taskId, status: 'done' })
    return new Response(null, { status: 204 })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 500)
  }
})

// GET /api/workspaces/:id/events — paginated event history (must be before GET /:id for route ordering)
app.get('/:id/events', (c) => {
  try {
    const id = c.req.param('id')
    const workspace = workspaceService.getWorkspace(id)
    if (!workspace) {
      return c.json({ error: `Workspace '${id}' not found` }, 404)
    }

    const before = c.req.query('before') // event ID cursor
    // optional: scope to a session view. Session views also include
    // workspace-level rows where session_id IS NULL (legacy/pre-session items).
    const session = c.req.query('session')
    const limit = Math.min(parseInt(c.req.query('limit') ?? '100', 10) || 100, 500)

    const db = getDb()
    let rows: Array<{
      id: string
      workspace_id: string
      type: string
      payload: string
      session_id: string | null
      created_at: string
    }>

    if (before) {
      // Get the rowid of the cursor event
      const cursorRow = db.prepare('SELECT rowid FROM ws_events WHERE id = ?').get(before) as
        | { rowid: number }
        | undefined
      if (!cursorRow) {
        return c.json({ events: [], hasMore: false })
      }
      rows = session
        ? (db
            .prepare(
              'SELECT * FROM ws_events WHERE workspace_id = ? AND (session_id = ? OR session_id IS NULL) AND rowid < ? ORDER BY rowid DESC LIMIT ?',
            )
            .all(id, session, cursorRow.rowid, limit) as typeof rows)
        : (db
            .prepare('SELECT * FROM ws_events WHERE workspace_id = ? AND rowid < ? ORDER BY rowid DESC LIMIT ?')
            .all(id, cursorRow.rowid, limit) as typeof rows)
    } else {
      // No cursor — return events. When filtering by session, we want the
      // MOST RECENT events of that session first (so the feed renders from
      // the end), reversed to chronological order below.
      rows = session
        ? (db
            .prepare(
              'SELECT * FROM ws_events WHERE workspace_id = ? AND (session_id = ? OR session_id IS NULL) ORDER BY rowid DESC LIMIT ?',
            )
            .all(id, session, limit) as typeof rows)
        : (db
            .prepare('SELECT * FROM ws_events WHERE workspace_id = ? ORDER BY rowid ASC LIMIT ?')
            .all(id, limit) as typeof rows)
    }

    // Reverse to chronological order (we queried DESC for "before" pagination,
    // or for the "session + no cursor" case where we fetched the newest first).
    if (before || session) rows.reverse()

    const events = rows.map((row) => {
      let parsedPayload: unknown
      try {
        parsedPayload = JSON.parse(row.payload)
      } catch {
        parsedPayload = row.payload
      }
      return {
        id: row.id,
        workspaceId: row.workspace_id,
        type: row.type,
        payload: parsedPayload,
        sessionId: row.session_id,
        createdAt: row.created_at,
      }
    })

    // Check if there are more older events beyond what we returned
    let hasMore = false
    if (rows.length > 0) {
      if (before) {
        const firstRow = db.prepare('SELECT rowid FROM ws_events WHERE id = ?').get(rows[0].id) as
          | { rowid: number }
          | undefined
        if (firstRow) {
          const older = session
            ? (db
                .prepare(
                  'SELECT COUNT(*) as c FROM ws_events WHERE workspace_id = ? AND (session_id = ? OR session_id IS NULL) AND rowid < ?',
                )
                .get(id, session, firstRow.rowid) as { c: number })
            : (db
                .prepare('SELECT COUNT(*) as c FROM ws_events WHERE workspace_id = ? AND rowid < ?')
                .get(id, firstRow.rowid) as { c: number })
          hasMore = older.c > 0
        }
      } else if (session) {
        const total = db
          .prepare(
            'SELECT COUNT(*) as c FROM ws_events WHERE workspace_id = ? AND (session_id = ? OR session_id IS NULL)',
          )
          .get(id, session) as { c: number }
        hasMore = total.c > rows.length
      }
    }

    return c.json({ events, hasMore })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 500)
  }
})

// GET /api/workspaces/archived — list archived workspaces (must be before GET /:id)
app.get('/archived', (c) => {
  try {
    return c.json(workspaceService.listArchivedWorkspaces())
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 500)
  }
})

// GET /:id/prep-autoloop-prompt — compose the project-aware grooming
// prompt. Used by the "Prepare for auto-loop" button. Place BEFORE
// `app.get('/:id', ...)` so the more-specific path wins.
app.get('/:id/prep-autoloop-prompt', (c) => {
  try {
    const id = c.req.param('id')
    const workspace = workspaceService.getWorkspace(id)
    if (!workspace) return c.json({ error: `Workspace '${id}' not found` }, 404)

    const projectSettings = settingsService.getProjectSettings(workspace.projectPath)
    const e2eSettings = projectSettings?.e2e ?? { framework: '', skill: '', prompt: '' }
    const finalizationSettings = projectSettings?.finalization ?? { prompt: '' }

    const prompt = `${PREP_AUTOLOOP_INTRO}

${buildAutoLoopGroomingSteps(e2eSettings, finalizationSettings)}

${AUTO_LOOP_HARD_RULES}`

    return c.json({ prompt })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 500)
  }
})

// GET /api/workspaces/:id — get workspace details with tasks
app.get('/:id', (c) => {
  try {
    const id = c.req.param('id')
    const workspace = workspaceService.getWorkspaceWithTasks(id)

    if (!workspace) {
      return c.json({ error: `Workspace '${id}' not found` }, 404)
    }

    return c.json(workspace)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 500)
  }
})

// POST /api/workspaces/:id/favorite — mark workspace as favorite
app.post('/:id/favorite', (c) => {
  const { id } = c.req.param()
  try {
    const ws = workspaceService.setFavorite(id)
    return c.json(ws)
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    const status = msg.includes('not found') ? 404 : 500
    return c.json({ error: msg }, status)
  }
})

// DELETE /api/workspaces/:id/favorite — remove favorite from workspace
app.delete('/:id/favorite', (c) => {
  const { id } = c.req.param()
  try {
    const ws = workspaceService.unsetFavorite(id)
    return c.json(ws)
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    const status = msg.includes('not found') ? 404 : 500
    return c.json({ error: msg }, status)
  }
})

// PUT /api/workspaces/:id/tags — replace the workspace's tag list
app.put('/:id/tags', async (c) => {
  const { id } = c.req.param()
  try {
    const body = await c.req.json<{ tags?: unknown }>()
    if (!Array.isArray(body.tags)) {
      return c.json({ error: 'tags must be an array of strings' }, 400)
    }
    if (body.tags.some((t) => typeof t !== 'string')) {
      return c.json({ error: 'tags must contain only strings' }, 400)
    }
    const ws = workspaceService.setWorkspaceTags(id, body.tags as string[])
    return c.json(ws)
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    const status = msg.includes('not found') ? 404 : 500
    return c.json({ error: msg }, status)
  }
})

// PATCH /api/workspaces/:id — update workspace fields (status, model, agentPermissionMode, name)
app.patch('/:id', migrationGuard, async (c) => {
  try {
    const id = c.req.param('id')
    const body = await c.req.json<{
      status?: WorkspaceStatus
      model?: string
      reasoningEffort?: string
      agentPermissionMode?: AgentPermissionMode
      name?: string
    }>()

    const workspace = workspaceService.getWorkspace(id)
    if (!workspace) {
      return c.json({ error: `Workspace '${id}' not found` }, 404)
    }

    let updated = workspace
    if (body.model !== undefined) {
      updated = workspaceService.updateWorkspaceModel(id, body.model)
    }
    if (body.reasoningEffort !== undefined) {
      updated = workspaceService.updateWorkspaceReasoningEffort(id, body.reasoningEffort)
    }
    if (body.agentPermissionMode !== undefined) {
      if (!isAgentPermissionMode(body.agentPermissionMode)) {
        return c.json(
          { error: `Invalid agentPermissionMode. Must be one of: ${VALID_AGENT_PERMISSION_MODES.join(', ')}` },
          400,
        )
      }
      updated = workspaceService.updateAgentPermissionMode(id, body.agentPermissionMode)
    }
    if (body.status) {
      updated = workspaceService.updateWorkspaceStatus(id, body.status)
    }
    if (body.name !== undefined) {
      updated = workspaceService.updateWorkspaceName(id, body.name)
    }
    if (
      !body.status &&
      body.model === undefined &&
      body.reasoningEffort === undefined &&
      body.agentPermissionMode === undefined &&
      body.name === undefined
    ) {
      return c.json({ error: 'Missing field: status, model, reasoningEffort, agentPermissionMode, or name' }, 400)
    }

    return c.json(updated)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message.includes('not found')) {
      return c.json({ error: message }, 404)
    }
    if (
      message.includes('Invalid status transition') ||
      message.includes('name cannot be empty') ||
      message.includes('name cannot exceed')
    ) {
      return c.json({ error: message }, 400)
    }
    return c.json({ error: message }, 500)
  }
})

/** Open the workspace worktree in the user's configured editor. */
app.post('/:id/open-editor', (c) => {
  try {
    const id = c.req.param('id')
    const workspace = workspaceService.getWorkspace(id)
    if (!workspace) return c.json({ error: `Workspace '${id}' not found` }, 404)

    const globalSettings = settingsService.getGlobalSettings()
    if (!globalSettings.editorCommand) {
      return c.json({ error: 'No editor command configured' }, 400)
    }

    const worktreePath = workspace.worktreePath
    if (!fs.existsSync(worktreePath)) {
      return c.json({ error: `Worktree path does not exist: ${worktreePath}` }, 400)
    }

    const child = spawn(globalSettings.editorCommand, [worktreePath], {
      detached: true,
      stdio: 'ignore',
    })
    // spawn errors fire async on the ChildProcess (ENOENT etc.) — without a
    // handler the unhandled 'error' event crashes the whole Node process.
    child.on('error', (err) => {
      console.error(`[open-editor] spawn '${globalSettings.editorCommand}' failed:`, err.message)
      wsService.emitEphemeral(workspace.id, 'editor:open-failed', {
        command: globalSettings.editorCommand,
        message: err.message,
      })
    })
    child.unref()

    return c.json({ success: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 500)
  }
})

/** Re-run the project setup script in the workspace worktree. */
app.post('/:id/run-setup-script', async (c) => {
  try {
    const id = c.req.param('id')
    const workspace = workspaceService.getWorkspace(id)
    if (!workspace) return c.json({ error: `Workspace '${id}' not found` }, 404)

    if (setupScriptRunning.has(id)) {
      return c.json({ error: 'Setup script is already running for this workspace' }, 409)
    }

    // Stop the running agent before re-running the setup script
    try {
      if (agentManager.getAgentStatus(id)) {
        agentManager.stopAgent(id)
      }
    } catch {
      /* best-effort — agent may already be stopped */
    }

    const effectiveSettings = settingsService.getEffectiveSettings(workspace.projectPath)
    if (!effectiveSettings.setupScript) {
      return c.json({ error: 'No setup script configured' }, 400)
    }

    const worktreePath = workspace.worktreePath
    if (!fs.existsSync(worktreePath)) {
      return c.json({ error: `Worktree path does not exist: ${worktreePath}` }, 400)
    }

    setupScriptRunning.add(id)
    try {
      const result = await runSetupScript(workspace.id, worktreePath, effectiveSettings.setupScript, {
        workspaceName: workspace.name,
        branchName: workspace.workingBranch,
        sourceBranch: workspace.sourceBranch,
        projectPath: workspace.projectPath,
      })

      if (result.exitCode !== 0) {
        return c.json({ error: `Setup script failed with exit code ${result.exitCode}` }, 500)
      }

      return c.json({ success: true })
    } finally {
      setupScriptRunning.delete(id)
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 500)
  }
})

// POST /api/workspaces/:id/archive — mark workspace as archived (soft-delete)
app.post('/:id/archive', migrationGuard, (c) => {
  try {
    const id = c.req.param('id')
    const workspace = workspaceService.getWorkspace(id)
    if (!workspace) {
      return c.json({ error: `Workspace '${id}' not found` }, 404)
    }
    if (workspace.archivedAt) {
      return c.json({ error: 'Already archived' }, 400)
    }

    try {
      agentManager.stopAgent(id)
    } catch {
      // Agent may not be running — ignore
    }

    try {
      devServerService.stopDevServer(id)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[workspaces] stopDevServer during archive failed: ${message}`)
    }

    try {
      terminalService.destroyTerminal(id)
    } catch {
      // Terminal may not exist — ignore
    }

    const updated = workspaceService.archiveWorkspace(id)

    wsService.emitEphemeral(id, 'workspace:archived', { workspace: updated })

    return c.json(updated)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 500)
  }
})

// POST /api/workspaces/:id/unarchive — restore an archived workspace
app.post('/:id/unarchive', migrationGuard, (c) => {
  try {
    const id = c.req.param('id')
    const workspace = workspaceService.getWorkspace(id)
    if (!workspace) {
      return c.json({ error: `Workspace '${id}' not found` }, 404)
    }
    if (!workspace.archivedAt) {
      return c.json({ error: 'Not archived' }, 400)
    }

    const updated = workspaceService.unarchiveWorkspace(id)
    wsService.emitEphemeral(id, 'workspace:unarchived', { workspace: updated })
    return c.json(updated)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 500)
  }
})

// DELETE /api/workspaces/:id — delete workspace
app.delete('/:id', migrationGuard, async (c) => {
  try {
    const id = c.req.param('id')

    const workspace = workspaceService.getWorkspace(id)
    if (!workspace) {
      return c.json({ error: `Workspace '${id}' not found` }, 404)
    }

    // Parse optional body for branch deletion options
    const body = await c.req
      .json<{
        deleteLocalBranch?: boolean
        deleteRemoteBranch?: boolean
      }>()
      .catch(() => ({}) as { deleteLocalBranch?: boolean; deleteRemoteBranch?: boolean })

    // Stop agent if running (best-effort)
    try {
      agentManager.stopAgent(id)
    } catch {
      // Agent may not be running — ignore
    }

    try {
      terminalService.destroyTerminal(id)
    } catch {
      // Terminal may not exist — ignore
    }

    // Collected best-effort warnings: the DB deletion always proceeds, but
    // side-effects (worktree, local/remote branches) can fail independently.
    // We surface a user-friendly message per failure so the UI can show a
    // sticky toast with a copy-pasteable recovery command — common case:
    // Docker leaves root-owned files inside the worktree, git worktree
    // remove fails with EACCES.
    const warnings: string[] = []

    // Remove worktree (only if owned — for attached external worktrees we
    // never created the dir, so we must not delete it on the user's behalf).
    const worktreePath = workspace.worktreePath
    if (workspace.worktreeOwned) {
      try {
        worktreeService.removeWorktree(workspace.projectPath, worktreePath)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.error(`[workspaces] Failed to remove worktree: ${message}`)
        warnings.push(
          `Failed to remove worktree directory '${worktreePath}'. The git entry may still reference it. ` +
            `Fix manually:\n` +
            `  sudo rm -rf '${worktreePath}'\n` +
            `  cd '${workspace.projectPath}' && git worktree prune\n` +
            `Reason: ${message}`,
        )
      }
    } else {
      console.log(`[workspaces] keeping reused worktree on delete: ${worktreePath}`)
    }

    // Delete local branch if requested
    if (body.deleteLocalBranch) {
      try {
        gitOps.deleteLocalBranch(workspace.projectPath, workspace.workingBranch)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.error(`[workspaces] Failed to delete local branch: ${message}`)
        warnings.push(
          `Failed to delete local branch '${workspace.workingBranch}'. Fix manually:\n` +
            `  cd '${workspace.projectPath}' && git branch -D '${workspace.workingBranch}'\n` +
            `Reason: ${message}`,
        )
      }
    }

    // Delete remote branch if requested
    if (body.deleteRemoteBranch) {
      try {
        gitOps.deleteRemoteBranch(workspace.projectPath, workspace.workingBranch)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.error(`[workspaces] Failed to delete remote branch: ${message}`)
        warnings.push(
          `Failed to delete remote branch '${workspace.workingBranch}'. Fix manually:\n` +
            `  cd '${workspace.projectPath}' && git push origin --delete '${workspace.workingBranch}'\n` +
            `Reason: ${message}`,
        )
      }
    }

    // Delete workspace from DB (cascades to tasks, sessions, events)
    workspaceService.deleteWorkspace(id)

    // When everything worked cleanly we keep the legacy 204 response so
    // existing clients aren't surprised by a JSON body. Warnings promote the
    // response to 200 so the body is readable.
    if (warnings.length === 0) {
      return new Response(null, { status: 204 })
    }
    return c.json({ ok: true, warnings }, 200)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 500)
  }
})

// POST /api/workspaces/:id/start — start/restart agent
app.post('/:id/start', migrationGuard, async (c) => {
  try {
    const id = c.req.param('id')

    const workspace = workspaceService.getWorkspace(id)
    if (!workspace) {
      return c.json({ error: `Workspace '${id}' not found` }, 404)
    }

    // If the workspace declares an engine, ensure it is still registered.
    // Otherwise startAgent() would throw from deep inside resolveEngine and
    // surface as an opaque 500 — better to fail fast with a clear 400.
    const workspaceEngine = (workspace as { engine?: string }).engine
    if (workspaceEngine) {
      const validEngineIds = listEngines().map((e) => e.id as string)
      if (!validEngineIds.includes(workspaceEngine)) {
        return c.json(
          {
            error: `Workspace uses engine '${workspaceEngine}' which is no longer available. Recreate or reconfigure the workspace.`,
          },
          400,
        )
      }
    }

    const body = await c.req
      .json<{ prompt?: string; agentSessionId?: string; resume?: boolean }>()
      .catch(() => ({ prompt: undefined, agentSessionId: undefined, resume: undefined }))
    const prompt = body.prompt ?? 'Continue the previous task where you left off.'
    const agentSessionId = body.agentSessionId
    const resume = body.resume === true

    // Stop existing agent if running
    try {
      agentManager.stopAgent(id)
    } catch {
      // Agent may not be running — ignore
    }

    const worktreePath = workspace.worktreePath

    const agent = agentManager.startAgent(
      id,
      worktreePath,
      prompt,
      workspace.model,
      resume,
      workspace.agentPermissionMode,
      agentSessionId,
      workspace.reasoningEffort,
    )
    workspaceService.updateWorkspaceStatus(id, 'executing')

    // Persist the user prompt so it survives page refresh.
    // When agentSessionId is provided (idle-session flow), the prompt was typed
    // by the user in the chat input; otherwise it's the workspace start prompt.
    if (body.prompt) {
      wsService.emit(id, 'user:message', { content: body.prompt, sender: 'user' }, agent.agentSessionId)
    }

    return c.json({ status: 'started' })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 500)
  }
})

// GET /api/workspaces/:id/git-stats — commit count and diff stats for the branch
app.get('/:id/git-stats', async (c) => {
  try {
    const id = c.req.param('id')
    const workspace = workspaceService.getWorkspace(id)
    if (!workspace) {
      return c.json({ error: `Workspace '${id}' not found` }, 404)
    }

    const worktreePath = workspace.worktreePath

    const commitCount = gitOps.getCommitCount(worktreePath, workspace.sourceBranch, workspace.workingBranch)
    const diffStats = gitOps.getStructuredDiffStatsBetween(
      worktreePath,
      workspace.sourceBranch,
      workspace.workingBranch,
    )
    const pr = await gitOps.getPrStatusAsync(workspace.projectPath, workspace.workingBranch)
    const unpushedCount = await gitOps.getUnpushedCountAsync(worktreePath)
    const workingTree = gitOps.getWorkingTreeStatus(worktreePath)

    return c.json({
      commitCount,
      filesChanged: diffStats.filesChanged,
      insertions: diffStats.insertions,
      deletions: diffStats.deletions,
      prUrl: pr?.url ?? null,
      prState: pr?.state ?? null,
      unpushedCount,
      workingTree,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 500)
  }
})

// GET /api/workspaces/:id/diff?mode=branch|unpushed — list changed files
// - `branch` (default): committed + working tree changes vs sourceBranch,
//   i.e. what the PR will contain.
// - `unpushed`: committed-only changes vs `origin/<workingBranch>`,
//   i.e. what the next `git push` will send.
app.get('/:id/diff', (c) => {
  try {
    const id = c.req.param('id')
    const mode = c.req.query('mode') === 'unpushed' ? 'unpushed' : 'branch'
    // Opt-in flag from the diff viewer toggle. Only meaningful in `branch`
    // mode — `unpushed` is committed-only by definition.
    const includeUntracked = c.req.query('includeUntracked') === '1'
    const workspace = workspaceService.getWorkspace(id)
    if (!workspace) {
      return c.json({ error: `Workspace '${id}' not found` }, 404)
    }

    const worktreePath = workspace.worktreePath
    const files =
      mode === 'unpushed'
        ? gitOps.getUnpushedChangedFiles(worktreePath, workspace.workingBranch)
        : gitOps.getChangedFiles(worktreePath, workspace.sourceBranch, includeUntracked)

    c.header('Cache-Control', 'no-store')
    return c.json({
      files,
      mode,
      sourceBranch: workspace.sourceBranch,
      workingBranch: workspace.workingBranch,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 500)
  }
})

// GET /api/workspaces/:id/diff-file?path=...&mode=branch|unpushed
// Resolves `original` at the appropriate base ref:
//  - `branch`   → sourceBranch
//  - `unpushed` → origin/<workingBranch>
// `modified` is always the current worktree content.
app.get('/:id/diff-file', (c) => {
  try {
    const id = c.req.param('id')
    const filePath = c.req.query('path')
    const mode = c.req.query('mode') === 'unpushed' ? 'unpushed' : 'branch'
    if (!filePath) {
      return c.json({ error: 'Missing path query parameter' }, 400)
    }

    const workspace = workspaceService.getWorkspace(id)
    if (!workspace) {
      return c.json({ error: `Workspace '${id}' not found` }, 404)
    }

    const worktreePath = workspace.worktreePath
    const baseRef = mode === 'unpushed' ? `origin/${workspace.workingBranch}` : workspace.sourceBranch
    const original = gitOps.getFileAtRef(worktreePath, baseRef, filePath)
    const modified = gitOps.getFileContent(worktreePath, filePath)

    c.header('Cache-Control', 'no-store')
    return c.json({ original: original ?? '', modified: modified ?? '', filePath, mode })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 500)
  }
})

// POST /api/workspaces/:id/rollback-file { path }
// Reset a single file to its `origin/<workingBranch>` version (overwrites
// working tree + index). Used by the right-click menu in the diff viewer.
// Returns 422 when the branch has never been pushed (no remote ref to
// rollback to) so the UI can disable the action gracefully.
app.post('/:id/rollback-file', async (c) => {
  try {
    const id = c.req.param('id')
    const workspace = workspaceService.getWorkspace(id)
    if (!workspace) {
      return c.json({ error: `Workspace '${id}' not found` }, 404)
    }

    const body = await c.req.json<{ path?: unknown }>()
    const filePath = typeof body?.path === 'string' ? body.path.trim() : ''
    if (!filePath) {
      return c.json({ error: 'Missing or invalid `path` field' }, 400)
    }

    let target: gitOps.RollbackTarget
    try {
      target = gitOps.rollbackFile(workspace.worktreePath, workspace.workingBranch, filePath)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return c.json({ error: message }, 422)
    }

    return c.json({ ok: true, path: filePath, target })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 500)
  }
})

// GET /api/workspaces/:id/commits?limit=50 — list commits between sourceBranch
// and HEAD, each tagged with whether it's already pushed to origin/<branch>.
app.get('/:id/commits', (c) => {
  try {
    const id = c.req.param('id')
    const workspace = workspaceService.getWorkspace(id)
    if (!workspace) {
      return c.json({ error: `Workspace '${id}' not found` }, 404)
    }
    const limitRaw = c.req.query('limit')
    const limit = Math.min(Math.max(1, parseInt(limitRaw ?? '50', 10) || 50), 200)
    const worktreePath = workspace.worktreePath
    const commits = gitOps.listBranchCommits(worktreePath, workspace.sourceBranch, workspace.workingBranch, limit)
    c.header('Cache-Control', 'no-store')
    return c.json({ commits, sourceBranch: workspace.sourceBranch, workingBranch: workspace.workingBranch })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 500)
  }
})

// POST /api/workspaces/:id/rename-branch { newName }
// Rename the working branch in git, move the worktree dir to match, and
// update the DB. Run as one atomic operation from the UI "Rename branch"
// action. If the worktree move fails (dirty tree, etc.) the branch rename
// is kept — the DB is still updated so Kōbō tracks the current name.
app.post('/:id/rename-branch', async (c) => {
  try {
    const id = c.req.param('id')
    const body = (await c.req.json().catch(() => ({}))) as { newName?: unknown }
    const newName = typeof body.newName === 'string' ? body.newName.trim() : ''
    if (!newName) {
      return c.json({ error: 'newName is required' }, 400)
    }
    if (!/^[A-Za-z0-9/_\-.]+$/.test(newName)) {
      return c.json({ error: 'Invalid branch name (only letters, digits, /, _, -, . allowed)' }, 400)
    }
    const workspace = workspaceService.getWorkspace(id)
    if (!workspace) {
      return c.json({ error: `Workspace '${id}' not found` }, 404)
    }
    if (!workspace.worktreeOwned) {
      return c.json(
        {
          error: 'Rename is not available for attached external worktrees. Manage the branch name with git directly.',
        },
        400,
      )
    }
    if (newName === workspace.workingBranch) {
      return c.json(workspace) // no-op
    }

    const oldWorktreePath = workspace.worktreePath
    // Sibling rename: keep the same worktrees-root, swap the branch leaf.
    // Cannot use `path.dirname` directly because branches with slashes
    // (e.g. `feature/x`) make the dirname end one level too deep.
    const oldSuffix = `/${workspace.workingBranch}`
    const worktreesRoot = oldWorktreePath.endsWith(oldSuffix)
      ? oldWorktreePath.slice(0, -oldSuffix.length)
      : path.join(workspace.projectPath, '.worktrees')
    const newWorktreePath = path.join(worktreesRoot, newName)

    // Reject early if the target name is already in use — either as a local
    // branch or on origin. Avoids git's generic "already exists" error and
    // protects against the same silent-fallback trap the create flow has.
    if (gitOps.branchExists(oldWorktreePath, newName)) {
      return c.json({ error: `Branch '${newName}' already exists (locally or on origin)`, code: 'branch_exists' }, 409)
    }

    try {
      gitOps.renameBranch(oldWorktreePath, workspace.workingBranch, newName)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return c.json({ error: `Failed to rename git branch: ${message}` }, 500)
    }

    // Best-effort: align the worktree dir with the new branch name. If the
    // tree is dirty or another process holds a lock, skip silently — the
    // worktree keeps working under its old path, and Kōbō uses the ref name,
    // not the dir, for git operations.
    try {
      gitOps.moveWorktree(workspace.projectPath, oldWorktreePath, newWorktreePath)
      workspaceService.updateWorktreePath(id, newWorktreePath)
    } catch (err) {
      console.error('[workspaces] Failed to move worktree dir (branch renamed anyway):', err)
      // worktree_path stays at oldWorktreePath, which still exists on disk
    }

    const updated = workspaceService.updateWorkingBranch(id, newName)
    return c.json(updated)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 500)
  }
})

// POST /api/workspaces/:id/resync-branch
// Read the real current branch name inside the worktree (via
// `git rev-parse --abbrev-ref HEAD`) and update the DB if it drifted. Used
// after the agent renames the branch from the chat (`git branch -m …`).
app.post('/:id/resync-branch', (c) => {
  try {
    const id = c.req.param('id')
    const workspace = workspaceService.getWorkspace(id)
    if (!workspace) {
      return c.json({ error: `Workspace '${id}' not found` }, 404)
    }
    if (!workspace.worktreeOwned) {
      return c.json(
        {
          error: 'Resync-branch is not available for attached external worktrees.',
        },
        400,
      )
    }
    const worktreePath = workspace.worktreePath
    let actual: string
    try {
      actual = gitOps.getCurrentBranch(worktreePath).trim()
    } catch (err) {
      // Could mean the dir was moved too — try scanning worktrees.
      const message = err instanceof Error ? err.message : String(err)
      return c.json({ error: `Could not read HEAD: ${message}` }, 500)
    }
    if (!actual || actual === workspace.workingBranch) {
      return c.json({ ok: true, changed: false, workingBranch: workspace.workingBranch })
    }

    // Branch was renamed in-place by the agent (`git branch -m ...`). The
    // worktree directory is still at <worktrees-root>/<old-name>; move it so it
    // matches the new ref, otherwise Kōbō's path resolver breaks and
    // subsequent session spawns fail with ENOENT on .mcp.json. Best-effort:
    // if the move fails (dir already moved, lockfile, dirty tree), we still
    // update the DB so git ops stay aligned with the current ref name — the
    // user can repair the dir manually.
    const oldSuffix = `/${workspace.workingBranch}`
    const worktreesRoot = worktreePath.endsWith(oldSuffix)
      ? worktreePath.slice(0, -oldSuffix.length)
      : path.join(workspace.projectPath, '.worktrees')
    const newWorktreePath = path.join(worktreesRoot, actual)
    try {
      gitOps.moveWorktree(workspace.projectPath, worktreePath, newWorktreePath)
      workspaceService.updateWorktreePath(id, newWorktreePath)
    } catch (err) {
      console.error('[workspaces] resync-branch: moveWorktree failed (DB update proceeds):', err)
      // worktree_path stays at the old path; DB update for working branch still proceeds
    }

    const updated = workspaceService.updateWorkingBranch(id, actual)
    return c.json({ ok: true, changed: true, workingBranch: updated.workingBranch })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 500)
  }
})

// POST /api/workspaces/:id/push — push working branch to origin
app.post('/:id/push', async (c) => {
  try {
    const id = c.req.param('id')
    const workspace = workspaceService.getWorkspace(id)
    if (!workspace) {
      return c.json({ error: `Workspace '${id}' not found` }, 404)
    }

    const body = await c.req.json<{ force?: boolean }>().catch(() => ({}) as { force?: boolean })
    const force = body?.force === true

    const worktreePath = workspace.worktreePath

    try {
      // Only pass an options arg when force is requested — keeps the
      // no-options call shape identical to before for callers/tests that
      // assert on argument count.
      if (force) {
        gitOps.pushBranch(worktreePath, workspace.workingBranch, { force: true })
      } else {
        gitOps.pushBranch(worktreePath, workspace.workingBranch)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return c.json({ error: message }, 500)
    }

    // Emit a trace into the chat feed so the user sees the action
    const session = workspaceService.getActiveSession(id)
    wsService.emit(
      id,
      'user:message',
      { content: `Pushed branch ${workspace.workingBranch} to origin`, sender: 'system-prompt' },
      session?.id ?? undefined,
    )

    return c.json({ ok: true, branch: workspace.workingBranch })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 500)
  }
})

// POST /api/workspaces/:id/pull — pull working branch from origin (fast-forward only)
app.post('/:id/pull', (c) => {
  try {
    const id = c.req.param('id')
    const workspace = workspaceService.getWorkspace(id)
    if (!workspace) {
      return c.json({ error: `Workspace '${id}' not found` }, 404)
    }

    const worktreePath = workspace.worktreePath

    try {
      gitOps.pullBranch(worktreePath, workspace.workingBranch)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return c.json({ error: message }, 500)
    }

    // Emit a trace into the chat feed so the user sees the action
    const session = workspaceService.getActiveSession(id)
    wsService.emit(
      id,
      'user:message',
      { content: `Pulled branch ${workspace.workingBranch} from origin`, sender: 'system-prompt' },
      session?.id ?? undefined,
    )

    return c.json({ ok: true, branch: workspace.workingBranch })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 500)
  }
})

/** Rebase the workspace branch onto its source branch. */
app.post('/:id/rebase', (c) => {
  try {
    const id = c.req.param('id')
    const workspace = workspaceService.getWorkspace(id)
    if (!workspace) return c.json({ error: `Workspace '${id}' not found` }, 404)

    const worktreePath = workspace.worktreePath
    gitOps.rebaseBranch(worktreePath, workspace.sourceBranch)

    return c.json({ success: true })
  } catch (err) {
    if (err instanceof gitOps.GitConflictError) {
      return c.json({ error: err.message, conflict: true, operation: err.operation, files: err.files }, 409)
    }
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 500)
  }
})

/** Merge the source branch into the workspace branch (non-fast-forward). */
app.post('/:id/merge', (c) => {
  try {
    const id = c.req.param('id')
    const workspace = workspaceService.getWorkspace(id)
    if (!workspace) return c.json({ error: `Workspace '${id}' not found` }, 404)

    const worktreePath = workspace.worktreePath
    gitOps.mergeBranch(worktreePath, workspace.sourceBranch)

    return c.json({ success: true })
  } catch (err) {
    if (err instanceof gitOps.GitConflictError) {
      return c.json({ error: err.message, conflict: true, operation: err.operation, files: err.files }, 409)
    }
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 500)
  }
})

/** Abort any in-progress merge or rebase in the worktree. */
app.post('/:id/git/abort', (c) => {
  try {
    const id = c.req.param('id')
    const workspace = workspaceService.getWorkspace(id)
    if (!workspace) return c.json({ error: `Workspace '${id}' not found` }, 404)

    const worktreePath = workspace.worktreePath
    const aborted = gitOps.abortOngoingGitOperation(worktreePath)
    return c.json({ success: true, aborted })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 500)
  }
})

/** Hand off merge/rebase conflicts to the workspace agent with an intelligent-resolution prompt. */
app.post('/:id/git/resolve-with-agent', migrationGuard, async (c) => {
  try {
    const id = c.req.param('id')
    const workspace = workspaceService.getWorkspace(id)
    if (!workspace) return c.json({ error: `Workspace '${id}' not found` }, 404)

    const body = (await c.req.json<{ operation?: 'merge' | 'rebase'; files?: string[] }>().catch(() => ({}))) as {
      operation?: 'merge' | 'rebase'
      files?: string[]
    }
    const worktreePath = workspace.worktreePath
    const operation = body.operation ?? gitOps.getOngoingGitOperation(worktreePath) ?? 'merge'
    const files = body.files && body.files.length > 0 ? body.files : gitOps.getConflictedFiles(worktreePath)

    if (files.length === 0) {
      return c.json({ error: 'No conflicted files detected — nothing for the agent to resolve' }, 400)
    }

    const fileList = files.map((f) => `- ${f}`).join('\n')
    const continueCmd = operation === 'merge' ? 'git merge --continue' : 'git rebase --continue'
    const prompt = `I started a \`git ${operation}\` of \`origin/${workspace.sourceBranch}\` into our working branch \`${workspace.workingBranch}\` and it produced conflicts that I need your help to resolve INTELLIGENTLY.

Conflicted files (${files.length}):
${fileList}

## Resolution rules — read carefully

1. **Our branch is the source of truth for the feature we are building.** Its behavior must be preserved.
2. **The source branch (\`${workspace.sourceBranch}\`) carries legitimate upstream changes** (bug fixes, refactors, dependency bumps). Integrate these where they don't conflict with our intent.
3. **Do NOT blindly pick a side.** Neither \`--ours\` nor \`--theirs\` wholesale. Read each conflict hunk and reason about what the correct merged state is.
4. **Think semantically, not syntactically.** If our branch renamed \`foo\` to \`bar\` and the source branch added a new call to \`foo\`, the correct resolution is a new call to \`bar\`, not "keep ours and drop the new call".
5. **Preserve tests and contracts.** If both sides touched the same test, keep coverage from both.
6. **Imports, versions, lock files:** prefer the superset (union) unless they genuinely conflict — in which case use the more recent / more restrictive.

## Steps

1. For each conflicted file, open it and read both conflict markers.
2. Decide the merge intent. If unsure, investigate both sides' commit history (\`git log --oneline ours..HEAD <file>\` vs \`git log --oneline origin/${workspace.sourceBranch} <file>\`).
3. Edit the file to the correct merged state and remove the conflict markers.
4. Run the test suite to verify no regression (\`npm test\` or the project's equivalent).
5. \`git add <resolved-files>\` then \`${continueCmd}\`.
6. Report the summary: which files you touched, the key decisions you made, and the final test result.

Start now.`

    // Persist the prompt in the chat feed so the user sees what was dispatched.
    const session = workspaceService.getActiveSession(workspace.id)
    wsService.emit(workspace.id, 'user:message', { content: prompt, sender: 'user' }, session?.id ?? undefined)

    // Cancel any pending wakeup: the user is driving this turn, the
    // scheduler should not also wake the agent a few minutes later.
    wakeupService.cancel(workspace.id, 'user-message')

    let messageSent = false
    try {
      agentManager.sendMessage(workspace.id, prompt)
      messageSent = true
    } catch {
      try {
        agentManager.startAgent(
          workspace.id,
          worktreePath,
          prompt,
          workspace.model,
          true,
          workspace.agentPermissionMode,
          undefined,
          workspace.reasoningEffort,
        )
        workspaceService.updateWorkspaceStatus(workspace.id, 'executing')
        messageSent = true
      } catch (resumeErr) {
        const resumeMsg = resumeErr instanceof Error ? resumeErr.message : String(resumeErr)
        console.warn(`[workspaces] resolve-with-agent: agent resume failed: ${resumeMsg}`)
      }
    }

    return c.json({ ok: true, operation, files, messageSent })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 500)
  }
})

/** Change the base branch of an existing PR via gh CLI. */
app.post('/:id/change-pr-base', async (c) => {
  try {
    const id = c.req.param('id')
    const body = await c.req.json<{ base: string }>()
    if (!body.base) return c.json({ error: 'Missing base parameter' }, 400)

    const workspace = workspaceService.getWorkspace(id)
    if (!workspace) return c.json({ error: `Workspace '${id}' not found` }, 404)

    const worktreePath = workspace.worktreePath

    await execFileAsync('gh', ['pr', 'edit', '--base', body.base], { cwd: worktreePath })

    return c.json({ success: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 500)
  }
})

// POST /api/workspaces/:id/open-pr — create a GitHub PR and send a templated prompt to the agent
app.post('/:id/open-pr', async (c) => {
  try {
    const id = c.req.param('id')
    const workspace = workspaceService.getWorkspace(id)
    if (!workspace) {
      return c.json({ error: `Workspace '${id}' not found` }, 404)
    }

    const worktreePath = workspace.worktreePath

    // Verify branch exists on remote
    let lsRemoteOut = ''
    try {
      const { stdout } = await execFileAsync('git', ['ls-remote', '--heads', 'origin', workspace.workingBranch], {
        cwd: worktreePath,
      })
      lsRemoteOut = stdout
    } catch {
      lsRemoteOut = ''
    }
    if (!lsRemoteOut.trim()) {
      return c.json({ error: 'Branch is not on remote', code: 'branch_not_pushed' }, 409)
    }

    // Ensure all local commits are pushed
    try {
      const { stdout } = await execFileAsync('git', ['rev-list', '@{u}..HEAD', '--count'], { cwd: worktreePath })
      const countStr = stdout.trim()
      const count = parseInt(countStr, 10) || 0
      if (count > 0) {
        return c.json({ error: 'Local commits not pushed', code: 'unpushed_commits' }, 409)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const stderr = (err as { stderr?: string | Buffer }).stderr?.toString() ?? ''
      const combined = `${message} ${stderr}`.toLowerCase()
      if (combined.includes('no upstream') || combined.includes('aucun amont') || combined.includes('no such ref')) {
        return c.json({ error: 'Branch has no upstream', code: 'branch_not_pushed' }, 409)
      }
      return c.json({ error: `Failed to check branch state: ${message}` }, 500)
    }

    // Create PR via GitHub CLI
    let ghOutput: string
    try {
      const placeholderBody = 'Automated PR — description will be updated by the agent.'
      const { stdout } = await execFileAsync(
        'gh',
        [
          'pr',
          'create',
          '--base',
          workspace.sourceBranch,
          '--head',
          workspace.workingBranch,
          '--title',
          workspace.name,
          '--body',
          placeholderBody,
        ],
        { cwd: worktreePath },
      )
      ghOutput = stdout
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const stderr = (err as { stderr?: string | Buffer }).stderr?.toString() ?? ''
      return c.json({ error: `gh pr create failed: ${message} ${stderr}`.trim() }, 500)
    }

    // Parse PR URL and number from gh output
    const urlMatch = ghOutput.match(/https:\/\/github\.com\/[^\s]+\/pull\/(\d+)/)
    if (!urlMatch) {
      return c.json({ error: 'Could not parse PR URL from gh output' }, 500)
    }
    const prUrl = urlMatch[0]
    const prNumber = parseInt(urlMatch[1], 10)

    // ── From here on, PR exists. No more 5xx responses. ──

    // Resolve the PR prompt template; skip message steps if empty
    const effective = settingsService.getEffectiveSettings(workspace.projectPath)
    if (!effective.prPromptTemplate) {
      return c.json({ ok: true, prNumber, prUrl, messageSent: false })
    }

    // Build context and render the PR prompt template
    const commits = gitOps.getCommitsBetween(worktreePath, workspace.sourceBranch, workspace.workingBranch)
    const diffStats = gitOps.getDiffStatsBetween(worktreePath, workspace.sourceBranch, workspace.workingBranch)
    const tasks = workspaceService.listTasks(workspace.id)

    const rendered = renderPrTemplate(effective.prPromptTemplate, {
      workspace,
      prNumber,
      prUrl,
      commits,
      diffStats,
      tasks,
    })

    // Emit user:message into the chat feed
    const session = workspaceService.getActiveSession(workspace.id)
    wsService.emit(workspace.id, 'user:message', { content: rendered, sender: 'user' }, session?.id ?? undefined)

    // Cancel any pending wakeup: the user is driving this turn.
    wakeupService.cancel(workspace.id, 'user-message')

    // Send to the running agent, or resume the agent with the PR prompt
    let messageSent = false
    try {
      agentManager.sendMessage(workspace.id, rendered)
      messageSent = true
    } catch {
      // Agent not running — resume it with the PR prompt
      try {
        const worktreePathForResume = workspace.worktreePath
        agentManager.startAgent(
          workspace.id,
          worktreePathForResume,
          rendered,
          workspace.model,
          true,
          workspace.agentPermissionMode,
          undefined,
          workspace.reasoningEffort,
        )
        workspaceService.updateWorkspaceStatus(workspace.id, 'executing')
        messageSent = true
      } catch (resumeErr) {
        const resumeMsg = resumeErr instanceof Error ? resumeErr.message : String(resumeErr)
        console.warn(`[workspaces] open-pr: PR created but agent resume failed: ${resumeMsg}`)
      }
    }

    return c.json({ ok: true, prNumber, prUrl, messageSent })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 500)
  }
})

/** POST /api/workspaces/:id/mark-read — mark workspace as read (clear unread indicator). */
app.post('/:id/mark-read', (c) => {
  try {
    const id = c.req.param('id')
    const workspace = workspaceService.getWorkspace(id)
    if (!workspace) {
      return c.json({ error: `Workspace '${id}' not found` }, 404)
    }

    workspaceService.markWorkspaceRead(id)
    wsService.emitEphemeral(id, 'workspace:unread', { hasUnread: false })

    return c.json({ success: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 500)
  }
})

// POST /api/workspaces/:id/stop — stop agent
app.post('/:id/stop', migrationGuard, (c) => {
  try {
    const id = c.req.param('id')

    const workspace = workspaceService.getWorkspace(id)
    if (!workspace) {
      return c.json({ error: `Workspace '${id}' not found` }, 404)
    }

    try {
      agentManager.stopAgent(id)
    } catch {
      // Agent may not be tracked (e.g. server restarted) — just update status
    }

    // Always transition to idle so the UI reflects the stopped state
    try {
      workspaceService.updateWorkspaceStatus(id, 'idle')
    } catch {
      // Status transition may not be valid
    }

    return c.json({ status: 'stopped' })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 500)
  }
})

// POST /api/workspaces/:id/interrupt — soft-interrupt agent (SIGINT, like Escape in Claude Code)
app.post('/:id/interrupt', migrationGuard, (c) => {
  try {
    const id = c.req.param('id')

    const workspace = workspaceService.getWorkspace(id)
    if (!workspace) {
      return c.json({ error: `Workspace '${id}' not found` }, 404)
    }

    agentManager.interruptAgent(id)
    return c.json({ status: 'interrupted' })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 500)
  }
})

export default app
