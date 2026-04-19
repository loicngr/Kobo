# Kōbō

> **Kōbō** (工房) — Japanese for *workshop*. A multi-workspace agent manager for [Claude Code](https://claude.com/claude-code).

> [!NOTE]
> 🚧 **Active development** — breaking changes may still land on `develop`. The database layer ships with forward-only migrations and a timestamped pre-migration backup of `kobo.db` before any schema change, so upgrades preserve your data even across invasive refactors.

Kōbō lets you delegate multiple coding missions to Claude Code agents in parallel. Each workspace lives in its own isolated git worktree with its own branch, its own Claude session, optionally its own dev server, and a custom MCP tools server the agent uses to track progress. A Vue 3 dashboard shows live agent output, tasks, acceptance criteria, and git state across every workspace.

Think of it as an apprentice's hall: you hand out missions, each apprentice sets up their own workbench, and you watch them work from a single control surface.

## Features

- **Isolated git worktrees** — every workspace runs on its own branch in its own directory, so concurrent Claude sessions never step on each other
- **Pluggable agent engine** — Kōbō talks to agents through an `AgentEngine` contract with a normalised `AgentEvent` stream (`src/server/services/agent/engines/`). Claude Code is the first engine; dropping in another runtime (e.g. the Claude Agent SDK) only requires a new adapter, not a rewrite of the UI or orchestration layer
- **Rich chat feed** — live streaming text, thinking blocks, inline tool calls with expandable diffs for Edit/Write, per-turn session cards, markdown rendering, jump-to-previous-user-message button, and infinite scroll-up over persisted history
- **Task & acceptance criteria tracking** — the agent reports progress through a dedicated MCP server (`kobo-tasks`) that reads and updates tasks directly from the SQLite database
- **Documents panel** — tree view in the right drawer that surfaces every AI-generated markdown file under `docs/plans/`, `docs/superpowers/`, and `.ai/thoughts/`. Paths mentioned in chat messages are auto-detected against the catalogue and become one-click deep-links into the panel
- **Git panel with inline diff viewer** — Monaco-powered side-by-side / inline diff of the working branch against its source, with file tree (same q-tree as Documents), inline rebase/merge conflict resolution, and a clean action bar: `Sync` split-button (pull / rebase / merge), `Push`, `Diff`, `Create PR`
- **Notion integration** — pull workspace missions straight from Notion pages, extract markdown, and use it as the source of truth for acceptance criteria
- **Sentry integration** — paste a Sentry issue URL to spin up a dedicated "fix workspace" with the stacktrace, tags, and offending spans written to `.ai/thoughts/SENTRY-<id>.md`; the agent is primed with a TDD fix workflow and has access to the Sentry MCP tools for deeper digging
- **Per-workspace dev servers** — start/stop Docker or Node dev servers scoped to each branch, with log streaming
- **Conventional-commit enforcement** — project-level git conventions are written to `.ai/.git-conventions.md` inside every workspace so Claude follows them during commits
- **Pull request automation** — one-click `push`, `pull`, `open-pr`, and "change PR base" endpoints integrate with the GitHub CLI, using a configurable prompt template
- **Multi-session support** — create multiple Claude agent sessions per workspace, each with its own chat history; resume completed sessions via `--resume`; sessions are named and persisted in localStorage
- **Prompt templates** — personal library of reusable prompts with variable substitution (`{working_branch}`, `{commit_count}`, etc.), insertable from the chat input via `/` autocomplete; editable in Settings > Templates
- **Favorites and tags** — pin workspaces to the top via right-click favourite, organise with per-workspace tags filterable from the sidebar; a global tag catalogue keeps colours consistent across workspaces
- **Health panel + config export/import** — inspect backend health (agent sessions, migration state, dev servers, DB size) and roundtrip your Kōbō config (settings, templates, skills) between machines via JSON
- **Usage tracking** — rolling input/output token counts and cost estimates per workspace, aggregated across sessions and live-updated from `usage` events
- **Resizable right drawer** — drag-to-resize horizontally and vertically, with tab state and split ratio persisted to localStorage
- **Soft interrupt** — pause an agent mid-execution (SIGINT, like pressing Escape in Claude Code) without killing the process; the agent stops the current tool and waits for the next message
- **Archive instead of delete** — soft-remove workspaces without losing the worktree, branches, or history; unarchive restores the exact pre-archive state

## Tech stack

- **Backend** — Node.js ≥ 20, [Hono](https://hono.dev/), [better-sqlite3](https://github.com/WiseLibs/better-sqlite3), [ws](https://github.com/websockets/ws), [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk)
- **Frontend** — [Vue 3](https://vuejs.org/), [Quasar 2](https://quasar.dev/), [Pinia](https://pinia.vuejs.org/), `vue-router`, [Monaco Editor](https://microsoft.github.io/monaco-editor/) (git diff viewer), `marked` + `dompurify` (markdown rendering)
- **Tooling** — TypeScript, [Vitest](https://vitest.dev/), [Biome](https://biomejs.dev/) (lint + format), `tsx` for dev
- **Storage** — single SQLite file (`~/.config/kobo/kobo.db` by default, overridable via `KOBO_HOME`) with WAL mode and forward-only migrations

## Quick start

### Prerequisites

- Node.js ≥ 20
- [Claude Code CLI](https://claude.com/claude-code) installed and authenticated (`claude` on your `PATH`)
- Git
- Optional: Docker (if you configure per-workspace dev servers)
- Optional: `gh` CLI (if you use the PR automation)
- Optional: a Notion integration token (only if you want to import workspace missions from Notion pages — see [Notion integration](#notion-integration))
- Optional: a Sentry auth token (only if you want to create fix workspaces from Sentry issue URLs — see [Sentry integration](#sentry-integration))

### Run via `npx` (recommended)

```bash
SERVER_PORT=9998 PORT=9999 npx @loicngr/kobo@latest
```

That's it. npm downloads the package, installs dependencies, starts the Kōbō server on the port you specified, and serves the web UI at `http://localhost:9999`. Data is persisted to `~/.config/kobo/` (overridable via `KOBO_HOME`).

On first launch Kōbō creates `~/.config/kobo/` if it doesn't exist. If the `claude` CLI is missing from your `PATH` you will see a warning in the terminal — install Claude Code before creating your first workspace.

### Run from source (contributors)

```bash
git clone https://github.com/loicngr/kobo.git
cd kobo
npm install
(cd src/client && npm install)
```

### Run (development)

```bash
npm run dev:all
```

This starts the Hono backend on port `3300` (via `tsx watch`, with `KOBO_HOME=./data` so dev uses the repo-local data directory and never touches your real `~/.config/kobo/`) and the Quasar dev server on port `8080` concurrently. Open <http://localhost:8080> in your browser.

You can run a production-installed Kōbō (`npx @loicngr/kobo`) alongside a dev server without any conflict — they use different data directories by design.

To run them separately:

```bash
npm run dev         # backend only (KOBO_HOME=./data automatically)
npm run dev:client  # frontend only
```

### Build (production)

```bash
npm run build       # builds client + server
npm start           # runs the compiled server
```

### Test & lint

```bash
npm test            # backend vitest suite (740+ tests)
npm run test:client # client vitest suite (Pinia stores + pure utils, 85+ tests)
npm run test:all    # backend + client suites
npm run lint        # biome check (lint + format verification)
npm run lint:fix    # biome check with safe auto-fixes
npm run format      # biome format --write
npx tsc --noEmit    # server type check
```

## Notion integration

Kōbō can pull the content of a Notion page (title, body, checklists) and turn it into tasks and acceptance criteria when you create a workspace. **This feature is opt-in and requires you to configure your own Notion credentials** — Kōbō does not ship an API key.

Under the hood, Kōbō spawns the official [`@notionhq/notion-mcp-server`](https://github.com/makenotion/notion-mcp-server) as a child process and talks to it over stdio using the Model Context Protocol. The package is fetched via `npx -y @notionhq/notion-mcp-server` the first time you trigger an import, so there is nothing to install manually — only a token to provide.

### Getting a Notion integration token

1. Go to <https://www.notion.so/profile/integrations> and create a new internal integration
2. Give it a name (e.g. `kobo`) and the capabilities you need (at minimum: *Read content*)
3. Copy the internal integration secret (format `ntn_...` or `secret_...`)
4. Open the Notion page you want to import, click **…** → **Connections** → **Add connection** → select your integration. Kōbō can only read pages that are explicitly shared with the integration.

### Giving the token to Kōbō

Kōbō reads the token from the first source available, in this order:

1. `NOTION_API_TOKEN` environment variable
2. `NOTION_TOKEN` environment variable
3. `~/.claude.json` — if you already have the Notion MCP configured for Claude Code, Kōbō reads the token from `mcpServers.notion.env.NOTION_TOKEN` (or `NOTION_API_TOKEN`). **This is the recommended setup** — one token configured once, shared by both Claude Code and Kōbō.

Example: configure Notion MCP in Claude Code (one-time setup that also unlocks Kōbō's Notion import):

```bash
claude mcp add notion -s user -e NOTION_TOKEN=ntn_your_token_here -- npx -y @notionhq/notion-mcp-server
```

Or launch Kōbō with the token inline:

```bash
NOTION_API_TOKEN=ntn_your_token_here PORT=9999 npx @loicngr/kobo@latest
```

### Advanced: overriding the MCP command

If you need to pin a specific version of the Notion MCP server, use a fork, or avoid `npx`, set these env vars before launching Kōbō:

- `NOTION_MCP_COMMAND` — the binary to run (default: `npx`)
- `NOTION_MCP_ARGS` — space-separated arguments (default: `-y @notionhq/notion-mcp-server`)

Without a valid token configured, the Notion import field in the workspace creation form will return an error when you click **Refresh** or submit a Notion URL — the rest of Kōbō (workspaces, agents, tasks, Git integration) keeps working independently.

## Sentry integration

Kōbō can turn a Sentry issue into a dedicated "fix workspace" — you paste the issue URL at workspace creation and Kōbō extracts the stacktrace, culprit, tags, offending spans and extra context, writes them as a local markdown file inside the worktree (`.ai/thoughts/SENTRY-<id>.md`), and primes the Claude agent with a TDD fix workflow that points at that file. The agent also keeps access to the Sentry MCP tools (`search_issue_events`, `get_issue_tag_values`, `get_sentry_resource`) so it can dig deeper on its own. **This feature is opt-in and reuses the Sentry MCP configuration you already have for Claude Code** — Kōbō does not manage a Sentry token separately.

Under the hood, Kōbō spawns the official [`@sentry/mcp-server`](https://www.npmjs.com/package/@sentry/mcp-server) as a child process using the exact `command`, `args`, and `env` from your `~/.claude.json`, then calls `get_sentry_resource` over stdio. No token handling inside Kōbō — if you change the token or the host in your Claude Code config, Kōbō follows automatically.

### Getting a Sentry auth token

1. In Sentry, go to **Settings → Developer Settings → Custom Integrations** (or **User Auth Tokens** for personal use)
2. Create a token with at least these scopes: `project:read`, `event:read`, `org:read`
3. Copy the token (format `sntryu_...` for user tokens)

### Configuring the Sentry MCP in Claude Code

The recommended setup is to register the Sentry MCP once in Claude Code — Kōbō picks it up automatically:

```bash
claude mcp add sentry -s user \
  -e SENTRY_ACCESS_TOKEN=sntryu_your_token_here \
  -e SENTRY_HOST=your-org.sentry.io \
  -- npx -y @sentry/mcp-server@latest
```

For self-hosted Sentry, set `SENTRY_HOST` to your Sentry hostname (e.g. `sentry.mycompany.com`).

### How Kōbō picks the entry

Kōbō reads `~/.claude.json` and uses the first entry under `mcpServers` whose key contains `sentry` (case-insensitive) **and is not disabled**. This means:

- A single `sentry` entry → used as-is
- Multiple entries whose key contains `sentry` → the first matching non-disabled key wins
- Toggle `"disabled": true` on an entry to make Kōbō skip it

### Usage

1. In the workspace creation form, click **Import Sentry**
2. Paste the issue URL (e.g. `https://your-org.sentry.io/issues/112081699`)
3. Submit — Kōbō extracts the issue, writes `.ai/thoughts/SENTRY-<numericId>.md`, creates a `Fix: <title>` task, and boots the agent with the fix workflow

The Sentry issue Short-ID (e.g. `ACME-API-3` — the canonical identifier Sentry assigns to each issue) is used as the ticket prefix for the working branch (e.g. `fix/ACME-API-3--slow-db-query` or `bugfix/ACME-API-3--slow-db-query`, depending on the branch prefix you chose at creation). The Short-ID is also what Sentry recognises in commit messages like `Fixes ACME-API-3` to auto-close the issue on merge. The local copy of the issue is written to `.ai/thoughts/SENTRY-<shortId>.md` (e.g. `SENTRY-ACME-API-3.md`). When Sentry is active, the description field becomes optional — the extracted context is enough to start work.

If the MCP server is slow to initialize (e.g. cold `npx` fetch, self-hosted host validation), bump the handshake timeout with `KOBO_MCP_INIT_TIMEOUT_MS` (default: `30000`).

Without a valid Sentry MCP configured in `~/.claude.json`, the Sentry import field returns a clear error when you submit — the rest of Kōbō keeps working.

## Recommended: Superpowers plugin for Claude Code

For the best experience, we recommend installing the [**superpowers**](https://github.com/obra/superpowers) plugin in Claude Code. Kōbō is designed to work well with it out of the box:

- **Brainstorming → spec → plan → execute** workflow — superpowers produces design specs in `docs/superpowers/specs/` and implementation plans in `docs/superpowers/plans/`; Kōbō's **Plan browser** (right-side drawer) lists both so you can review them without leaving the UI
- **Subagent-driven development** — executes plans task-by-task via parallel subagents; Kōbō surfaces sub-agent activity in the chat feed and the *Agent busy* banner so you always know what's running
- **Test-driven development, systematic debugging, code review** — all integrated with Kōbō's task tracking and git workflow

Install inside Claude Code:

```bash
/plugin marketplace add obra/superpowers-marketplace
/plugin install superpowers@superpowers-marketplace
```

Then start a new workspace in Kōbō — the agent will pick up the skills automatically.

## Architecture

```
src/
├── server/                                 # Hono backend
│   ├── index.ts                            # app bootstrap + WS upgrade
│   ├── db/                                 # SQLite schema, migrations, singleton
│   ├── services/
│   │   ├── agent/                          # agent engine abstraction (replaces agent-manager.ts)
│   │   │   ├── orchestrator.ts             # per-workspace engine map, retry/quota, watchdog, public API
│   │   │   ├── session-controller.ts       # lifecycle wrapper around one AgentEngine instance
│   │   │   ├── event-router.ts             # maps engine AgentEvent stream to WS emit + DB side-effects
│   │   │   └── engines/claude-code/        # spawn + NDJSON stream-parser + args-builder + mcp-config + capabilities
│   │   ├── content-migration-service.ts    # legacy ws_events → normalised AgentEvent rows, with DB backup
│   │   └── …                               # workspace, dev-server, ws, notion, sentry, settings, pr-template
│   ├── routes/                             # Hono handlers (workspaces, engines, migration, templates, …)
│   └── utils/                              # git-ops, process-tracker, paths
├── shared/                                 # modules shared by backend and frontend (e.g. model catalogue)
├── client/                                 # Vue 3 + Quasar SPA
│   └── src/
│       ├── stores/                         # Pinia: workspace, websocket, agent-stream, migration, settings, …
│       ├── components/                     # ActivityFeed, TurnCard, WorkspaceList, ChatInput, GitPanel, …
│       ├── services/                       # agent-event-view (foldEvents), conversation-turns (groupIntoTurns), inline-diff
│       ├── pages/                          # WorkspacePage, CreatePage, SettingsPage
│       └── router/
├── mcp-server/                             # standalone MCP server spawned per workspace
│   ├── kobo-tasks-server.ts                # entry point, registers list_tasks & mark_task_done
│   └── kobo-tasks-handlers.ts              # pure handlers over SQLite
└── __tests__/                              # Vitest suite (engines, orchestrator, migration, routes, …)
```

See [`AGENTS.md`](./AGENTS.md) for a deeper dive into conventions, data model, WebSocket protocol, and contribution guidelines.

## Data model

| Table | Purpose |
|---|---|
| `workspaces` | the unit of work — branch, status, model, engine, `archived_at`, `favorited_at`, `tags`, Notion link, … |
| `tasks` | workspace sub-items — tasks and acceptance criteria |
| `agent_sessions` | agent runs — pid, `engine_session_id`, lifecycle |
| `ws_events` | persisted WebSocket events (chat history, `agent:event` stream, user messages) for replay on reconnect |

## MCP server

Each workspace spawns its own `kobo-tasks` MCP server as a child process of the Claude Code agent. It exposes two tools:

- `list_tasks()` — returns all tasks & acceptance criteria for the current workspace with their IDs and status
- `mark_task_done(task_id)` — marks a task as done and notifies the backend over HTTP so the UI updates live

The MCP server reads and writes the same SQLite database as the main backend. Isolation between workspaces is enforced via the `KOBO_WORKSPACE_ID` environment variable passed at spawn time and validated on every query.

## Configuration

Kōbō reads settings from `~/.config/kobo/settings.json` (or falls back to defaults). Global settings cascade into per-project overrides:

- `defaultModel` — Claude model to use (e.g. `claude-opus-4-6`)
- `prPromptTemplate` — template rendered when opening a PR via the `/open-pr` endpoint; supports `{{pr_number}}`, `{{pr_url}}`, `{{branch_name}}`, `{{diff_stats}}`, `{{commits}}`, etc.
- `gitConventions` — markdown-formatted git conventions written to `.ai/.git-conventions.md` in every workspace so the agent follows them when committing
- `devServer` — per-project `startCommand` / `stopCommand` for launching workspace-scoped dev servers

## Contributing

This is a personal tool, but PRs and issues are welcome. Before submitting:

1. Read [`AGENTS.md`](./AGENTS.md) — it covers the commit rules, branching model, and code conventions
2. Run `npm run lint`, `npx tsc --noEmit`, and `npm test` locally
3. Base your branch on `develop` (not `main`); PRs target `develop`

CI runs lint + type check + tests on every PR to `develop`.

## License

GNU General Public License v3.0 or later. See [`LICENSE`](./LICENSE) for the full text.

Kōbō links against [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3), [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk), [Vue](https://vuejs.org/), [Quasar](https://quasar.dev/), and other open-source libraries — see `package.json` for the full list.
