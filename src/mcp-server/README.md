# Kōbō Tasks MCP Server

Standalone MCP (Model Context Protocol) server spawned by Kōbō for each Claude Code agent running inside a workspace. Exposes workspace-scoped tools that the agent can invoke to interact with Kōbō state: tasks, settings, dev server, images, git, etc.

Kōbō also exposes conversation tools to external MCP clients over HTTP and through the global stdio server.

## Connect an external LLM

**Settings → Global → Network access → External LLM access (MCP)** provides this installation's backend URLs and a local stdio configuration. The preview uses a token placeholder; **Copy with token** explicitly includes the current network token. Development configurations use the backend port, independently of the UI port. The JSON examples use a generic `mcpServers` format; adapt the enclosing configuration to your client.

### HTTP (local or remote)

Connect a client supporting **MCP Streamable HTTP** to the running backend:

```text
http://127.0.0.1:3000/api/mcp
```

Use the backend's actual port (`3300` for the default development server). This endpoint needs no database path or separate MCP process. It supports MCP initialization, tool discovery and JSON responses; conversation updates are retrieved by polling a cursor rather than a persistent event stream.

For another machine, enable [Network access](../../CONFIGURATION.md#network-access), restart Kōbō as instructed there, and replace `127.0.0.1` with its reachable address. Configure either header in the MCP client:

```text
Authorization: Bearer <your Kōbō network access token>
```

```text
X-Kobo-Token: <your Kōbō network access token>
```

Find the token in **Settings → Global → Network access**. The existing Host/Origin checks and reverse-proxy settings also apply to MCP. Local connections need no token unless **Behind a reverse proxy** is enabled. This is shared-token authentication; clients requiring an OAuth authorization flow are not supported. For access outside a trusted LAN, follow the existing reverse-proxy/TLS deployment guidance. Adding this endpoint does not enable network access automatically.

The HTTP endpoint exposes `list_workspaces` and the six [conversation tools](#conversation-tools) below. Its discovery response is an array of `{ id, name, status, projectPath, archivedAt }`.

### Stdio (local client)

The existing global server exposes the same six conversation tools alongside its workspace-management tools. For a local checkout, build Kōbō first and add an entry like this to a client using the `mcpServers` configuration format, replacing the absolute paths:

```json
{
  "mcpServers": {
    "kobo": {
      "command": "node",
      "args": ["/absolute/path/to/Kobo/dist/mcp-server/kobo-tasks-server.js"],
      "env": {
        "KOBO_DB_PATH": "/absolute/path/to/kobo/kobo.db",
        "KOBO_BACKEND_URL": "http://127.0.0.1:3000"
      }
    }
  }
}
```

Leave `KOBO_WORKSPACE_ID` unset or empty for an external client. Use the same database and backend instance: the production database defaults to `~/.config/kobo/kobo.db`, while development uses `data/kobo.db`. If the backend requires a token, set `KOBO_NETWORK_TOKEN` for backend calls. Conversation tools always use the running backend to preserve agent ownership and lifecycle checks.

### Conversation tools

| Tool | Arguments | Result |
|---|---|---|
| `get_workspace` | `workspace_id` | Workspace metadata, tasks and active/latest session. |
| `list_workspace_sessions` | `workspace_id` | Workspace sessions with their IDs and status. |
| `read_workspace_messages` | `workspace_id`, optional `session_id`, `after_cursor`, `limit` | Chronological conversation fragments, `nextCursor`, `hasMore`, `workspaceStatus`, `activeSessionId`. |
| `send_workspace_message` | `workspace_id`, `content`, optional `session_id`, `idempotency_key` | `{ accepted: true, sessionId }`; keyed sends also return `requestId`, `eventId`, and `replayed` on a successful retry. |
| `get_workspace_questions` | `workspace_id` | Pending `questions` and `requiresHumanApproval` for a permission request at the head of the queue. |
| `answer_workspace_question` | `workspace_id`, `tool_call_id`, `answers` | `{ accepted: true }` after answering the current question. |

Typical dialogue:

1. Call `list_workspaces`, then `get_workspace` and optionally `list_workspace_sessions` to select the conversation.
2. Read existing messages, following `nextCursor` while `hasMore` is true. Keep the final cursor.
3. Call `send_workspace_message` with the workspace ID and your text. An inactive agent is resumed; a selected session must belong to this workspace and must be the running session if one is already running.
4. Poll `read_workspace_messages` with the saved cursor for the reply. Acceptance means the message was delivered, not that the agent finished its work. `workspaceStatus` and `get_workspace_questions` expose progress and blockers.
5. To answer a question, pass the current `toolCallId` as `tool_call_id`, and map its question identifiers to string answers in `answers` (Codex uses question IDs; Claude questions use their question text). Tool permission requests must be approved by the human in Kōbō.

Each message fragment has `{ id, sessionId, role, text, messageId, createdAt }`, optionally `source` and `clientMessageId`. Concatenate assistant fragments sharing a `messageId` and `sessionId` in returned order. `limit` bounds **source events scanned**, from 1 to 200 (default 100): a page can contain no text while still advancing its cursor. Session filtering also includes older untagged events (`sessionId: null`). Keep the same session filter when continuing a cursor. Cursors are workspace-specific; if retention removes a cursor, the tool returns an explicit error and reading must restart without it.

Messages use the workspace's configured engine and permission mode, and pause an active auto-loop just like chat input. Archived or purged workspaces must be restored first; messages are refused during compaction or while a question/permission is pending. A workspace-bound stdio agent cannot send to itself. Message content is limited to 100,000 characters; HTTP request bodies to 1 MiB.

### Retrying messages safely

Generate one `idempotency_key` per intended message and reuse it unchanged on retries:

```json
{
  "workspace_id": "<workspace ID>",
  "content": "Investigate the failing test",
  "idempotency_key": "<a UUID generated once for this instruction>"
}
```

The key is scoped to the workspace and remains recorded until that workspace is deleted, independently of chat-history retention. A repeated accepted request returns its original receipt without delivering again, including after backend restart. Reusing the key for different content or a different requested session returns `idempotency_conflict`.

Unsuccessful keyed calls set MCP `isError: true` and return `{ accepted: false, requestId, code, message }` in both JSON text and structured content:

- `in_progress`: another call still owns the request; poll by repeating the same key.
- `delivery_rejected`: validation refused the message before engine dispatch; an intentional later attempt needs a new key.
- `delivery_unknown`: delivery may have occurred, for example if the backend stopped between engine dispatch and receipt persistence. Inspect history before choosing to send another instruction. This key will never automatically dispatch again.
- `idempotency_conflict`: the same key was used for different input.

This prevents duplicate dispatch caused by retrying the same key; it does not guarantee exactly-once execution inside an external engine. Calls without a key retain the original behavior: inspect history before retrying an ambiguous failure. Question answers use the exact pending tool-call ID rather than message idempotency keys.

### Identifying the external client

HTTP clients can set `X-Kobo-Client-Name`. For Unicode labels, percent-encode the value using `encodeURIComponent` and also send `X-Kobo-Client-Name-Encoding: uri`; the settings panel generates this automatically. Stdio reads the client's initialization name, with an optional `KOBO_MCP_CLIENT_NAME` override. The bridge carries that label into HTTP calls.

Messages and question answers carry `source: { kind: "mcp", clientName, transport }` and appear as **External LLM · client name** in live and reloaded conversations. Missing labels become **External MCP client**. Names are bounded to 100 Unicode code points and escaped by the UI. Labels and transport metadata are self-reported provenance, not authenticated identities or permission grants. Older messages without provenance retain their previous presentation.

### Live engine validation

Normal `make ci` runs deterministic tests without provider credentials. The explicit live test creates a disposable repository/worktree, database and backend, sends an instruction through HTTP, reads a real engine response, checks stdio history, then restarts the backend and verifies receipt replay:

```bash
KOBO_LIVE_ENGINE=codex KOBO_LIVE_MODEL=<available-model-id> npm run test:mcp:live
KOBO_LIVE_ENGINE=claude-code KOBO_LIVE_MODEL=<available-model-id> make test-mcp-live
```

Use a concrete model available to your configured provider. This invokes the real engine and uses its existing credentials; it may consume quota. Cleanup stops the test's owned backend/agents and deletes temporary files. Missing credentials, provider errors and a missing reply fail the explicit test rather than being counted as successful validation.

## How it runs

Kōbō's Claude Code engine (under `src/server/services/agent/engines/claude-code/`) writes a `.mcp.json` file into each worktree and passes it to Claude Code via `--mcp-config`. Claude spawns this server as a child process with stdio transport and injects these environment variables:

| Env var | Purpose |
|---|---|
| `KOBO_WORKSPACE_ID` | ID of the current workspace — scopes workspace-local queries. Optional: when unset, the server runs in "global" mode (see [Global tools](#global-tools-workspace-less-mode) below) and exposes management and conversation tools; workspace-scoped tools are omitted from the tool list entirely. |
| `KOBO_DB_PATH` | Absolute path to Kōbō's SQLite DB. **Required**. |
| `KOBO_SETTINGS_PATH` | Absolute path to Kōbō's `settings.json`. Optional — `get_settings` returns an error shape if absent. |
| `KOBO_BACKEND_URL` | Base URL of the running Kōbō HTTP backend. Default: `http://localhost:3000`. Used by tools that need runtime state (dev server, git info, workspace transitions). |
| `KOBO_NETWORK_TOKEN` | Optional network access token sent with backend requests. |
| `KOBO_MCP_CLIENT_NAME` | Optional display name overriding the external stdio client's initialization name. |

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

### Global tools (workspace-less mode)

These 4 management tools and the 6 [conversation tools](#conversation-tools) are always registered, regardless of whether `KOBO_WORKSPACE_ID` is set — they let a session that Kōbō did NOT spawn (e.g. a standalone terminal session) discover, manage and talk to workspaces instead of being bound to one. The HTTP endpoint exposes discovery and conversation only.

#### `list_workspaces`
List Kōbō workspaces with id, title, status, and creation date. Reads the DB directly — works even when the Kōbō backend server isn't running.

**Input:**
- `include_archived` (boolean, optional) — default `false`

**Output:** `Array<{ id, title, status, createdAt }>`

---

#### `create_workspace`
Create a new workspace (git worktree + agent session), like the "Créer" button on the Create page. Requires the Kōbō backend server to be running and reachable at `KOBO_BACKEND_URL` — this API has no automatic branch-name derivation from the workspace name, unlike the UI.

**Input:**
- `name`, `project_path`, `source_branch`, `working_branch` (string, required)
- `model`, `reasoning_effort`, `engine`, `description` (string, optional)
- `tasks`, `acceptance_criteria` (string[], optional)
- `agent_permission_mode` (`plan | bypass | strict | interactive`, optional)
- `auto_loop` (boolean, optional), `auto_loop_session_mode` (`per_task | continuous`, optional)
- `skip_setup_script` (boolean, optional)

**Output:** created `Workspace`

---

#### `archive_workspace`
Archive a workspace by id, like the "Archiver" action in the workspace context menu. Requires the backend to be running.

**Input:**
- `workspace_id` (string, required) — from `list_workspaces`

---

#### `stop_workspace`
Force-stop the currently running agent session on a workspace, like the red "Arrêter" button in the chat header. Requires the backend to be running. Safe to call when nothing is running.

**Input:**
- `workspace_id` (string, required) — from `list_workspaces`

---

## Implementation notes

- **Handlers** live in `kobo-tasks-handlers.ts` as pure functions taking the DB handle (and sometimes paths) as arguments. This keeps them unit-testable in isolation — see `src/__tests__/kobo-tasks-server.test.ts`.
- **Backend HTTP helper** `backendRequest()` in `kobo-tasks-server.ts` wraps fetch calls to `KOBO_BACKEND_URL` for tools needing runtime state. On non-2xx it throws — the top-level dispatcher catches and returns an `isError` content.
- **Notifications**: `mark_task_done` hits `POST /tasks/:id/notify-done`, while `create_task` / `update_task` / `delete_task` hit `POST /tasks/notify-updated`. Both cause the backend to emit a `task:updated` WS event so the Vue UI refreshes.
- **Workspace scoping**: every handler that touches tasks uses `WHERE workspace_id = ?` to prevent cross-workspace access, even if the LLM passes a task_id from another workspace.
- **Error handling**: the MCP dispatcher wraps every tool call in a `try/catch` and returns `{ isError: true, content: [{ type: 'text', text: 'Error: ...' }] }` on failure. Handlers should throw with descriptive messages.
