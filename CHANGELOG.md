# Changelog

## Unreleased

### Changed
- The `claude-code` engine now runs on top of the official [`@anthropic-ai/claude-agent-sdk`](https://github.com/anthropics/claude-agent-sdk-typescript) instead of spawning the `claude` CLI and parsing `stream-json` line by line. MCP servers are passed in-process (no temp config file), interrupts use `query.interrupt()` / `AbortController`, and event lifecycle is driven by typed `SDKMessage` instead of regex on stdout. Refs #9.
- The `claude` CLI is no longer a runtime dependency — only an authentication path (`claude /login` shares credentials with the SDK and the usage poller).
- Prose-based quota detection (regex on assistant text) was removed; the `usage/` poller (Anthropic OAuth usage endpoint) is the source of truth for quota state.

### Added
- `AskUserQuestion` is interactive. The agent can pause via the SDK `defer` pattern, surface a question panel in the UI, and resume after the user answers — without keeping the session resident in memory while it waits. Backed by a new `awaiting-user` workspace status and a `POST /api/workspaces/:id/deferred-tool-use/answer` endpoint.

### Removed
- `args-builder.ts`, `stream-parser.ts`, `mcp-config.ts` and their tests under `src/server/services/agent/engines/claude-code/` — obsolete after the SDK swap.
- The runtime ws_events content migration that converted legacy `agent:output` rows to typed `AgentEvent` is now a no-op (production DBs were already migrated). Legacy rows on rare unmigrated DBs are left untouched.
