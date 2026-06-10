# Changelog

All notable changes to Kōbō are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/). Each release is an `## <version>`
section — the in-app "What's new" dialog reads this file.

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
