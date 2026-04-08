#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import Database from 'better-sqlite3'
import {
  createTaskHandler,
  deleteTaskHandler,
  getDevServerStatusHandler,
  getSettingsHandler,
  getWorkspaceInfoHandler,
  listTasksHandler,
  listWorkspaceImagesHandler,
  markTaskDoneHandler,
  updateTaskHandler,
} from './kobo-tasks-handlers.js'

const workspaceId = process.env.KOBO_WORKSPACE_ID
const dbPath = process.env.KOBO_DB_PATH
const settingsPath = process.env.KOBO_SETTINGS_PATH
const backendUrl = process.env.KOBO_BACKEND_URL ?? 'http://localhost:3000'

if (!workspaceId) {
  console.error('[kobo-tasks-server] KOBO_WORKSPACE_ID env var is required')
  process.exit(1)
}

if (!dbPath) {
  console.error('[kobo-tasks-server] KOBO_DB_PATH env var is required')
  process.exit(1)
}

let db: Database.Database
try {
  db = new Database(dbPath, { readonly: false })
  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 5000')
  db.pragma('foreign_keys = ON')
} catch (err) {
  console.error('[kobo-tasks-server] Failed to open database:', err)
  process.exit(1)
}

/** Fire-and-forget POST to the backend so the UI reflects a task marked as done. */
async function notifyBackend(taskId: string): Promise<void> {
  try {
    const url = `${backendUrl}/api/workspaces/${workspaceId}/tasks/${taskId}/notify-done`
    const res = await fetch(url, { method: 'POST' })
    if (!res.ok) {
      console.error(`[kobo-tasks-server] notify-done HTTP ${res.status}`)
    }
  } catch (err) {
    console.error('[kobo-tasks-server] notify-done failed:', err)
  }
}

/** Fire-and-forget POST to the backend so the UI refreshes the task list after a mutation. */
async function notifyTasksUpdated(): Promise<void> {
  try {
    const url = `${backendUrl}/api/workspaces/${workspaceId}/tasks/notify-updated`
    await fetch(url, { method: 'POST' })
  } catch (err) {
    console.error('[kobo-tasks-server] notify-updated failed:', err)
  }
}

/** Generic HTTP request to the Kobo backend, returning parsed JSON or null. */
async function backendRequest(method: 'GET' | 'POST' | 'PATCH', pathname: string, body?: unknown): Promise<unknown> {
  const url = `${backendUrl}${pathname}`
  const init: RequestInit = { method }
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' }
    init.body = JSON.stringify(body)
  }
  const res = await fetch(url, init)
  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    throw new Error(`Backend ${method} ${pathname} returned ${res.status}: ${errText}`)
  }
  const text = await res.text()
  return text ? JSON.parse(text) : null
}

const server = new Server({ name: 'kobo-tasks', version: '1.0.0' }, { capabilities: { tools: {} } })

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'list_tasks',
      description:
        'List all tasks and acceptance criteria for the current workspace with their IDs and current status. Call this first to discover task IDs before calling mark_task_done / update_task / delete_task.',
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
    {
      name: 'mark_task_done',
      description:
        'Mark a task or acceptance criterion as done. Use this when you have completed the work for a criterion and validated it.',
      inputSchema: {
        type: 'object',
        properties: {
          task_id: {
            type: 'string',
            description: 'The ID of the task to mark as done (obtained from list_tasks)',
          },
        },
        required: ['task_id'],
      },
    },
    {
      name: 'create_task',
      description:
        'Create a new task or acceptance criterion for the current workspace. Appended at the end of the list.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Task title' },
          is_acceptance_criterion: {
            type: 'boolean',
            description: 'Whether this is an acceptance criterion (default: false)',
          },
        },
        required: ['title'],
      },
    },
    {
      name: 'update_task',
      description:
        'Update an existing task — change title, status, or is_acceptance_criterion flag. At least one field is required.',
      inputSchema: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: 'The ID of the task to update' },
          title: { type: 'string', description: 'New title (optional)' },
          status: {
            type: 'string',
            enum: ['pending', 'in_progress', 'done'],
            description: 'New status (optional)',
          },
          is_acceptance_criterion: {
            type: 'boolean',
            description: 'Toggle acceptance criterion flag (optional)',
          },
        },
        required: ['task_id'],
      },
    },
    {
      name: 'delete_task',
      description: 'Delete a task from the current workspace permanently.',
      inputSchema: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: 'The ID of the task to delete' },
        },
        required: ['task_id'],
      },
    },
    {
      name: 'get_settings',
      description:
        'Read Kōbō settings (global + projects). Optionally filter to a specific project by path to get both global and that project override.',
      inputSchema: {
        type: 'object',
        properties: {
          project_path: {
            type: 'string',
            description: 'Optional project path to resolve a specific project entry',
          },
        },
        required: [],
      },
    },
    {
      name: 'get_dev_server_status',
      description:
        'Get the live dev server status for the current workspace. Returns status (running/stopped/starting/error/unknown), URL, HTTP port, instance name, project name, and running container names.',
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
    {
      name: 'get_workspace_info',
      description:
        'Get all metadata about the current workspace (name, project path, branches, model, notion URL, worktree path, status).',
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'start_dev_server',
      description: 'Start the dev server configured for the current workspace.',
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'stop_dev_server',
      description: 'Stop the dev server of the current workspace.',
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'get_dev_server_logs',
      description: 'Fetch the last N lines of the dev server logs for the current workspace.',
      inputSchema: {
        type: 'object',
        properties: {
          tail: {
            type: 'number',
            description: 'Number of lines to fetch from the end (default: 200)',
          },
        },
        required: [],
      },
    },
    {
      name: 'list_workspace_images',
      description:
        'List all images uploaded to the current workspace (from .ai/images/index.json). Returns uid, originalName, relativePath and createdAt for each image.',
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'get_git_info',
      description:
        'Get git stats for the current workspace (commit count, files changed, insertions, deletions, PR URL if any).',
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'set_workspace_status',
      description:
        'Update the current workspace status. Valid values: idle, completed, error. Transitions are validated by the backend.',
      inputSchema: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: ['idle', 'completed', 'error'],
            description: 'New status (e.g. idle, completed)',
          },
        },
        required: ['status'],
      },
    },
  ],
}))

/** Wrap a successful result as an MCP tool response with JSON text content. */
function ok(data: unknown) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
}

/** Wrap an error message as an MCP tool error response. */
function fail(message: string) {
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true }
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params
  const a = (args ?? {}) as Record<string, unknown>

  try {
    if (name === 'list_tasks') {
      return ok(listTasksHandler(db, workspaceId!))
    }

    if (name === 'mark_task_done') {
      const taskId = a.task_id as string | undefined
      if (!taskId) return fail('task_id parameter is required')
      const result = markTaskDoneHandler(db, workspaceId!, taskId)
      void notifyBackend(taskId)
      return ok(result)
    }

    if (name === 'create_task') {
      const title = a.title as string | undefined
      if (!title) return fail('title parameter is required')
      const task = createTaskHandler(db, workspaceId!, {
        title,
        is_acceptance_criterion: a.is_acceptance_criterion as boolean | undefined,
      })
      void notifyTasksUpdated()
      return ok(task)
    }

    if (name === 'update_task') {
      const taskId = a.task_id as string | undefined
      if (!taskId) return fail('task_id parameter is required')
      const task = updateTaskHandler(db, workspaceId!, taskId, {
        title: a.title as string | undefined,
        status: a.status as string | undefined,
        is_acceptance_criterion: a.is_acceptance_criterion as boolean | undefined,
      })
      void notifyTasksUpdated()
      return ok(task)
    }

    if (name === 'delete_task') {
      const taskId = a.task_id as string | undefined
      if (!taskId) return fail('task_id parameter is required')
      const result = deleteTaskHandler(db, workspaceId!, taskId)
      void notifyTasksUpdated()
      return ok(result)
    }

    if (name === 'get_settings') {
      return ok(getSettingsHandler(settingsPath, a.project_path as string | undefined))
    }

    if (name === 'get_dev_server_status') {
      try {
        const result = await backendRequest('GET', `/api/dev-server/${workspaceId}/status`)
        return ok(result)
      } catch {
        // Fallback to DB if the backend HTTP API is unreachable
        return ok(getDevServerStatusHandler(db, workspaceId!))
      }
    }

    if (name === 'get_workspace_info') {
      return ok(getWorkspaceInfoHandler(db, workspaceId!))
    }

    if (name === 'start_dev_server') {
      const result = await backendRequest('POST', `/api/dev-server/${workspaceId}/start`)
      return ok(result)
    }

    if (name === 'stop_dev_server') {
      const result = await backendRequest('POST', `/api/dev-server/${workspaceId}/stop`)
      return ok(result)
    }

    if (name === 'get_dev_server_logs') {
      const tail = (a.tail as number | undefined) ?? 200
      const result = await backendRequest('GET', `/api/dev-server/${workspaceId}/logs?tail=${tail}`)
      return ok(result)
    }

    if (name === 'list_workspace_images') {
      const info = getWorkspaceInfoHandler(db, workspaceId!)
      return ok(listWorkspaceImagesHandler(info.worktreePath))
    }

    if (name === 'get_git_info') {
      const result = await backendRequest('GET', `/api/workspaces/${workspaceId}/git-stats`)
      return ok(result)
    }

    if (name === 'set_workspace_status') {
      const status = a.status as string | undefined
      if (!status) return fail('status parameter is required')
      const result = await backendRequest('PATCH', `/api/workspaces/${workspaceId}`, { status })
      return ok(result)
    }

    return fail(`Unknown tool: ${name}`)
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err))
  }
})

const transport = new StdioServerTransport()
server.connect(transport).catch((err) => {
  console.error('[kobo-tasks-server] Fatal:', err)
  process.exit(1)
})

process.on('SIGTERM', () => {
  db.close()
  process.exit(0)
})
process.on('SIGINT', () => {
  db.close()
  process.exit(0)
})
