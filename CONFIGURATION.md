# Configuration

Complete reference for every Kōbō setting, environment variable, and external integration. For a quick start see the [README](./README.md); for architecture, conventions, and contribution rules see [`AGENTS.md`](./AGENTS.md).

## Contents

- [Storage layout](#storage-layout)
- [Environment variables](#environment-variables)
- [Settings UI](#settings-ui)
- [Progressive Web App](#progressive-web-app)
- [Custom change-source-branch script](#custom-change-source-branch-script)
- [Auto-purge worktree on PR merged](#auto-purge-worktree-on-pr-merged)
- [Network access](#network-access)
- [Docker deployment](#docker-deployment)
  - [Choosing a compose file](#choosing-a-compose-file)
  - [The image](#the-image)
  - [Environment variables (Docker)](#environment-variables-docker)
  - [Volumes](#volumes)
  - [Ports](#ports)
  - [Token / login flow](#token--login-flow)
  - [Quick local test — docker-compose.local.yml](#quick-local-test--docker-composelocalyml)
  - [Rehearsing the reverse-proxy stack — docker-compose.local-traefikyml](#rehearsing-the-reverse-proxy-stack--docker-composelocal-traefikyml)
  - [Real deployment — docker-compose.exampleyml](#real-deployment--docker-composeexampleyml)
  - [Troubleshooting](#troubleshooting)
- [Agent runtimes](#agent-runtimes)
  - [Claude Code](#claude-code)
  - [OpenAI Codex](#openai-codex)
  - [Permission modes](#permission-modes)
- [Dev server](#dev-server)
- [Forge integration](#forge-integration)
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
| `PORT` | `3000` | HTTP / WebSocket server port. Overridden by `SERVER_PORT` when both are set. |
| `SERVER_PORT` | — | Takes precedence over `PORT`. Useful for stacking Kōbō next to other tools that also honour `PORT`. |
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
| `KOBO_NETWORK_ACCESS_ENABLED` | — | Set `true` to enable [network access](#network-access) at boot, without going through Settings. Mainly useful for headless/Docker deployments. |
| `KOBO_NETWORK_ACCESS_BEHIND_PROXY` | — | Set `true` to enable [behind a reverse proxy](#behind-a-reverse-proxy) mode at boot (disables the loopback bypass entirely). Requires `KOBO_NETWORK_ACCESS_ENABLED=true`. |
| `GH_TOKEN` | — | Non-interactive auth for the `gh` CLI (used by the [forge integration](#forge-integration)). Needed in headless containers where `gh auth login`'s browser flow isn't practical. |
| `GITLAB_TOKEN` | — | Non-interactive auth for the `glab` CLI, same rationale as `GH_TOKEN`. |
| `KOBO_WORKTREE_CLEANUP_IMAGE` | `alpine` | Docker image used to reclaim ownership of root-owned files when removing a worktree fails on a permission error. Override with a locally cached image to avoid a pull. |

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
| `defaultPermissionModeByEngine` | `Record<engine, mode>` | Default permission mode per engine. See [Permission modes](#permission-modes). |
| `dangerouslySkipPermissions` | `boolean` | Disable all approval prompts. **Use with care.** |
| `prPromptTemplate` | `string` | Template rendered by the `/open-pr` endpoint. Supports `{{pr_number}}`, `{{pr_url}}`, `{{branch_name}}`, `{{diff_stats}}`, `{{commits}}`, etc. |
| `reviewPromptTemplate` | `string` | Template for the review prompt action. |
| `notionInitialPromptTemplate` | `string` | Template injected as the first user message when a workspace is created from a Notion page. |
| `sentryInitialPromptTemplate` | `string` | Template injected as the first user message when a workspace is created from a Sentry issue. |
| `gitConventions` | `string` | Markdown block written to `.ai/.git-conventions.md` inside every workspace. |
| `setupScript` | `string` | Shell script run in a worktree after it is created, before the agent starts. Empty disables. |
| `cleanupScript` | `string` | Shell script run after a session ends. Empty disables. See `cleanupScriptMode`. |
| `cleanupScriptMode` | `'idle' \| 'no-tasks'` | When the cleanup script fires: after every session (`idle`) or only when no Kōbō task remains (`no-tasks`). In auto-loop it runs only once every task is done. |
| `cleanupScriptOnlyOnChanges` | `boolean` | Run the cleanup script only when the worktree has uncommitted changes (modified / added / deleted / untracked files). |
| `archiveScript` | `string` | Shell script run server-side when a workspace is archived. Empty disables. |
| `changeSourceBranchScript` | `string` | Shell script that **replaces** the built-in change-source-branch logic. See [Custom change-source-branch script](#custom-change-source-branch-script). Empty uses the built-in cherry-pick flow. |
| `editorCommand` | `string` | Command used by the "Open in editor" action (e.g. `code`, `phpstorm`, `cursor`). The worktree path is appended as the last argument. |
| `browserNotifications` | `boolean` | Trigger Web Notifications when an agent finishes a turn. |
| `audioNotifications` | `boolean` | Play a sound when an agent finishes a turn. |
| `whipEnabled` | `boolean` | Enable the interactive whip. Default `false`. |
| `whipShortcut` | `string` | Portable whip shortcut. Default `mod+shift+x`. |
| `whipVolume` | `number` | Independent whip volume from `0` to `1`. Default `1`; master `audioNotifications` still mutes playback. |
| `audioNotificationSound` | `string` | Identifier of the chosen sound. |
| `audioQuestionSound` | `string` | Sound used when an agent asks a question. |
| `audioPrCiFailedSound` | `string` | Sound used when CI enters `FAILURE`. |
| `audioPrCiFailedEnabled` | `boolean` | Enable audio when CI enters `FAILURE`. |
| `audioPrCiFailedVolume` | `number` | CI-failure sound volume from `0` to `1`. |
| `audioPrCiRecoveredSound` | `string` | Sound used when CI moves from `FAILURE` to `SUCCESS`. |
| `audioPrCiRecoveredEnabled` | `boolean` | Enable audio when CI recovers. |
| `audioPrCiRecoveredVolume` | `number` | CI-recovery sound volume from `0` to `1`. |
| `audioPrChangesRequestedSound` | `string` | Sound used when a review requests changes. |
| `audioPrChangesRequestedEnabled` | `boolean` | Enable audio when changes are requested. |
| `audioPrChangesRequestedVolume` | `number` | Changes-requested sound volume from `0` to `1`. |
| `audioPrApprovedSound` | `string` | Sound used when a PR becomes approved. |
| `audioPrApprovedEnabled` | `boolean` | Enable audio when a PR becomes approved. |
| `audioPrApprovedVolume` | `number` | PR-approved sound volume from `0` to `1`. |
| `audioPrMergeConflictSound` | `string` | Sound used when a merge conflict appears. |
| `audioPrMergeConflictEnabled` | `boolean` | Enable audio when a merge conflict appears. |
| `audioPrMergeConflictVolume` | `number` | Merge-conflict sound volume from `0` to `1`. |
| `audioPrReadyToMergeSound` | `string` | Sound used when an idle workspace's PR becomes ready to merge. |
| `audioPrReadyToMergeEnabled` | `boolean` | Enable audio when a PR becomes ready to merge. |
| `audioPrReadyToMergeVolume` | `number` | Ready-to-merge sound volume from `0` to `1`. |
| `audioPrMergedSound` | `string` | Sound used when an open PR becomes merged. |
| `audioPrMergedEnabled` | `boolean` | Enable audio when a PR becomes merged. |
| `audioPrMergedVolume` | `number` | PR-merged sound volume from `0` to `1`. |
| `audioNotificationVolume` | `number` | General notification sound volume from `0` to `1`. |
| `notionMcpKey` | `string` | Override the `~/.claude.json` key used for Notion (defaults to the first non-disabled entry containing `notion`). |
| `sentryMcpKey` | `string` | Same logic for Sentry. |
| `notionEnabled` | `boolean` | Enable Notion imports and automations. Defaults to `true`; disabling preserves its configuration and existing workspace links. |
| `sentryEnabled` | `boolean` | Enable Sentry imports and automations. Defaults to `true`; disabling preserves its configuration and existing workspace links. |
| `showThinkingBlocks` | `boolean` | Display the latest agent reasoning panel immediately above the chat input. Defaults to `true`. |
| `notionStatusProperty` | `string` | Notion DB property updated to `notionInProgressStatus` when a workspace starts work on a Notion-backed mission. Empty disables the feature. |
| `notionInProgressStatus` | `string` | Value written to `notionStatusProperty`. |
| `notionAssigneeProperty` | `string` | Notion People property to auto-assign to the authenticated user. |
| `notionUserId` | `string` | Notion user UUID assigned via `notionAssigneeProperty`. |
| `tags` | `string[]` | Global tag catalogue exposed in the sidebar filters and the workspace-tag picker. |
| `branchPrefixes` | `string[]` | Git branch prefixes offered on the workspace creation page (stored without the trailing `/`). The first entry is the default selection. |
| `worktreesPath` | `string` | Root directory where new worktrees are created. Defaults to `.worktrees` (resolved relative to the project). Absolute, `$HOME`, `~`, and `%USERPROFILE%` are accepted; `..` and drive-relative Windows paths (`C:foo`) are rejected. |
| `worktreesPrefixByProject` | `boolean` | Nest each worktree under a project-named subfolder, preventing collisions when multiple projects share the same `worktreesPath`. |
| `autoPurgeOnPrMerged` | `boolean` | When a PR transitions to MERGED, also remove the worktree from disk (in addition to archiving). Chat history and PR metadata are preserved. Default `false`. See [Auto-purge worktree on PR merged](#auto-purge-worktree-on-pr-merged). |
| `voiceEnabled` | `boolean` | Enable local push-to-talk transcription. |
| `voicePttKey` | `'alt' \| 'ctrl+space'` | Hotkey held to record. |
| `voiceLanguage` | `string` | `auto` or a 2-letter language code. |
| `voiceModel` | `string \| null` | Active model name (e.g. `base`). |
| `voiceCommandPath` | `string` | Override `whisper-cli` path. Empty falls back to `WHISPER_CPP_COMMAND` then `PATH`. |
| `voiceFfmpegPath` | `string` | Override `ffmpeg` path. Empty falls back to `PATH`. |
| `voiceTemperature` | `number` | Decoding temperature, `0`–`1`. |
| `voicePrompt` | `string` | Initial prompt to bias transcription (custom vocabulary, names). |

PR/MR event sound settings accept `inherit` (the default, uses
`audioNotificationSound`) or a bundled sound filename from **Settings →
Notifications**. Each event has an independent `Enabled` toggle and `Volume`.
Migration v45 converts a previous `none` selection into a disabled card and
preserves the effective general volume. Review-decision sounds currently
require GitHub because the GitLab provider does not expose approval decisions.
When multiple states change in one poll, every enabled sound is queued and
played in order.

### Per-project settings

Projects override a subset of global settings. Anything you set here takes precedence for workspaces created under that project path.

| Key | Type | Purpose |
|---|---|---|
| `path` | `string` | Absolute project path (primary key). |
| `displayName` | `string` | Override the auto-derived name. |
| `color` | `ProjectColor \| null` | Sidebar accent. |
| `defaultSourceBranch` | `string` | Source branch new workspaces branch from (e.g. `develop`). |
| `defaultModel` | `string` | Project-scoped model default. |
| `dangerouslySkipPermissions` | `boolean` | Project-scoped override. |
| `prPromptTemplate`, `reviewPromptTemplate`, `notionInitialPromptTemplate`, `sentryInitialPromptTemplate`, `gitConventions` | `string` | Per-project versions of the global templates. Empty inherits the global value. |
| `setupScript`, `cleanupScript`, `archiveScript` | `string` | Per-project versions of the global lifecycle scripts. Empty inherits the global value. |
| `changeSourceBranchScript` | `string` | Per-project version of the custom change-source-branch script. Empty inherits the global value. See [Custom change-source-branch script](#custom-change-source-branch-script). |
| `cleanupScriptMode` | `'' \| 'idle' \| 'no-tasks'` | Per-project override of the cleanup trigger mode. Empty inherits the global mode. |
| `taskPromptTemplate` | `string` | Prompt auto-injected into the task-description textarea on the creation page when this project is selected. Empty disables. |
| `forge` | `'auto' \| 'github' \| 'gitlab' \| 'bitbucket-community' \| 'none'` | Which forge provides PR/MR features. `auto` detects from the git remote URL. See [Forge integration](#forge-integration). |
| `devServer.startCommand` / `stopCommand` | `string` | Per-workspace dev server commands. Docker, npm, or any shell-startable process. See [Dev server](#dev-server) for the status/URL contract. |
| `e2e.framework` | `'cypress' \| 'playwright' \| 'jest' \| 'vitest' \| 'other' \| ''` | E2E framework auto-loop grooming should target. |
| `e2e.skill` | `string` | Optional skill name injected into the E2E grooming prompt. |
| `e2e.prompt` | `string` | Free-form prompt appended to every `[E2E] ` sub-task. |
| `finalization.prompt` | `string` | Runs as the very last auto-loop iteration (`[FINAL]`-prefixed task). Empty disables. |

## Progressive Web App

Production builds (`npm run build`, `npm start`, or `npx @loicngr/kobo`) serve
the Quasar PWA build. Open Kōbō in a browser and use **Install app** or **Add
to Home Screen** to install it as a desktop or mobile application.

The PWA caches the application shell for fast reopening, but agent sessions,
chat history, HTTP requests, and WebSocket updates still require a reachable
Kōbō server. Kōbō shows an offline notice and offers an explicit reload when a
new service worker is ready; it never reloads an active page automatically.
The development client (`npm run dev:client`) intentionally uses Quasar's
normal dev server and is not installable.

When working from source, `npm run install-all` installs the root, client, and
`src/client/src-pwa` dependency trees. The third tree contains Quasar's
build-only Workbox dependencies and is required by `npm run build`, but not by
the normal development client.

## Custom change-source-branch script

The **Change source branch** action defaults to Kōbō's built-in cherry-pick of
the branch-proper commits. If a project (or the global default) sets
`changeSourceBranchScript`, that script **replaces** the built-in logic.

### Contract

When the script is set, Kōbō:

- still refuses if the agent is running (corruption risk, non-negotiable);
- spawns `bash -c "<your script>"` from the worktree as cwd;
- waits up to 5 minutes;
- on exit `0` → updates the workspace's `source_branch` metadata to the new
  base the user typed, and refreshes the UI;
- on non-zero exit (or timeout) → surfaces the script's stderr as the toast.

The script owns everything else: the git reconstruction (cherry-pick, rebase,
or reset, your choice), the conflict resolution, the PR base change (`gh pr edit`
/ `glab mr update`), and the force-push (`git push --force-with-lease`). The
built-in features that only apply to the cherry-pick path stay **inactive** on
the custom path: the backup branch, the `cancel-source-change` recovery, the
force-push confirmation prompt, and the agent-driven conflict resolution.

### Environment variables

| Variable | Value |
|---|---|
| `KOBO_NEW_BASE` | the new source branch the user typed in the dialog |
| `KOBO_OLD_BASE` | the workspace's previous `sourceBranch` |
| `KOBO_WORKING_BRANCH` | the workspace's working branch |
| `KOBO_WORKTREE_PATH` | absolute path of the worktree (also the script's cwd) |
| `KOBO_PROJECT_PATH` | absolute path of the main project repo |
| `KOBO_PROJECT_NAME` | project directory name (basename of `KOBO_PROJECT_PATH`); handy for log lines or notifications |
| `KOBO_WORKSPACE_ID` | Kōbō workspace id (stable across renames); useful for backup branch naming, idempotency keys, etc. |
| `KOBO_WORKSPACE_NAME` | workspace display name as shown in the Kōbō UI |
| `KOBO_FORGE` | resolved forge id for this project (`github`, `gitlab`, `bitbucket-community` or `none`); use it to pick the appropriate CLI cleanly instead of probing them all |
| `KOBO_PR_NUMBER` | number of the PR / MR open on the resolved forge for the working branch. Empty when none is open, when the forge is `none`, or when its CLI cannot resolve it. |

The standard process env (`PATH`, `HOME`, etc.) is forwarded unchanged.

### Example — sekur-style cherry-pick + PR re-target + force-push

```bash
#!/usr/bin/env bash
set -euo pipefail

git fetch origin
COMMITS=$(git log --reverse --format=%H "$KOBO_WORKING_BRANCH" \
  --not "origin/$KOBO_NEW_BASE" "origin/$KOBO_OLD_BASE")
COUNT=$(printf '%s\n' "$COMMITS" | grep -c '^[0-9a-f]' || true)

if [ "$COUNT" -eq 0 ]; then
  git reset --hard "origin/$KOBO_NEW_BASE"
elif [ "$COUNT" -gt 50 ]; then
  echo "Too many proper commits ($COUNT) — rebase manually" >&2
  exit 1
else
  git branch "kobo-backup/${KOBO_WORKING_BRANCH}-$(date +%s)" "$KOBO_WORKING_BRANCH"
  git reset --hard "origin/$KOBO_NEW_BASE"
  printf '%s\n' "$COMMITS" | xargs git cherry-pick
fi

# Re-target the PR / MR — use the forge Kōbō resolved for this project.
# `command -v` makes the script degrade gracefully if `gh` / `glab` is missing.
case "${KOBO_FORGE:-none}" in
  github)
    if command -v gh >/dev/null 2>&1; then
      gh pr edit --base "$KOBO_NEW_BASE" 2>/dev/null || true
    else
      echo "warn: 'gh' CLI not installed — skipping PR base update" >&2
    fi
    ;;
  gitlab)
    if command -v glab >/dev/null 2>&1; then
      glab mr update --target-branch "$KOBO_NEW_BASE" 2>/dev/null || true
    else
      echo "warn: 'glab' CLI not installed — skipping MR base update" >&2
    fi
    ;;
  *) : ;; # no forge configured — skip
esac

# Force-push if the branch is tracked upstream.
if git rev-parse --abbrev-ref "@{upstream}" >/dev/null 2>&1; then
  git push --force-with-lease origin "$KOBO_WORKING_BRANCH"
fi
```

### Trust model

The script can do anything: `git reset --hard`, force-push, delete files. The
trust model is identical to `setupScript` / `cleanupScript` / `archiveScript`.
Kōbō is a local single-user dev tool and the script is your own code.

## Auto-purge worktree on PR merged

Purging a worktree frees its disk space (often hundreds of MB or GB worth of
`node_modules`, `vendor`, build artefacts, etc.) while keeping the workspace
discoverable: chat history and PR metadata are retained in the database, the
workspace is archived, and the worktree folder is removed from disk.

**Manual trigger**: workspace context menu → **Free disk space (delete worktree)**.
A confirmation dialog warns you before any destructive action.

**Automatic trigger**: Settings → Worktrees → **Auto-purge worktree on PR
merged**. When enabled, the pr-watcher fires `purgeWorktree(id)` on the
OPEN → MERGED transition, in addition to the existing auto-archive. Disabled by
default; opt in once you trust the restore flow on your machine.

### Restoring a purged workspace

Kōbō captures restore metadata (`prNumber`, `prUrl`, `forge`, `mergeCommitSha`,
`originalSourceBranch`, `originalWorkingBranch`) at purge time. Recreate the
worktree manually with either:

```bash
# GitHub (via gh CLI)
gh pr checkout <pr-number> --recurse-submodules

# Or directly via git — works on GitHub even after branch deletion
git fetch origin pull/<pr-number>/head:<branch-name>
git worktree add <path> <branch-name>
```

The pr-watcher detects the worktree folder reappearing on its next 30 s tick
and automatically:

1. Clears `worktree_purged_at` + `worktree_purge_restore_data`
2. Clears `archived_at` (workspace becomes active again)
3. Emits `workspace:worktree-restored` (client refreshes both lists)

No UI action needed. The reactivated workspace recovers its prior status, chat
history, tasks, and cron schedules.

### Permission errors during purge

Docker often leaves root-owned files in `node_modules` / `vendor` inside the
worktree (containers run as `root` by default). When Kōbō tries to remove them
it hits `EACCES` / `EPERM`. Kōbō now auto-recovers by spawning a throwaway
Docker container that runs `chown` to reclaim ownership of the worktree, then
retries the removal; the manual `sudo rm -rf` fallback is only shown when
Docker is unavailable or the retry still fails. See Settings → Worktrees →
**How purge works** expansion in the UI for the full guide (manual recovery
commands for already-broken worktrees, including `setfacl` and `chown -R`
alternatives).

**Prevention summary**:

- **Best**: configure your container to run as the host user (`USER`
  directive in `Dockerfile`, or `user: "${UID}:${GID}"` in `docker-compose.yml`
  with `UID`/`GID` exported).
- **Fallback**: pose a default ACL on the worktrees root so future files
  inherit access for your user: `setfacl -d -m u:$(whoami):rwX <worktrees-root>`.
  Works on ext4 / btrfs / xfs with standard Docker bind mounts; does NOT work
  on named Docker volumes, NTFS / exFAT / tmpfs, strict SELinux with `:Z`, or
  `userns-remap`.

## Conversation history retention (opt-in)

Every agent message, tool call and diff Kōbō displays is persisted in the
`ws_events` table so the activity feed survives a reload. At roughly 25 rows per
second per running session, that table is the one that grows without bound —
and SQLite never gives the space back on its own.

Kōbō can prune it, but **the feature is off by default and always has to be
turned on deliberately**: it permanently deletes conversation history, and a
silent loss of history is worse than a large file. Leave it off and nothing is
ever deleted, exactly as before.

**Settings → Worktrees → Conversation history retention** exposes two values,
both global (the database is single):

| Setting | Default | Meaning |
|---|---|---|
| Delete events older than (days) | `0` | Age above which an agent event is deleted. **`0` means retention is disabled — nothing is ever deleted.** |
| Events always kept per workspace | `0` | The most recent events of each workspace survive whatever their age. Set it (5000 is a good starting point) at the same time you enable retention, so an old but still-open workspace keeps a readable history. |

The prune runs **once, at server start-up**, before the daily backup, in batches
of 5 000 rows so the SQLite write lock is never held for more than a few
milliseconds. When enough pages have been freed, a `VACUUM` returns the space to
the filesystem.

**What it deletes:** rows of `ws_events` — the recorded agent output.
**What it never touches:** workspaces, tasks, sessions, branches, worktrees, or
any file in your repositories.

Enabling retention — or shortening an existing window — asks for confirmation
first, and the dialog states how many of your recorded events the new window
would delete. Note that the first run is the largest one: switching a year-old
database to a 30-day window deletes eleven months in one go. Deleted events
cannot be recovered, and the server logs how many each prune removed.

## Network access

By default, Kōbō binds its HTTP and WebSocket server to `127.0.0.1` (localhost
only). Network access is an **opt-in** feature that re-binds to all interfaces
(`0.0.0.0`) so you can control Kōbō from another device on the same LAN: a
phone, a tablet, a second computer.

**Default posture: disabled.** Localhost connections never require a token,
regardless of this setting.

### Production vs. development mode (important)

**This setting only secures production.** How you run Kōbō matters:

- **Production** (`npm start`, or `npx @loicngr/kobo`): a single Kōbō process
  serves both the UI and the API on one port, so the bind address follows this
  setting directly: disabled → `127.0.0.1` (invisible on the LAN, connections
  refused), enabled → all interfaces + token gate. This is the only mode the
  network-access toggle protects.
- **Development** (`npm run dev:all`): the Quasar/Vite dev server runs as a
  **separate process** (port 8080) that always binds all interfaces and proxies
  `/api` + `/ws` to the backend over `localhost`. Because those proxied requests
  reach the backend from loopback, they are **exempt from the token gate**, and
  the dev UI stays reachable on the LAN regardless of this setting. **Dev mode is
  not secured by network access.** To lock it down in dev, either use production
  mode, or bind the dev server to localhost by setting `devServer: { host:
  '127.0.0.1' }` in `src/client/quasar.config.ts`.

### Enabling network access

1. Open **Settings → Global → Network access**.
2. Toggle **Enable network access** on.
3. A banner appears: **"Kōbō must be restarted to apply this change."** Restart
   Kōbō; the server cannot re-bind a live port without restarting. The banner
   stays visible until the restart happens so you don't miss it.
4. After restart, Kōbō listens on all interfaces. Your LAN IP addresses (one
   per network interface) are listed in the same Settings panel.

To disable network access, toggle it off and restart again.

### The network access token

When network access is enabled, every non-loopback HTTP request and every
non-loopback WebSocket connection must supply a shared token.

- **Auto-generated**: Kōbō generates a random token the first time you enable
  the feature. You never have to type one in.
- **Where to find it**: Settings → Global → Network access → **Token** field
  (always masked; use the copy button).
- **Regenerate**: the **Regenerate** button creates a new random token and
  invalidates any device already using the old one. Useful when a device is
  lost or you rotate credentials.
- **Not exported**: the token is excluded from any config export / backup
  bundle, because it is a per-machine secret tied to this installation.

### Connecting a remote device

**Option A: QR code (recommended for phones)**

The Settings panel shows a QR code encoding
`http://<lan-ip>:<port>/?token=<token>`. Scan it with your phone's camera
while on the same Wi-Fi network; the browser opens directly to a pre-authenticated
session. The token is stored in the browser's `localStorage` under
`kobo:network-token` so subsequent visits don't require re-scanning.

**Option B: manual URL**

1. Copy one of the LAN URLs shown in the Settings panel (format
   `http://<lan-ip>:<port>/`).
2. Open it on the remote device.
3. A login dialog appears: paste the token from the Settings panel and confirm.
4. The token is stored in `localStorage`; subsequent visits auto-authenticate.

**Host machine (localhost)**: the host always connects to `http://localhost:<port>`
as usual and is never asked for a token, regardless of whether network access is
enabled.

### Token transport

| Connection type | How to supply the token |
|---|---|
| HTTP requests | `X-Kobo-Token: <token>` header |
| WebSocket connections | `?token=<token>` query parameter on the upgrade URL |

The Kōbō browser client handles both automatically once the token is stored in
`localStorage`. Third-party scripts or API consumers must supply the header or
query param manually.

The IP address used for the loopback exemption is taken **from the OS socket**,
never from forwarded headers (`X-Forwarded-For` etc.), so a remote client cannot
spoof a loopback address to bypass authentication.

### Security caveats

> **Network access is designed for trusted local networks only.**

- **No HTTPS / no TLS.** Kōbō's built-in server serves plain HTTP. The token
  travels in cleartext on the network. Anyone who can observe your LAN traffic
  (e.g. another device on an open Wi-Fi network) can capture it.
- **Not suitable for internet exposure.** Do not open the Kōbō port on your
  router or firewall. If you need access over the internet, place a terminating
  HTTPS reverse proxy (nginx, Caddy…) or a zero-config VPN (Tailscale, WireGuard)
  in front of Kōbō yourself. Kōbō is not responsible for that layer.
- **A reverse proxy in front of Kōbō defeats the token gate.** The loopback
  exemption trusts the OS socket address. A proxy that forwards requests from
  `localhost` makes every request look like loopback, so the token check is
  skipped. If you run one, enforce authentication (and TLS) at the proxy layer.
  Don't rely on Kōbō's token behind it.
- **Development mode is not protected** by this setting: the Vite dev server
  (port 8080) is always exposed and bypasses the gate. See
  [Production vs. development mode](#production-vs-development-mode-important)
  above; only production (`npm start`) is secured.
- **Single shared token.** All remote devices share the same token. Regenerating
  it disconnects every device at once; there is no per-device revocation.

### Behind a reverse proxy

The loopback bypass described above — any request from `127.0.0.1`/`::1` is always allowed,
token or not — becomes unsafe the moment a reverse proxy (Traefik, nginx, Caddy…) sits in front
of Kōbō. In a typical Docker Compose deployment, Traefik and Kōbō run as separate containers on a
shared network; every request Kōbō sees originates from the proxy, and depending on the network
path it can be indistinguishable from a genuine loopback request. Without this setting, anyone who
can reach the proxy publicly gets unauthenticated access to Kōbō, silently.

**Enable it**: Settings → Global → Network access → **Behind a reverse proxy** (only visible once
Network access itself is enabled). No restart needed — unlike the main Network access toggle, this
one only changes the per-request auth decision, not the listening address.

**What changes**: the loopback bypass is disabled entirely. Every request — including ones from
the host machine itself — must present the token. If you `curl localhost:3000` directly from
inside the container or the host for debugging, you now need `-H "X-Kobo-Token: <token>"` too.

For the concrete Docker setup (which compose file, which env vars, which volumes), see
[Docker deployment](#docker-deployment) below.

## Docker deployment

Kōbō ships an official `Dockerfile` and three ready-to-use Compose files, one per use case. All
three build from the same image; only the topology and a handful of env vars differ.

### Choosing a compose file

| File | Topology | Use it for |
|---|---|---|
| [`docker-compose.local.yml`](./docker-compose.local.yml) | Kōbō only, port `3000` published directly. No Traefik, no TLS, no SSH server, no Docker socket. | Trying Kōbō out or poking at a change locally — the fastest path to a running instance. |
| [`docker-compose.local-traefik.yml`](./docker-compose.local-traefik.yml) | Traefik in front, Kōbō never on a published port, `kobo.localhost` (auto-resolves to `127.0.0.1`, no `/etc/hosts` editing). | Rehearsing the exact reverse-proxy topology/auth/mount setup locally, before touching a real VPS. |
| [`docker-compose.example.yml`](./docker-compose.example.yml) | Traefik + Let's Encrypt (real domain, real TLS), SSH access, optional Docker-socket passthrough. | The reference for an actual production deployment (VPS behind a reverse proxy). |

All three share the same underlying image (`docker build -t kobo:local .` from the repo root,
once) and the same core volume set; they differ in network topology and which optional pieces
(SSH server, Docker socket, TLS) are wired in.

### The image

Multi-stage `Dockerfile`, `node:24.19.0-slim` base:

- **Build stage**: installs root, client, and PWA deps, then runs `npm run build` (client via Quasar, server via `tsc`).
- **Runtime stage**: production deps only, plus OS tooling the agents and forge CLIs need — `git`, `openssh-client` + `openssh-server`, `ripgrep`, `fd-find`, `jq`, `curl`, Python + build tools, the Docker CLI (talks to a mounted host socket, see [Volumes](#volumes)), `gh`, `glab`, `tmux`, `vim`/`nano`, and more for interactive shell use.
- **Global CLIs**: `@anthropic-ai/claude-code` and `@openai/codex` are installed globally for interactive login (`claude /login`, `codex login` over SSH) — separate from Kōbō's own bundled SDK/subprocess usage, which needs no global install.
- **`git config --system --add safe.directory '*'`**: the container runs as root, but bind-mounted project repos keep the *host* user's UID on disk. Git's ownership check (CVE-2022-24765 mitigation) refuses to touch a repo it doesn't "own" unless told otherwise. This line pre-trusts every mounted path — fine for a single-user dev container, not something you'd do on a multi-tenant host.
- **`HEALTHCHECK`**: `curl -f http://localhost:$SERVER_PORT/api/health` every 30s. `/api/health` is exempt from the network-access token gate unconditionally (even with `networkAccessBehindProxy` on) — Docker's `HEALTHCHECK` process has no way to supply the runtime-generated token, and without the exemption a "behind a reverse proxy" container never reports healthy, which makes Traefik's Docker provider filter it out of its router table entirely (Traefik drops unhealthy/starting containers from routing).
- **`EXPOSE 3000`**, `ENV SERVER_PORT=3000`, entrypoint `docker-entrypoint.sh` → `npm start`.

Build once: `docker build -t kobo:local .`

### Environment variables (Docker)

Beyond the [general environment variables](#environment-variables), these matter specifically for a container deployment:

| Variable | Where it's set | Purpose |
|---|---|---|
| `KOBO_HOME` | all three compose files | Points at the named volume mount (`/root/.config/kobo`) so state survives `docker compose down`. |
| `KOBO_NETWORK_ACCESS_ENABLED` | all three | Binds Kōbō to `0.0.0.0` inside the container at boot — required, since a Docker-forwarded or Traefik-proxied connection never looks like true loopback from Kōbō's point of view, even locally. Without it the container's `127.0.0.1`-only default blocks every external route. |
| `KOBO_NETWORK_ACCESS_BEHIND_PROXY` | `local-traefik.yml`, `example.yml` | Disables the loopback-trust bypass entirely — needed whenever a reverse proxy sits in front, since every request now looks like it comes from the proxy. Not set in `local.yml`, which publishes Kōbō's port directly with no proxy in between. |
| `GH_TOKEN` / `GITLAB_TOKEN` | `example.yml` (bring your own via `.env`) | Non-interactive auth for `gh`/`glab` inside the container — there's no browser to complete an interactive `gh auth login` on a headless VPS. |
| `KOBO_PROJECTS_DIR` | host-side, read by all three via `${KOBO_PROJECTS_DIR:-./kobo-projects}` | Not a container env var — a *host* shell variable that picks the bind-mount source for `/projects`. Defaults to `./kobo-projects` next to the compose file. |

Both `KOBO_NETWORK_ACCESS_ENABLED` and `KOBO_NETWORK_ACCESS_BEHIND_PROXY` are read once at boot —
this is what lets the container come up fully configured with no manual Settings-UI step (there's
no browser to click through on a fresh headless deploy). The auto-generated token still needs to be
retrieved once — see [Token / login flow](#token--login-flow).

### Volumes

| Mount | RO/RW | Purpose |
|---|---|---|
| `<name>-data:/root/.config/kobo` (named volume) | RW | Kōbō's own state — SQLite DB, `settings.json`, etc. Named (not bind-mounted) so it survives `docker compose down` without `-v`, and so it can be deliberately **shared** across compose files by reusing the same volume name (see the two local files, both `kobo-test-data`). |
| `${KOBO_PROJECTS_DIR:-./kobo-projects}:/projects` | RW | The repos you create workspaces against, and their worktrees — all on one filesystem, so a worktree created next to a project lands on the same volume as the project itself. |
| `${HOME}/.ssh:/root/.ssh` | RO | Git SSH auth — needed to push/pull over SSH remotes. |
| `${HOME}/.gitconfig:/root/.gitconfig` | RO | Commit author identity. Without it, agent-authored commits fail with "please tell me who you are". |
| `${HOME}/.claude.json:/root/.claude.json` | RW | Claude Code auth + MCP server registrations. **Must already exist as a file on the host** (run `claude /login` locally first if it doesn't) — Docker silently creates an empty *directory* instead of erroring on a missing bind-mount source, which breaks auth in a confusing way. |
| `${HOME}/.claude:/root/.claude` | RW | Claude Code's full state directory (skills/plugins cache, session transcripts, memory) — Claude Code writes into this tree during normal operation. |
| `${HOME}/.codex:/root/.codex` | RW | Codex's full state directory (`auth.json`, `config.toml`). Harmless to mount even if you only use Claude Code. |
| `/var/run/docker.sock:/var/run/docker.sock` | RW, `example.yml` only | Lets the dev-server panel start/stop/tail logs for your projects' own `docker compose` stacks. **DANGER**: grants the container root-equivalent control over the host — anyone who can run a command inside `kobo` can spawn a privileged container that mounts the host filesystem. Remove this line if you don't need the dev-server panel. |

### Ports

| Port | File(s) | Notes |
|---|---|---|
| `3000` (published) | `local.yml` only | Kōbō's HTTP/WS port, published directly — no proxy in front. |
| `80` | `local-traefik.yml` | Traefik's plain-HTTP entrypoint, routes `kobo.localhost` / `traefik.localhost`. |
| `443` | `example.yml` | Traefik's TLS entrypoint (Let's Encrypt via the `le` cert resolver), routes your real domain. |
| `2222 → 22` (published) | `example.yml` only | SSH into the container (`ssh -p 2222 root@<host>`), key-based auth only via the same mounted `~/.ssh`, no password login. The one exception to "no published ports" — Traefik proxies HTTP/WS, not raw TCP, so SSH needs its own path. Rebuilding the image regenerates the SSH host keys, so expect a one-time "host key changed" warning from your SSH client after a rebuild. |

Kōbō itself is **never** published directly in the two Traefik-fronted files — only Traefik is
reachable, matching the real production posture.

### Token / login flow

All three files pre-enable network access via env vars, so there's no interactive Settings-UI step.
Retrieve the auto-generated token from the container's boot log, then bookmark the token-bearing URL:

```bash
docker compose -f <compose-file> logs kobo | grep Token
```

Open `http://<host>/?token=<token>` (exact host depends on the file — see the walkthroughs below).
The token is stored in the browser's `localStorage`, so you only paste it once per browser.

### Quick local test — `docker-compose.local.yml`

```bash
docker build -t kobo:local .                          # once
docker compose -f docker-compose.local.yml up -d
docker compose -f docker-compose.local.yml logs kobo | grep Token
```

Open `http://localhost:3000/?token=<token from above>`.

By default the file bind-mounts `./kobo-projects` (next to it) at `/projects` — put a real git repo
in there (or set `KOBO_PROJECTS_DIR` to point elsewhere) before creating a workspace. When you get
to the project-path picker in the Create-workspace UI, remember it's browsing the **container's**
filesystem, not your host's — your repo shows up under `/projects/<name>`, not wherever it lives on
your machine. A repo created purely with `git init` has no `origin` remote — Kōbō needs one to
`git fetch`, so either clone a real project into `/projects`, or point `origin` at any reachable git
URL (a local bare repo works fine for throwaway testing — see [Troubleshooting](#troubleshooting)).

Stop with `docker compose -f docker-compose.local.yml down` (add `-v` to also drop the named volume
and lose all Kōbō state).

### Rehearsing the reverse-proxy stack — `docker-compose.local-traefik.yml`

```bash
docker build -t kobo:local .                          # once, if not already built
docker compose -f docker-compose.local-traefik.yml up -d
docker compose -f docker-compose.local-traefik.yml logs kobo | grep Token
```

Open `http://kobo.localhost/?token=<token from above>` — `.localhost` resolves to `127.0.0.1` on
most OSes without touching `/etc/hosts`. This exercises the exact routing/auth/mount setup used by
`docker-compose.example.yml`, minus a real domain and TLS certificate.

**Traefik dashboard**: `http://traefik.localhost`, protected by HTTP basic auth (`admin` /
`kobo-local` — a local-only throwaway credential). Useful for debugging router/service discovery
(`/api/http/routers` shows exactly what Traefik sees). To change the password, generate a new hash
and swap it into the `dashboard-auth` middleware label:

```bash
openssl passwd -apr1 '<new-password>'
```

The hash contains literal `$` characters, which Compose's own variable interpolation would try to
expand — every `$` in the label value must be doubled to `$$` (already done in the shipped file).

This file intentionally shares its named volume (`kobo-test-data`) with `docker-compose.local.yml`,
so a workspace created under one is visible under the other. If you want isolated state instead,
rename the volume in one of the two files.

Stop with `docker compose -f docker-compose.local-traefik.yml down`.

### Real deployment — `docker-compose.example.yml`

Before using it:

1. Replace `image: kobo:local` with a real registry tag once one is published, or `docker build -t kobo:local .` from this repo on the target machine.
2. Replace `kobo.example.com` with your real domain, and `you@example.com` with a real email (Let's Encrypt account).
3. Populate a `.env` file next to the compose file with `GH_TOKEN` / `GITLAB_TOKEN` if you use the forge integration.
4. Point every bind mount (`~/.ssh`, `~/.gitconfig`, `~/.claude.json`, `~/.claude`, `~/.codex`) at real paths on the host — see [Volumes](#volumes) for what each one is for, in particular the "`~/.claude.json` must already exist as a file" gotcha.
5. Decide whether you need the Docker-socket passthrough (dev-server panel). If not, delete that volume line — see the DANGER note in [Volumes](#volumes).
6. Network access + behind-a-reverse-proxy are already pre-enabled via the `KOBO_NETWORK_ACCESS_*` env vars in the file — no manual bootstrap step.

Bring it up, grab the token, bookmark the URL:

```bash
docker compose -f docker-compose.example.yml up -d
docker compose -f docker-compose.example.yml logs kobo | grep Token
```

Open `https://kobo.example.com/?token=<token>`. SSH access: `ssh -p 2222 root@<host>` (key-based
only). See [Ports](#ports) and [Volumes](#volumes) above for the full rationale on the Docker socket
and SSH tradeoffs before deploying this to a real machine.

### Troubleshooting

- **`fatal: detected dubious ownership in repository at '/projects/<name>'`** — only happens if you
  build your own image without the `git config --system --add safe.directory '*'` line described in
  [The image](#the-image) above; the shipped image already has it.
- **A workspace's `git fetch origin` fails with "'origin' does not appear to be a git repository"**
  — the project under `/projects/<name>` has no `origin` remote (e.g. a plain `git init` test repo).
  Kōbō's workspace-creation flow always does `git fetch origin <branch>` first. Fix by pointing
  `origin` at any reachable git URL; for throwaway testing, a local bare repo works fine:
  ```bash
  git init -q --bare /projects/my-repo-remote.git
  git -C /projects/my-repo push /projects/my-repo-remote.git HEAD
  git -C /projects/my-repo remote add origin /projects/my-repo-remote.git
  ```
- **The project-path picker in the Create-workspace UI shows unfamiliar folders** — it browses the
  **container's** filesystem, not your host's. Your repos show up under `/projects/<name>`, not
  wherever they live on your machine.
- **Container stays `unhealthy` / Traefik never routes to it with `KOBO_NETWORK_ACCESS_BEHIND_PROXY=true`**
  — check `docker inspect <container> --format '{{json .State.Health}}'`. This should not happen on
  a current image (`/api/health` is exempt from the token gate, see [The image](#the-image)); if you
  see a 401 in the health log on a custom-built image, you're missing that exemption.
- **`docker compose logs kobo | grep Token` returns nothing** — network access wasn't enabled at
  boot. Confirm `KOBO_NETWORK_ACCESS_ENABLED=true` is actually set in the `environment:` block for
  the `kobo` service.

## Agent runtimes

Engines are selected per workspace at creation time. Both share the same UI surface (chat feed, task panel, permission modes, sub-agent panel, quota footer, auto-loop).

### Claude Code

Authenticate once:

```bash
claude /login
```

Kōbō talks to the embedded [`@anthropic-ai/claude-agent-sdk`](https://github.com/anthropics/claude-agent-sdk-typescript), which reuses the same login. The `claude` CLI is **not** required at runtime; you only need it for `/login`, `mcp add`, and other one-off setup commands. As a fallback you can export `ANTHROPIC_API_KEY` instead.

Supported models include `claude-opus-4-7`, `claude-opus-4-6`, `claude-sonnet-4-6`, `claude-haiku-4-5`. Pick the default in **Settings → Agents → Default model (Claude Code)**.

### OpenAI Codex

> Experimental. The Claude Code engine remains the primary, battle-tested path.

Authenticate either way:

```bash
codex login                                # writes ~/.codex/auth.json
# OR
OPENAI_API_KEY=sk-… npx @loicngr/kobo
```

Kōbō spawns a long-lived `codex app-server` subprocess per workspace and bridges its JSON-RPC stream to the same UI. The `codex` binary ships transitively via [`@openai/codex`](https://www.npmjs.com/package/@openai/codex), so no separate install is required.

When a Codex session is already working, **Send now** sends a queued chat message through the app-server's `turn/steer` endpoint. The message stays queued until Codex acknowledges the steer request; a failed request is restored to the queue instead of being lost.

Supported models include `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, and `gpt-5.3-codex` (note: `gpt-5.5` requires ChatGPT auth; API-key auth is limited to `gpt-5.4` and below). Reasoning effort (`auto` / `minimal` / `low` / `medium` / `high` / `xhigh`) is selectable on every workspace. Both selectors switch automatically when you flip the engine.

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
| `bypass` | `danger-full-access` | `never` | `default` |
| `strict` | `workspace-write` | `on-request` | `default` |
| `interactive` | `workspace-write` | `unless-trusted` | `default` |

Interactive Q&A (`request_user_input`) is only available in `plan` for Codex, a constraint of Codex itself. In `bypass`, `strict`, and `interactive`, Codex can still ask questions as normal chat text and you can respond in the chat, but it cannot open Kōbō's structured question panel.
Full access in `bypass` is required for linked-worktree Git metadata under the repository's shared `.git` directory.

When an approval panel appears, **Allow this turn** permits the same tool for
the rest of the current session. **Allow this operation** stores a rule for the
same workspace, engine, tool, and exact operation payload; **Allow this tool**
stores a rule for every invocation of that tool in the workspace. Persistent
rules survive restarts and can be removed from the workspace's permission UI.

## Dev server

Each workspace can run its own dev server. The **Tools** panel shows its status, a clickable URL, the live container count, and a logs button. That works only when your project follows a small contract. This section documents the contract so the panel lights up for *your* project, not just Docker-instance projects.

### What the panel actually does

Kōbō treats the dev server in two independent layers:

| Layer | Driven by | Works for any project? |
|---|---|---|
| **Start / Stop** | The shell commands you configure | ✅ Yes, any shell-startable process |
| **Status badge, URL, container count, logs** | The `.container/instances/*.env` convention + Docker | ❌ No, requires the convention below |

You can always start and stop a server. The green **Running** badge, the `http://localhost:…` link, and the logs viewer only appear when Kōbō can *resolve an instance* for the workspace. If it can't, the status stays `unknown` and no URL is shown; Start/Stop still work, just blind.

> **Known limitation: Docker-coupled, for now.** Status detection, the URL, the container count, and the logs viewer are currently hard-wired to Docker and to the `.container/instances/*.env` convention described below. This is a deliberate, temporary state: it works today for Docker-instance projects, and the convention is documented here so you can adopt it. An **evolution is planned** to abstract this layer, making the URL/port configurable and the running-detection engine-agnostic (e.g. a TCP probe) so the panel works for any project, Docker or not, without imposing this file layout. Until that lands, follow the contract below.

### 1. Configure start / stop commands

In **Settings → (project) → Dev server**, set:

| Field | Purpose |
|---|---|
| `devServer.startCommand` | Shell command (or multi-line script) run to start the server. **Required.** |
| `devServer.stopCommand` | Shell command run to stop it. Optional. |

How Kōbō runs them:

- `startCommand` runs as `bash -c "<command>"`, detached, with the working directory set to the workspace **worktree** (falling back to the project root).
- It runs with two extra environment variables injected:
  - `INSTANCE`: the workspace branch name, sanitized: lowercased, with `/` and `_` replaced by `-`. Example: branch `feature/My_Thing` → `INSTANCE=feature-my-thing`.
  - `DEV_DOCKER_NO_FOLLOW=1`: a hint that your script must **not** block tailing logs. Start the server, then exit. If your start command stays in the foreground (e.g. `docker compose logs -f`), Kōbō's process never returns and the status stays stuck on `starting`.
- `stopCommand` runs with `INSTANCE` and `PROJECT_NAME` in the environment. After it, Kōbō also unconditionally runs `docker compose -p <PROJECT_NAME> down` if a `PROJECT_NAME` was resolved, so a Docker project does not strictly need a `stopCommand` at all.

### 2. Make the status panel light up — the `.container/instances` contract

For the **Running** badge, the URL, the container count, and the logs button to appear, your **start command must create an instance file**:

```
<project-root>/.container/instances/<any-name>.env
```

Notes:

- The path is relative to the **project root** Kōbō knows (the main repo path), not the per-workspace worktree.
- The file name is free; Kōbō scans *every* `*.env` file in that directory.
- The file must contain these keys (`KEY=value`, `#` comments and surrounding quotes are tolerated):

| Key | Used for |
|---|---|
| `INSTANCE_NAME` | **Matching.** Must equal the sanitized branch name, i.e. the value of the `INSTANCE` env var Kōbō passed you. This is how Kōbō finds *this workspace's* instance among all the `.env` files. |
| `HTTP_PORT` | The URL. Kōbō shows `http://localhost:<HTTP_PORT>`. |
| `PROJECT_NAME` | **Running detection.** Kōbō lists running Docker containers (`docker ps`) and counts those whose name *contains* `PROJECT_NAME` (case-insensitive). One or more match → status `running`. Zero → `stopped`. |

The simplest correct start script therefore: read `$INSTANCE`, start your containers, then write the `.env` file with `INSTANCE_NAME=$INSTANCE`.

### 3. Running detection and logs

- **Status**: `running` if at least one Docker container's name contains `PROJECT_NAME`; `starting` while the start process is still in flight; `stopped` otherwise; `unknown` if no instance file matched.
- **Logs**: the logs button runs `docker logs` on those same matched containers.

Both are **Docker-only**. A project that runs a plain Node process (`npm run dev`) and writes an instance file will get a URL, but the badge will read `stopped` and the logs button will be empty, because there is no matching Docker container. If you don't use Docker, treat the URL as the useful signal and ignore the badge.

### Minimal setups

**Docker project**: full panel support. Follow the contract: start command creates the `.env`, containers are named after `PROJECT_NAME`.

**Non-Docker project (e.g. Vite/Node)**: partial support. You can still get a clickable URL:

1. Set `startCommand` to something like `PORT=$((3000)) npm run dev & echo started`.
2. Have it (or a wrapper) write `.container/instances/<branch>.env` with `INSTANCE_NAME=$INSTANCE` and `HTTP_PORT=3000`. `PROJECT_NAME` can be anything.
3. The URL appears; the status badge will say `stopped` (no Docker container), as expected.

**No instance file at all**: Start/Stop run your commands; the panel shows `unknown` with no URL. Perfectly fine if you just want the buttons.

### Example: the full convention end-to-end

The reference implementation is the `sekur` project. Its Kōbō `startCommand` is effectively `make dev-docker`, where the `Makefile` calls `./sh/dev-docker.sh $(INSTANCE)` and `$(INSTANCE)` reads the `INSTANCE` env var Kōbō injects. The script:

1. Picks free ports starting at `8700`.
2. Names the Docker Compose project `sekur-<instance>` and runs `docker compose -p sekur-<instance> up -d`.
3. Writes `<project-root>/.container/instances/sekur-<instance>.env`:

```env
# Instance: feature-my-thing
PROJECT_NAME=sekur-feature-my-thing
INSTANCE_NAME=feature-my-thing
HTTP_PORT=8700
HTTPS_PORT=8701
DB_PORT=8702
```

4. Honors `DEV_DOCKER_NO_FOLLOW=1` by exiting instead of tailing logs.

Kōbō then resolves the workspace (branch `feature/my-thing` → sanitized `feature-my-thing` → matches `INSTANCE_NAME`), shows `http://localhost:8700`, and detects the `sekur-feature-my-thing-*` containers as `running`.

### A minimal, copy-pasteable start script

Drop this in your project as `sh/dev-docker.sh`, make it executable (`chmod +x`), and set the Kōbō `startCommand` to `bash sh/dev-docker.sh`. It is a trimmed-down version of the `sekur` script, keeping only what the convention requires.

```bash
#!/usr/bin/env bash
# Starts an isolated Docker instance for the current Kōbō workspace and
# writes the .container/instances/<project>.env file Kōbō reads for status.
set -e

# Kōbō injects INSTANCE (sanitized branch name). Fall back to the git branch
# so the script also works when run by hand.
INSTANCE_NAME="${INSTANCE:-$(git branch --show-current | tr '/_' '-' | tr '[:upper:]' '[:lower:]')}"

# Docker Compose project name — must appear in the container names so Kōbō's
# `docker ps` matching detects the instance as running.
APP_NAME="${APP_NAME:-myapp}"
PROJECT_NAME="${APP_NAME}-${INSTANCE_NAME}"

# Pick the first free HTTP port starting at 8700 (10-port stride per instance).
HTTP_PORT=8700
while nc -zw1 localhost "$HTTP_PORT" 2>/dev/null; do
  HTTP_PORT=$((HTTP_PORT + 10))
done

# The instance file MUST live under the project root, in .container/instances/.
INSTANCE_DIR="$(git rev-parse --show-toplevel)/.container/instances"
mkdir -p "$INSTANCE_DIR"
cat > "${INSTANCE_DIR}/${PROJECT_NAME}.env" <<EOF
# Instance: ${INSTANCE_NAME}
PROJECT_NAME=${PROJECT_NAME}
INSTANCE_NAME=${INSTANCE_NAME}
HTTP_PORT=${HTTP_PORT}
EOF

# Start the containers. `-p "$PROJECT_NAME"` names them so detection works;
# export HTTP_PORT so compose.yaml can bind it.
HTTP_PORT="$HTTP_PORT" docker compose -p "$PROJECT_NAME" up -d

echo "Started ${PROJECT_NAME} on http://localhost:${HTTP_PORT}"

# Kōbō runs this detached and sets DEV_DOCKER_NO_FOLLOW=1 — exit instead of
# tailing logs, otherwise the status stays stuck on `starting`.
if [ "${DEV_DOCKER_NO_FOLLOW:-0}" = "1" ]; then
  exit 0
fi
docker compose -p "$PROJECT_NAME" logs -f
```

Matching `stopCommand` (optional; Kōbō also runs `docker compose -p <PROJECT_NAME> down` itself):

```bash
docker compose -p "${APP_NAME:-myapp}-${INSTANCE}" down
```

Adapt the port stride, the `APP_NAME`, and any extra `*_PORT` keys to your stack. The three keys Kōbō reads stay fixed: `INSTANCE_NAME`, `PROJECT_NAME`, `HTTP_PORT`.

### Troubleshooting

| Symptom | Likely cause |
|---|---|
| Status stuck on `starting` | Start command never exits; it's tailing logs. Make it return; honor `DEV_DOCKER_NO_FOLLOW`. |
| Status `unknown`, no URL | No `.env` in `.container/instances/`, or its `INSTANCE_NAME` doesn't match the sanitized branch. Check `INSTANCE_NAME` equals `$INSTANCE`. |
| URL shown but badge says `stopped` | No running Docker container whose name contains `PROJECT_NAME` (normal for non-Docker projects). |
| Logs button empty | Same cause: `docker logs` has no matching container. |
| Wrong port in URL | `HTTP_PORT` in the `.env` doesn't match the port the server actually bound. |

## Forge integration

Kōbō can open pull requests (GitHub or Bitbucket) or merge requests (GitLab) directly from the Git panel. The **forge** setting controls which service is used for a given project.

### Modes

| Value | Behaviour |
|---|---|
| `auto` (default) | Kōbō reads the `origin` remote URL: host contains `github.com` → GitHub; host contains `gitlab` → GitLab; host contains `bitbucket` → Bitbucket Community; anything else → `none`. |
| `github` | Always use GitHub, regardless of the remote URL. |
| `gitlab` | Always use GitLab, regardless of the remote URL. |
| `bitbucket-community` | Always use Bitbucket Community (`bkt`), regardless of the remote URL. |
| `none` | PR/MR features are disabled. The PR block is hidden in the Git panel. |

Set the per-project value in **Settings → (project) → Forge**.

### Auto-detection

`auto` is designed to work without any configuration for the common cases:

- GitHub.com repositories: the remote URL contains `github.com` → GitHub detected automatically.
- GitLab.com repositories: the remote URL contains `gitlab` → GitLab detected automatically.
- Bitbucket Cloud repositories: the remote URL contains `bitbucket.org` → Bitbucket Community detected automatically.
- Self-hosted GitLab on a custom hostname (e.g. `git.mycompany.com`): the hostname does not contain `gitlab`, so `auto` falls back to `none`. Set `forge: gitlab` explicitly for these projects.

### CLI prerequisites

Kōbō delegates PR/MR operations to the forge CLI and ships no credentials of its own. You must install and authenticate the relevant CLI before the PR actions become available:

**GitHub:**

```bash
# Install: https://cli.github.com
gh auth login
```

**GitLab (GitLab.com):**

```bash
# Install: https://gitlab.com/gitlab-org/cli
glab auth login
```

**GitLab (self-hosted):**

```bash
glab auth login --hostname git.mycompany.com
```

**Bitbucket Cloud:**

Install [`bkt`](https://github.com/avivsinai/bitbucket-cli), then open **Settings → Forge** and enter your Atlassian email and a Bitbucket-scoped API token. Kōbō keeps this token locally, excludes it from settings exports, and passes it to `bkt` for Bitbucket workspaces and their agents. No `bkt auth login` context or interactive keyring prompt is required.

Kōbō only invokes the CLI binary. If the CLI is missing from `PATH` or not authenticated, PR/MR actions are disabled with an explanatory tooltip in the Git panel. Kōbō keeps working; only the PR/MR features are affected.

### UI behaviour

- The Git panel label adapts per forge: **Create PR** on GitHub and Bitbucket, **Create MR** on GitLab.
- When `forge` is `none` (or auto-resolves to `none`), the PR/MR block is hidden entirely: no errors, no placeholders.
- When the CLI is absent or unauthenticated, the button is disabled with a tooltip explaining the issue instead of surfacing a raw error.

## Notion integration

Pulls the body, title, and checklists of a Notion page to seed a workspace's tasks and acceptance criteria.

Enable the integration in **Settings → Notion**. Disabling it preserves its
credentials and existing workspace links but hides Notion import and automation
actions until it is enabled again.

Use **Test connection** in the same Settings tab to start the configured MCP
server, initialise it, and make a lightweight authenticated API request. The
result shows the elapsed time or an actionable configuration error.

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

The recommended path is **(3)**: one token shared between Claude Code and Kōbō:

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

When `notionAssigneeProperty` is set, Kōbō updates the named People property on the imported page to `notionUserId`, but only if the property has no assignee yet. Both fields are global settings; leave blank to disable.

### Status field updates

When `notionStatusProperty` is set, Kōbō flips it to `notionInProgressStatus` as soon as the workspace starts work. Useful for keeping a Notion kanban in sync.

## Sentry integration

Turns a Sentry issue URL into a "fix workspace": Kōbō extracts the stacktrace, tags, and offending spans, writes them to `.ai/thoughts/SENTRY-<id>.md`, and primes the agent with a TDD fix workflow plus live access to the Sentry MCP tools.

Enable the integration in **Settings → Sentry**. Disabling it preserves its
configuration and existing workspace links but hides Sentry import and
automation actions until it is enabled again.

Use **Test connection** in the same Settings tab to initialise the configured
MCP server and run its identity check. The result shows the elapsed time or an
actionable configuration error.

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

When Sentry is active, the workspace description field becomes optional; the extracted context is enough to start work.

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

- **Temperature** (`0`–`1`): decoding stability vs flexibility.
- **Initial prompt**: biases recognition for custom vocabulary, names, or jargon.
- **Translate to English**: translate non-English speech rather than transcribing it.
- **Suppress non-speech tokens**: reduce non-speech artefacts in the output.

## Skill suites

Kōbō's auto-generated prompts (review template, auto-loop grooming intro, QA template, brainstorming instruction) reference skills by name. The **Settings → Skills → Skill suite** selector picks which ecosystem those prompts target. Four options are supported:

| Suite | Auto-prompts cite | Best for |
|---|---|---|
| `superpowers` (default) | `superpowers:*` skills (brainstorming, writing-plans, executing-plans, TDD, debugging, requesting-code-review, …) | Plugin-driven workflow inside Claude Code |
| `gstack` | gstack slash commands (`/review`, `/ship`, `/qa`, `/browse`, `/design-review`, `/investigate`, `/codex`, …) | Concrete CLI-driven workflows, browser-based QA, opinionated ship/deploy loop |
| `superpowers+gstack` | Both, specialised by intent (e.g. `/review` for tactical bug-hunting, `superpowers:requesting-code-review` for principles-level critique) | Users who install both suites and want each used for what it does best |
| `custom` | Whatever you write in the `custom*` fields (Settings → Skills → Custom prompts) | Air-gapped, suite-agnostic, or non-standard setups |

Switching the selector only changes the prompt text Kōbō emits; it does **not** install or remove anything. Pick whichever matches the skills you have available in your Claude Code / Codex environment.

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

[`gbrain`](https://github.com/garrytan/gbrain) is a separate companion tool: a per-project knowledge graph and semantic search index, with an MCP server interface. It's **not** a Kōbō skill suite (it doesn't change the auto-generated prompts) but it plugs into Kōbō workspaces transparently via the standard Claude Code MCP config: any MCP server registered in `~/.claude.json` is inherited by Kōbō agents at session start.

When gbrain is configured, the agent gets access to tools like:

- `search`, `query`, `resolve_slugs`: semantic + graph search over the project's indexed content
- `get_page`, `put_page`, `delete_page`, `get_chunks`, `get_versions`, `revert_version`: page-level knowledge-graph CRUD
- `add_link`, `remove_link`, `get_links`, `get_backlinks`, `traverse_graph`, `find_orphans`: link operations
- `add_tag`, `remove_tag`, `get_tags`: tagging
- `submit_job`, `list_jobs`, `get_job`, `get_job_progress`, `pause_job`, `resume_job`, `retry_job`, `replay_job`, `cancel_job`: async ingestion jobs
- `add_timeline_entry`, `get_timeline`, `log_ingest`, `get_ingest_log`: per-project activity log
- `file_list`, `file_upload`, `file_url`: file attachments
- `sync_brain`, `get_health`, `get_stats`: administration

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
- If you don't use gbrain, the agent falls back to `grep` / `Read` for code exploration; no setup is required.
