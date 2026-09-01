# Kōbō

**Run a fleet of Claude Code and Codex agents in parallel — each in its own git worktree, all from one dashboard.**

[![npm](https://img.shields.io/npm/v/@loicngr/kobo.svg)](https://www.npmjs.com/package/@loicngr/kobo)
[![license](https://img.shields.io/npm/l/@loicngr/kobo.svg)](./LICENSE)
[![node](https://img.shields.io/node/v/@loicngr/kobo.svg)](https://nodejs.org/)

Kōbō (工房, "workshop") turns *one agent, one terminal* into a real workflow. Spin up as many isolated workspaces as you need, watch every agent work live, review and merge their diffs from a Monaco-based Git panel, and let auto-loop or scheduled wakeups keep them going while you're away.

> [!NOTE]
> Active development on `develop`. Forward-only migrations and timestamped pre-migration backups keep upgrades safe.

![Kōbō workspace view: live chat and git panel](docs/assets/images/workspace-chat.png)

## Why Kōbō

| | |
|---|---|
| **🗂️ Isolated worktrees, two engines** | Every workspace is its own git worktree and branch — parallel sessions never collide. Pick Claude Code or OpenAI Codex per workspace, and switch engines later without losing the worktree: Kōbō hands off tasks, git state, and recent context to a fresh session. |
| **💬 Live chat, real diff review** | Streaming responses, inline Edit/Write diffs, a reasoning panel, and a Monaco diff viewer with **inline file editing**, conflict resolution, and one-click `Sync` / `Push` / `Open PR` / `Merge`. |
| **🔁 Auto-loop, cron, wakeups** | Turn an agent loose on the task list: it works through tasks, retries on rate limits, and stops itself when there's nothing left, progress stalls, or it needs you. Cron schedules and one-shot wakeups keep workspaces moving on their own timeline. |
| **🔀 Create from a PR/MR, or from a ticket** | Pick an open pull/merge request from GitHub, GitLab, or Bitbucket and Kōbō resolves every local conflict for you before spinning up the workspace. Or start straight from a Notion page or a Sentry issue URL. |

## Quick start

Requires Node.js ≥ 24.15 and a logged-in Claude Code **or** Codex CLI.

```bash
npx @loicngr/kobo@latest
```

Open <http://localhost:3000>. Data is persisted under `~/.config/kobo/` (override via `KOBO_HOME`).

Default port is `3000`; if it's taken, `SERVER_PORT` (checked first) or `PORT` picks another:

```bash
SERVER_PORT=9997 PORT=9998 npx @loicngr/kobo@latest
```

Kōbō's production build is an installable PWA — use your browser's **Install app** action. Want to run from source or contribute instead? See [`CONTRIBUTING.md`](./CONTRIBUTING.md). Prefer Docker? Jump to [Docker deployment](#docker-deployment).

![Diff viewer with side-by-side changes](docs/assets/images/diff-viewer.png)

## Everything else Kōbō does

- **Command palette & search**: `/` autocompletes skills and commands, `@` fuzzy-completes worktree file paths, `Ctrl+F` searches readable messages, `Ctrl+K` opens a command palette. The global search page deep-links to the same spot.
- **Full MCP toolset (`kobo-tasks`)**: task/acceptance-criteria CRUD, dev server control, a unified `get_ticket` (Notion or Sentry), cross-workspace conversation search, per-session usage, and a `.ai/thoughts` decision log — see [`AGENTS.md`](./AGENTS.md) for the full tool list.

  ![Sub-agents panel showing parallel tool calls](docs/assets/images/sub-agents-panel.png)
- **Multi-forge Git panel**: GitHub (`gh`), GitLab (`glab`), or Bitbucket Community (`bkt`), auto-detected from the remote — `Open PR`, `Merge ready PR`, `Change PR base`, `Change source branch`, all from the UI.
- **Dev server panel**: start, stop, and tail a workspace's dev server (Docker or npm) from the Tools panel.
- **Attention indicators**: CI failures, review-requested changes, and a conflict-aware **ready-to-merge** badge on every workspace card, plus a one-click **Fix CI** button.
- **Interactive Q&A**: an agent can pause mid-session to ask you a question through the UI instead of guessing.

  ![Agent asking a clarifying question, awaiting the user's answer](docs/assets/images/agent-question.png)
- **Quota-aware**: 5-hour / 7-day Claude usage and Codex rate-limit buckets live in the footer; sessions auto-resume after a reset.
- **Disk-space purge**: reclaim a merged workspace's `node_modules`/`vendor` weight without losing its chat history — see [`CONFIGURATION.md`](./CONFIGURATION.md#auto-purge-worktree-on-pr-merged).
- **Lifecycle scripts**: shell scripts run automatically on setup, cleanup, and archive, with output streamed into the chat.
- **Observability**: a per-session timeline (duration, tools, tokens, errors) and a downloadable redacted diagnostic JSON.
- **Optional integrations**: Notion (import missions) and Sentry (fix from issue URL), each independently toggled with a **Test connection** action; local voice transcription via `whisper.cpp`.

## Configuration

The most common knobs:

| Env var | Default | Purpose |
|---|---|---|
| `PORT` / `SERVER_PORT` | `3000` | HTTP / WebSocket server port (`SERVER_PORT` takes precedence) |
| `KOBO_HOME` | `~/.config/kobo` | Data directory (SQLite, settings, voice models) |
| `NOTION_API_TOKEN` | none | Notion integration token |
| `ANTHROPIC_API_KEY` | none | Claude Code engine credential (alternative to `claude /login`) |
| `OPENAI_API_KEY` | none | Codex engine credential (alternative to `codex login`) |

Everything else — worktree paths, dev server commands, prompt templates, git conventions, lifecycle scripts, forge selection, permission modes — lives in **Settings**, with per-project values inheriting from global ones. The full reference (every env var, every setting key, MCP server registration, forge/Notion/Sentry/voice setup) is in [`CONFIGURATION.md`](./CONFIGURATION.md).

### Docker

An official `Dockerfile` and three ready-to-use Compose files ship in this repository: a quick local test stack, a Traefik-fronted local rehearsal (no domain needed), and a full VPS reference (Traefik + Let's Encrypt, SSH access, optional Docker-socket passthrough). See [`CONFIGURATION.md`](./CONFIGURATION.md#docker-deployment) for every compose file, env var, and volume mount.

### Network access

Kōbō binds to `127.0.0.1` only by default. Enabling **Settings → Global → Network access** re-binds to the LAN behind a shared token (a QR code makes pairing a phone easy). Plain HTTP — keep it to trusted networks, or front it with HTTPS/a VPN for anything further. Details in [`CONFIGURATION.md`](./CONFIGURATION.md#network-access).

## Agent runtimes

- **Claude Code**: authenticate once with `claude /login`. Kōbō calls the embedded SDK directly — no `claude` binary needed at runtime.
- **OpenAI Codex**: run `codex login` or export `OPENAI_API_KEY`. Kōbō spawns a long-lived `codex app-server` subprocess per workspace.

Both engines share task tracking, permission modes, the sub-agent panel, and the quota footer. The mapping of Kōbō's four permission modes (`plan` / `bypass` / `strict` / `interactive`) to each engine's native sandbox semantics is in [`CONFIGURATION.md`](./CONFIGURATION.md#permission-modes).

## Skill suites

Kōbō's auto-generated prompts (review, auto-loop grooming, QA, brainstorming) can target **[superpowers](https://github.com/obra/superpowers)** (brainstorm → spec → plan → execute, TDD, debugging), **[gstack](https://github.com/garrytan/gstack)** (slash-command workflows for QA, design review, ship pipelines), both together, or your own custom prompts — selectable in **Settings → Skills**. Pairs optionally with **[gbrain](https://github.com/garrytan/gbrain)** for per-project semantic search. Full setup in [`CONFIGURATION.md`](./CONFIGURATION.md#skill-suites).

## Architecture

Hono backend, Vue 3 + Quasar PWA, SQLite (WAL) for persistence, WebSocket for live updates. Each workspace spawns its own agent engine and a dedicated MCP server (`kobo-tasks`) that the agent uses to query and mutate workspace state.

```
src/
├── server/         # Hono backend (routes, services, db, agent orchestrator)
│   ├── services/agent/engines/  # claude-code/ + codex/ engines
│   └── ...
├── client/         # Vue 3 + Quasar PWA
├── mcp-server/     # kobo-tasks MCP server, spawned per workspace
├── shared/         # types shared backend ↔ frontend
└── __tests__/      # Vitest suite, backend + client, thousands of tests
```

[`AGENTS.md`](./AGENTS.md) covers the data model, WebSocket protocol, engine contracts, MCP tool surface, migration discipline, i18n rules, and contribution guidelines.

## Contributing

PRs welcome. See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for the from-source setup, scripts, and release process, and [`AGENTS.md`](./AGENTS.md) for code conventions and the database-migration discipline.

## License

GPL-3.0-or-later. See [`LICENSE`](./LICENSE).
