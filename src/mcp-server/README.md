# Kōbō Tasks MCP Server

Standalone MCP (Model Context Protocol) server spawned by Kōbō for each Claude Code agent running inside a workspace. Exposes workspace-scoped tools that the agent can invoke to interact with Kōbō state: tasks, settings, dev server, images, git, etc.

## How it runs

Kōbō's `agent-manager.ts` writes a `.mcp.json` file into each worktree and passes it to Claude Code via `--mcp-config`. Claude spawns this server as a child process with stdio transport and injects these environment variables:

| Env var | Purpose |
|---|---|
| `KOBO_WORKSPACE_ID` | ID of the current workspace — scopes all queries. **Required**. |
| `KOBO_DB_PATH` | Absolute path to Kōbō's SQLite DB. **Required**. |
| `KOBO_SETTINGS_PATH` | Absolute path to Kōbō's `settings.json`. Optional — `get_settings` returns an error shape if absent. |
| `KOBO_BACKEND_URL` | Base URL of the running Kōbō HTTP backend. Default: `http://localhost:3000`. Used by tools that need runtime state (dev server, git info, workspace transitions). |

The server reads the DB directly for read-only queries, writes directly for task CRUD, and calls the backend HTTP API for anything that touches runtime processes (dev server) or state transitions requiring validation.

## Tools

### Tasks

#### `list_tasks`
List all tasks and acceptance criteria for the current workspace with their IDs and current status. Call this first to discover task IDs.

**Input:** none
**Output:** `TaskDto[]` — `{ id, title, status, is_acceptance_criterion }`

---

#### `mark_task_done`
Mark a task or acceptance criterion as done. Use when you have completed and validated the work.

**Input:**
- `task_id` (string, required) — ID from `list_tasks`

**Output:** `{ success: true, task: TaskDto }`
**Side effect:** emits `task:updated` WS event (via backend `notify-done`).

---

#### `create_task`
Create a new task or acceptance criterion for the current workspace. Appended at the end of the list.

**Input:**
- `title` (string, required)
- `is_acceptance_criterion` (boolean, optional) — default `false`

**Output:** `TaskDto`
**Side effect:** emits `task:updated` WS event.

---

#### `update_task`
Update an existing task — change title, status, or `is_acceptance_criterion` flag. At least one field is required.

**Input:**
- `task_id` (string, required)
- `title` (string, optional)
- `status` (string, optional) — `pending | in_progress | done`
- `is_acceptance_criterion` (boolean, optional)

**Output:** `TaskDto`
**Side effect:** emits `task:updated` WS event.

---

#### `delete_task`
Delete a task from the current workspace permanently.

**Input:**
- `task_id` (string, required)

**Output:** `{ success: true, task_id: string }`
**Side effect:** emits `task:updated` WS event.

---

### Workspace

#### `get_workspace_info`
Get all metadata about the current workspace in a single call: name, project path, branches, model, Notion URL, worktree path, status, timestamps.

**Input:** none
**Output:**
```ts
{
  id, name, projectPath, sourceBranch, workingBranch,
  worktreePath, status, model, notionUrl, notionPageId,
  devServerStatus, createdAt, updatedAt
}
```

---

#### `set_workspace_status`
Update the current workspace status. Transitions are validated by the backend against the state machine.

**Input:**
- `status` (string, required) — e.g. `idle`, `completed`, `error`

**Output:** updated `Workspace`

---

#### `get_git_info`
Get git stats for the current workspace: commit count, files changed, insertions, deletions, and PR URL if one exists for the branch.

**Input:** none
**Output:** `{ commitCount, filesChanged, insertions, deletions, prUrl }`

---

### Dev server

#### `get_dev_server_status`
Check whether the dev server is running for the current workspace. Reads `dev_server_status` from the DB.

**Input:** none
**Output:** `{ workspaceId, status }`

---

#### `start_dev_server`
Start the dev server configured for the current workspace (via backend).

**Input:** none
**Output:** `DevServerStatus`

---

#### `stop_dev_server`
Stop the dev server of the current workspace (via backend).

**Input:** none
**Output:** `DevServerStatus`

---

#### `get_dev_server_logs`
Fetch the last N lines of the dev server logs for the current workspace.

**Input:**
- `tail` (number, optional) — default `200`

**Output:** `{ logs: string[] }`

---

### Settings

#### `get_settings`
Read Kōbō settings (global and/or per-project). Reads `KOBO_SETTINGS_PATH` directly from disk.

**Input:**
- `project_path` (string, optional) — if provided, returns the specific project entry alongside global

**Output (with `project_path`):** `{ global, project }`
**Output (without):** `{ global, projects }`
**Output (settings unavailable):** `{ global: null, project: null, error }`

---

### Images

#### `list_workspace_images`
List all images uploaded to the current workspace via Kōbō's chat paste/upload flow. Reads `.ai/images/index.json` from the worktree.

**Input:** none
**Output:** `Array<{ uid, originalName, relativePath, createdAt }>`

---

## Implementation notes

- **Handlers** live in `kobo-tasks-handlers.ts` as pure functions taking the DB handle (and sometimes paths) as arguments. This keeps them unit-testable in isolation — see `src/__tests__/kobo-tasks-server.test.ts`.
- **Backend HTTP helper** `backendRequest()` in `kobo-tasks-server.ts` wraps fetch calls to `KOBO_BACKEND_URL` for tools needing runtime state. On non-2xx it throws — the top-level dispatcher catches and returns an `isError` content.
- **Notifications**: `mark_task_done` hits `POST /tasks/:id/notify-done`, while `create_task` / `update_task` / `delete_task` hit `POST /tasks/notify-updated`. Both cause the backend to emit a `task:updated` WS event so the Vue UI refreshes.
- **Workspace scoping**: every handler that touches tasks uses `WHERE workspace_id = ?` to prevent cross-workspace access, even if the LLM passes a task_id from another workspace.
- **Error handling**: the MCP dispatcher wraps every tool call in a `try/catch` and returns `{ isError: true, content: [{ type: 'text', text: 'Error: ...' }] }` on failure. Handlers should throw with descriptive messages.
