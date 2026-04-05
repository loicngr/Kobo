import { execFileSync } from 'node:child_process'
import { Hono } from 'hono'
import * as agentManager from '../services/agent-manager.js'
import * as devServerService from '../services/dev-server-service.js'
import * as notionService from '../services/notion-service.js'
import * as settingsService from '../services/settings-service.js'
import * as wsService from '../services/websocket-service.js'
import type { WorkspaceStatus } from '../services/workspace-service.js'
import * as workspaceService from '../services/workspace-service.js'
import * as worktreeService from '../services/worktree-service.js'
import * as gitOps from '../utils/git-ops.js'

const app = new Hono()

// GET /api/workspaces — list all workspaces
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
    }>()

    if (!body.name || !body.projectPath || !body.sourceBranch || !body.workingBranch) {
      return c.json({ error: 'Missing required fields: name, projectPath, sourceBranch, workingBranch' }, 400)
    }

    // 1. Create workspace
    let workspace = workspaceService.createWorkspace({
      name: body.name,
      projectPath: body.projectPath,
      sourceBranch: body.sourceBranch,
      workingBranch: body.workingBranch,
      notionUrl: body.notionUrl,
      notionPageId: body.notionPageId,
      model: body.model,
    })

    let notionContent: notionService.NotionPageContent | null = null

    // 2. If notionUrl provided, extract Notion page
    if (body.notionUrl) {
      workspaceService.updateWorkspaceStatus(workspace.id, 'extracting')

      try {
        notionContent = await notionService.extractNotionPage(body.notionUrl)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.error(`[workspaces] Failed to extract Notion page: ${message}`)
      }
    }

    // 3. Create tasks from extracted data
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

    // 4. Create worktree
    let worktreePath: string
    try {
      worktreePath = worktreeService.createWorktree(body.projectPath, body.workingBranch, body.sourceBranch)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      workspaceService.updateWorkspaceStatus(workspace.id, 'error')
      return c.json({ error: `Failed to create worktree: ${message}` }, 500)
    }

    // 4b. Write git conventions to the worktree if configured
    const effectiveSettings = settingsService.getEffectiveSettings(body.projectPath)
    if (effectiveSettings.gitConventions) {
      try {
        const fs = await import('node:fs')
        const path = await import('node:path')
        const aiDir = path.default.join(worktreePath, '.ai')
        fs.mkdirSync(aiDir, { recursive: true })
        const conventionsPath = path.default.join(aiDir, 'git-conventions.md')
        fs.writeFileSync(conventionsPath, effectiveSettings.gitConventions, 'utf-8')
      } catch (err) {
        console.error('[workspaces] Failed to write git-conventions.md:', err)
      }
    }

    // 5. Save Notion content as markdown in worktree
    let notionFilePath: string | null = null
    if (notionContent && body.notionUrl) {
      try {
        const fs = await import('node:fs')
        const path = await import('node:path')
        const thoughtsDir = path.default.join(worktreePath, '.ai', 'thoughts')
        fs.mkdirSync(thoughtsDir, { recursive: true })

        // Derive filename from title (TK-XXX pattern or slug)
        const tkMatch = workspace.name.match(/TK-\d+/i)
        const filename = tkMatch
          ? `${tkMatch[0]}.md`
          : `PAGE-${notionService.parseNotionUrl(body.notionUrl).replace(/-/g, '')}.md`
        notionFilePath = path.default.join(thoughtsDir, filename)

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

    // 6. Update workspace status to 'brainstorming'
    workspaceService.updateWorkspaceStatus(workspace.id, 'brainstorming')

    // 6. Build prompt with tasks and acceptance criteria
    const allTasks = workspaceService.listTasks(workspace.id)
    const todos = allTasks.filter((t) => !t.isAcceptanceCriterion)
    const criteria = allTasks.filter((t) => t.isAcceptanceCriterion)

    let brainstormPrompt = `You are working on: ${workspace.name}\n`

    if (notionContent?.goal) {
      brainstormPrompt += `\nGoal: ${notionContent.goal}\n`
    }

    brainstormPrompt += `\nBranch: ${body.workingBranch}\n`

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

    if (criteria.length > 0 || todos.length > 0) {
      brainstormPrompt += `\nYou have access to MCP tools via the 'kobo-tasks' server:\n`
      brainstormPrompt += `- list_tasks() — list all tasks and criteria with their IDs and current status\n`
      brainstormPrompt += `- mark_task_done(task_id) — mark a task or criterion as done\n`
      brainstormPrompt += `\nAs you implement the work and validate each criterion, call mark_task_done with the corresponding task_id. Call list_tasks first to see the current IDs.\n`
    }

    if (effectiveSettings.gitConventions) {
      brainstormPrompt += `\n# Git conventions\nIMPORTANT: Before any git operation (commit, branch, rebase, merge, push), read and apply the conventions defined in \`.ai/git-conventions.md\`. They are project-specific and override any default behavior. Re-read this file if you're unsure or if context was compacted.\n`
    }

    brainstormPrompt += `\nIMPORTANT: Start by reading CLAUDE.md and/or AGENTS.md at the project root if they exist — they contain project conventions and instructions you must follow.`
    brainstormPrompt += `\n\nThen brainstorm the implementation approach. Explore the codebase to understand the existing structure. Ask clarifying questions if needed. When you're done brainstorming and have a clear plan, create a plan file and proceed with implementation. Once you have completed the brainstorming phase, output [BRAINSTORM_COMPLETE] on its own line.`

    // Persist the initial prompt in the feed so it's visible in the chat
    const { emit } = await import('../services/websocket-service.js')
    emit(workspace.id, 'user:message', { content: brainstormPrompt, sender: 'system-prompt' })

    try {
      agentManager.startAgent(workspace.id, worktreePath, brainstormPrompt, workspace.model)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[workspaces] Failed to start agent: ${message}`)
      try {
        workspaceService.updateWorkspaceStatus(workspace.id, 'error')
      } catch {
        /* already logged */
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

// POST /api/workspaces/:id/refresh-notion — re-extract Notion page and update tasks
app.post('/:id/refresh-notion', async (c) => {
  try {
    const id = c.req.param('id')
    const workspace = workspaceService.getWorkspace(id)
    if (!workspace) return c.json({ error: `Workspace '${id}' not found` }, 404)
    if (!workspace.notionUrl) return c.json({ error: 'No Notion URL configured' }, 400)

    const notionContent = await notionService.extractNotionPage(workspace.notionUrl)

    // Delete existing tasks and recreate from Notion
    const db = (await import('../db/index.js')).getDb()
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
    const taskId = c.req.param('taskId')
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
    workspaceService.deleteTask(taskId)
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

// PATCH /api/workspaces/:id — update workspace status
app.patch('/:id', async (c) => {
  try {
    const id = c.req.param('id')
    const body = await c.req.json<{ status: WorkspaceStatus }>()

    if (!body.status) {
      return c.json({ error: 'Missing required field: status' }, 400)
    }

    const workspace = workspaceService.getWorkspace(id)
    if (!workspace) {
      return c.json({ error: `Workspace '${id}' not found` }, 404)
    }

    const updated = workspaceService.updateWorkspaceStatus(id, body.status)
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

    // 1. Stop agent if running
    try {
      agentManager.stopAgent(id)
    } catch {
      // Agent may not be running — ignore
    }

    // 2. Remove worktree
    const worktreesDir = `${workspace.projectPath}/.worktrees`
    const worktreePath = `${worktreesDir}/${workspace.workingBranch}`
    try {
      worktreeService.removeWorktree(workspace.projectPath, worktreePath)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[workspaces] Failed to remove worktree: ${message}`)
    }

    // 3. Delete local branch if requested
    if (body.deleteLocalBranch) {
      try {
        gitOps.deleteLocalBranch(workspace.projectPath, workspace.workingBranch)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.error(`[workspaces] Failed to delete local branch: ${message}`)
      }
    }

    // 4. Delete remote branch if requested
    if (body.deleteRemoteBranch) {
      try {
        gitOps.deleteRemoteBranch(workspace.projectPath, workspace.workingBranch)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.error(`[workspaces] Failed to delete remote branch: ${message}`)
      }
    }

    // 5. Delete workspace from DB
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

    const body = await c.req.json<{ prompt?: string }>().catch(() => ({ prompt: undefined }))
    const prompt = body.prompt ?? 'Continue the previous task where you left off.'

    // Stop existing agent if running
    try {
      agentManager.stopAgent(id)
    } catch {
      // Agent may not be running — ignore
    }

    const worktreePath = `${workspace.projectPath}/.worktrees/${workspace.workingBranch}`

    agentManager.startAgent(id, worktreePath, prompt, workspace.model)
    workspaceService.updateWorkspaceStatus(id, 'executing')

    return c.json({ status: 'started' })
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

    const path = await import('node:path')
    const worktreePath = path.default.join(workspace.projectPath, '.worktrees', workspace.workingBranch)

    try {
      gitOps.pushBranch(worktreePath, workspace.workingBranch)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return c.json({ error: message }, 500)
    }

    // Emit a trace into the chat feed so the user sees the action
    const { emit } = await import('../services/websocket-service.js')
    const session = workspaceService.getLatestSession(id)
    const sessionId = session?.claudeSessionId ?? undefined
    emit(
      id,
      'user:message',
      { content: `Pushed branch ${workspace.workingBranch} to origin`, sender: 'system-prompt' },
      sessionId,
    )

    return c.json({ ok: true, branch: workspace.workingBranch })
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

    const path = await import('node:path')
    const worktreePath = path.default.join(workspace.projectPath, '.worktrees', workspace.workingBranch)

    // 1. Check branch is on remote
    let lsRemoteOut = ''
    try {
      const result = execFileSync('git', ['ls-remote', '--heads', 'origin', workspace.workingBranch], {
        cwd: worktreePath,
      })
      lsRemoteOut = result.toString()
    } catch {
      lsRemoteOut = ''
    }
    if (!lsRemoteOut.trim()) {
      return c.json({ error: 'Branch is not on remote', code: 'branch_not_pushed' }, 409)
    }

    // 2. Check all local commits are pushed
    try {
      const result = execFileSync('git', ['rev-list', '@{u}..HEAD', '--count'], { cwd: worktreePath })
      const countStr = result.toString().trim()
      const count = parseInt(countStr, 10) || 0
      if (count > 0) {
        return c.json({ error: 'Local commits not pushed', code: 'unpushed_commits' }, 409)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const stderr = (err as { stderr?: Buffer }).stderr?.toString() ?? ''
      const combined = `${message} ${stderr}`.toLowerCase()
      if (combined.includes('no upstream') || combined.includes('aucun amont') || combined.includes('no such ref')) {
        return c.json({ error: 'Branch has no upstream', code: 'branch_not_pushed' }, 409)
      }
      return c.json({ error: `Failed to check branch state: ${message}` }, 500)
    }

    // 3. Create PR via gh
    let ghOutput: string
    try {
      const placeholderBody = 'Automated PR — description will be updated by the agent.'
      const result = execFileSync(
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
      ghOutput = result.toString()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const stderr = (err as { stderr?: Buffer }).stderr?.toString() ?? ''
      return c.json({ error: `gh pr create failed: ${message} ${stderr}`.trim() }, 500)
    }

    // 4. Parse PR URL and number
    const urlMatch = ghOutput.match(/https:\/\/github\.com\/[^\s]+\/pull\/(\d+)/)
    if (!urlMatch) {
      return c.json({ error: 'Could not parse PR URL from gh output' }, 500)
    }
    const prUrl = urlMatch[0]
    const prNumber = parseInt(urlMatch[1], 10)

    // ── From here on, PR exists. No more 5xx responses. ──

    // 5. Resolve the template; skip message steps if empty
    const effective = settingsService.getEffectiveSettings(workspace.projectPath)
    if (!effective.prPromptTemplate) {
      return c.json({ ok: true, prNumber, prUrl, messageSent: false })
    }

    // 6. Build context and render the template
    const { renderPrTemplate } = await import('../services/pr-template-service.js')
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

    // 7. Emit user:message into the chat feed
    const { emit } = await import('../services/websocket-service.js')
    const session = workspaceService.getLatestSession(workspace.id)
    const sessionId = session?.claudeSessionId ?? undefined
    emit(workspace.id, 'user:message', { content: rendered, sender: 'user' }, sessionId)

    // 8. Send to the running agent (degrade on failure)
    try {
      agentManager.sendMessage(workspace.id, rendered)
      return c.json({ ok: true, prNumber, prUrl, messageSent: true })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.warn(`[workspaces] open-pr: PR created but sendMessage failed: ${message}`)
      return c.json({
        ok: true,
        prNumber,
        prUrl,
        messageSent: false,
        warning: `Agent is not active — message was not sent (${message})`,
      })
    }
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
