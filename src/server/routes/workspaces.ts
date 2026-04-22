import { execFile as execFileCb, spawn } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFileCb)

import fs from 'node:fs'
import path from 'node:path'
import { Hono } from 'hono'
import { getDb } from '../db/index.js'
import { migrationGuard } from '../middleware/migration-guard.js'
import { listEngines } from '../services/agent/engines/registry.js'
import * as agentManager from '../services/agent/orchestrator.js'
import * as devServerService from '../services/dev-server-service.js'
import * as notionService from '../services/notion-service.js'
import { renderPrTemplate } from '../services/pr-template-service.js'
import * as sentryService from '../services/sentry-service.js'
import * as settingsService from '../services/settings-service.js'
import { runSetupScript } from '../services/setup-script-service.js'
import * as terminalService from '../services/terminal-service.js'
import * as wakeupService from '../services/wakeup-service.js'
import * as wsService from '../services/websocket-service.js'
import type { PermissionMode, WorkspaceStatus } from '../services/workspace-service.js'
import * as workspaceService from '../services/workspace-service.js'
import * as worktreeService from '../services/worktree-service.js'
import * as gitOps from '../utils/git-ops.js'

/** Hono sub-router for workspace CRUD, tasks, agent lifecycle, git operations, and PR creation. */
const app = new Hono()

/** Tracks workspaces currently running a setup script to prevent concurrent executions. */
const setupScriptRunning = new Set<string>()

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
      permissionMode?: string
      engine?: string
    }>()

    if (!body.name || !body.projectPath || !body.sourceBranch || !body.workingBranch) {
      return c.json({ error: 'Missing required fields: name, projectPath, sourceBranch, workingBranch' }, 400)
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

    // Create workspace record
    const globalSettings = settingsService.getGlobalSettings()
    // workingBranch may be updated after Notion extraction to inject the ticket ID
    let workingBranch = body.workingBranch
    let workspace = workspaceService.createWorkspace({
      name: body.name,
      projectPath: body.projectPath,
      sourceBranch: body.sourceBranch,
      workingBranch,
      notionUrl: body.notionUrl,
      notionPageId: body.notionPageId,
      model: body.model,
      reasoningEffort: body.reasoningEffort,
      permissionMode: body.permissionMode || globalSettings.defaultPermissionMode || 'plan',
      engine: body.engine,
    })

    let notionContent: notionService.NotionPageContent | null = null
    let sentryContent: sentryService.SentryIssueContent | null = null

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

    // Extract Notion page content if a URL was provided
    if (body.notionUrl) {
      workspaceService.updateWorkspaceStatus(workspace.id, 'extracting')

      try {
        notionContent = await notionService.extractNotionPage(body.notionUrl)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.error(`[workspaces] Failed to extract Notion page: ${message}`)
      }
    }

    // Extract Sentry issue content if a URL was provided. Done early (before
    // worktree creation) so the issue ID can be injected into the branch name.
    if (body.sentryUrl) {
      workspaceService.updateWorkspaceStatus(workspace.id, 'extracting')

      try {
        sentryContent = await sentryService.extractSentryIssue(body.sentryUrl)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.error(`[workspaces] Failed to extract Sentry issue: ${message}`)
      }
    }

    // Update workspace name with Sentry issue title if the user did not provide
    // a custom name and Notion hasn't already filled it.
    if (sentryContent?.title && !notionContent?.title && workspace.name === 'workspace') {
      workspace = workspaceService.updateWorkspaceName(workspace.id, sentryContent.title)
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

      // Update workspace name with Notion page title only if user didn't provide a custom name
      if (notionContent.title && workspace.name === 'workspace') {
        workspace = workspaceService.updateWorkspaceName(workspace.id, notionContent.title)
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

    // Inject ticket ID into the working branch.
    // Works with or without Notion: ticket ID comes from Notion extraction first,
    // then falls back to a TK-XXXX pattern anywhere in the workspace name.
    // The worktree has not been created yet, so a DB update is sufficient.
    {
      // Sentry's canonical identifier is the issue short-ID (e.g. "ACME-API-3"),
      // which is what Sentry auto-close recognises in commit messages.
      const detectedTicketId =
        notionContent?.ticketId || sentryContent?.issueId || workspace.name.match(/[A-Z]+-\d+/i)?.[0]
      if (detectedTicketId && !workingBranch.toLowerCase().includes(detectedTicketId.toLowerCase())) {
        const ticketPrefix = detectedTicketId.toUpperCase()
        const slashIdx = workingBranch.indexOf('/')
        const typePrefix = slashIdx >= 0 ? workingBranch.slice(0, slashIdx + 1) : 'feature/'
        // Use Notion/Sentry title or workspace name for the slug — all have proper accented
        // characters that NFD normalization can transliterate (é→e, ç→c, etc.)
        const titleSource = notionContent?.title || sentryContent?.title || workspace.name
        const titleSlug = titleSource
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '')
          .substring(0, 50)
        workingBranch = `${typePrefix}${ticketPrefix}--${titleSlug}`
        workspace = workspaceService.updateWorkingBranch(workspace.id, workingBranch)
      }
    }

    // Create git worktree for the working branch
    let worktreePath: string
    try {
      worktreePath = worktreeService.createWorktree(body.projectPath, workingBranch, body.sourceBranch)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      workspaceService.updateWorkspaceStatus(workspace.id, 'error')
      return c.json({ error: `Failed to create worktree: ${message}` }, 500)
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
    if (effectiveSettings.setupScript && !body.skipSetupScript) {
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
      brainstormPrompt += `\n\nThen brainstorm the implementation approach. Explore the codebase to understand the existing structure. Ask clarifying questions if needed. When you're done brainstorming and have a clear plan, create a plan file and proceed with implementation. Once you have completed the brainstorming phase, output [BRAINSTORM_COMPLETE] on its own line.`

      try {
        const agent = agentManager.startAgent(
          workspace.id,
          worktreePath,
          brainstormPrompt,
          workspace.model,
          false,
          workspace.permissionMode,
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

// POST /api/workspaces/:id/refresh-notion — re-extract Notion page and update tasks
app.post('/:id/refresh-notion', async (c) => {
  try {
    const id = c.req.param('id')
    const workspace = workspaceService.getWorkspace(id)
    if (!workspace) return c.json({ error: `Workspace '${id}' not found` }, 404)
    if (!workspace.notionUrl) return c.json({ error: 'No Notion URL configured' }, 400)

    const notionContent = await notionService.extractNotionPage(workspace.notionUrl)

    // Delete existing tasks and recreate from Notion
    const db = getDb()
    db.prepare('DELETE FROM tasks WHERE workspace_id = ?').run(id)

    let sortOrder = 0
    for (const todo of notionContent.todos) {
      workspaceService.createTask(id, {
        title: todo.title,
        isAcceptanceCriterion: false,
        sortOrder: sortOrder++,
      })
    }
    for (const feature of notionContent.gherkinFeatures) {
      workspaceService.createTask(id, {
        title: feature,
        isAcceptanceCriterion: true,
        sortOrder: sortOrder++,
      })
    }

    // Update name if it was the default
    if (notionContent.title && workspace.name === 'workspace') {
      workspaceService.updateWorkspaceName(id, notionContent.title)
    }

    const updated = workspaceService.getWorkspaceWithTasks(id)
    return c.json(updated)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
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
      rows = db
        .prepare('SELECT * FROM ws_events WHERE workspace_id = ? AND rowid < ? ORDER BY rowid DESC LIMIT ?')
        .all(id, cursorRow.rowid, limit) as typeof rows
    } else {
      // No cursor — return the oldest events
      rows = db
        .prepare('SELECT * FROM ws_events WHERE workspace_id = ? ORDER BY rowid ASC LIMIT ?')
        .all(id, limit) as typeof rows
    }

    // Reverse to chronological order (we queried DESC for "before" pagination)
    if (before) rows.reverse()

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
    if (before && rows.length > 0) {
      const firstRow = db.prepare('SELECT rowid FROM ws_events WHERE id = ?').get(rows[0].id) as
        | { rowid: number }
        | undefined
      if (firstRow) {
        const older = db
          .prepare('SELECT COUNT(*) as c FROM ws_events WHERE workspace_id = ? AND rowid < ?')
          .get(id, firstRow.rowid) as { c: number }
        hasMore = older.c > 0
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

// PATCH /api/workspaces/:id — update workspace fields (status, model, permissionMode, name)
app.patch('/:id', migrationGuard, async (c) => {
  try {
    const id = c.req.param('id')
    const body = await c.req.json<{
      status?: WorkspaceStatus
      model?: string
      reasoningEffort?: string
      permissionMode?: PermissionMode
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
    if (body.permissionMode !== undefined) {
      const validModes: PermissionMode[] = ['auto-accept', 'plan']
      if (!validModes.includes(body.permissionMode)) {
        return c.json({ error: `Invalid permission mode. Must be one of: ${validModes.join(', ')}` }, 400)
      }
      updated = workspaceService.updateWorkspacePermissionMode(id, body.permissionMode)
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
      body.permissionMode === undefined &&
      body.name === undefined
    ) {
      return c.json({ error: 'Missing field: status, model, reasoningEffort, permissionMode, or name' }, 400)
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

    const worktreePath = path.join(workspace.projectPath, '.worktrees', workspace.workingBranch)
    if (!fs.existsSync(worktreePath)) {
      return c.json({ error: `Worktree path does not exist: ${worktreePath}` }, 400)
    }

    const child = spawn(globalSettings.editorCommand, [worktreePath], {
      detached: true,
      stdio: 'ignore',
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

    const worktreePath = path.join(workspace.projectPath, '.worktrees', workspace.workingBranch)
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

    // Remove worktree
    const worktreesDir = `${workspace.projectPath}/.worktrees`
    const worktreePath = `${worktreesDir}/${workspace.workingBranch}`
    try {
      worktreeService.removeWorktree(workspace.projectPath, worktreePath)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[workspaces] Failed to remove worktree: ${message}`)
    }

    // Delete local branch if requested
    if (body.deleteLocalBranch) {
      try {
        gitOps.deleteLocalBranch(workspace.projectPath, workspace.workingBranch)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.error(`[workspaces] Failed to delete local branch: ${message}`)
      }
    }

    // Delete remote branch if requested
    if (body.deleteRemoteBranch) {
      try {
        gitOps.deleteRemoteBranch(workspace.projectPath, workspace.workingBranch)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.error(`[workspaces] Failed to delete remote branch: ${message}`)
      }
    }

    // Delete workspace from DB (cascades to tasks, sessions, events)
    workspaceService.deleteWorkspace(id)

    return new Response(null, { status: 204 })
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

    const worktreePath = `${workspace.projectPath}/.worktrees/${workspace.workingBranch}`

    const agent = agentManager.startAgent(
      id,
      worktreePath,
      prompt,
      workspace.model,
      resume,
      workspace.permissionMode,
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

    const worktreePath = path.join(workspace.projectPath, '.worktrees', workspace.workingBranch)

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
    const workspace = workspaceService.getWorkspace(id)
    if (!workspace) {
      return c.json({ error: `Workspace '${id}' not found` }, 404)
    }

    const worktreePath = path.join(workspace.projectPath, '.worktrees', workspace.workingBranch)
    const files =
      mode === 'unpushed'
        ? gitOps.getUnpushedChangedFiles(worktreePath, workspace.workingBranch)
        : gitOps.getChangedFiles(worktreePath, workspace.sourceBranch)

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

    const worktreePath = path.join(workspace.projectPath, '.worktrees', workspace.workingBranch)
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
    const worktreePath = path.join(workspace.projectPath, '.worktrees', workspace.workingBranch)
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
    if (newName === workspace.workingBranch) {
      return c.json(workspace) // no-op
    }

    const oldWorktreePath = path.join(workspace.projectPath, '.worktrees', workspace.workingBranch)
    const newWorktreePath = path.join(workspace.projectPath, '.worktrees', newName)

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
    } catch (err) {
      console.error('[workspaces] Failed to move worktree dir (branch renamed anyway):', err)
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
    const worktreePath = path.join(workspace.projectPath, '.worktrees', workspace.workingBranch)
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

    const worktreePath = path.join(workspace.projectPath, '.worktrees', workspace.workingBranch)

    try {
      gitOps.pushBranch(worktreePath, workspace.workingBranch)
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

    const worktreePath = path.join(workspace.projectPath, '.worktrees', workspace.workingBranch)

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

    const worktreePath = path.join(workspace.projectPath, '.worktrees', workspace.workingBranch)
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

    const worktreePath = path.join(workspace.projectPath, '.worktrees', workspace.workingBranch)
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

    const worktreePath = path.join(workspace.projectPath, '.worktrees', workspace.workingBranch)
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
    const worktreePath = path.join(workspace.projectPath, '.worktrees', workspace.workingBranch)
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
          workspace.permissionMode,
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

    const worktreePath = path.join(workspace.projectPath, '.worktrees', workspace.workingBranch)

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

    const worktreePath = path.join(workspace.projectPath, '.worktrees', workspace.workingBranch)

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
        const worktreePathForResume = `${workspace.projectPath}/.worktrees/${workspace.workingBranch}`
        agentManager.startAgent(
          workspace.id,
          worktreePathForResume,
          rendered,
          workspace.model,
          true,
          workspace.permissionMode,
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
