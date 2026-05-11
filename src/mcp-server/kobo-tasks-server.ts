#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type Database from 'better-sqlite3'
import { getDb } from '../server/db/index.js'
import { runMigrations } from '../server/db/migrations.js'
import {
  createTaskHandler,
  cronListHandler,
  deleteTaskHandler,
  getDevServerStatusHandler,
  getSessionUsageHandler,
  getSettingsHandler,
  getWorkspaceInfoHandler,
  listDocumentsHandler,
  listTasksHandler,
  listWorkspaceImagesHandler,
  logThoughtHandler,
  markAutoLoopReadyHandler,
  markTaskDoneHandler,
  readDocumentHandler,
  setWorkspaceAgentDescriptionHandler,
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
  // Use the shared `getDb` singleton so any service that calls `getDb()`
  // internally (e.g. cron-service.arm) hits the SAME connection as this
  // MCP server, against the SAME DB file. Without this bootstrap, the
  // singleton would resolve via getDbPath() → getKoboHome() → KOBO_HOME
  // env var, which the agent SDK does NOT pass to the MCP server (only
  // KOBO_DB_PATH is passed). That would silently open a second connection
  // against the user's prod DB at ~/.config/kobo/kobo.db, which may not
  // even have the same schema as the dev DB the backend is using.
  db = getDb(dbPath)
  // Defensive: run migrations to ensure the schema is at the latest version.
  // The backend already ran them at boot, but this MCP server might be the
  // first to touch the DB (e.g. tests, race at first boot, or KOBO_DB_PATH
  // pointing somewhere the backend hasn't migrated). Idempotent — no-op if
  // the DB is already at SCHEMA_VERSION.
  runMigrations(db)
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

/**
 * Fire-and-forget POST that lands on `/auto-loop-ready`, which itself emits
 * the `autoloop:ready-flipped` WS event so the frontend's toggle unlocks
 * immediately after the grooming session completes. The handler already
 * flipped the DB flag; this call is ONLY for the event emission + the
 * (harmless) idempotent second write.
 */
async function notifyAutoLoopReady(): Promise<void> {
  try {
    const url = `${backendUrl}/api/workspaces/${workspaceId}/auto-loop-ready`
    await fetch(url, { method: 'POST' })
  } catch (err) {
    console.error('[kobo-tasks-server] notify-autoloop-ready failed:', err)
  }
}

/**
 * Fire-and-forget POST that lands on `/agent-description/notify-updated`,
 * which emits the `workspace:agent-description-updated` WS event so the
 * sidebar fallback display + the workspace header italic line refresh live
 * across every connected client. The handler already wrote the column to DB;
 * this call is ONLY for the event emission.
 */
async function notifyAgentDescriptionUpdated(): Promise<void> {
  try {
    const url = `${backendUrl}/api/workspaces/${workspaceId}/agent-description/notify-updated`
    await fetch(url, { method: 'POST' })
  } catch (err) {
    console.error('[kobo-tasks-server] notify-agent-description-updated failed:', err)
  }
}

/** Generic HTTP request to the Kobo backend, returning parsed JSON or null. */
async function backendRequest(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  pathname: string,
  body?: unknown,
): Promise<unknown> {
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
        'CALL FIRST on any non-trivial turn to know what the user wants done and what is already completed. Returns every task and acceptance criterion for the current workspace with its id and status. Re-call periodically (before marking something done, or after the user asks for a status) to stay in sync with user-added or external updates.',
      inputSchema: { type: 'object', properties: {}, required: [] },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
      name: 'mark_task_done',
      description:
        'CALL AS SOON AS a task or acceptance criterion is finished AND verified (tests pass, feature works, diff committed). Do not wait for the end of the turn — the user watches progress live and marking each item as it completes is the primary signal Kōbō uses to track you.',
      inputSchema: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: 'Task id from list_tasks.' },
        },
        required: ['task_id'],
      },
      annotations: { destructiveHint: false, openWorldHint: false },
    },
    {
      name: 'mark_auto_loop_ready',
      description:
        'CALL ONLY at the end of a `/kobo-prep-autoloop` grooming session, once all tasks look atomic and implementable in one session. Flips a flag on the workspace that unlocks the auto-loop toggle in the UI. Do NOT call during normal sessions.',
      inputSchema: { type: 'object', properties: {}, required: [] },
      annotations: { destructiveHint: false, openWorldHint: false },
    },
    {
      name: 'create_task',
      description:
        'CALL WHEN you discover follow-up work that was not in the original list and needs to stick around (e.g. "refactor this helper later", "add a test for edge case"). Appends at the end of the list. Do not use it for ephemeral internal notes — prefer log_thought for those.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short, imperative title (e.g. "Add retry to fetchUser").' },
          is_acceptance_criterion: {
            type: 'boolean',
            description: 'Mark as acceptance criterion rather than a task (default: false).',
          },
        },
        required: ['title'],
      },
      annotations: { destructiveHint: false, openWorldHint: false },
    },
    {
      name: 'update_task',
      description:
        'CALL WHEN you need to refine a task — rewording for clarity, flipping status to `in_progress` as you start it, or promoting a task to acceptance criterion. At least one mutable field is required.',
      inputSchema: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: 'Task id from list_tasks.' },
          title: { type: 'string', description: 'New title (optional).' },
          status: {
            type: 'string',
            enum: ['pending', 'in_progress', 'done'],
            description: 'New status (optional).',
          },
          is_acceptance_criterion: {
            type: 'boolean',
            description: 'Toggle acceptance criterion flag (optional).',
          },
        },
        required: ['task_id'],
      },
      annotations: { destructiveHint: false, openWorldHint: false },
    },
    {
      name: 'delete_task',
      description:
        'CALL ONLY when a task was created in error or became truly irrelevant (scope change validated by user). Prefer marking done or in_progress over deleting.',
      inputSchema: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: 'Task id from list_tasks.' },
        },
        required: ['task_id'],
      },
      annotations: { destructiveHint: false, openWorldHint: false },
    },
    {
      name: 'get_workspace_info',
      description:
        'CALL EARLY in a session to confirm project path, working/source branch, worktree path, model, and notion link. Cheap read — useful when the user refers to "this workspace" or when you need the worktree path to locate files.',
      inputSchema: { type: 'object', properties: {}, required: [] },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
      name: 'set_workspace_agent_description',
      description:
        "Set or clear the workspace's agent-side description (≤ 200 chars). Pass an empty string to clear. The user sees this string under the workspace title in the sidebar (it takes precedence over the user-controlled `description` field). Plain text only. The current value is available via get_workspace_info as agentDescription. NOTE: there is a separate user-controlled `description` field — do NOT try to write it; it has no MCP tool.",
      inputSchema: {
        type: 'object',
        properties: {
          description: {
            type: 'string',
            description: 'Plain text, max 200 characters. Empty string clears the description.',
          },
        },
        required: ['description'],
      },
      annotations: { destructiveHint: false, openWorldHint: false },
    },
    {
      name: 'cron_create',
      description:
        'Schedule a recurring trigger on THIS workspace. At each fire, Kōbō waits for the workspace to be idle (no active session) and then resumes the same conversation by injecting `prompt` as the next user message — same UX as `schedule_wakeup` but recurring. Skip-if-active: if a session is already running when the timer fires, that occurrence is skipped, the next occurrence is computed, and the cron continues. The cron persists across server restarts (skip-missed semantics on boot — no catchup spam). Delete with `cron_delete(id)`. Multiple crons per workspace are allowed.',
      inputSchema: {
        type: 'object',
        properties: {
          expression: {
            type: 'string',
            description:
              'Standard 5-field cron expression (`min hour dom month dow`) or one of the helpers `@hourly`, `@daily`, `@weekly`, `@monthly`, `@yearly`. Example: `*/30 * * * *` = every 30 minutes; `0 9 * * 1` = every Monday at 9am. Validated at create time.',
          },
          prompt: {
            type: 'string',
            description: 'The prompt to inject as the next user message at each fire.',
          },
          label: {
            type: 'string',
            description: 'Optional human-readable label for the cron (shown in the UI).',
          },
          mode: {
            type: 'string',
            enum: ['resume', 'fresh'],
            description:
              "How each fire is handled. 'resume' (default) pins the cron to the session you're calling from, so every fire continues THAT conversation by injecting `prompt` as the next user message — use this when the cron should follow up on ongoing work. 'fresh' starts a brand-new session at every fire with a clean context — use this for periodic checks (e.g. CI watch, daily standup) that don't need conversation continuity.",
          },
          oneShot: {
            type: 'boolean',
            description:
              "When true, the cron cancels itself after the first real fire (default false = recurring). Use this to schedule a single trigger at a specific cron-expressible time (e.g. `0 14 7 6 *` = next 7 June at 14:00) without it repeating yearly. Skip-active fires don't consume the one-shot — the cron retries at the next occurrence until it actually runs once.",
          },
        },
        required: ['expression', 'prompt'],
      },
      annotations: { destructiveHint: false, openWorldHint: false },
    },
    {
      name: 'cron_delete',
      description:
        "Cancel a previously-armed cron by id. Idempotent — returns ok=true even if the id is unknown. Only the workspace's own crons can be cancelled (cron_list to see them).",
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The cron id returned by cron_create.' },
        },
        required: ['id'],
      },
      annotations: { destructiveHint: false, openWorldHint: false },
    },
    {
      name: 'cron_list',
      description: 'List all crons currently armed on THIS workspace, including their next and last fire times.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
      name: 'get_git_info',
      description:
        'CALL BEFORE creating a PR, committing in batches, or reporting progress to the user. Returns commit count ahead of source, files changed, insertions/deletions, and existing PR URL if any.',
      inputSchema: { type: 'object', properties: {}, required: [] },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
      name: 'set_workspace_status',
      description:
        'CALL WHEN you believe the mission is done (`completed`), blocked beyond recovery (`error`), or explicitly idle awaiting user input (`idle`). Transitions are validated by the backend — invalid ones are rejected.',
      inputSchema: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: ['idle', 'completed', 'error'],
            description: 'Target status.',
          },
        },
        required: ['status'],
      },
      annotations: { destructiveHint: false, openWorldHint: false },
    },
    {
      name: 'get_notion_ticket',
      description:
        'CALL when the user references "the ticket", "the Notion page", or when you need the source-of-truth text for the mission. Returns the Notion URL + locally-extracted ticket content from .ai/thoughts/.',
      inputSchema: { type: 'object', properties: {}, required: [] },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
      name: 'get_dev_server_status',
      description:
        'CALL BEFORE asking the user whether the app is running, or when your change is dev-server-sensitive. Returns running/stopped/starting/error + URL, port, container names.',
      inputSchema: { type: 'object', properties: {}, required: [] },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
      name: 'start_dev_server',
      description: 'CALL WHEN the user asks you to test the running app and the dev server is stopped.',
      inputSchema: { type: 'object', properties: {}, required: [] },
      annotations: { destructiveHint: false, openWorldHint: false },
    },
    {
      name: 'stop_dev_server',
      description:
        'CALL WHEN the user explicitly asks to stop the dev server, or before destructive operations that require a clean boot.',
      inputSchema: { type: 'object', properties: {}, required: [] },
      annotations: { destructiveHint: false, openWorldHint: false },
    },
    {
      name: 'get_dev_server_logs',
      description:
        'CALL WHEN debugging a runtime issue the user describes as happening in the running app. Returns the last N lines of logs (default 200). Cheaper than asking the user to paste them.',
      inputSchema: {
        type: 'object',
        properties: {
          tail: { type: 'number', description: 'Number of lines from the end (default: 200).' },
        },
        required: [],
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
      name: 'list_workspace_images',
      description:
        'CALL WHEN the user mentions "the screenshot", "the attached image", or when you need to reference a previously-uploaded image. Returns uid, originalName, relativePath, createdAt for every image in .ai/images/.',
      inputSchema: { type: 'object', properties: {}, required: [] },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
      name: 'get_settings',
      description:
        'CALL WHEN you need to confirm configured models, PR prompt templates, git conventions, or dev-server commands before acting on them. Pass project_path to merge global + project-specific entries.',
      inputSchema: {
        type: 'object',
        properties: {
          project_path: {
            type: 'string',
            description: 'Project path to resolve a specific project entry (optional).',
          },
        },
        required: [],
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    // ── Knowledge / context tools ─────────────────────────────────────────────
    {
      name: 'list_documents',
      description:
        'CALL EARLY on a new session to discover plans, specs, and thoughts previously written for this workspace. Recursively lists every .md under docs/plans/, docs/superpowers/, and .ai/thoughts/. Before writing a new plan, check if one already exists.',
      inputSchema: { type: 'object', properties: {}, required: [] },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
      name: 'read_document',
      description:
        'CALL AFTER list_documents when a file title looks relevant to the current task. Returns the full markdown content. Scoped to docs/plans/, docs/superpowers/, .ai/thoughts/ — reject anything else.',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description:
              'Worktree-relative path from list_documents (e.g. "docs/superpowers/plans/2026-04-17-foo.md").',
          },
        },
        required: ['path'],
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
      name: 'log_thought',
      description:
        'CALL WHEN you make a decision worth remembering — architecture choice, trade-off taken, dead-end avoided, pattern discovered. Appends a dated markdown file to .ai/thoughts/. Keep entries short and focused; one decision per call. Use create_task for actionable follow-ups instead.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short, descriptive title (becomes the filename slug and the # H1).' },
          content: { type: 'string', description: 'Markdown body explaining the decision and its reasoning.' },
          tag: {
            type: 'string',
            description: 'Optional short tag appended to filename (e.g. "arch", "bug", "perf").',
          },
        },
        required: ['title', 'content'],
      },
      annotations: { destructiveHint: false, openWorldHint: false },
    },
    {
      name: 'search_codebase',
      description:
        'CALL WHEN you need to recall prior chat history across workspaces — past decisions, prior user requests, an agent message you remember but can’t locate. Full-text search over user messages + agent outputs persisted in Kōbō. Use the local Grep tool for searching source code; this tool searches CONVERSATIONS.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search phrase. Plain text; no regex.' },
          include_archived: {
            type: 'boolean',
            description: 'Include archived workspaces in the search (default: false).',
          },
          scope: {
            type: 'string',
            enum: ['workspace', 'all'],
            description: 'Restrict to this workspace only (default) or search across every workspace.',
          },
          limit: { type: 'number', description: 'Max results to return (default 30, max 100).' },
        },
        required: ['query'],
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
      name: 'get_session_usage',
      description:
        'CALL when you need to self-regulate on long missions — returns token/cost totals for the workspace lifetime and for the currently running agent_session. Useful before spawning heavy subagents or deep reasoning on already-expensive sessions.',
      inputSchema: { type: 'object', properties: {}, required: [] },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
      name: 'schedule_wakeup',
      description:
        'CALL to schedule a follow-up turn on THIS workspace after a delay. End the current turn normally; once it finishes and the workspace is idle, Kōbō waits `delaySeconds`, then resumes the same conversation by injecting `prompt` as the next user message. The wakeup is scoped to the current workspace and resumes its latest session — you cannot target another workspace or another session. If a turn is still active when the timer fires, the wakeup is skipped (status: `session-active`). Replaces any previously pending wakeup on this workspace. Delay is clamped to [60, 21600] seconds (1min to 6h). Prefer this over the built-in `ScheduleWakeup` tool — it is the SDK-supported entry point.',
      inputSchema: {
        type: 'object',
        properties: {
          delaySeconds: {
            type: 'number',
            description: 'Seconds from now until the wakeup fires. Clamped to [60, 21600] (1min to 6h).',
          },
          prompt: {
            type: 'string',
            description: 'Prompt sent to the agent when the wakeup fires.',
          },
          reason: {
            type: 'string',
            description: 'Short label shown to the user explaining the wakeup (optional).',
          },
        },
        required: ['delaySeconds', 'prompt'],
      },
      annotations: { destructiveHint: false, openWorldHint: false },
    },
    {
      name: 'cancel_wakeup',
      description:
        'CALL to cancel any pending wakeup on this workspace (e.g. the condition you were waiting on resolved early, or you decided not to continue). Idempotent — safe to call when nothing is pending.',
      inputSchema: { type: 'object', properties: {}, required: [] },
      annotations: { destructiveHint: false, openWorldHint: false },
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

    if (name === 'mark_auto_loop_ready') {
      const result = markAutoLoopReadyHandler(db, workspaceId!)
      void notifyAutoLoopReady()
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

    if (name === 'set_workspace_agent_description') {
      const description = a.description as string | undefined
      if (typeof description !== 'string') return fail('description parameter is required')
      const result = setWorkspaceAgentDescriptionHandler(db, workspaceId!, { description })
      if ('ok' in result && result.ok) {
        void notifyAgentDescriptionUpdated()
      }
      return ok(result)
    }

    if (name === 'cron_create') {
      const expression = a.expression as string | undefined
      const prompt = a.prompt as string | undefined
      const label = typeof a.label === 'string' ? (a.label as string) : undefined
      const mode = typeof a.mode === 'string' ? (a.mode as string) : undefined
      const oneShot = typeof a.oneShot === 'boolean' ? (a.oneShot as boolean) : undefined
      if (typeof expression !== 'string' || typeof prompt !== 'string') {
        return fail('expression and prompt parameters are required')
      }
      if (mode !== undefined && mode !== 'resume' && mode !== 'fresh') {
        return fail("mode must be 'resume' or 'fresh'")
      }
      // Route through the backend so the in-memory `setTimeout` lives in the
      // backend process (which owns orchestrator + WS broadcast). Calling
      // cron-service.arm() directly here would persist the row but arm the
      // timer in the MCP server sub-process, which dies with the agent
      // session — fires would never trigger a real session resume.
      try {
        const created = (await backendRequest('POST', `/api/workspaces/${workspaceId}/crons`, {
          expression,
          prompt,
          label,
          mode,
          oneShot,
        })) as { cron: unknown }
        return ok({ ok: true, cron: created.cron })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return ok({ ok: false, error: message })
      }
    }

    if (name === 'cron_delete') {
      const id = a.id as string | undefined
      if (typeof id !== 'string') return fail('id parameter is required')
      // Same reason as cron_create — the backend owns the timer Map.
      try {
        await backendRequest('DELETE', `/api/workspaces/${workspaceId}/crons/${id}`)
        return ok({ ok: true })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return ok({ ok: false, error: message })
      }
    }

    if (name === 'cron_list') {
      const result = cronListHandler(db, workspaceId!)
      return ok(result)
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

    if (name === 'get_notion_ticket') {
      const info = getWorkspaceInfoHandler(db, workspaceId!)
      const thoughtsDir = path.join(info.worktreePath, '.ai', 'thoughts')
      let ticketContent = ''
      if (fs.existsSync(thoughtsDir)) {
        const files = fs.readdirSync(thoughtsDir).filter((f) => f.endsWith('.md'))
        for (const file of files) {
          ticketContent += `${fs.readFileSync(path.join(thoughtsDir, file), 'utf-8')}\n`
        }
      }
      return ok({
        notionUrl: info.notionUrl,
        notionPageId: info.notionPageId,
        ticketContent: ticketContent.trim() || null,
      })
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

    if (name === 'list_documents') {
      const info = getWorkspaceInfoHandler(db, workspaceId!)
      return ok(listDocumentsHandler(info.worktreePath))
    }

    if (name === 'read_document') {
      const docPath = a.path as string | undefined
      if (!docPath) return fail('path parameter is required')
      const info = getWorkspaceInfoHandler(db, workspaceId!)
      return ok(readDocumentHandler(info.worktreePath, docPath))
    }

    if (name === 'log_thought') {
      const title = a.title as string | undefined
      const content = a.content as string | undefined
      if (!title) return fail('title parameter is required')
      if (!content) return fail('content parameter is required')
      const info = getWorkspaceInfoHandler(db, workspaceId!)
      return ok(
        logThoughtHandler(info.worktreePath, {
          title,
          content,
          tag: a.tag as string | undefined,
        }),
      )
    }

    if (name === 'get_session_usage') {
      return ok(getSessionUsageHandler(db, workspaceId!))
    }

    if (name === 'schedule_wakeup') {
      const delaySeconds = a.delaySeconds
      const prompt = a.prompt
      if (typeof delaySeconds !== 'number' || !Number.isFinite(delaySeconds) || delaySeconds <= 0) {
        return fail('delaySeconds must be a positive number')
      }
      if (typeof prompt !== 'string' || prompt.trim().length === 0) {
        return fail('prompt is required')
      }
      const reason = a.reason
      if (reason !== undefined && typeof reason !== 'string') {
        return fail('reason must be a string when provided')
      }
      const result = await backendRequest('POST', `/api/workspaces/${workspaceId}/pending-wakeup`, {
        delaySeconds,
        prompt,
        reason,
      })
      return ok(result)
    }

    if (name === 'cancel_wakeup') {
      const result = await backendRequest('DELETE', `/api/workspaces/${workspaceId}/pending-wakeup`)
      return ok(result)
    }

    if (name === 'search_codebase') {
      const query = a.query as string | undefined
      if (!query) return fail('query parameter is required')
      const scope = (a.scope as string | undefined) ?? 'workspace'
      const includeArchived = a.include_archived === true
      const limit = Math.min(Math.max(1, (a.limit as number | undefined) ?? 30), 100)
      const qs = new URLSearchParams({ q: query, limit: String(limit) })
      if (includeArchived) qs.set('includeArchived', 'true')
      const raw = (await backendRequest('GET', `/api/search?${qs.toString()}`)) as Array<Record<string, unknown>>
      const results = scope === 'all' ? raw : raw.filter((r) => r.workspaceId === workspaceId)
      return ok({ query, scope, total: results.length, results })
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
