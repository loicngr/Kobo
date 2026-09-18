# AGENTS.md

Guidance for AI coding agents (Claude Code, Cursor, etc.) working on this repository.

## What this project is

**Kōbō** (工房, Japanese for "workshop") orchestrates Claude Code and OpenAI Codex agents across isolated git worktrees. Each "workspace" is a self-contained mission with its own worktree, branch, agent sessions, optional dev server, optional Notion/Sentry context, and a dedicated MCP tools server. A Vue 3 UI lets the human track progress, read live agent output, review Git changes, and manage the lifecycle. A workspace can switch engines through a handoff to a fresh session while preserving its worktree and history.

Single-user dev tool, local by default. The server binds `127.0.0.1` unless the opt-in "network access" setting is enabled, which binds all interfaces and gates non-loopback API/WS requests behind a shared token. Behind-a-reverse-proxy mode also requires the token for loopback API/WS requests; `/api/health` stays exempt. Host/Origin checks apply separately. No multi-tenant concerns.

## Tech stack

**Backend**: Node.js ≥ 24.15, Hono (HTTP), `ws` (WebSocket), better-sqlite3 (WAL mode), nanoid, `@modelcontextprotocol/sdk`. TypeScript throughout, `tsx` for dev, `tsc` for production build.

**Frontend**: Vue 3, Quasar 2, Pinia, vue-router, marked + dompurify for markdown rendering. Vite via `@quasar/app-vite`, built and served as a Progressive Web App in production.

**Database**: a single SQLite file under the **Kōbō home directory** (`~/.config/kobo/kobo.db` by default, overridable via `KOBO_HOME`). Fresh-install schema lives in `src/server/db/schema.ts` (`initSchema`); incremental migrations live in `src/server/db/migrations.ts`. **The project is in production**, so every schema change MUST ship as a migration that preserves data, never as a breaking change to `initSchema` alone. See [Database migrations](#database-migrations) below.

**Kōbō home directory**: `KOBO_HOME` env var overrides everything. Otherwise `$XDG_CONFIG_HOME/kobo/`, else `~/.config/kobo/`. Contains `kobo.db`, `settings.json`, `skills.json`, `templates.json`, and `workspace-templates.json`. **Development uses `./data/`** via the `KOBO_HOME=./data` prefix in the `dev` npm script, so local dev never touches your real `~/.config/kobo/` and can run in parallel with a production-installed Kōbō (`npx @loicngr/kobo`). See `src/server/utils/paths.ts`.

**Tests**: Vitest covers backend services/routes and frontend stores, utilities, composables, and selected Vue components. The client suite uses Vue Test Utils and `happy-dom`; type-checking and manual smoke tests complement it. `npm test` runs the backend suite only; `npm run test:all` runs both suites. The three dependency trees (root, client, PWA) have separate lockfiles.

## Commands

```bash
# Install
npm install                         # root
(cd src/client && npm install)      # client — separate tree
(cd src/client/src-pwa && npm install) # Quasar PWA build — separate tree

# Develop
npm run dev                         # backend only (tsx watch on src/server/index.ts)
npm run dev:client                  # frontend only (quasar dev)
npm run dev:all                     # both concurrently

# Check & test
npm run lint                        # biome check (linting + formatting)
npx tsc --noEmit                    # type check backend (the project's primary quality gate)
npm run typecheck:tests             # type check backend test fixtures and tests
(cd src/client && npm run type-check) # vue-tsc: client + Vue components
npm test                            # backend vitest suite
(cd src/client && npm test)         # client stores, utilities, composables and components
npm run test:all                    # backend + client suites
make ci                            # install, audit, lint, type checks, build, both suites
npm run test:watch                  # vitest in watch mode

# Build & run
npm run build                       # builds client + server
npm start                           # production server (requires prior build)
```

**Run individual test files** with `npx vitest run src/__tests__/<file>.test.ts`. Filter by test name with `-t "<pattern>"`.

## Architecture

```
src/
├── server/
│   ├── index.ts                    # Hono app bootstrap + WS upgrade
│   ├── db/
│   │   ├── index.ts                # singleton getDb / closeDb
│   │   ├── schema.ts               # initSchema — CREATE TABLE IF NOT EXISTS …
│   │   └── migrations.ts           # append-only migration registry + transactional runner
│   ├── services/                   # business logic — pure functions over db + external processes
│   │   ├── workspace-service.ts    # workspaces + tasks + agent_sessions CRUD
│   │   ├── agent/                  # agent engine abstraction (replaces former agent-manager.ts)
│   │   │   ├── orchestrator.ts     # per-workspace engine map, retry/quota handling, watchdog, public API
│   │   │   ├── session-controller.ts # lifecycle wrapper around an AgentEngine instance
│   │   │   ├── event-router.ts     # persists/broadcasts normalized AgentEvent via WebSocket
│   │   │   └── engines/{claude-code,codex}/ # per-engine adapters implementing the AgentEngine contract
│   │   ├── forge/                  # github / gitlab / bitbucket-community / none, registry + auto-resolve
│   │   ├── change-source-branch-service.ts # re-target a workspace onto a new source branch (built-in cherry-pick or custom bash)
│   │   ├── git-stats-service.ts    # pure compute of commit/ahead-behind/diff stats + forge availability for a workspace
│   │   ├── settings-defaults.ts    # DEFAULT_* constants for opt-in settings (e.g. change-source-branch script)
│   │   ├── lifecycle-hook-service.ts # user shell hooks on session-ended / pr-merged / autoloop-disabled
│   │   ├── awaiting-user-reminder-service.ts # reminds about workspaces stuck in `awaiting-user`
│   │   ├── workspace-template-service.ts # create-form presets (workspace-templates.json) + presetFromWorkspace
│   │   ├── content-migration-service.ts # runtime legacy ws_events → normalised AgentEvent migration
│   │   ├── templates-service.ts    # prompt templates CRUD (JSON file persistence, seeding)
│   │   ├── dev-server-service.ts   # per-workspace dev server lifecycle (docker or npm process)
│   │   ├── websocket-service.ts    # emit / emitEphemeral to subscribed clients
│   │   ├── worktree-service.ts     # git worktree create/remove
│   │   ├── notion-service.ts       # extract Notion page via @notionhq/notion-mcp-server (user-provided token)
│   │   ├── settings-service.ts     # global + per-project settings cascade
│   │   └── pr-template-service.ts  # pure template variable substitution
│   ├── routes/                     # Hono handlers, thin layer over services
│   │   ├── workspaces.ts           # /api/workspaces/* — the main surface
│   │   ├── templates.ts            # /api/templates — prompt templates CRUD
│   │   ├── workspace-templates.ts  # /api/workspace-templates - saved create-form presets
│   │   ├── documents.ts            # workspace plans, specs and thoughts browser (read-only)
│   │   ├── mcp.ts                  # /api/mcp — external discovery and conversation tools
│   │   ├── dev-server.ts, git.ts, notion.ts, settings.ts
│   ├── utils/
│   │   ├── git-ops.ts              # pushBranch, pullBranch, getCommitsBetween, delete{Local,Remote}Branch…
│   │   └── process-tracker.ts      # per-workspace spawned-process map
├── client/                         # Vue 3 + Quasar PWA
│   └── src/
│       ├── stores/                 # pinia: workspace, websocket, settings, dev-server, templates
│       ├── components/             # WorkspaceList, AcceptancePanel, ChatInput, GitPanel, DocumentsPanel, WorkspaceAttentionLabels, HelpMenu…
│       ├── utils/                  # expand-template, formatters, workspace-attention (CI failure / changes-requested derivation)…
│       ├── tours/                  # declarative onboarding tours, one file per zone + registry
│       ├── pages/                  # WorkspacePage, CreatePage, SettingsPage
│       └── router/
├── mcp-server/                     # standalone MCP server spawned per workspace
│   ├── kobo-tasks-server.ts        # entrypoint, registers tools
│   └── kobo-tasks-handlers.ts      # pure handlers (list_tasks, mark_task_done)
├── shared/                         # model catalogues, prompts, dialogue contracts, shared utilities
└── __tests__/                      # backend Vitest suites; client tests live under client/src/__tests__/
```

## Data model (SQLite)

| Table | Purpose |
|---|---|
| `workspaces` | the unit of work: id, name, project_path, source_branch, working_branch, status, notion_url, model, `brainstorm_model`, dev_server_status, `archived_at`, `worktree_purged_at`, `worktree_purge_restore_data` (JSON), `auto_loop`, `auto_loop_ready`, `auto_loop_session_mode`, `no_progress_streak`, timestamps, `comparison_id` |
| `tasks` | workspace sub-items: title, status, `is_acceptance_criterion`, sort_order; CASCADE DELETE on workspace |
| `agent_sessions` | agent-engine sessions: pid where applicable, engine session id, status, timestamps, model, and name |
| `ws_events` | persisted WebSocket events for replay on reconnect: type, payload, session_id, created_at |
| `pending_review_returns` | one-shot return from a review to its original session and LLM configuration (migration v44) |
| `pending_wakeups` | one-row-per-workspace scheduler for the `schedule_wakeup` MCP tool: target_at (ISO UTC), prompt, reason; CASCADE DELETE on workspace |
| `pending_quota_backoffs` | persisted quota retries and their attempt counts |
| `pending_crons` | recurring workspace schedules and their next run |
| `session_event_metrics` / `usage_snapshots` | session event counters and provider usage snapshots |
| `workspace_activity` | significant lifecycle/PR events for the absence digest |
| `search_*` | derived logical-message search index and indexing progress; see `search-schema.ts` |
| `mcp_message_requests` | durable external-message idempotency ledger; independent of event retention |
| `schema_migrations` | applied migration versions, names and timestamps |
| `workspace_chat_history` | chat-input history per workspace: message text + `created_at`, ordered by autoincrement id, capped at 200 entries by the service; CASCADE DELETE on workspace |
| `workspace_permission_rules` | remembered per-workspace tool approvals, scoped to an exact operation or every invocation of a tool; CASCADE DELETE on workspace |

`status` enum: `created | extracting | brainstorming | executing | compacting | awaiting-user | completed | idle | error | quota`. Transitions are validated in `updateWorkspaceStatus` against `VALID_TRANSITIONS`.

`compacting` is a server-owned busy state while the agent compacts context. The orchestrator associates the previous status with the current controller and restores it when compaction ends; stop, errors and startup reconciliation must not leave the workspace stuck in compaction. Normal workspace status updates make this state available after reload and across clients. Chat sends are refused during compaction before delivery or fallback starts, and the client keeps the user's draft while disabling send. The existing status column is unrestricted TEXT, so adding this state does not change the database schema.

`archived_at` is **orthogonal** to `status`. Archiving is a visibility flag, not a lifecycle state. Unarchive restores the exact pre-archive `status`.

`worktree_purged_at` + `worktree_purge_restore_data` drive the disk-space purge feature (see [Worktree purge](#worktree-purge) below): when set, the workspace's worktree folder has been removed from disk but the chat history is preserved. `worktree_purge_restore_data` is a JSON blob (`{ prNumber, prUrl, forge, mergeCommitSha, originalWorktreePath, originalSourceBranch, originalWorkingBranch }`) captured at purge time for future "Restore" UX. Both fields are cleared automatically by the pr-watcher when the worktree folder reappears on disk.

`auto_loop` preserves the user's execution intent. `auto_loop_runs` (migration v45) stores phase (`grooming | execution | finalization`), operational state (`active | waiting | blocked | completed | stopped`), iteration count and diagnostic recovery. `auto_loop_progress` records monotone task milestones; metadata changes are not progress. After three stagnant iterations, run one diagnostic and two further attempts, then block explicitly without clearing intent. Quotas wait for their actual reset, including multi-day windows; only transient failures use the retry cap. Archived/deleted workspaces disable the loop.

Tasks have `role` (`work | finalization`) and structured `verification`. MCP and HTTP share transactional task mutations. An auto-loop task cannot become done without passing reported checks. Finalization runs after all other tasks/criteria, is invalidated by scope changes, and is mandatory before completion. The proof is agent-reported evidence, not server-side execution of arbitrary commands.

`auto_loop_messages` durably queues next-iteration instructions, independently of engine session ids. A dispatch interrupted before confirmed completion becomes `unknown`, requiring explicit acknowledgement or retry. Unknown or in-flight instructions prevent completion. Actual engine closure (`EngineProcess.closed`), not a logical end event alone, releases controller ownership and permits the next writer.

`brainstorm_model` (nullable, set only at creation) lets a workspace created with `auto_loop=1` run its initial brainstorming session on a different model than the auto-loop iterations that follow, while staying on the same engine. `POST /api/workspaces` uses it for the very first `startAgent` call only; every subsequent auto-loop iteration (`auto-loop-service.ts`'s `spawnNextIteration`) always reads `model`, unchanged. The switch to `model` takes effect once that first live session ends naturally — not at the `[BRAINSTORM_COMPLETE]` marker, since the same session keeps running under `brainstorm_model` until it stops on its own.

## Database migrations

**The project is in production**. Every schema change MUST ship as an incremental migration that preserves existing data. Never drop-and-recreate, never rely on `initSchema` alone to patch running databases.

### The two files and their roles

- **`src/server/db/schema.ts`**: `initSchema(db)` creates the current application schema for **fresh installs only**, including the search and MCP-message schemas through their helpers.
- **`src/server/db/migrations.ts`**: the ordered `migrations` registry contains `{ version, name, migrate(db) }` entries. `SCHEMA_VERSION` is derived from its last entry. `runMigrations(db)` records applied entries in `schema_migrations(version, name, applied_at)` and applies each pending entry in its own transaction. A fresh installation runs `initSchema` and records all entries as applied in one transaction. Legacy `schema_version` databases are converted to the history table automatically.

Both files must be kept in sync: after adding a migration, update `initSchema` so fresh installs get the same final shape without replaying migrations.

### Adding a migration for a new feature

Every feature that touches the schema:

1. Append an entry to `migrations` with the next version and a descriptive name. `SCHEMA_VERSION` updates automatically; do not replace its derived expression with a literal.
2. Implement the entry's `migrate(db)` using raw SQL, such as `ALTER TABLE workspaces ADD COLUMN new_field TEXT`. The runner owns the transaction and skips versions already recorded.
3. Update `initSchema` in `schema.ts` so the fresh-install shape matches (e.g. add the new column to the `CREATE TABLE` statement)
4. Let the runner record the new entry in `schema_migrations`; do not manually update a legacy `schema_version` row.
5. Add a test in `src/__tests__/migrations.test.ts` that verifies:
   - A database at the previous version can be upgraded without data loss
   - The new version matches `SCHEMA_VERSION`
   - Fresh installs and upgraded installs converge to the same schema
6. Never edit or reorder migration blocks that have already shipped; they are historical. If you need to fix a mistake, add a new migration.

### Rules

- **Migrations are append-only.** Shipped migration blocks are frozen. Fixes go in new migrations.
- **Always idempotent where possible.** Use `IF NOT EXISTS`, check for column existence before altering, etc. Prefer migrations that can be safely re-run.
- **`ALTER TABLE ADD COLUMN` is safe in SQLite** (even on large tables). For more invasive changes (rename, drop, change type), use the [12-step SQLite pattern](https://sqlite.org/lang_altertable.html#otheralter) within a transaction.

- **Run migrations on every backend start.** `src/server/index.ts` opens the connection with `getDb()`, checks for pending migrations, attempts a pre-migration backup, then calls `runMigrations(db)`. `getDb()` only opens/configures SQLite; it does not initialize or migrate the schema. Tests creating their own database must initialize it explicitly.
- **Settings migrations are separate.** The JSON settings migration versions in `settings-service.ts` are independent of SQLite's `SCHEMA_VERSION`.
- **Test upgrades, not just fresh installs.** The `migrations.test.ts` suite must exercise "old DB → new DB" paths.

## WebSocket protocol

### External MCP dialogue and update checks

`POST /api/mcp` exposes stateless Streamable HTTP discovery/dialogue tools, behind the existing Host/Origin and network-token gates. The global stdio server forwards dialogue calls through this backend so agent runtime ownership remains centralized. `workspace-message-service.ts` shares delivery with WebSocket chat.

Optional `send_workspace_message.idempotency_key` uses `mcp_message_requests` (migration v43). Reserve before dispatch, preserve fingerprints and terminal outcomes, and never automatically resend an unfinished request after restart. The user event and accepted receipt commit in one SQLite transaction; broadcast follows commit. Dispatch may precede persistence, so interrupted requests are explicitly `delivery_unknown`, not an exactly-once execution promise. The backend alone calls `reconcileMessageRequests` on startup. History retention does not delete the ledger; workspace deletion cascades it.

MCP messages and question answers include optional `source: { kind: 'mcp', clientName, transport }`; keep it across live, sync, history and conversation grouping paths without changing legacy `sender` behavior. Client names are display labels, not authorization identities. Unicode HTTP labels use URI encoding with `X-Kobo-Client-Name-Encoding: uri`; stdio forwards the initialization name or `KOBO_MCP_CLIENT_NAME` override.

`update-check-service.ts` owns the single immediate/every-20-minute npm release check. It is explicitly started/stopped by the backend, coalesces route/poller calls, and broadcasts ephemeral global `kobo:update-checked` events. The client update store also refreshes at reconnect. Do not reintroduce a per-tab registry poll or automatically install updates.

The explicit `npm run test:mcp:live` / `make test-mcp-live` command requires `KOBO_LIVE_ENGINE` and `KOBO_LIVE_MODEL`, uses real credentials and disposable data, and must stay outside `make ci`. Normal CI uses deterministic transport/service tests.

Clients subscribe to individual workspace ids. The server sends `WsEvent` objects:

```ts
{ id, workspaceId, type, payload, sessionId?, createdAt }
```

Agent engines emit a normalized `AgentEvent` union, carried by `agent:event`. Common outer types include `user:message`, `task:updated`, `devserver:status`, `workspace:status`, `workspace:archived`, `workspace:unarchived`, and `sync:response`. Legacy `agent:output` rows remain supported through content migration. Keep the backend union in `services/agent/engines/types.ts` and its client mirror in `client/src/types/agent-event.ts` synchronized.

Error events may carry a stable `code`. Claude's post-result drain timeout uses
`result_drain_timeout` and its stream inactivity timeout uses `stream_idle_timeout`:
keep both in the chat but exclude them from `AgentErrorBanner`. The selector also
recognizes their exact legacy messages for persisted history. Other errors keep
their banners. A `session:ended` with reason `watchdog` leaves a manual workspace
`idle`, unless accompanied by a nonzero exit code. Preserve the watchdog end reason
and auto-loop's bounded recovery/backoff behavior; real engine failures remain errors.

Two emit flavors in `websocket-service.ts`:
- `emit(workspaceId, type, payload)` persists to `ws_events` for later replay via `sync:request` on reconnect
- `emitEphemeral(workspaceId, type, payload)` delivers once and never persists. Use it for lifecycle events (archive, status changes) that shouldn't replay.

## External integrations

### Forge providers

`src/server/services/forge/` implements `ForgeProvider` for `github` (`gh`), `gitlab` (`glab`), `bitbucket-community` (`bkt`), and `none` (disables PR/MR features). `getForgeProvider(id)` resolves a provider; `resolveForge(projectPath)` first reads the explicit project setting, then classifies the `origin` URL by `github.com`, `gitlab`, or `bitbucket`, falling back to `none`. Successful remote reads are cached for five minutes. PR routes and the watcher use the resolved provider. **Kōbō ships no forge credentials**: users authenticate `gh`/`glab` themselves; Bitbucket uses the email and API token entered in Settings, passed to `bkt` and excluded from settings exports. Missing or unauthenticated CLIs disable PR/MR actions with an explanation.

### Notion (opt-in, user-provided credentials)

`notion-service.ts` spawns the official [`@notionhq/notion-mcp-server`](https://github.com/makenotion/notion-mcp-server) as a child process (`npx -y @notionhq/notion-mcp-server`) and talks to it over stdio using JSON-RPC / MCP. **Kōbō ships no Notion credentials**, so the feature only works if the user has configured their own integration token. The token is resolved in this order:

1. `NOTION_API_TOKEN` env var
2. `NOTION_TOKEN` env var
3. `~/.claude.json` → `mcpServers.notion.env.NOTION_TOKEN` / `NOTION_API_TOKEN` (Claude Code's MCP config: the recommended path, the same token shared with Claude Code)

The selected Claude config entry defaults to the enabled key named exactly `notion`; `global.notionMcpKey` selects another exact key. Its command/args are reused unless `NOTION_MCP_COMMAND` / `NOTION_MCP_ARGS` override them; otherwise the fallback is `npx -y @notionhq/notion-mcp-server`. Existing `OPENAPI_MCP_HEADERS` are preserved; when absent, the resolved token is used to construct them.

When adding features touching `notion-service.ts`, remember: **no token = no feature**. The rest of Kōbō must keep working if the Notion token is absent; only the explicit Notion import endpoints should fail with a clear error. Do not throw at server startup.

See the "Notion integration" section of the README for the end-user setup guide.

### Agent engines

Two engines live under `src/server/services/agent/engines/`, both implementing the `AgentEngine` contract in `types.ts`:

**Claude Code** (`claude-code/`): consumes the `@anthropic-ai/claude-agent-sdk` async iterator. The SDK manages the Claude runtime; Kōbō does not launch a separate `claude` CLI command. Authentication reuses the user's Claude login or `ANTHROPIC_API_KEY`. The engine arms a **15 s result-drain watchdog** when the SDK emits its `result` message: if the async iterator does not close cleanly within the window, `session:ended` is force-emitted so the orchestrator and auto-loop never hang on a stuck generator. The watchdog is idempotent via a `sessionEndedEmitted` guard and the timer is cleared in `finally`.

**OpenAI Codex** (`codex/`): uses the **`codex app-server` JSON-RPC protocol** (line-delimited JSON over stdio with a long-lived `codex` subprocess). The engine layers are:
- `jsonrpc/transport.ts` + `jsonrpc/peer.ts`: generic JSON-RPC 2.0 stdio peer (request correlation, notifications, server-initiated requests)
- `client.ts`: typed `AppServerClient` wrapping the peer (initialize / thread.start / thread.resume / turn.start / turn.interrupt)
- `protocol/types.ts`: hand-written subset of the Codex v2 protocol types (camelCase field names like `agentMessage`, `commandExecution`, etc.). The full canonical bindings are generated by `codex app-server generate-ts` if the protocol drifts.
- `event-mapper.ts`: translates app-server notifications (`item/started`, `item/completed`, `item/agentMessage/delta`, `turn/completed`, `thread/tokenUsage/updated`, `account/rateLimits/updated`, `error`) into Kōbō `AgentEvent` union
- `server-requests.ts`: handles server-initiated approval/elicitation requests (`item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/tool/requestUserInput`, `item/permissions/requestApproval`, plus v1 legacy aliases `execCommandApproval` / `applyPatchApproval`)
- `engine.ts`: `createCodexEngine()` factory wiring everything into `AgentEngine`
- `spawn.ts`: locates the `codex` binary via `@openai/codex` dependency and spawns `codex app-server`

Auth: delegated to the `codex` CLI which reads `OPENAI_API_KEY` from env or `~/.codex/auth.json`. Kōbō ships no Codex credentials. The `@openai/codex` package (binary) is a direct dependency.

Background: the engine was migrated from `@openai/codex-sdk` (one-shot `codex exec`) to `codex app-server` in May 2026 to unlock features the SDK didn't surface (sub-agent visibility, interactive approvals, `request_user_input`, structured rate limits). The original migration plan and wire-capture notes live at `docs/superpowers/plans/2026-05-11-codex-app-server-migration.md` and `2026-05-11-codex-app-server-wire-capture.md`.

**Protocol gotchas worth remembering** (post-migration findings):

- **`experimentalApi: true` is mandatory in the `initialize` handshake.** Without it, any turn using experimental fields (most importantly `turn/start.collaborationMode`) is rejected with `-32600: requires experimentalApi capability`. See `client.ts:connect()`.
- **`collaborationMode` is sticky server-side.** Once a turn ran in `mode: 'plan'`, every subsequent turn on the same thread stays in plan until we explicitly send `mode: 'default'` again. The engine therefore always emits the field on `turn/start`, never omitting it, so a Plan → Bypass switch actually takes effect. Mapping: Kōbō `plan` → `plan`, every other Kōbō mode → `default`. Plan mode is the only one that unlocks Codex's internal `request_user_input` tool.
- **Permission mode vs collaboration mode are independent.** Sandbox + approvalPolicy control *what the agent may do at OS level* (read-only / workspace-write, never / on-request / unless-trusted). `collaborationMode` is a separate session-level flag that gates internal Codex behaviour (notably interactive Q&A). Kōbō hides both behind a single "permission mode" selector and maps them together.
- **Sub-agents map to `collabAgentToolCall`.** Codex's analogue of Claude's Task tool is `collabAgentToolCall` (`spawnAgent` / `sendInput` / `resumeAgent` / `wait` / `closeAgent`). The mapper emits **both** a `tool:call` named `Task` (chat card) and a `subagent:progress` event (right-hand panel) per call, the same dual-emission Claude does. See `event-mapper.ts` `handleItemStarted` / `handleItemCompleted` for the `collabAgentToolCall` branch.
- **`fileChange` items carry a unified-diff blob.** The protocol shape is `{ path, kind: PatchChangeKind, diff: string }` per change; `kind` is a discriminated union, not a string. The mapper flattens the first change into a Claude-style Edit input (`{ file_path, diff, change_kind, move_path? }`) so the existing `ToolCallItem` renderer picks it up. The client parses the unified diff into `DiffLine[]` via `parseUnifiedDiff` in `inline-diff.ts`.
- **Streaming bursts trip auto-scroll.** Both engines can emit token deltas; Claude enables SDK partial messages as well. The naive `eventCount` watcher in `ActivityFeed.vue` triggered an animated `scrollToBottom(180)` per event, causing stacked animations and visible jank. Scroll requests are coalesced through `requestAnimationFrame`; preserve burst handling when changing the feed.
- **`MCP tools` need `default_tools_approval_mode: 'auto'` in `config.mcp_servers`.** Without it Codex flags every MCP tool call as needing user approval ("user cancelled MCP tool call"). Kōbō trusts every tool it spawns, so the options-builder pre-approves the namespace.

## Workspace operations

### Fresh sessions and LLM handoffs

`session-handoff-service.ts` owns manual transfers within a workspace, including
same-engine model changes. `session_handoffs` (migration v46) preserves the source,
target, request idempotency, report and operation state. Lifecycle reservations
permit only launches carrying their owner token; ordinary chat, reviews and
automatic writers remain excluded until completion or explicit cancellation.

Stop the source immediately and confirm closure before resuming its exact native
conversation for the optional report-only turn. The final destination always uses
a fresh conversation. Generation uses a scoped `submit_session_handoff` MCP tool;
the backend persists the report, publishes `.ai/handoffs/` documents and owns the
transition. Never treat this generation as auto-loop progress or settle uncertain
instructions through it. Pending instruction contents stay with the loop dispatcher.

`EngineProcess.ready`, when provided, confirms initial native session/turn
acceptance. A returned process handle alone is insufficient evidence that a
transfer started successfully. Startup reconciliation retains interrupted transfers
for an explicit retry/skip/cancel decision and never replays them automatically.
Stop cancels pending transfers, including while no engine is running. Preserve
source selection by last use after a review return; loading a historical completed
transfer must not change the user's currently selected conversation.
Failed, interrupted and cancelled transfers restore the source conversation as well
as its configuration once the engine is stopped. `agent_sessions.activation_order`
(migration v47) records starts, resumes and source restoration independently of real
start/end timestamps. Backend current-session and implicit-resume selection, and the
client's current-session helper, use this order with the legacy timestamp fallback.
Keep failed target sessions in history and do not force a historical handoff's
selection over a later conversation after reload.
Rolled-back targets have `activation_order = -1`: exclude them from default
selection and implicit resume, but retain their native id and execution history.
An explicit start/resume activates them again. Without a source conversation,
rollback clears the client selection, including stale persisted preferences,
so the next ordinary message starts a fresh conversation on the restored engine.
Pending wakeups pinned to the source move to the destination only after confirmed
startup, in the same transaction as handoff completion. Preserve their prompt and
deadline, and never rebind a wakeup belonging to another conversation.

### Review LLM and return to the original session

The current conversation is the running session, or the last activated session,
falling back to `max(startedAt, endedAt)` for legacy rows. Keep the session list in creation order,
but do not use its first entry to identify the current conversation: a temporary
review can return to an older session. The stale-session banner and the next
review's return target must recognize that original session, including on reload.

`StartReviewDialog.vue` uses the shared model/effort/permission catalogues. Changed
settings force a new session on both client and server. `review-service.ts`
validates before side effects, waits for confirmed shutdown, then applies the
selected configuration and launches the review. Without a return request, these
settings remain the workspace defaults. Legacy requests retain their behavior.

The optional `returnToSession` flag captures the exact resumable original session.
`pending_review_returns` persists its configuration and the review session id
before switching engines. The orchestrator intercepts a successful review end
(including watchdog closure without a nonzero exit), restores configuration and
resumes that exact native conversation with the reviewer's final text report.
Resume selection is scoped to the target engine; never pass a reviewer's native
conversation id to the original engine, even after cancellation or restart.
The report reassembles text deltas/final snapshots, is bounded to 24,000 characters,
and links back to the complete review session through the conversation tool.
The receiving agent is asked to summarize and await instructions before fixes.
The intent is consumed before delivery, preventing repeated ends from sending twice.
Errors restore settings without automatically resuming; explicit stop cancels the
return. Startup restores interrupted-review settings without replaying a possibly
already-delivered handoff. Preserve these guards and the auto-loop interception.
`workspace:configuration` is ephemeral and updates all four LLM settings across tabs.

### Delete confirmation

The workspace deletion dialog requires the exact `workingBranch`, not the editable
workspace title. Trim surrounding whitespace from the confirmation input, but
preserve case and the full branch name. Display the branch separately from the
input label so long values remain readable; retain the worktree/history warning.

### Attachments during creation

`CreationAttachments.vue` keeps `File[]` in the create form, with image-only
object-URL previews revoked on removal/unmount. The workspace store sends
existing JSON requests unchanged when there are no files; attachments use
multipart fields `workspace` (one JSON string) and repeated `attachments`.
The legacy `images` field is accepted too; both fields share validation limits.
`attachment-service.ts` validates before workspace/git side effects,
then saves after the worktree exists and before setup/agent launch. Images use
`image-service.ts`; documents use generated filenames in `.ai/attachments/`,
exclusive writes and the existing directory-containment helper. File ownership
is recorded immediately after exclusive open so partial writes are cleaned on
failure. Creation excludes `.ai/attachments/` from Git; document uploads also
ensure that exclusion for existing workspaces. Never use an
uploaded filename as a storage path. The initial prompt stores image references
and document names/paths for normal starts and setup retries. Documents are
copied byte-for-byte, with no PDF extraction or OCR.
Limits and supported formats live in `src/shared/attachments.ts`:
10 files, 50 MiB each, 50 MiB total; the creation route limits the body to 51 MiB.
Document validation uses supported filename extensions because browser MIME
labels can be empty or generic. A failed creation cleans its own uploaded files
from reused worktrees, preserving existing files; setup failures retain the
workspace, files and initial prompt. Comparison requests copy the same browser
files independently. Attachments are not persisted in form presets.
See [creation attachments](CONFIGURATION.md#attachments-in-the-creation-description).

### Chat attachments

`POST /api/workspaces/:id/attachments` in `routes/images.ts` accepts one multipart
`attachment`, validates it with the shared `attachments.ts` policy and returns
`uid`, `kind`, `path`, `originalName`, and `reference`. It uses the same storage as
creation and a lifecycle guard against concurrent purge/delete. Document deletion
accepts only the generated filename at `DELETE /:id/attachments/:filename`; images
retain their existing retrieval/deletion endpoints. The legacy image upload also
uses the 50 MiB limit.

`use-chat-attachments.ts` owns pending upload state, draft-level limits and serial
uploads. `ChatInput.vue` transfers file ownership when sending/queuing, restores
badges on failed sends, and discards unsent files on workspace/session changes.
Late upload receipts are cleaned up using the captured original workspace id.
Never delete handed-off files when clearing a draft or changing conversations.
See [chat attachments](CONFIGURATION.md#attachments-in-workspace-chat).

### Setup during PR import

Resolving a PR checkout enables `skipSetupScript` by default, but the create
form leaves this toggle editable for PR imports. `resolveCreateOverrides`
preserves that choice and the request explicitly sends false when setup is wanted.
After successful PR extraction, the server runs setup only for an explicit
`skipSetupScript: false`; an omitted field continues to skip it. Ordinary worktree
reuse outside PR import still forces setup off. Worktree ownership is unchanged.

### Change source branch

`change-source-branch-service.ts` re-targets a workspace onto a new source branch. The default path is a cherry-pick of the branch-proper commits (commits in the working branch but in **neither** the old nor the new base), inspired by the sekur `deploy-preprod-rebase.yml` workflow. The route is `POST /api/workspaces/:id/change-source-branch` and returns a discriminated status: `done | aligned | conflict | too-many | dirty`.

- **Built-in cherry-pick**: `fetchAllBranches` → `listProperCommits` → `stashPush` (if dirty + aligned) → backup branch (`kobo-backup/<branch>-<unix-ts>`) → `reset --hard origin/<new>` → cherry-pick replay → optional force-push prompt → forge PR-base update via `provider.changePrBase`. Conflicts leave the worktree in a cherry-pick state for the user/agent to resolve via `POST /:id/git/resolve-with-agent`. `GitConflictError` carries an `operation: 'rebase' | 'merge' | 'cherry-pick'` discriminator.
- **Custom bash override**: if `effective.changeSourceBranchScript` is non-empty (per-project override or global default), the script **replaces** the built-in flow. Spawned with `bash -c`, cwd = worktree, 5 min timeout, stderr captured (last 8 KB). Exit 0 → Kōbō updates the source-branch metadata; any non-zero exit → the stderr tail is propagated as a clean error. The user-facing menu item only shows when the resolved script is non-empty; clearing the effective script hides the action; the global default is the bundled Kōbō script.
- **Custom-script env vars**: `KOBO_NEW_BASE`, `KOBO_OLD_BASE`, `KOBO_WORKING_BRANCH`, `KOBO_WORKTREE_PATH`, `KOBO_PROJECT_PATH`, `KOBO_PROJECT_NAME`, `KOBO_WORKSPACE_ID`, `KOBO_WORKSPACE_NAME`, `KOBO_FORGE`, `KOBO_PR_NUMBER` (empty when no PR/MR is open). The default script lives in `settings-defaults.ts` and is seeded into `global.changeSourceBranchScript` by settings migration v33; the client reads it through `GET /api/settings/defaults` for the "Reset to Kōbō default" button. See [CONFIGURATION.md → Custom change-source-branch script](CONFIGURATION.md#custom-change-source-branch-script).

### Lifecycle hooks

`src/server/services/lifecycle-hook-service.ts` runs a user-provided bash script on three moments that previously had none: `session-ended` (from `orchestrator.onSessionEnded`, once a session is known not to be superseded), `pr-merged` (from the pr-watcher, at the `pr:merged` emit, before archive/purge) and `autoloop-disabled` (from `auto-loop-service.disable`, for **every** reason including `user-action`, unlike the cleanup script which only fires on `completed`). The session-ended hook goes through `fireSessionEndedHook`, which also covers the watchdog's dead-engine sweep (that path never reaches `onSessionEnded`), dedupes by session id so a late `session:ended` from the same engine does not fire it twice, and stands down when the stop cause is `delete` or `purge` (`stopAgentAndWait`'s third argument) because the worktree is being removed.

Each event maps to one effective-settings key (`sessionEndedScript` / `prMergedScript` / `autoLoopDisabledScript`, settings migration v55), cascading project-over-global with empty meaning inherit. Execution reuses `runScript` with `eventPrefix: 'hook:<event>'`; `runScript` gained an `extraEnv` option, merged **under** the identity variables so a hook payload can never claim a different `WORKSPACE_ID`. `runLifecycleHook` never rejects and returns `null` when there is nothing to run (no script, unknown workspace, worktree gone). The pr-watcher awaits the `pr-merged` hook before auto-purge so a deploy script does not lose its worktree mid-run. See [CONFIGURATION.md → Lifecycle hooks](CONFIGURATION.md#lifecycle-hooks).

### Engine comparison

Successful paired creation opens the existing `split` route with `left` and `right` workspace ids in creation order. A single successful creation keeps the normal workspace route, including when the second creation fails.

One task, two engines, two sibling worktrees. `POST /api/workspaces` accepts a `comparisonId`; the client posts twice with the same one (sequentially — parallel creations contend on the git index lock), suffixing the name with the engine's display name and the branch with the engine id and giving the non-configured engine the model picked for it on the form and its own effort / permission defaults. `workspaces.comparison_id` (migration v40) groups them; `listComparisonMembers` reads them back, treating an empty id as no group rather than as a match against the NULL majority. `GET /api/workspaces/:id/comparison` returns each member with its cached git stats (`null`, never zeros, when nothing has been measured). `ComparisonPanel.vue` renders the table at the top of the Git tab, only for workspaces that belong to a comparison. See [CONFIGURATION.md → Comparing two engines on one task](CONFIGURATION.md#comparing-two-engines-on-one-task).

### Unanswered question reminder

`src/server/services/awaiting-user-reminder-service.ts` polls every 60 s for non-archived workspaces in `awaiting-user` and, past `global.awaitingUserReminderMinutes` (settings migration v56, `0` = off, the default), broadcasts `workspace:awaiting-reminder` via `broadcastAll` — deliberately not `emitEphemeral`, since the user is by definition not watching that workspace. The client (`stores/websocket.ts`) turns it into the same browser notification + question sound pair used when the question is first asked.

`computeDueReminders` holds the interval arithmetic as a near-pure function over an injected `Map<id, {firstSeenAt, remindersSent}>`, so it is unit-tested without a timer or a DB. Two rules it encodes: a workspace that leaves `awaiting-user` is dropped from the map (answering resets the clock), and a tick that finds itself several intervals behind sends **one** reminder, not one per missed interval. State is in-memory only, like the pr-watcher's caches: a restart restarts the clock.

### Workspace templates and duplication

`workspace-template-service.ts` persists named presets of the create form in `<KOBO_HOME>/workspace-templates.json` (same JSON pattern as `templates.json`, no SQLite migration). `sanitizePreset` keeps known keys with the right type and drops the rest, so a hand-edited file degrades to unset fields rather than errors. `presetFromWorkspace(id)` derives the same shape from an existing workspace (tasks as titles, statuses dropped); `GET /api/workspaces/:id/preset` exposes it read-only and "Duplicate" opens `/create?from=<id>` with it. On the client, `utils/workspace-preset.ts` (`capturePreset` / `applyPreset`, pure, round-trip tested) is the single bridge between the form and a preset; the create page applies the engine first and waits a tick so its engine watchers normalise model / effort / permission mode before the preset's values land. See [CONFIGURATION.md → Workspace templates and duplication](CONFIGURATION.md#workspace-templates-and-duplication).

### Onboarding tours

`src/client/src/tours/` declares one driver.js tour per zone (home, create, workspace, git-pr, settings, dashboard, health, search, changelog) as data, one file per zone plus `registry.ts` whose order is the Help menu order: each step carries a stable id, a `data-tour` anchor, an i18n key prefix and optionally `when` (a run-time gate, `anchorPresent` from `dom.ts` for the steps whose anchor is rendered conditionally), `beforeShow` (open a tab, then the engine waits for the anchor to be visible) and `clickTarget` (the anchor `beforeShow` clicks). `composables/use-tours.ts` owns the single driver instance and the seen-state (`localStorage['kobo:tours']`, step ids per tour, marked as each step is shown so leaving mid-way only replays the rest); `migrateLegacyFlag` turns the pre-tours boolean flag into a fully seen home tour. `autoRun` shows unseen steps only, never stacks over a running tour and never navigates - it bails unless the current route is the tour's route - so the main layout and the pages arm it through `scheduleAutoRun`, which delays it past their first render and clears the timer on unmount; a run refused because another tour is running is queued and replayed in registry order, and a run refused because a dialog is open is retried once. `runTour`, used by the Help menu in the sidebar (which lists every tour with its status and can reset them all) and by the per-screen replay buttons, is the only path that navigates to the tour's route first. `waitForVisible` in `dom.ts` waits until the anchor intersects the viewport, not merely until it exists in the DOM; when an anchor never shows up the engine skips that step with a console warning and does not mark it seen, so it replays next time. `SETTINGS_GROUPS` in `tours/settings.ts` groups the Settings tabs into one step each. `tours-registry.test.ts` is a drift guard with a deliberately narrow scope: it fails when a step's anchor or `clickTarget` has no matching `data-tour` attribute in a Vue source, when an i18n key is missing in one of the five locales, when a Settings tab is not in exactly one group, or when a step id listed in its hand-maintained list of gated steps has lost its `when`. It does not detect a newly conditional anchor on its own - adding a `v-if` around an anchor means adding the step id to that list. A feature that adds a screen or a Settings tab adds its step or group; step ids are never renamed once shipped.

### Worktree purge

`src/server/services/worktree-purge-service.ts` removes a workspace's worktree from disk while preserving the chat history and PR metadata. Triggered manually via `POST /api/workspaces/:id/purge-worktree` from the workspace context menu, or automatically by the pr-watcher when a PR transitions to MERGED **and** `global.autoPurgeOnPrMerged` is enabled (Settings → Worktrees toggle, settings migration v36).

Sequence: `captureRestoreData` (best-effort forge lookup for PR number / URL / merge SHA) → stop agent + dev server + terminal → `archiveWorkspace` → `removeWorktree` → `markWorktreePurged(restoreData)` → emit `workspace:worktree-purged`. Permission errors on removal (EACCES / EPERM, typically Docker-owned files in `node_modules` / `vendor`) trigger an attempt to reclaim ownership through a temporary Docker container and retry removal. If recovery fails, the UI offers manual cleanup guidance and prevention tips (Docker `USER`, default ACLs). Agent and dev-server shutdown must be confirmed before removal; shutdown failures leave the worktree in place. See [CONFIGURATION.md → Auto-purge worktree on PR merged](CONFIGURATION.md#auto-purge-worktree-on-pr-merged).

**Auto-restore on manual recreation.** When the user manually recreates the worktree folder (`gh pr checkout <pr-number>` or `git worktree add <path> <branch>`), the pr-watcher detects the folder reappearing on its next 30 s tick via `autoRestoreManuallyRecreatedWorktrees()`: it iterates archived workspaces with `worktreePurgedAt`, validates the exact worktree root, repository and working branch via `isMatchingWorkspaceWorktree`, and on a match calls `restoreWorktreeFromDisk(id)` which clears `worktree_purged_at` + `worktree_purge_restore_data` + `archived_at` in one transaction, then emits `workspace:worktree-restored`. The client websocket store reuses the same handler as `workspace:archived`/`unarchived` to refresh both the active and archived workspace lists. No UI action needed.

**Restore**: `POST /api/workspaces/:id/restore-worktree` calls `worktree-restore-service.ts` to recreate the exact checkout and only then clear purge/archive metadata via `restoreWorktreeFromDisk`. Source order: surviving local branch → optional `headCommitSha` in the existing restore JSON → exact branch fetched from `origin`. No SQL migration is needed for the optional JSON key; older records remain supported. No reset, overwrite, agent/dev-server start or setup script. `workspace-lifecycle-guard.ts` excludes overlapping restore/purge/delete operations, while the existing common-Git-directory lock serializes Git mutations. The watcher shares `isMatchingWorkspaceWorktree` validation and invalidates in-flight PR checks on restoration; delayed auto-purges carry their expected archive timestamp to avoid purging a workspace restored in the meantime. The context menu and purged banner expose the action; HTTP and the existing `workspace:worktree-restored` event reconcile client lists. Discarded uncommitted/ignored files and dependencies are not recoverable.

### Workspace navigation and activity digest

`utils/workspace-sort.ts` applies the browser-persisted sort within each drawer group; fuzzy search relevance remains primary. `ActionAvailability.vue` pairs disabled controls with visible, focusable explanations derived from `utils/action-blocker.ts`.

`SplitWorkspacePage.vue` hosts two same-origin embedded clients (`?pane=1`), isolating routers, stores and terminal registries. `utils/split-workspace.ts` and the router bridge synchronize the host URL without treating that bookkeeping as a departure. Actual departures consult both panes for dirty edits, unsent drafts and all in-memory queued messages. Embedded clients suppress automatic tours and browser/audio notifications; the host owns these.

`activity-service.ts` records significant metadata from `emit` and `emitEphemeral` in `workspace_activity` (migration v41, 30-day retention). It excludes streaming data and superseded session endings. `/api/activity` exposes a paginated monotonic cursor; `stores/activity.ts` keeps browser-local visit checkpoints and protects against late responses after visibility changes. `ActivityDigest.vue` links events to workspace/session or Git context. Never advance an unread checkpoint to the head of unloaded pages.

`global.activityDigestEnabled` (settings migration v58, default true) controls the
feature from Settings → Notifications. When false, `recordActivity` skips new
journal entries; `ActivityDigest.vue` hides its entry/dialog and removes its timer
and visibility/network listeners. Wait for settings to load before starting the
tracker. Disabling invalidates in-flight activity responses without acknowledging
unread events or deleting history; re-enabling resumes from the saved checkpoint.

### Workspace attention indicators

`src/client/src/utils/workspace-attention.ts` derives a small set of badges (CI failure, changes-requested) from the PR snapshot + git stats stored on each workspace. `WorkspaceAttentionLabels.vue` renders them inline on the workspace cards in the left drawer. The derivation is a pure function, easy to unit-test and free of IO. Drawer cards therefore stay reactive to whatever the pr-watcher / bulk-info refresh writes back into the store.

### Bulk workspace info refresh

`GET /api/workspaces/info` returns `{ workspaces, prSnapshots, gitStats }` in one shot. The client polls this endpoint every 15 s so every non-archived workspace stays ≤ 15 s fresh without a per-card stats request. The poll is skipped while the browser tab is hidden and fires once immediately when the tab becomes visible again. The server-side pr-watcher feeds the same caches (`lastKnownGitStats` map, PR snapshots) so the work is shared between the polling client and the watchdog loop.

### File editing in the diff viewer

The right panel of `DiffViewer.vue` is editable when the workspace agent is stopped and the file is not in `deleted` status. `Ctrl/Cmd+S` or the explicit Save button persists the file via `POST /api/workspaces/:id/save-file`, sending `{ path, content, baseSha }` where `baseSha` is the sha256 captured at `GET /diff-file` time. The route refuses with **412 Precondition Failed** + `{ currentSha }` if the on-disk content has changed; the client shows a Reload / Keep mine dialog. Worktree-traversal guards (including parent-symlink escapes) and a 1 MB size cap live in `file-editor-service.ts`. Changing files in the tree while dirty pops an "Unsaved changes" prompt.

## Code conventions

**Service layer** throws descriptive errors; the route layer catches and maps to HTTP status codes. Error messages follow the pattern `` `Workspace '${id}' not found` `` / `` `... is already archived` ``.

**Route layer** is thin: always wrap the handler body in `try / catch` and return `c.json({ error: message }, status)`. Match the existing shape in `src/server/routes/workspaces.ts`.

**Best-effort failures** may be logged and swallowed for non-critical side effects such as lifecycle-hook reporting. Process shutdown is a precondition for destructive operations: use `stopAgentAndWait` with `assertAgentStopped`, propagate dev-server shutdown failures, and retain the worktree when shutdown is unconfirmed. See [Audit remediation contracts](#audit-remediation-contracts-september-2026).

**Route ordering matters** in Hono. Static paths (`GET /archived`) MUST be declared **before** dynamic segments (`GET /:id`) or the dynamic segment captures them. There's a regression test locking this invariant in `src/__tests__/routes-workspaces.test.ts`.

**File size**: prefer focused files. `WorkspaceList.vue` and `workspaces.ts` (routes) are the largest files; don't grow them further without a clear reason. If a file approaches unwieldy, surface it as a concern rather than silently splitting it.

**Dependencies**: root `package.json` covers backend + tests. `src/client/package.json` is a separate npm tree. Install both.

## Internationalization (i18n)

The frontend uses `vue-i18n` with 5 supported locales: English (`en`), French (`fr`), German (`de`), Spanish (`es`), Italian (`it`). Translation files live in `src/client/src/i18n/`; the dependency version is declared in `src/client/package.json`.

**Mandatory rules for all frontend code:**

- **NEVER hardcode user-visible text** in Vue templates or scripts. Always use `$t('key')` in templates and `t('key')` in `<script setup>` (via `const { t } = useI18n()`).
- When adding or modifying a text, **update ALL 5 locale files** (`en.ts`, `fr.ts`, `de.ts`, `es.ts`, `it.ts`) with the corresponding translation.
- Keys follow the pattern `'component.label'` (e.g. `'git.push'`, `'settings.title'`, `'common.save'`). Use the existing key structure as reference.
- Keep technical terms in English across all locales when that's the industry convention (Git, PR, Push, Diff, Commit, Branch, Tokens, etc.).
- Placeholders like `{count}`, `{n}`, `{query}` must remain intact in all translations.
- The language selector is in the Settings page (Global tab). The locale is auto-detected from the browser on first visit and persisted in `localStorage('kobo:locale')`.

## Testing discipline

- **TDD for backend**: write the failing test, confirm it fails for the right reason, implement minimally, confirm it passes, commit. One commit per logical unit. See `src/__tests__/workspace-service.test.ts` for the setup pattern: `resetDb()` creates a fresh database in a temporary directory, initializes its schema, and closes/removes it after each test.
- **Route tests** use `vi.mock()` on service modules before imports (see `src/__tests__/routes-workspaces.test.ts`). Keep mocks complete; missing exports cause obscure failures.
- **Frontend tests** cover Pinia stores, pure utilities, composables, and selected Vue components (for example `ActivityFeed`, `TurnCard`, and `WorkspaceCard`). Run with `cd src/client && npm test`; use Vue Test Utils and the existing `happy-dom` setup for component regressions. Run `cd src/client && npm run type-check` for Vue/TypeScript checking, and use manual smoke tests for browser behavior that the DOM test environment cannot exercise.
- **`beforeEach(() => vi.clearAllMocks())`** is the convention for all route test files.

## Git workflow

- Feature branches live under `.worktrees/<name>` (git worktrees, not checkout switching). The directory is gitignored.
- Branches named `feature/<slug>` target `develop`. `develop` merges to `main` for releases.
- This project uses the **superpowers** skills workflow: brainstorming → writing-plans → subagent-driven-development → finishing-a-development-branch. Specs land in `docs/superpowers/specs/`, plans in `docs/superpowers/plans/`. Both directories are gitignored for new files going forward.
- NEVER `git push --force` without explicit user consent. Always prefer `--force-with-lease` over `--force` when rewriting pushed branches.

### Commit rules (mirrors `DEFAULT_GIT_CONVENTIONS` in `src/server/services/settings-service.ts`)

These rules are the source of truth and are also written to `.ai/.git-conventions.md` inside every workspace that the agent creates. Follow them when committing on this repository too.

**Commits**
- Use Conventional Commits: `type(scope): subject`
- Types: `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`, `perf`, `build`, `ci`
- Subject: imperative mood, lowercase, no trailing period, max 72 chars
- Body: wrap at 72 chars, explain *why* not *what*
- Reference issues with `Refs #123` or `Closes #123`
- **NEVER add a `Co-Authored-By:` trailer**, regardless of whether the commit was assisted by an AI agent. Commits on this repository must have a single human author.

**Branches**
- Feature: `feature/<short-kebab-case>`
- Fix: `fix/<short-kebab-case>`
- Never commit directly to `main`/`master`/`develop`

**Workflow**
- Rebase on the source branch before opening a PR; do not merge it in
- Keep commits atomic and self-contained (each compiles and passes tests)
- Squash fixup commits before pushing
- Never force-push to shared branches

**Safety**
- Never run destructive commands (`reset --hard`, `push --force`, `clean -fd`) without explicit user confirmation
- Never skip hooks (`--no-verify`) unless the user explicitly asks
- Always inspect `git status` and `git diff` before staging

## Human language

The human user of this repository prefers French for conversational exchanges. Code, tests, commit messages, and documentation (including this file) remain in English for toolchain compatibility, but chat responses should be in French unless the user switches.

## Design System

Always read `DESIGN.md` (repo root) before making any visual or UI decisions. Every
font choice, color, spacing value, and aesthetic decision is defined there. The CSS
variables in `src/client/src/css/design-tokens.scss` are the runtime source of truth
for the values documented in `DESIGN.md`; never hardcode hex colors or spacing
literals in components.

Aesthetic direction: **Brutally Minimal × Industrial** (Linear / Anthropic Console
reference). Dark-native, monochrome, single indigo accent (`--kobo-accent` /
`#6c63ff`) used sparingly. No purple gradients, no decorative illustrations, no
bubble-pill shapes, no spring physics. Geist + Geist Mono for technical values.

When reviewing or writing UI code, flag any deviation from `DESIGN.md`. Do not
deviate from the documented system without explicit user approval.

## What NOT to do

- Don't drop-and-recreate the database to apply schema changes. The project is in production, so every schema change ships as a migration that preserves data (see [Database migrations](#database-migrations)).
- Don't edit or reorder migration blocks that have already shipped. Migrations are append-only; fixes go in new migrations.
- Don't add confirmation dialogs for reversible actions (archive, unarchive). Only destructive actions (delete) get a dialog.
- Don't introduce ORMs, query builders, or schema validation libraries; the project is small enough for raw prepared statements and hand-written mappers.
- Don't break the single-source-of-truth of `CLAUDE.md` → `AGENTS.md` symlink. Edit `AGENTS.md`; `CLAUDE.md` follows automatically.
- Don't swallow failed or timed-out shutdowns before deleting, purging, or replacing a worktree. Only non-critical best-effort side effects may fail without blocking the primary operation.
- Don't hardcode user-visible text in the frontend. Every string must go through `$t()` / `t()` with keys in all 5 locale files. See [Internationalization (i18n)](#internationalization-i18n).
- Don't hardcode hex colors, spacing literals, or font names in components. Use the CSS variables from `src/client/src/css/design-tokens.scss` and the patterns in `DESIGN.md`. See [Design System](#design-system).


## Audit remediation contracts (September 2026)

- `stopAgentAndWait` returns `stopped | not-running | timeout | failed`. Destructive callers must pass its result through `assertAgentStopped`. A timeout or failure retains the same controller in `stopping` until actual stop completion; it never authorizes a replacement or worktree removal. Pending replacements remain cancellable and are finalized as `killed` when stopped before starting. Dev-server shutdown retains ownership of the entire process group until no live member remains, including when the shell exits first; process inspection failures propagate to destructive callers. A successful custom stop can override a failed generic Docker shutdown only after an independent successful query confirms no running containers with the exact project label.
- Acquire `withWorkspaceLifecycleGuard` before `withGitRepoLock`. Agent/dev-server starts check lifecycle ownership centrally. Wakeups and cron defer while busy; auto-loop waiters are reconsidered on guard release and confirmed capacity release. A user stop persistently disables auto-loop, including while waiting for capacity without a controller. Internal stops explicitly pass `replacement`, `setup`, `archive` or `shutdown` to preserve that intent; delete and purge retain their dedicated causes.
- Quota-backoff `arm` receives the authoritative next `retryCount` from the orchestrator. Persist that value directly; consuming the preceding timer row must not reset the retry sequence.
- A quota retry with a residual controller awaits a confirmed technical stop before starting another iteration. Persist recovery before that await and retain its attempt count if the stop remains unconfirmed. Shutdown suspends quota, wakeup and cron timers without consuming their rows; late arms stay persisted but do not deliver until boot restores the schedulers. Automatic continuations also check shutdown when deferred lifecycle callbacks run, preserving auto-loop intent instead of treating a refused start as an error.
- Codex uses a 120-second stream-idle deadline and a bounded 30-minute deadline while normalized foreground tool calls remain unresolved. Synthetic `TodoWrite` calls emitted for completed plans must have matching results so they do not keep the tool deadline active. Human-input pauses remain independent of the tool timeout.
- Codex explicit stop confirms `exit` after each escalation, including `SIGKILL`; an unconfirmed exit rejects the stop instead of authorizing destructive follow-up. Exit listeners and deadlines are removed when that wait settles.
- Conversation loading indicators follow outstanding session/history/sync requests only while no content is available. Background refreshes must preserve the displayed conversation, component state and reading position, including feeds containing only user messages.
- PR diagnosis fingerprints are asynchronous and include binary staged/unstaged diffs and untracked file contents (symlink targets, not their destinations). Untracked nested Git repositories are fingerprinted recursively, including HEAD and index changes; ignored files and Git internals are excluded. Await them at every callsite. Workspace matching always includes normalized project identity.
- Daily DB backups are checked at startup and hourly, with the existing 24-hour minimum age and retention. Stop the scheduler and await its active backup before closing SQLite.
