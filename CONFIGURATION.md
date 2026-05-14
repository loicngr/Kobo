# Configuration

Complete reference for every Kōbō setting, environment variable, and external integration. For a quick start see the [README](./README.md); for architecture, conventions, and contribution rules see [`AGENTS.md`](./AGENTS.md).

## Contents

- [Storage layout](#storage-layout)
- [Environment variables](#environment-variables)
- [Settings UI](#settings-ui)
- [Agent runtimes](#agent-runtimes)
  - [Claude Code](#claude-code)
  - [OpenAI Codex](#openai-codex)
  - [Permission modes](#permission-modes)
- [Notion integration](#notion-integration)
- [Sentry integration](#sentry-integration)
- [Voice transcription](#voice-transcription)
- [Skill suites](#skill-suites)
  - [superpowers](#superpowers)
  - [gstack](#gstack)
  - [superpowers + gstack](#superpowers--gstack)
  - [custom](#custom)
- [gbrain (companion MCP)](#gbrain-companion-mcp)

## Storage layout

Kōbō persists all state under a single home directory, resolved in this order:

1. `KOBO_HOME` env var (absolute path)
2. `$XDG_CONFIG_HOME/kobo/`
3. `~/.config/kobo/`

Contents:

```
$KOBO_HOME/
├── kobo.db                  # SQLite (WAL mode). Forward-only migrations.
├── kobo.db.backup-<ISO>-<seq>  # Pre-migration backup (auto-created before any schema change).
├── settings.json            # Global and per-project settings.
├── templates.json           # Prompt templates.
├── skills.json              # Skill suite configuration.
└── voice/
    └── models/whisper/      # Downloaded ggml-*.bin models.
```

A production-installed Kōbō (`npx @loicngr/kobo`) and a dev server can run side by side: `npm run dev` forces `KOBO_HOME=./data` so dev never touches your real config.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `9999` | HTTP / WebSocket server port. |
| `SERVER_PORT` | — | Alias for `PORT` (used by the `npx` runner). |
| `KOBO_HOME` | `~/.config/kobo` | Override the storage directory. |
| `KOBO_ENFORCE_LOCAL_HOME` | — | When set, refuses any `KOBO_HOME` that resolves outside the current directory. Used by `npm run dev` to guarantee dev data lives in `./data`. |
| `KOBO_MCP_INIT_TIMEOUT_MS` | `30000` | Handshake timeout for the Notion and Sentry MCP servers. Bump it if cold `npx` fetches are slow on your network. |
| `XDG_CONFIG_HOME` | — | Standard XDG override consulted before `~/.config`. |
| `NOTION_API_TOKEN` | — | Notion integration token (preferred over `NOTION_TOKEN`). |
| `NOTION_TOKEN` | — | Fallback Notion token. |
| `NOTION_MCP_COMMAND` | `npx` | Binary used to launch the Notion MCP server. |
| `NOTION_MCP_ARGS` | `-y @notionhq/notion-mcp-server` | Space-separated arguments passed to `NOTION_MCP_COMMAND`. |
| `OPENAI_API_KEY` | — | Codex engine credential. Alternative to `codex login`. |
| `ANTHROPIC_API_KEY` | — | Claude credential. Alternative to `claude /login`. |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Where the Claude SDK reads its auth and MCP config. |
| `WHISPER_CPP_COMMAND` | `whisper-cli` | Override the whisper.cpp binary if it's not in `PATH` and you don't want to set it via Settings. |
| `DEBUG_MCP_STDERR` | — | When set, pipe spawned MCP servers' stderr to the Kōbō log. Useful for debugging Notion/Sentry MCP issues. |

## Settings UI

Settings are managed live from the **Settings** page in the UI and persisted to `$KOBO_HOME/settings.json`. The file is structured as:

```jsonc
{
  "global": { /* defaults applied to every project */ },
  "projects": [
    { "path": "/abs/path/to/repo", /* per-project overrides */ }
  ]
}
```

### Global settings

| Key | Type | Purpose |
|---|---|---|
| `defaultModel` | `string` | Fallback model when no engine-specific default is set. |
| `defaultModelByEngine` | `Record<engine, string>` | Per-engine default model (`claude-code` / `codex`). |
| `defaultPermissionModeByEngine` | `Record<engine, mode>` | Default permission mode per engine — see [Permission modes](#permission-modes). |
| `dangerouslySkipPermissions` | `boolean` | Disable all approval prompts. **Use with care.** |
| `prPromptTemplate` | `string` | Template rendered by the `/open-pr` endpoint. Supports `{{pr_number}}`, `{{pr_url}}`, `{{branch_name}}`, `{{diff_stats}}`, `{{commits}}`, etc. |
| `reviewPromptTemplate` | `string` | Template for the review prompt action. |
| `notionInitialPromptTemplate` | `string` | Template injected as the first user message when a workspace is created from a Notion page. |
| `sentryInitialPromptTemplate` | `string` | Template injected as the first user message when a workspace is created from a Sentry issue. |
| `gitConventions` | `string` | Markdown block written to `.ai/.git-conventions.md` inside every workspace. |
| `editorCommand` | `string` | Command used by the "Open in editor" action (e.g. `code`, `phpstorm`, `cursor`). The worktree path is appended as the last argument. |
| `browserNotifications` | `boolean` | Trigger Web Notifications when an agent finishes a turn. |
| `audioNotifications` | `boolean` | Play a sound when an agent finishes a turn. |
| `audioNotificationSound` | `string` | Identifier of the chosen sound. |
| `audioNotificationVolume` | `number` | `0` to `100`. |
| `notionMcpKey` | `string` | Override the `~/.claude.json` key used for Notion (defaults to the first non-disabled entry containing `notion`). |
| `sentryMcpKey` | `string` | Same logic for Sentry. |
| `notionStatusProperty` | `string` | Notion DB property updated to `notionInProgressStatus` when a workspace starts work on a Notion-backed mission. Empty disables the feature. |
| `notionInProgressStatus` | `string` | Value written to `notionStatusProperty`. |
| `notionAssigneeProperty` | `string` | Notion People property to auto-assign to the authenticated user. |
| `notionUserId` | `string` | Notion user UUID assigned via `notionAssigneeProperty`. |
| `tags` | `string[]` | Global tag catalogue exposed in the sidebar filters and the workspace-tag picker. |
| `worktreesPath` | `string` | Root directory where new worktrees are created. Defaults to `.worktrees` (resolved relative to the project). Absolute, `$HOME`, `~`, and `%USERPROFILE%` are accepted; `..` and drive-relative Windows paths (`C:foo`) are rejected. |
| `worktreesPrefixByProject` | `boolean` | Nest each worktree under a project-named subfolder, preventing collisions when multiple projects share the same `worktreesPath`. |
| `voiceEnabled` | `boolean` | Enable local push-to-talk transcription. |
| `voicePttKey` | `'alt' \| 'ctrl+space'` | Hotkey held to record. |
| `voiceLanguage` | `string` | `auto` or a 2-letter language code. |
| `voiceModel` | `string \| null` | Active model name (e.g. `base`). |
| `voiceCommandPath` | `string` | Override `whisper-cli` path. Empty falls back to `WHISPER_CPP_COMMAND` then `PATH`. |
| `voiceFfmpegPath` | `string` | Override `ffmpeg` path. Empty falls back to `PATH`. |
| `voiceTemperature` | `number` | Decoding temperature, `0`–`1`. |
| `voicePrompt` | `string` | Initial prompt to bias transcription (custom vocabulary, names). |

### Per-project settings

Projects override a subset of global settings — anything you set here takes precedence for workspaces created under that project path.

| Key | Type | Purpose |
|---|---|---|
| `path` | `string` | Absolute project path (primary key). |
| `displayName` | `string` | Override the auto-derived name. |
| `color` | `ProjectColor \| null` | Sidebar accent. |
| `defaultSourceBranch` | `string` | Source branch new workspaces branch from (e.g. `develop`). |
| `defaultModel` | `string` | Project-scoped model default. |
| `dangerouslySkipPermissions` | `boolean` | Project-scoped override. |
| `prPromptTemplate`, `reviewPromptTemplate`, `notionInitialPromptTemplate`, `sentryInitialPromptTemplate`, `gitConventions` | `string` | Per-project versions of the global templates. |
| `setupScript` | `string` | Shell command run once after a worktree is created (e.g. `npm install`). |
| `devServer.startCommand` / `stopCommand` | `string` | Per-workspace dev server commands. Docker, npm, or any shell-startable process. |
| `e2e.framework` | `'cypress' \| 'playwright' \| 'jest' \| 'vitest' \| 'other' \| ''` | E2E framework auto-loop grooming should target. |
| `e2e.skill` | `string` | Optional skill name injected into the E2E grooming prompt. |
| `e2e.prompt` | `string` | Free-form prompt appended to every `[E2E] ` sub-task. |
| `finalization.prompt` | `string` | Runs as the very last auto-loop iteration (`[FINAL]`-prefixed task). Empty disables. |

## Agent runtimes

Engines are selected per workspace at creation time. Both share the same UI surface (chat feed, task panel, permission modes, sub-agent panel, quota footer, auto-loop).

### Claude Code

Authenticate once:

```bash
claude /login
```

Kōbō talks to the embedded [`@anthropic-ai/claude-agent-sdk`](https://github.com/anthropics/claude-agent-sdk-typescript), which reuses the same login. The `claude` CLI is **not** required at runtime — it's only needed for `/login`, `mcp add`, and other one-off setup commands. As a fallback you can export `ANTHROPIC_API_KEY` instead.

Supported models include `claude-opus-4-7`, `claude-opus-4-6`, `claude-sonnet-4-6`, `claude-haiku-4-5`. Pick the default in **Settings → Agents → Default model (Claude Code)**.

### OpenAI Codex

> Experimental. The Claude Code engine remains the primary, battle-tested path.

Authenticate either way:

```bash
codex login                                # writes ~/.codex/auth.json
# OR
OPENAI_API_KEY=sk-… npx @loicngr/kobo
```

Kōbō spawns a long-lived `codex app-server` subprocess per workspace and bridges its JSON-RPC stream to the same UI. The `codex` binary ships transitively via [`@openai/codex`](https://www.npmjs.com/package/@openai/codex) — no separate install required.

Supported models include `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, and `gpt-5.3-codex` (note: `gpt-5.5` requires ChatGPT auth — API-key auth is limited to `gpt-5.4` and below). Reasoning effort (`auto` / `minimal` / `low` / `medium` / `high` / `xhigh`) is selectable on every workspace. Both selectors switch automatically when you flip the engine.

### Permission modes

Each engine maps Kōbō's four modes onto its own sandbox + approval flags. The mapping is fixed in code, but knowing it helps you pick a sensible default.

**Claude Code** (controlled via SDK options):

| Kōbō mode | Effect |
|---|---|
| `plan` | Read-only sandbox; the agent plans without writing. |
| `bypass` | Full autonomy in the worktree. |
| `strict` | Writes allowed; approval prompted on sensitive commands. |
| `interactive` | Approval prompted on every untrusted action. |

**OpenAI Codex** (controlled via `sandbox` + `approvalPolicy` + `collaborationMode`):

| Kōbō mode | Codex sandbox | Codex approval | `collaborationMode` |
|---|---|---|---|
| `plan` | `read-only` | `never` | `plan` (enables `request_user_input`) |
| `bypass` | `workspace-write` | `never` | `default` |
| `strict` | `workspace-write` | `on-request` | `default` |
| `interactive` | `workspace-write` | `unless-trusted` | `default` |

Interactive Q&A (`request_user_input`) is only available in `plan` for Codex — this is a constraint of Codex itself.

## Notion integration

Pulls the body, title, and checklists of a Notion page to seed a workspace's tasks and acceptance criteria.

### Setup

1. Visit <https://www.notion.so/profile/integrations> and create an internal integration.
2. Grant it at least *Read content*.
3. Copy the token (format `ntn_…` or `secret_…`).
4. Open the target Notion page → **…** → **Connections** → **Add connection** → select the integration. Kōbō can only read pages explicitly shared with the integration.

### Token sources

Resolved in this order:

1. `NOTION_API_TOKEN` env var
2. `NOTION_TOKEN` env var
3. `~/.claude.json` → `mcpServers.notion.env.NOTION_TOKEN` (or `NOTION_API_TOKEN`)

The recommended path is **(3)** — one token shared between Claude Code and Kōbō:

```bash
claude mcp add notion -s user -e NOTION_TOKEN=ntn_your_token -- npx -y @notionhq/notion-mcp-server
```

### Overriding the MCP command

Pin a version or use a fork:

```bash
NOTION_MCP_COMMAND=node \
NOTION_MCP_ARGS="./my-fork/dist/server.js" \
npx @loicngr/kobo
```

### Auto-assign on workspace creation

When `notionAssigneeProperty` is set, Kōbō updates the named People property on the imported page to `notionUserId` — but only if the property has no assignee yet. Both fields are global settings; leave blank to disable.

### Status field updates

When `notionStatusProperty` is set, Kōbō flips it to `notionInProgressStatus` as soon as the workspace starts work. Useful for keeping a Notion kanban in sync.

## Sentry integration

Turns a Sentry issue URL into a "fix workspace" — Kōbō extracts the stacktrace, tags, and offending spans, writes them to `.ai/thoughts/SENTRY-<id>.md`, and primes the agent with a TDD fix workflow plus live access to the Sentry MCP tools.

### Setup

1. Generate a Sentry auth token with at least `project:read`, `event:read`, `org:read`. User tokens (format `sntryu_…`) are simplest for personal use.
2. Register the Sentry MCP in Claude Code:

   ```bash
   claude mcp add sentry -s user \
     -e SENTRY_ACCESS_TOKEN=sntryu_your_token \
     -e SENTRY_HOST=your-org.sentry.io \
     -- npx -y @sentry/mcp-server@latest
   ```

   For self-hosted Sentry, set `SENTRY_HOST` to your hostname (e.g. `sentry.mycompany.com`).

Kōbō does not store the token. It reads the MCP entry from `~/.claude.json` and follows your Claude Code config automatically.

### How Kōbō picks the entry

Reads `~/.claude.json` and uses the first entry under `mcpServers` whose key contains `sentry` (case-insensitive) **and is not disabled**. To force a specific entry, set the global `sentryMcpKey` setting to its exact key.

### Usage

1. Paste a Sentry issue URL in the workspace creation form (**Import Sentry**).
2. Submit. Kōbō extracts the issue, writes `.ai/thoughts/SENTRY-<shortId>.md`, creates a `Fix: <title>` task, and boots the agent with the fix workflow.
3. The Sentry Short-ID (e.g. `ACME-API-3`) becomes the branch prefix (`fix/ACME-API-3--slug`), which means commit messages like `Fixes ACME-API-3` will auto-close the issue on merge.

When Sentry is active, the workspace description field becomes optional — the extracted context is enough to start work.

## Voice transcription

Local push-to-talk transcription using [`whisper.cpp`](https://github.com/ggml-org/whisper.cpp). Available in the workspace chat input and the workspace creation form.

### Requirements

- `whisper-cli` from whisper.cpp
- `ffmpeg`
- `cmake` (only to build whisper.cpp from source)
- At least one Whisper model downloaded via **Settings → Voice**

### Install whisper.cpp (Linux / macOS)

```bash
git clone https://github.com/ggml-org/whisper.cpp.git
cd whisper.cpp
cmake -B build
cmake --build build -j
# Binary lands at build/bin/whisper-cli
```

Alternatively, grab a prebuilt archive from the [whisper.cpp releases](https://github.com/ggml-org/whisper.cpp/releases) and point Kōbō at the extracted binary.

### Install whisper.cpp (Windows)

1. Install CMake and Visual Studio Build Tools (C/C++).
2. Build whisper.cpp as above, or use a prebuilt archive.
3. Verify in PowerShell:

   ```powershell
   where whisper-cli
   whisper-cli -h
   ```

### Install ffmpeg

**Ubuntu / Debian:**

```bash
sudo apt update
sudo apt install -y ffmpeg
```

**macOS:**

```bash
brew install ffmpeg
```

**Windows:**

```powershell
choco install ffmpeg     # or: scoop install ffmpeg
where ffmpeg
```

### Configure in Kōbō

**Settings → Voice**:

- Enable voice transcription.
- Optionally set the binary paths. Empty falls back to `WHISPER_CPP_COMMAND` env var, then `PATH`, for whisper-cli; `ffmpeg` is looked up in `PATH`.
- Download a model from the **Whisper models** section (sizes range from ~75 MB for `tiny` to ~3 GB for `large-v3`). The storage directory is displayed at the top of the section. Downloads are chunked and stream to disk with a live progress bar, and can be cancelled mid-flight.
- Pick the active model.

The Voice panel shows the runtime status for whisper-cli and ffmpeg so misconfigurations are visible immediately.

### Model sizes (approximate)

| Model | Disk | Recommended temperature |
|---|---|---|
| `tiny` | ~75 MB | `0.1` |
| `base` | ~142 MB | `0.1` |
| `small` | ~466 MB | `0.2` |
| `medium` | ~1.5 GB | `0.2` |
| `large-v3` | ~3.1 GB | `0.2` |

### Advanced parameters

- **Temperature** (`0`–`1`) — decoding stability vs flexibility.
- **Initial prompt** — biases recognition for custom vocabulary, names, or jargon.
- **Translate to English** — translate non-English speech rather than transcribing it.
- **Suppress non-speech tokens** — reduce non-speech artefacts in the output.

## Skill suites

Kōbō's auto-generated prompts (review template, auto-loop grooming intro, QA template, brainstorming instruction) reference skills by name. The **Settings → Skills → Skill suite** selector picks which ecosystem those prompts target. Four options are supported:

| Suite | Auto-prompts cite | Best for |
|---|---|---|
| `superpowers` (default) | `superpowers:*` skills (brainstorming, writing-plans, executing-plans, TDD, debugging, requesting-code-review, …) | Plugin-driven workflow inside Claude Code |
| `gstack` | gstack slash commands (`/review`, `/ship`, `/qa`, `/browse`, `/design-review`, `/investigate`, `/codex`, …) | Concrete CLI-driven workflows, browser-based QA, opinionated ship/deploy loop |
| `superpowers+gstack` | Both — specialised by intent (e.g. `/review` for tactical bug-hunting, `superpowers:requesting-code-review` for principles-level critique) | Users who install both suites and want each used for what it does best |
| `custom` | Whatever you write in the `custom*` fields (Settings → Skills → Custom prompts) | Air-gapped, suite-agnostic, or non-standard setups |

Switching the selector only changes the prompt text Kōbō emits — it does **not** install or remove anything. Pick whichever matches the skills you actually have available in your Claude Code / Codex environment.

### superpowers

The default. Open-source Claude Code plugin covering brainstorming, writing-plans, executing-plans, TDD, systematic-debugging, requesting / receiving-code-review, dispatching-parallel-agents, etc. Kōbō also surfaces specs from `docs/superpowers/specs/` and plans from `docs/superpowers/plans/` in the right-drawer Documents browser.

Install inside Claude Code:

```bash
/plugin marketplace add obra/superpowers-marketplace
/plugin install superpowers@superpowers-marketplace
```

Repo: <https://github.com/obra/superpowers>.

### gstack

CLI-driven skill suite with a different philosophy: concrete slash commands for navigation (`/browse`), QA (`/qa`, `/qa-only`), design (`/design-review`, `/plan-design-review`, `/design-shotgun`, `/design-html`), strategy (`/office-hours`, `/plan-ceo-review`, `/plan-eng-review`), debugging (`/investigate`, `/codex`), and the full ship loop (`/ship`, `/land-and-deploy`, `/canary`, `/document-release`). Voice triggers exist for many of the commands.

When this suite is active, Kōbō's review template tells the agent to invoke `/review`, the auto-loop review gate uses gstack's reviewer, and the QA prompt routes to `/browse` for real-browser smoke tests.

Install by following the instructions in the [gstack repo](https://github.com/garrytan/gstack), then switch the suite to `gstack` in **Settings → Skills**.

### superpowers + gstack

When both suites are installed, set the selector to `superpowers+gstack`. Kōbō's prompts then cite each suite for what it does best: superpowers for the discipline (TDD loop, plan execution, parallel subagents), gstack for the tactical surface (real-browser QA, design audits, ship pipeline, codex second-opinion).

### custom

Lets you bypass the bundled prompts entirely and write your own. The five `custom*` fields under **Settings → Skills → Custom prompts** are seeded with neutral, suite-free defaults (the *AGNOSTIC* prompt strings in `src/shared/skill-suite-prompts.ts`) so you have a starting point. Useful for air-gapped setups, internal forks, or compliance environments where a third-party plugin is off-limits.

## gbrain (companion MCP)

[`gbrain`](https://github.com/garrytan/gbrain) is a separate companion tool — a per-project knowledge graph and semantic search index, with an MCP server interface. It's **not** a Kōbō skill suite (it doesn't change the auto-generated prompts) but it plugs into Kōbō workspaces transparently via the standard Claude Code MCP config: any MCP server registered in `~/.claude.json` is inherited by Kōbō agents at session start.

When gbrain is configured, the agent gets access to tools like:

- `search`, `query`, `resolve_slugs` — semantic + graph search over the project's indexed content
- `get_page`, `put_page`, `delete_page`, `get_chunks`, `get_versions`, `revert_version` — page-level knowledge-graph CRUD
- `add_link`, `remove_link`, `get_links`, `get_backlinks`, `traverse_graph`, `find_orphans` — link operations
- `add_tag`, `remove_tag`, `get_tags` — tagging
- `submit_job`, `list_jobs`, `get_job`, `get_job_progress`, `pause_job`, `resume_job`, `retry_job`, `replay_job`, `cancel_job` — async ingestion jobs
- `add_timeline_entry`, `get_timeline`, `log_ingest`, `get_ingest_log` — per-project activity log
- `file_list`, `file_upload`, `file_url` — file attachments
- `sync_brain`, `get_health`, `get_stats` — administration

Install the CLI by following the instructions in the [gbrain repo](https://github.com/garrytan/gbrain), then initialise and register it with Claude Code:

```bash
# 1. Initialise a brain for this project (or use a shared remote brain)
cd /path/to/your/project
gbrain init

# 2. Register the MCP server in Claude Code (Kōbō reads the same ~/.claude.json)
claude mcp add gbrain -s user -- gbrain mcp
```

Once registered, Kōbō workspaces opened on this project will see the `gbrain__*` tools automatically. The `/sync-gbrain` gstack skill keeps the index fresh after large refactors. Repo: <https://github.com/garrytan/gbrain>.

Pairing notes:

- gbrain pairs especially well with the `gstack` skill suite (which calls `gbrain search` in several of its skills) and with auto-loop mode (the agent can query past work without re-reading the diff every iteration).
- If you don't use gbrain, the agent simply falls back to `grep` / `Read` for code exploration — no setup is required.
