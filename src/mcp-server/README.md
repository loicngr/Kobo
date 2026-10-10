# Kōbō Tasks MCP Server

Standalone MCP (Model Context Protocol) server configured for each Claude Code or Codex agent running inside a workspace. Exposes workspace-scoped tools that the agent can invoke to interact with Kōbō state: tasks, settings, dev server, images, git, etc.

Kōbō also exposes workspace creation, PR checkout diagnosis and conversation tools to external MCP clients over HTTP and through the global stdio server.

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

The orchestrator builds the workspace's MCP server specification in
`buildMcpServers()`. The Claude engine passes it through the SDK's `mcpServers`
option; the Codex engine supplies it through the app-server thread's
`config.mcp_servers`. The agent runtime launches the server over stdio with the
following environment. This wiring does not require writing a `.mcp.json` file
into the worktree.

| Env var | Purpose |
|---|---|
| `KOBO_WORKSPACE_ID` | ID of the current workspace — scopes workspace-local queries. Optional: when unset, the server runs in "global" mode (see [Global tools](#global-tools-workspace-less-mode) below) and exposes management and conversation tools; workspace-scoped tools are omitted from the tool list entirely. |
| `KOBO_DB_PATH` | Absolute path to Kōbō's SQLite DB. **Required**. |
| `KOBO_SETTINGS_PATH` | Absolute path to Kōbō's `settings.json`. Optional — `get_settings` returns an error shape if absent. |
| `KOBO_BACKEND_URL` | Base URL of the running Kōbō HTTP backend. Default: `http://localhost:3000`. Used by tools that need runtime state (dev server, git info, workspace transitions). |
| `KOBO_NETWORK_TOKEN` | Optional network access token sent with backend requests. |
| `KOBO_MCP_CLIENT_NAME` | Optional display name overriding the external stdio client's initialization name. |

The server reads the DB directly for local queries, writes directly for task
CRUD, and calls the backend HTTP API for runtime processes and validated
workspace transitions. Conversation tools are defined in
`src/shared/workspace-dialogue-tools.ts` and forwarded through the backend.
The stdio server opens an existing database; schema migration belongs to backend
startup.

## Tools

The tables below document the workspace tools in addition to the detailed task,
workspace, dev-server and settings references that follow. Global discovery and
conversation tools are described separately. The registration schemas in
`kobo-tasks-server.ts` are the source of truth for arguments.

### Automation and workspace metadata

| Tool | Input | Purpose |
|---|---|---|
| `mark_auto_loop_ready` | None | Mark task grooming complete so the UI can enable auto-loop. |
| `set_auto_loop` | `enabled` | Enable or disable auto-loop for this workspace on explicit user request. |
| `set_workspace_agent_description` | `description` | Set the agent's status summary (200 characters maximum); empty clears it. |
| `set_workspace_name` | `name` | Rename the workspace on explicit user request. |
| `schedule_wakeup` | `delaySeconds`, `prompt`, optional `reason` | Schedule one follow-up; the delay is clamped to 60–21,600 seconds. Replaces the workspace's pending wakeup. |
| `cancel_wakeup` | None | Cancel the pending wakeup, if any. |
| `cron_create` | `expression`, `prompt`, optional `label`, `mode`, `oneShot` | Persist a recurring trigger; mode is `resume` (default) or `fresh`. Accepts five-field cron or the documented hourly/daily/weekly/monthly/yearly aliases. |
| `cron_list` | None | List this workspace's schedules. |
| `cron_delete` | `id` | Cancel one of this workspace's schedules. |

### Final auto-loop review

`submit_final_review` (shown to agents as `kobo__submit_final_review`) is available
only in the separate final-review session launched by Kōbō. It is not an external
HTTP/global-stdio conversation tool or a general task-completion tool. Kōbō binds
its capability to the active reviewer; the agent cannot select another workspace
or session. Plan/read-only reviewers can submit this verdict without permission to
modify files or tasks.

Arguments: `summary` (non-empty, at most 12,000 characters) and `findings` (at most
100 items). Each finding requires `severity` (`critical`, `important`, or `minor`),
`file` (at most 1,000 characters), `description` and `recommendation` (each at most
4,000 characters), with an optional positive integer `line`. The complete
serialized verdict is capped at 60,000 characters. Include every actionable
finding; use `findings: []` only when the entire mission and its acceptance
criteria are clear. A prose-only report does not satisfy this completion gate.

Submit one final verdict, then end the turn. Repeating an identical verdict is
safe; replacing an already accepted verdict with different findings is refused.
Kōbō turns findings into tasks, returns them to the original working session for
automatic correction and final verification, and launches a fresh review. With no
findings, the original session receives the result before the loop completes.
This review/return state survives a client disconnect or server restart. An
uncertain return delivery requires explicit retry/cancel in Kōbō; the reviewer
must not try to bypass that decision. See [final review configuration](../../CONFIGURATION.md#final-review-for-auto-loop).

### Documents, context and history

| Tool | Input | Purpose |
|---|---|---|
| `get_ticket` | None | Read the workspace's Notion or Sentry source context. |
| `list_documents` | None | List Markdown under `docs/plans/`, `docs/superpowers/`, `.ai/thoughts/`, and `.ai/handoffs/`. |
| `read_document` | `path` | Read a worktree-relative document within those roots. |
| `log_thought` | `title`, `content`, optional `tag` | Write a uniquely named decision note under `.ai/thoughts/logs/`. |
| `submit_session_handoff` | `report` | Submit up to 24,000 characters of Markdown during a backend-requested handoff generation turn. The invocation supplies the operation identity; the agent cannot select another transfer. |
| `search_codebase` | `query`, optional `include_archived`, `scope`, `limit` | Search conversations, not repository source. Scope defaults to `workspace`; `all` searches across workspaces. Limit defaults to 30, maximum 100. |
| `get_session_usage` | None | Read workspace and active-session usage totals. |
| `read_workspace_events_csv` | Optional `session_id`, `offset`, `limit` | Read this workspace's conversation as paginated CSV; limit defaults to 100, maximum 500. |

`submit_session_handoff` is advertised only to the MCP invocation preparing a
session transfer. That invocation exposes read tools and report submission only.
After submitting, the agent ends its turn; the backend waits for confirmed engine
closure before launching the fresh conversation. Ordinary workspace and global
MCP clients cannot submit handoff reports or control this transition.

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
Query the backend for the current workspace's development-server status. If the
request fails, fall back to the saved database status.

**Input:** none
**Output:** `DevServerStatus` — status, instance/project names, HTTP port, URL, and matched containers. See the [Docker status contract](../../CONFIGURATION.md#dev-server).
Without a configured start command, the backend returns `not_configured` with
`configured: false`. The database fallback returns `{ workspaceId, status }`.

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

**Output:** `{ logs: string }` — combined Docker log text.

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

These management tools and the 6 [conversation tools](#conversation-tools) are registered regardless of whether `KOBO_WORKSPACE_ID` is set. Workspace-bound stdio, global stdio and external HTTP share creation, PR diagnosis, archive, purge, deletion and restoration tools. The HTTP endpoint also exposes discovery, conversation and memory; `stop_workspace` remains a stdio tool. Restricted final-review and handoff sessions cannot call creation or lifecycle mutation tools.

#### `list_workspaces`
List Kōbō workspaces with id, title, status, and creation date. Reads the DB directly — works even when the Kōbō backend server isn't running.

**Input:**
- `include_archived` (boolean, optional) — default `false`

**Output:** `Array<{ id, title, status, createdAt }>`

---

#### `create_workspace`
Create a workspace through the same backend handlers as the Create page, including worktree setup, imports, attachments, auto-loop and final review. The backend must be running. Inputs use snake_case; returned `Workspace` fields use the HTTP API's camelCase.

| Inputs | Meaning |
|---|---|
| `name`, `project_path` | Required. Select a project configured in Kōbō. |
| `source_branch`, `working_branch` | Required for ordinary creation; supply branch names explicitly. With `worktree_path`, only `source_branch` is required. With `pr_url`, canonical PR base/head branches are derived. |
| `engine`, `model`, `reasoning_effort`, `agent_permission_mode` | Same engine and permissions as the form (`claude-code` / `codex`; `plan` / `bypass` / `strict` / `interactive`, subject to engine support). |
| `description`, `tags`, `tasks`, `acceptance_criteria` | Description and arrays of strings. |
| `auto_loop`, `auto_loop_session_mode` | Enable auto-loop; mode is `per_task` or `continuous`. |
| `brainstorm_model`, `brainstorm_reasoning_effort` | Separate initial brainstorm configuration, on the workspace's engine. |
| `auto_loop_final_review` | Reviewer `{engine, model, reasoning_effort, additional_instructions?}`; uses the same durable review/correction cycle as the form. |
| `workflow_policy` | Optional `commit`, `push`, `publish`, each `manual` or `automatic`. |
| `notion_url`, `notion_page_id`, `sentry_url` | `notion_url` or `sentry_url` imports ticket context using the enabled, configured integration. `notion_page_id` stores an optional identifier; it does not import content on its own. |
| `pr_url`, `pr_checkout` | Resume a PR/MR through diagnosis and checkout; see below. |
| `worktree_path`, `skip_setup_script` | Reuse an existing worktree or control the setup script. PR checkout skips setup by default; explicit `false` runs it. |
| `comparison_id`, `creation_id` | Group separate creations for comparison; correlate creation progress. These are not idempotency keys. |
| `attachments` | Up to 10 `{name, mime_type, data_base64}` files, 50 MiB decoded total. Same file types as the form; send inline base64, never a server file path. |

For an engine comparison, create two workspaces with distinct working branches and the same `comparison_id`, configuring each engine separately. Selecting a saved form preset in an MCP client means sending its effective field values.

Example with final review:

```json
{
  "name": "Implement feature",
  "project_path": "/home/me/project",
  "source_branch": "develop",
  "working_branch": "feature/example",
  "engine": "codex",
  "auto_loop": true,
  "auto_loop_final_review": {
    "engine": "claude-code",
    "model": "opus",
    "reasoning_effort": "high",
    "additional_instructions": "Check regressions and tests"
  },
  "workflow_policy": { "commit": "manual", "push": "manual", "publish": "manual" }
}
```

**Result:** a created `Workspace`, or `{created: false, requiresAction: true, report, pr, fingerprint, reason?}` when PR checkout needs decisions. Opening/unarchiving an existing workspace returns `{created: false, workspaceId, workspace}`. Cancellation returns `{created: false, cancelled: true, ...}`. Backend errors are MCP errors with `{error, status, stage, details}` so stale checkout reports remain available.

If creation fails after PR checkout, Kōbō removes only the checkout created by that request when its directory, branch and HEAD are unchanged, it has no local or ignored files, and no workspace adopted it. The PR branch and earlier checkout decisions remain intact. Existing, modified or adopted checkouts are preserved. Errors include `details.checkoutRecovery` with the path, `removed` outcome and a reason when retained. An uncertain creation outcome preserves the checkout for inspection; do not retry automatically.

Creation requests have no automatic retry or exactly-once guarantee. After a disconnect/timeout, inspect `list_workspaces` before trying again: checkout or creation may have completed. The stdio bridge allows up to 15 minutes for creation; external clients should configure their own request timeout for slow setup scripts. Ordinary MCP requests retain the 1 MiB envelope limit; creation allows base64 expansion of the 50 MiB upload limit plus 1 MiB metadata, including at the SDK HTTP and stdio transport boundaries.

#### `diagnose_workspace_pr`

**Input:** `{project_path, pr_url}`. Returns `{report, pr, fingerprint}` for the configured forge and the PR's local Git state. Creates no workspace and applies no checkout changes.

1. Call `diagnose_workspace_pr` to inspect the PR. A clean PR can also be passed directly to `create_workspace` using only `name`, `project_path`, `pr_url` and the desired agent options.
2. When checkout needs a choice, call `create_workspace` with the same PR and `pr_checkout: {fingerprint, decisions}`. Use the returned fingerprint, not a guessed value. Missing choices return `requiresAction`; stale state returns an error with the current report.
3. Inspect the result before continuing. Existing workspaces can be opened or unarchived; use `restore_workspace` first for a purged checkout. No duplicate workspace is created automatically.

`decisions` uses the existing checkout contract's camelCase keys: `existingWorkspace: "open"`, `archivedWorkspace: "unarchive"`, `orphanWorktree: "attach" | "create-elsewhere"`, `pathCollision: {worktreePath}`, `localChanges: "stash" | "commit" | "discard" | "keep"`, `ongoingOperation: "abort" | "cancel"`, `divergence: "fast-forward" | "rebase" | "reset-hard" | "keep"`. Destructive choices must be supplied explicitly. The backend rechecks Git state under its checkout lock before applying them. Forks, unavailable forge CLIs and other blockers are reported using the same rules as the form.

---

#### `archive_workspace`
Archive a workspace by id, like the "Archiver" action in the workspace context menu. Stops its processes and auto-loop, preserves checkout and history, and may run the configured archive script. Available on internal stdio, global stdio and external HTTP; requires the backend to be running.

**Input:**
- `workspace_id` (string, required) — from `list_workspaces`

---

#### `purge_workspace_worktree`

Free disk space by removing a Kōbō-owned checkout and archiving the workspace. Conversation history and recovery metadata remain available; uncommitted files are not recoverable. External attached worktrees are protected.

**Input:** `{workspace_id, confirm_purge: true}`.

**Output:** `{workspace, warnings, outcome}` from the existing purge lifecycle. Inspect warnings and outcome: a failed removal does not mean disk space was freed.

#### `delete_workspace`

Permanently delete one workspace and its history, with the same branch options as the deletion dialog. Stops processes and removes its owned checkout; externally managed worktrees are preserved.

**Input:**

```json
{
  "workspace_id": "workspace-id",
  "confirm_delete": true,
  "confirmation_branch": "feature/example",
  "delete_local_branch": true,
  "delete_remote_branch": true
}
```

Both branch flags default to `false`; remote deletion requires local deletion too, as in the form. `confirmation_branch` must match the current working branch for every deletion. The backend checks it again under the lifecycle lock before any teardown; branch rename and resynchronization are rejected while this operation is in progress. Bulk deletion through the reserved `archived` endpoint is not exposed.

**Output:** `{ok: true, workspaceId, warnings: []}` after a clean 204 response, or the backend's `{ok: true, warnings}` when cleanup was incomplete. Preserve these warnings: deletion of the workspace record can succeed while branch or disk cleanup fails.

#### `unarchive_workspace` and `restore_workspace`

Both accept `{workspace_id}` and are available on all three MCP transports.

- `unarchive_workspace` restores visibility when the checkout is still present, preserving the workspace's prior status. A purged checkout is refused; use `restore_workspace`.
- `restore_workspace` checks or recreates the Kōbō-owned worktree using the existing recovery service, then unarchives the workspace. It preserves chat history, returns the final workspace with restoration outcome/source, and starts no agent or setup script. An already active, non-purged workspace is returned unchanged.

Restoration reuses the saved Git recovery information and retains the existing ownership/path/conflict checks. A checkout deleted manually without purge metadata may return `not-purged`; a workspace whose database record and history were permanently deleted cannot be restored by these tools.

Lifecycle errors preserve `{error, status, stage, details}`. No automatic mutation retries occur. A connection can close while an operation finishes, especially when an agent archives or deletes its own workspace; inspect current state before repeating a request.

---

#### `stop_workspace`
Stop the currently running agent session on a workspace, like the Stop action in the chat header. Also disables auto-loop and cancels a queued replacement. Requires the backend to be running. Safe to call when nothing is running; an unconfirmed shutdown is reported as an error.

**Input:**
- `workspace_id` (string, required) — from `list_workspaces`

---

## Persistent memory tools

The same six memory tools are available on a workspace-bound agent server and on the global external MCP server: `list_memory_scopes`, `list_memories`, `read_memory`, `search_memories`, `list_memory_operations`, and `remember`. They call Kōbō's shared memory service; HTTP and stdio clients see the same stored scopes and entries. External calls do not create or resume a workspace, agent session, or native engine conversation.

| Tool | Purpose and important arguments |
|---|---|
| `list_memory_scopes` | Lists selectable scopes; external clients may pass `workspace_id` to list exactly the applicable global/project/workspace scopes. |
| `list_memories` | Bounded page of compact metadata; select one `scope_id`, or an applicable `workspace_id` externally. |
| `read_memory` | Reads a specific `scope_id` + `entry_id`; large bodies are returned as explicit fragments with a revision/code-point cursor. Set `repeat: true` only to intentionally spend budget rereading an unchanged range. |
| `search_memories` | Bounded search in a selected scope or external workspace view; results are metadata/excerpts, not a corpus dump. |
| `list_memory_operations` | Bounded content-free journal page for one scope or external workspace view. |
| `remember` | Creates/updates a concise fact. Supply `scope_id`, `expected_generation`, `key`, `title`, and `body`; updates also require `entry_id`, `expected_revision`, and `key`. |

Internal tools derive workspace/session/engine attribution and access from a short-lived launch capability. Do not send an actor field. A read-only plan/review/report launch cannot write, and stopping revokes its capability. External clients must choose a scope explicitly for writes and `read_memory`; they cannot forge an internal session, human actor, or use the workspace bridge to escape its scope. Memory MCP exposes no delete, promotion, proposal approval, or clear operation; a human performs those in Settings/the workspace drawer.

Mode applies to internal and external writes at call time: Manual denies agent writes, Hybrid applies workspace writes and proposes project/global changes, and Automatic applies the selected scope. A `remember` receipt reports denied/applied/proposed and revision/generation metadata, not a copy of the saved body. No mutation is retried automatically after a transport error; inspect the key/proposal before deciding whether to retry. Hybrid proposals stay pending until human approval; switching modes never approves them.

Each response is independently bounded, and native conversation memory retrieval is cumulatively budgeted across resumes/restarts. Bootstrap targets 1,000 estimated tokens, ordinary tool output targets 1,000 with a hard 1,500 cap, and a native context epoch has a 6,000 cumulative retrieval-token ceiling. Retrieval output stops at 5,500, reserving up to 500 tokens for one terminal budget-denial receipt. After that receipt, exhausted MCP reads return `isError: true` with `content: []`. The final serialized envelope has a separate 12,000-byte ceiling and includes 96 bytes of framing headroom in its cost. These values estimate only Kōbō memory retrieval; Kōbō has no trustworthy full-context/window telemetry and cannot promise the rest of a provider conversation fits.

`remember` and `list_memory_scopes` remain available after retrieval exhaustion, including existing conversations. Their body-free control replies (including errors) are capped at 1,000 estimated tokens per call and report `budget.chargedTokens: 0`; they do not consume/reset the cumulative retrieval budget. Mode, read-only and scope restrictions still apply. The same policy applies to internal and external MCP. Do not poll scope discovery or repeat writes unnecessarily: control replies still occupy model context, although they are outside the cumulative retrieval ceiling.

External `list_memory_scopes` returns scope IDs, levels, and generation/revision CAS values; pass the current generation to `remember` and rediscover after a clear/conflict. HTTP/global-stdio clients should reuse the opaque `memory_context_id` returned by receipts for one cooperative external conversation. This keeps its cumulative allowance across stateless requests; it is budget bookkeeping, not an authorization token and cannot reference an internal conversation ledger. Kōbō cannot detect external compaction or know that a new ID means an empty model context. External provenance records the normalized display client name and `http`/`stdio` transport, not an authenticated identity. Reuse the same id across calls and respect returned exhaustion receipts instead of looping.

Automatic mode means the agent deliberately calls `remember` when it has stable, reusable knowledge; there is no background transcript extraction or post-session model call. Clear prevents later Kōbō memory reads/injection but cannot retract text already transmitted to an engine or remove provider chat history. See [Persistent memory](../../CONFIGURATION.md#persistent-memory) for scope lifecycle, erasure and UI behavior.

## Implementation notes

- **Handlers** live in `kobo-tasks-handlers.ts` as pure functions taking the DB handle (and sometimes paths) as arguments. This keeps them unit-testable in isolation — see `src/__tests__/kobo-tasks-server.test.ts`.
- **Backend HTTP helper** `backendRequest()` in `kobo-tasks-server.ts` wraps fetch calls to `KOBO_BACKEND_URL` for tools needing runtime state. On non-2xx it throws — the top-level dispatcher catches and returns an `isError` content.
- **Notifications**: `mark_task_done` hits `POST /tasks/:id/notify-done`, while `create_task` / `update_task` / `delete_task` hit `POST /tasks/notify-updated`. Both cause the backend to emit a `task:updated` WS event so the Vue UI refreshes.
- **Workspace scoping**: every handler that touches tasks uses `WHERE workspace_id = ?` to prevent cross-workspace access, even if the LLM passes a task_id from another workspace.
- **Error handling**: the MCP dispatcher wraps every tool call in a `try/catch` and returns `{ isError: true, content: [{ type: 'text', text: 'Error: ...' }] }` on failure. Handlers should throw with descriptive messages.

### Group messages

The UI, workspace-bound stdio, global stdio and external HTTP MCP share the same
backend delivery service. The MCP exposes three tools:

1. `preview_workspace_group_message`: select optional `tags`, `statuses`, and
   `dev_server_running` (boolean, default false). Set it to true to keep only
   workspaces with development server status `running`.
   Tags match any selected tag, statuses match any selected status, and all enabled
   filters intersect. Empty filters match all non-archived, non-purged workspaces.
   Results include `workspaceId`, `name`, `tags`, `status`, and `delivery`, sorted
   by workspace ID. Use `limit` (1–200, default 200) and `offset` (default 0),
   checking `total` to paginate. Preview is live, not a reservation.
2. `send_workspace_group_message`: supply a unique `request_id`, an explicit
   `workspace_ids` list (1–200 distinct IDs), and `content` (up to 100,000
   characters). Filters and wildcards cannot substitute for selected IDs.
   Workspace-bound agents cannot include their own workspace. Manual targets
   receive immediately; auto-loop targets queue for their next iteration.
3. `get_workspace_group_message`: inspect the durable receipt using `request_id`.
   Submission returns promptly; `complete` and each recipient's `state` track
   delivery separately (`pending`, `sending`, `sent`, `queued`, `rejected`,
   `unknown`, or `not_sent`). `queued` confirms enqueueing, not execution.

Repeating the same request ID with the same content, recipients and MCP source
returns its receipt without sending again. Reusing that ID with different input
fails. Ineligible recipients fail individually without discarding other results.
After a server interruption, undelivered recipients become `not_sent` and
ambiguous dispatches become `unknown`; neither is automatically resent. Inspect
workspace history before issuing another request for an uncertain recipient.
MCP client name and HTTP/stdio provenance remain attached to delivered messages.
Read-only final-review and handoff launches expose preview and receipt lookup,
but cannot submit a group message.
