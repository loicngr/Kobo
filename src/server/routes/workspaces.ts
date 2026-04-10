import { execFile as execFileCb, spawn } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFileCb)

import fs from 'node:fs'
import path from 'node:path'
import { Hono } from 'hono'
import { getDb } from '../db/index.js'
import * as agentManager from '../services/agent-manager.js'
import * as devServerService from '../services/dev-server-service.js'
import * as notionService from '../services/notion-service.js'
import { renderPrTemplate } from '../services/pr-template-service.js'
import * as settingsService from '../services/settings-service.js'
import { runSetupScript } from '../services/setup-script-service.js'
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
app.post('/', async (c) => {
  try {
    const body = await c.req.json<{
      name: string
      projectPath: string
      sourceBranch: string
      workingBranch: string
      notionUrl?: string
      notionPageId?: string
      model?: string
      tasks?: string[]
      acceptanceCriteria?: string[]
      skipSetupScript?: boolean
      description?: string
      permissionMode?: string
    }>()

    if (!body.name || !body.projectPath || !body.sourceBranch || !body.workingBranch) {
      return c.json({ error: 'Missing required fields: name, projectPath, sourceBranch, workingBranch' }, 400)
    }

    // Create workspace record
    const globalSettings = settingsService.getGlobalSettings()
    let workspace = workspaceService.createWorkspace({
      name: body.name,
      projectPath: body.projectPath,
      sourceBranch: body.sourceBranch,
      workingBranch: body.workingBranch,
      notionUrl: body.notionUrl,
      notionPageId: body.notionPageId,
      model: body.model,
      permissionMode: body.permissionMode || globalSettings.defaultPermissionMode || 'plan',
    })

    let notionContent: notionService.NotionPageContent | null = null

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

    // Create git worktree for the working branch
    let worktreePath: string
    try {
      worktreePath = worktreeService.createWorktree(body.projectPath, body.workingBranch, body.sourceBranch)
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
          branchName: body.workingBranch,
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
        const fallbackMatch = `${workspace.name} ${body.workingBranch}`.match(/TK-\d+/i)
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
      const ticketId = notionContent?.ticketId || `${workspace.name} ${body.workingBranch}`.match(/TK-\d+/i)?.[0]
      if (ticketId) {
        brainstormPrompt += `Ticket: ${ticketId.toUpperCase()}\n`
      }

      if (body.description) {
        brainstormPrompt += `\nUser instructions:\n${body.description}\n`
      }

      if (notionContent?.goal) {
        brainstormPrompt += `\nGoal: ${notionContent.goal}\n`
      }

      brainstormPrompt += `\nBranch: ${body.workingBranch}\nSource branch: ${body.sourceBranch}\nIMPORTANT: When creating a pull request, always use --base ${body.sourceBranch} to target the correct source branch.\n`

      if (notionFilePath) {
        brainstormPrompt += `\nNotion ticket: ${body.notionUrl}`
        brainstormPrompt += `\nLocal copy: ${notionFilePath}\n`
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
        const agent = agentManager.startAgent(workspace.id, worktreePath, brainstormPrompt, workspace.model)
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
app.post('/:id/sessions', (c) => {
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

// PATCH /api/workspaces/:id — update workspace fields (status, model, permissionMode)
app.patch('/:id', async (c) => {
  try {
    const id = c.req.param('id')
    const body = await c.req.json<{ status?: WorkspaceStatus; model?: string; permissionMode?: PermissionMode }>()

    const workspace = workspaceService.getWorkspace(id)
    if (!workspace) {
      return c.json({ error: `Workspace '${id}' not found` }, 404)
    }

    let updated = workspace
    if (body.model !== undefined) {
      updated = workspaceService.updateWorkspaceModel(id, body.model)
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
    if (!body.status && body.model === undefined && body.permissionMode === undefined) {
      return c.json({ error: 'Missing field: status, model, or permissionMode' }, 400)
    }

    return c.json(updated)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message.includes('not found')) {
      return c.json({ error: message }, 404)
    }
    if (message.includes('Invalid status transition')) {
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
app.post('/:id/archive', (c) => {
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

    const updated = workspaceService.archiveWorkspace(id)

    wsService.emitEphemeral(id, 'workspace:archived', { workspace: updated })

    return c.json(updated)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 500)
  }
})

// POST /api/workspaces/:id/unarchive — restore an archived workspace
app.post('/:id/unarchive', (c) => {
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
app.delete('/:id', async (c) => {
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
app.post('/:id/start', async (c) => {
  try {
    const id = c.req.param('id')

    const workspace = workspaceService.getWorkspace(id)
    if (!workspace) {
      return c.json({ error: `Workspace '${id}' not found` }, 404)
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

// GET /api/workspaces/:id/diff — list changed files
app.get('/:id/diff', (c) => {
  try {
    const id = c.req.param('id')
    const workspace = workspaceService.getWorkspace(id)
    if (!workspace) {
      return c.json({ error: `Workspace '${id}' not found` }, 404)
    }

    const worktreePath = path.join(workspace.projectPath, '.worktrees', workspace.workingBranch)
    const files = gitOps.getChangedFiles(worktreePath, workspace.sourceBranch)
    return c.json({
      files,
      sourceBranch: workspace.sourceBranch,
      workingBranch: workspace.workingBranch,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 500)
  }
})

// GET /api/workspaces/:id/diff/:filePath — get original and modified content for a file
app.get('/:id/diff-file', (c) => {
  try {
    const id = c.req.param('id')
    const filePath = c.req.query('path')
    if (!filePath) {
      return c.json({ error: 'Missing path query parameter' }, 400)
    }

    const workspace = workspaceService.getWorkspace(id)
    if (!workspace) {
      return c.json({ error: `Workspace '${id}' not found` }, 404)
    }

    const worktreePath = path.join(workspace.projectPath, '.worktrees', workspace.workingBranch)
    const original = gitOps.getFileAtRef(worktreePath, workspace.sourceBranch, filePath)
    const modified = gitOps.getFileContent(worktreePath, filePath)

    return c.json({ original: original ?? '', modified: modified ?? '', filePath })
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
app.post('/:id/stop', (c) => {
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

export default app
