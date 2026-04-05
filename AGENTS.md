# AGENTS.md

Guidance for AI coding agents (Claude Code, Cursor, etc.) working on this repository.

## What this project is

**Kōbō** (工房 — Japanese for "workshop") orchestrates multiple Claude Code agents across isolated git worktrees. Each "workspace" is a self-contained mission with its own worktree, branch, Claude session, optional dev server, optional Notion source-of-truth, and a dedicated MCP tools server. A Vue 3 UI lets the human track progress, read live agent output, and manage the lifecycle.

Single-user, single-machine dev tool. No auth, no multi-tenant concerns.

## Tech stack

**Backend** — Node.js ≥ 20, Hono (HTTP), `ws` (WebSocket), better-sqlite3 (WAL mode), nanoid, `@modelcontextprotocol/sdk`. TypeScript throughout, `tsx` for dev, `tsc` for production build.

**Frontend** — Vue 3, Quasar 2, Pinia, vue-router, marked + dompurify for markdown rendering. Vite via `@quasar/app-vite`.

**Database** — Single SQLite file under the **Kōbō home directory** (`~/.config/kobo/kobo.db` by default, overridable via `KOBO_HOME`). Fresh-install schema lives in `src/server/db/schema.ts` (`initSchema`); incremental migrations live in `src/server/db/migrations.ts`. **The project is in production** — every schema change MUST ship as a migration that preserves data, never as a breaking change to `initSchema` alone. See [Database migrations](#database-migrations) below.

**Kōbō home directory** — `KOBO_HOME` env var overrides everything. Otherwise `$XDG_CONFIG_HOME/kobo/`, else `~/.config/kobo/`. Contains `kobo.db`, `settings.json`, `skills.json`. **Development uses `./data/`** via the `KOBO_HOME=./data` prefix in the `dev` npm script, so local dev never touches your real `~/.config/kobo/` and can run in parallel with a production-installed Kōbō (`npx @loicngr/kobo`). See `src/server/utils/paths.ts`.

**Tests** — vitest (18 test files, 355+ tests at time of writing). No frontend test infrastructure.

## Commands

```bash
# Install
npm install                         # root
(cd src/client && npm install)      # client — separate tree

# Develop
npm run dev                         # backend only (tsx watch on src/server/index.ts)
npm run dev:client                  # frontend only (quasar dev)
npm run dev:all                     # both concurrently

# Check & test
npx tsc --noEmit                    # type check (the project's primary quality gate)
npm test                            # run full vitest suite
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
│   │   └── migrations.ts           # incremental migrations, bumped per feature
│   ├── services/                   # business logic — pure functions over db + external processes
│   │   ├── workspace-service.ts    # workspaces + tasks + agent_sessions CRUD
│   │   ├── agent-manager.ts        # spawns Claude Code CLI, streams stdout, tracks sessions
│   │   ├── dev-server-service.ts   # per-workspace dev server lifecycle (docker or npm process)
│   │   ├── websocket-service.ts    # emit / emitEphemeral to subscribed clients
│   │   ├── worktree-service.ts     # git worktree create/remove
│   │   ├── notion-service.ts       # extract Notion page via @notionhq/notion-mcp-server (user-provided token)
│   │   ├── settings-service.ts     # global + per-project settings cascade
│   │   └── pr-template-service.ts  # pure template variable substitution
│   ├── routes/                     # Hono handlers, thin layer over services
│   │   ├── workspaces.ts           # /api/workspaces/* — the main surface
│   │   ├── dev-server.ts, git.ts, notion.ts, settings.ts
│   ├── utils/
│   │   ├── git-ops.ts              # pushBranch, getCommitsBetween, delete{Local,Remote}Branch…
│   │   └── process-tracker.ts      # per-workspace spawned-process map
├── client/                         # Vue 3 + Quasar SPA
│   └── src/
│       ├── stores/                 # pinia: workspace, websocket, settings, dev-server
│       ├── components/             # WorkspaceList, NotionPanel, AcceptancePanel, ChatInput, GitPanel…
│       ├── pages/                  # WorkspacePage, CreatePage, SettingsPage
│       └── router/
├── mcp-server/                     # standalone MCP server spawned per workspace
│   ├── kobo-tasks-server.ts        # entrypoint, registers tools
│   └── kobo-tasks-handlers.ts      # pure handlers (list_tasks, mark_task_done)
└── __tests__/                      # vitest, one file per service/route
```

## Data model (SQLite)

| Table | Purpose |
|---|---|
| `workspaces` | the unit of work — id, name, project_path, source_branch, working_branch, status, notion_url, model, dev_server_status, `archived_at`, timestamps |
| `tasks` | workspace sub-items — title, status, `is_acceptance_criterion`, sort_order; CASCADE DELETE on workspace |
| `agent_sessions` | Claude Code CLI invocations — pid, `claude_session_id`, status, started_at, ended_at |
| `ws_events` | persisted WebSocket events for replay on reconnect — type, payload, session_id, created_at |

`status` enum: `created | extracting | brainstorming | executing | completed | idle | error | quota`. Transitions are validated in `updateWorkspaceStatus` against `VALID_TRANSITIONS`.

`archived_at` is **orthogonal** to `status` — archiving is a visibility flag, not a lifecycle state. Unarchive restores the exact pre-archive `status`.

## Database migrations

**The project is in production**. Every schema change MUST ship as an incremental migration that preserves existing data. Never drop-and-recreate, never rely on `initSchema` alone to patch running databases.

### The two files and their roles

- **`src/server/db/schema.ts`** — `initSchema(db)` is the source of truth for **fresh installs only**. It creates every table at its current shape. New installations (empty `data/` directory) run `initSchema` once and land at the latest `SCHEMA_VERSION`.
- **`src/server/db/migrations.ts`** — `runMigrations(db)` reads the current `version` from the `schema_version` table and sequentially applies every pending migration block up to `SCHEMA_VERSION`. Existing databases upgrade through this path.

Both files must be kept in sync: after adding a migration, update `initSchema` so fresh installs get the same final shape without replaying migrations.

### Adding a migration for a new feature

Every feature that touches the schema:

1. Bump `SCHEMA_VERSION` in `migrations.ts` (e.g. `1` → `2`)
2. Add a new guarded block at the bottom of `runMigrations` that applies only if `currentVersion < newVersion`, using `db.exec` (better-sqlite3) to run raw SQL like `ALTER TABLE workspaces ADD COLUMN new_field TEXT`
3. Update `initSchema` in `schema.ts` so the fresh-install shape matches (e.g. add the new column to the `CREATE TABLE` statement)
4. At the end of `runMigrations`, bump the row in `schema_version` to the new `SCHEMA_VERSION` (the existing code already does this)
5. Add a test in `src/__tests__/migrations.test.ts` that verifies:
   - A database at the previous version can be upgraded without data loss
   - The new version matches `SCHEMA_VERSION`
   - Fresh installs and upgraded installs converge to the same schema
6. Never edit or reorder migration blocks that have already shipped — they are historical. If you need to fix a mistake, add a new migration.

### Rules

- **Migrations are append-only.** Shipped migration blocks are frozen. Fixes go in new migrations.
- **Always idempotent where possible.** Use `IF NOT EXISTS`, check for column existence before altering, etc. Prefer migrations that can be safely re-run.
- **`ALTER TABLE ADD COLUMN` is safe in SQLite** (even on large tables). For more invasive changes (rename, drop, change type), use the [12-step SQLite pattern](https://sqlite.org/lang_altertable.html#otheralter) within a transaction.
- **Run migrations on every backend start.** `runMigrations(db)` is called from `getDb()` via `src/server/db/index.ts`.
- **Test upgrades, not just fresh installs.** The `migrations.test.ts` suite must exercise "old DB → new DB" paths.

## WebSocket protocol

Clients subscribe to individual workspace ids. The server sends `WsEvent` objects:

```ts
{ id, workspaceId, type, payload, sessionId?, createdAt }
```

Common types: `agent:output`, `agent:status`, `agent:error`, `user:message`, `task:updated`, `devserver:status`, `workspace:archived`, `workspace:unarchived`, `sync:response`.

Two emit flavors in `websocket-service.ts`:
- `emit(workspaceId, type, payload)` — persists to `ws_events` for later replay via `sync:request` on reconnect
- `emitEphemeral(workspaceId, type, payload)` — delivered once, never persisted. Use for lifecycle events (archive, status changes) that shouldn't replay.

## External integrations

### Notion (opt-in, user-provided credentials)

`notion-service.ts` spawns the official [`@notionhq/notion-mcp-server`](https://github.com/makenotion/notion-mcp-server) as a child process (`npx -y @notionhq/notion-mcp-server`) and talks to it over stdio using JSON-RPC / MCP. **Kōbō ships no Notion credentials** — the feature only works if the user has configured their own integration token. The token is resolved in this order:

1. `NOTION_API_TOKEN` env var
2. `NOTION_TOKEN` env var
3. `~/.claude.json` → `mcpServers.notion.env.NOTION_TOKEN` / `NOTION_API_TOKEN` (Claude Code's MCP config — the recommended path, same token shared with Claude Code)

The MCP command and args can be overridden via `NOTION_MCP_COMMAND` (default `npx`) and `NOTION_MCP_ARGS` (default `-y @notionhq/notion-mcp-server`) for pinning a specific version or using a fork.

When adding features touching `notion-service.ts`, remember: **no token = no feature**. The rest of Kōbō must keep working if the Notion token is absent — only the explicit Notion import endpoints should fail with a clear error. Do not throw at server startup.

See the "Notion integration" section of the README for the end-user setup guide.

## Code conventions

**Service layer** throws descriptive errors; the route layer catches and maps to HTTP status codes. Error messages follow the pattern `` `Workspace '${id}' not found` `` / `` `... is already archived` ``.

**Route layer** is thin — always wrap the handler body in `try / catch` and return `c.json({ error: message }, status)`. Match the existing shape in `src/server/routes/workspaces.ts`.

**Swallowed failures** are acceptable (and required) for best-effort side effects like `agentManager.stopAgent` and `devServerService.stopDevServer` during delete/archive. Log with `console.error` and continue. Never let these break the happy path.

**Route ordering matters** in Hono. Static paths (`GET /archived`) MUST be declared **before** dynamic segments (`GET /:id`) or the dynamic segment captures them. There's a regression test locking this invariant in `src/__tests__/routes-workspaces.test.ts`.

**File size** — prefer focused files. `WorkspaceList.vue` and `workspaces.ts` (routes) are the largest files; don't grow them further without a clear reason. If a file approaches unwieldy, surface it as a concern, don't silently split.

**Dependencies** — root `package.json` covers backend + tests. `src/client/package.json` is a separate npm tree. Install both.

## Testing discipline

- **TDD for backend** — write the failing test, confirm it fails for the right reason, implement minimally, confirm it passes, commit. One commit per logical unit. See existing tests in `src/__tests__/workspace-service.test.ts` for the setup pattern (fresh in-memory DB per test via `resetDb()`).
- **Route tests** use `vi.mock()` on service modules before imports (see `src/__tests__/routes-workspaces.test.ts`). Keep mocks complete — missing exports cause obscure failures.
- **No frontend test infra.** Type-check via `npx tsc --noEmit` is the frontend gate. Manual smoke testing covers UI behavior.
- **`beforeEach(() => vi.clearAllMocks())`** is the convention for all route test files.

## Git workflow

- Feature branches live under `.worktrees/<name>` (git worktrees, not checkout switching). The directory is gitignored.
- Branches named `feature/<slug>` target `develop`. `develop` merges to `main` for releases.
- This project uses the **superpowers** skills workflow: brainstorming → writing-plans → subagent-driven-development → finishing-a-development-branch. Specs land in `docs/superpowers/specs/`, plans in `docs/superpowers/plans/`. Both directories are gitignored for new files going forward.
- NEVER `git push --force` without explicit user consent. Always prefer `--force-with-lease` over `--force` when rewriting pushed branches.

### Commit rules (mirrors `DEFAULT_GIT_CONVENTIONS` in `src/server/services/settings-service.ts`)

These rules are the source of truth and are also written to `.ai/git-conventions.md` inside every workspace that the agent creates. Follow them when committing on this repository too.

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
- Rebase on the source branch before opening a PR — do not merge it in
- Keep commits atomic and self-contained (each compiles and passes tests)
- Squash fixup commits before pushing
- Never force-push to shared branches

**Safety**
- Never run destructive commands (`reset --hard`, `push --force`, `clean -fd`) without explicit user confirmation
- Never skip hooks (`--no-verify`) unless the user explicitly asks
- Always inspect `git status` and `git diff` before staging

## Human language

The human user of this repository prefers French for conversational exchanges. Code, tests, commit messages, and documentation (including this file) remain in English for toolchain compatibility, but chat responses should be in French unless the user switches.

## What NOT to do

- Don't drop-and-recreate the database to apply schema changes. The project is in production — every schema change ships as a migration that preserves data (see [Database migrations](#database-migrations)).
- Don't edit or reorder migration blocks that have already shipped. Migrations are append-only; fixes go in new migrations.
- Don't add confirmation dialogs for reversible actions (archive, unarchive). Only destructive actions (delete) get a dialog.
- Don't introduce ORMs, query builders, or schema validation libraries — the project is small enough for raw prepared statements and hand-written mappers.
- Don't break the single-source-of-truth of `CLAUDE.md` → `AGENTS.md` symlink. Edit `AGENTS.md`; `CLAUDE.md` follows automatically.
- Don't skip `try/catch` swallowing on best-effort cleanup (agent stop, dev-server stop, worktree removal). These must never break the primary operation.
