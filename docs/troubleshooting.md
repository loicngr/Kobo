# Troubleshooting

## Environment check

Open the first-run setup from Help and run the check again after changing the selected engine or project. Reports show stable status codes and do not include raw command output or credentials.

| Check | Action |
|---|---|
| Node | Use Node 24.15 or later; contributors should use `.nvmrc`. |
| Git / Bash | Install the missing executable and make it available on the server's `PATH`. |
| Project | Select a writable Git repository containing at least one commit. |
| Storage / worktrees | Check permissions on `KOBO_HOME`, the project and configured worktree root. |
| Engine executable | Reinstall the package dependencies and check the chosen runtime installation. |
| Authentication / model: unknown | Authenticate with the selected provider, select a model available to that account, then run a small mission. The diagnostic deliberately makes no provider request. |

## Native dependency installation fails

Some platforms compile `node-pty` locally and need Python, make and a C++ compiler. During this rehearsal, node-gyp failed to find Node headers when its cache path contained spaces. Keep the build cache/home path free of spaces, or configure a separate node-gyp development cache before reinstalling. Application installation and Kōbō data directories with spaces and accented characters passed the Linux tarball test with a space-free build cache. This does not establish native Windows or WSL compatibility.

## The agent stays in Plan

Kōbō preserves your permission choice. Auto-loop can prepare a mission in Plan, but execution/finalization requires you to choose an execution mode explicitly. A plugin, prompt or workflow preference does not authorize an automatic permission escalation.

Commit, push and publication are independent preferences. Manual means an explicit request is needed for that action. More restrictive instructions such as “no commits” still win over automatic preferences. These prompt instructions do not replace a sandbox.

## Scheduled work waits

The concurrent-agent setting controls unattended admission, including auto-loop, scheduled work and quota retries. Running manual sessions count against capacity, but starting a manual session is exempt. A terminating agent owns its slot until its process is confirmed closed. Waiting does not mean the scheduled instruction has run. Inspect the schedule/loop status, quota reset and current sessions before retrying.

## Notion or Sentry fails

Enable the feature, save a direct connection or configure the legacy Claude MCP entry, and explicitly run Test connection. Check command availability, JSON arguments/environment, provider access and page/project permissions. Saving a connection replaces the complete private configuration; stored secrets are not returned to the browser. Clearing it restores legacy lookup if a legacy entry exists.

Kōbō hides MCP error text and stderr because third-party errors can include credentials. Inspect the MCP's configuration locally without pasting credentials into an issue. For Notion, server token environment variables override stored token variables; explicit `OPENAPI_MCP_HEADERS` remain authoritative for compatibility.

## Backup and restore

Daily and pre-migration SQLite snapshots are not a backup of settings, private integration configuration, repositories or uncommitted worktree changes.

1. Stop Kōbō and its agents cleanly. Copy the complete `KOBO_HOME` directory and separately preserve the project/worktree directories. Keep this backup private.
2. Before restoring, retain a copy of the current home. Use a separate directory for the restoration test and a matching application version. Never overwrite your only copy.
3. Copy the selected SQLite snapshot to `kobo.db` in that separate home. Remove only stale `kobo.db-wal`/`kobo.db-shm` files from the separate restore copy while no server is using it. Restore matching settings and other JSON files from the full backup.
4. Start with `KOBO_HOME` pointing at that separate directory. Confirm missions, conversations and settings before replacing production data. Old absolute worktree paths must still be available; starting an agent may write to them.

Migrations move forward. Running an older binary on a newly migrated database is not a supported rollback. Restore a compatible backup instead.

## Report a problem

Use GitHub Issues for reproducible bugs; include OS/architecture, Node and Kōbō versions, chosen engine, steps and expected/actual behavior. Remove prompts, repository paths, tokens and personal data from attachments. Do not upload `kobo.db`, your complete data home, integration configuration or raw conversation exports. Report vulnerabilities privately via [Security](../SECURITY.md).
