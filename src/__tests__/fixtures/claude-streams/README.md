# Claude NDJSON stream fixtures

Each `.ndjson` file in this directory contains one line per Claude stream-json event, representing a discrete scenario used by the `stream-parser` tests.

## Naming convention

`<scenario>.ndjson` — lowercase, kebab-case. One scenario per file.

## Current fixtures

| File | Covers |
|---|---|
| `init.ndjson` | `system/init` with `slash_commands`, session_id, model, cwd |
| `text-streaming.ndjson` | `assistant` message with multiple `text` blocks (delta-style) + `message_delta` + `message_stop` |
| `tool-use-result.ndjson` | `assistant` with `tool_use`, followed by `user` with `tool_result` (the currently-filtered type) |
| `thinking.ndjson` | `assistant` with a `thinking` content block |
| `compact.ndjson` | `system/compact` and `system/compact_boundary` |
| `subagent.ndjson` | `system/task_started`, `system/task_progress`, `system/task_notification` with tool_use_id |
| `rate-limit.ndjson` | `system/rate_limit_event` with both Claude native shape (`rateLimitType` + `utilization`) and legacy `buckets[]` shape |
| `brainstorm-complete.ndjson` | `assistant` text containing `[BRAINSTORM_COMPLETE]`; also a raw (non-JSON) line containing the same marker |
| `result.ndjson` | `result` message with `usage` stats and `cost_usd` |

## Regenerating

These fixtures are hand-curated snapshots. To add a new one:

1. Enable `KOBO_DEV_LOG_STREAM=1` before starting a Kōbō dev session (see `src/server/services/agent/orchestrator.ts` for the hook point).
2. Tail `~/.config/kobo/stream.log` during a session that reproduces the scenario.
3. Extract the relevant lines, name the file, update this README.

Fixtures MUST stay syntactically valid NDJSON (one JSON object per line, no trailing comma). Verify with: `jq -c . < fixture.ndjson`.
