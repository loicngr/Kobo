# Changelog

All notable changes to Kōbō are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/). Each release is an `## <version>`
section — the in-app "What's new" dialog reads this file.

## 1.10.1

- fix(auto-loop): recover from interrupted sessions (#18)

## 1.10.0

- fix(agent): make Claude sessions recover cleanly from a stuck post-result
  stream, prevent native wakeups from leaving orphaned questions, and keep
  live sessions out of the `idle` state
- feat(chat): keep queued messages scoped to the selected workspace session,
  restore them after a rejected send, and confirm delivery only after the
  engine accepts it
- feat(chat): send a queued message immediately to an active Claude session
  or steer an active Codex turn; serialise concurrent Codex steer requests
  against the current turn id
- feat(questions): support inline free-form answers for **Other**, option
  previews, structured Codex question ids, missing option arrays, secret
  answers, and stale-question-panel recovery
- fix(codex): map `request_user_input` and its auto-resolution metadata to the
  shared question UI, and document that structured Codex questions require
  `plan` mode
- docs: document live steering, interactive-question limitations, and the
  updated Q&A experience in README and CONFIGURATION

## 1.9.6

- feat(chat): inject a queued message into a running Claude session, with a
  session-scoped queue and explicit server acceptance
- feat(sessions): persist the model used by each agent session and display it
  when it differs from the workspace default
- fix(auto-loop): apply the brainstorming model before the initial session
  starts; add a separate brainstorming reasoning-effort selector
- feat(mcp): let agents read paginated user/agent conversation history across
  workspace sessions as CSV, with optional session filtering
- fix(chat): start a fresh session automatically when a historical session
  cannot be resumed
- ui(create): clarify auto-loop, session-mode, brainstorming, model and
  reasoning-effort controls; remember reasoning effort per model locally
- docs: document the Claude queued-message behavior

## 1.9.5

- fix(tests): make macOS tests portable (#16)

## 1.9.4

- fix(codex): allow git writes in bypass mode (#15)

## 1.9.3

- build(deps): bump claude-agent-sdk, mcp sdk, and codex

## 1.9.2

- feat: fall back to local source branch when origin is unreachable (#14)

## 1.9.1

- fix: exempt /api/health from network-auth and add local Docker compose stacks

## 1.9.0

- feat: opt out a workspace from PR-watch (skip forge polling, keep local git stats)
- feat: official Docker image, with an example Traefik reverse-proxy stack
- feat: reverse-proxy-safe auth mode + env-var network-access bootstrap
- feat: workspace toolbar polish (aligned model badges, copy engine session ID)
- docs: document reverse-proxy mode, Docker deployment, and Codex maturity

## 1.8.9

- docs: sync README/AGENTS.md with recent changes, dedupe CHANGELOG

## 1.8.8

- fix: resolve npm audit findings and scope client audit to prod deps

## 1.8.7

- feat: add auto-loop brainstorming model override and Claude Opus 5

## 1.8.6

- feat: add auto-loop session modes and global MCP workspace tools

## 1.8.5

- feat: add gpt-5.6 codex model family and gpt-5.2 to catalogue
- docs: overhaul README and split contributor guide into CONTRIBUTING.md

## 1.8.4

- feat: add Claude Sonnet 5 to the model catalogue

## 1.8.3

- fix: prevent git-stats revert and queued-image loss, improve project picker

## 1.8.2

- feat: PR badge, usage date, toast and auto-loop UX fixes

## 1.8.1

- feat: opt-in LAN network access plus UX and workspace fixes (#13)
- chore(docs): update CHANGELOG

## 1.8.0

- feat(schedule): manual wakeup & cron management per workspace
- feat(agent): enforce wakeup at turn-end + keep background work alive
- feat(workspace): warn when viewing a non-latest session outside auto-loop

## 1.7.34

- chore(npm): update claude sdk

## 1.7.33

- chore(npm): update claude sdk

## 1.7.32

- feat: CI recap card, compaction indicator, Claude Task tools, deps upgrade, npm audit fix

## 1.7.31

- feat: ready-to-merge status, open-pr fix, new models, dep audit

## 1.7.30

- feat: open-in-terminal button + git creation/purge fixes

## 1.7.29

- feat: git working-tree tooling, template reset, diff label

## 1.7.28

- feat: commit diff review, workspace rename tool, macOS usage keychain

## 1.7.27

- feat(git): add dirty-worktree recovery for rebase/merge

## 1.7.26

- fix(claude-code-engine): migrate compaction reminder to SessionStart hook

## 1.7.25

- feat(models): add Claude Opus 4.8 and make it the default

## 1.7.24

- refactor: prune redundant comments from worktree-purge work
- docs: replace stray French UI labels with their English equivalents
- docs(changelog): drop stale Unreleased section duplicated by v1.7.23

## 1.7.23

- docs: document worktree purge, auto-restore, and permission recovery
- feat(client): onboarding highlights changelog and auto-purge toggle
- feat(pr-watcher): auto-restore manually-recreated worktrees
- feat(workspace): worktree purge with auto-archive and restore metadata
- feat(templates): add /kobo-context slash command (you need to re-import default templates)

## 1.7.22

- feat(client): accept the new app.notion.com URL format

## 1.7.21

- feat: assorted workspace polish and PR-watcher reliability

## 1.7.20

- feat: open worktree in the user's file manager
- fix(client): make archived workspace cards clickable

## 1.7.19

- feat(client): archived banner, Fix-CI button, changelog page, prompt-retry banner (Open archived workspace)
- feat(server): workspace lifecycle, CI failure UX, collision-safe creation (error in setup script)
- feat(client): disable mutating actions on archived workspaces
- feat(pr-watcher): mark workspace unread on attention transitions (ci request changes)
- chore(deps): npm audit fix
- chore(CHANGELOG): update

## 1.7.18

- chore(audit): fix npm audit
- feat(client): collapsible ask-user-question panel

## 1.7.17

- feat: per-workspace chat history + inline file editing in the diff viewer
- feat: multi-forge, change source branch, pr-watcher

## 1.7.16

- feat(engine): handle user interruptions as clean stops

## 1.7.15

- docs: document new settings and features
- build(release): generate changelog section in version bump
- feat(onboarding): guided tour and what's-new dialog
- feat(settings): scripts, branch prefixes and project cards
- feat(workspaces): bulk-delete archived workspaces and fix flat sort
- feat(create): per-project task prompt template
- feat(health): show schema and settings migration versions
- feat(chat): dedicated script cards in the conversation feed
- feat(chat): @-mention file autocomplete with fuzzy matching
- feat(export): CSV export of workspace session events
- feat(server): lifecycle scripts, bulk delete and migration safety

## 1.7.14

- Show the Kōbō version in the Health page Environment card.
- Document the `SERVER_PORT` / `PORT` overrides and fix the default port.
- Split the configuration reference into a dedicated `CONFIGURATION.md`.
