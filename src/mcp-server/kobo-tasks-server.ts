#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import Database from 'better-sqlite3'
import { listTasksHandler, markTaskDoneHandler } from './kobo-tasks-handlers.js'

const workspaceId = process.env.KOBO_WORKSPACE_ID
const dbPath = process.env.KOBO_DB_PATH
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
  db.pragma('foreign_keys = ON')
} catch (err) {
  console.error('[kobo-tasks-server] Failed to open database:', err)
  process.exit(1)
}

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

const server = new Server({ name: 'kobo-tasks', version: '1.0.0' }, { capabilities: { tools: {} } })

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'list_tasks',
      description:
        'List all tasks and acceptance criteria for the current workspace with their IDs and current status. Call this first to discover task IDs before calling mark_task_done.',
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
  ],
}))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params

  if (name === 'list_tasks') {
    const tasks = listTasksHandler(db, workspaceId!)
    return {
      content: [{ type: 'text', text: JSON.stringify(tasks, null, 2) }],
    }
  }

  if (name === 'mark_task_done') {
    const taskId = (args as { task_id?: string })?.task_id
    if (!taskId) {
      return {
        content: [{ type: 'text', text: 'Error: task_id parameter is required' }],
        isError: true,
      }
    }
    try {
      const result = markTaskDoneHandler(db, workspaceId!, taskId)
      void notifyBackend(taskId)
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return {
        content: [{ type: 'text', text: `Error: ${message}` }],
        isError: true,
      }
    }
  }

  return {
    content: [{ type: 'text', text: `Unknown tool: ${name}` }],
    isError: true,
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
