# Claude NDJSON stream fixtures

These hand-curated fixtures preserve examples from the legacy Claude
stream-json parser. The current engine consumes SDK messages and maps them in
`src/server/services/agent/engines/claude-code/event-mapper.ts`; the active tests
construct their messages directly and do not currently load this directory.
Most lines are JSON objects; the brainstorm fixture also contains a deliberate
raw-text fallback line.

## Naming convention

`<scenario>.ndjson` — lowercase, kebab-case. One scenario per file.

## Current fixtures

| File | Covers |
|---|---|
| `init.ndjson` | `system/init` with `slash_commands`, session_id, model, cwd |
| `text-streaming.ndjson` | `assistant` message with multiple `text` blocks (delta-style) + `message_delta` + `message_stop` |
| `tool-use-result.ndjson` | `assistant` with `tool_use`, followed by `user` with `tool_result` |
| `thinking.ndjson` | `assistant` with a `thinking` content block |
| `compact.ndjson` | `system/compact` and `system/compact_boundary` |
| `subagent.ndjson` | `system/task_started`, `system/task_progress`, `system/task_notification` with tool_use_id |
| `rate-limit.ndjson` | `system/rate_limit_event` with both Claude native shape (`rateLimitType` + `utilization`) and legacy `buckets[]` shape |
| `brainstorm-complete.ndjson` | `assistant` text containing `[BRAINSTORM_COMPLETE]`; also a raw (non-JSON) line containing the same marker |
| `result.ndjson` | `result` message with `usage` stats and `cost_usd` |

## Maintaining these fixtures

These fixtures are hand-curated snapshots. To add a new one:

1. Start from a minimal, sanitized example of the scenario. The old
   `KOBO_DEV_LOG_STREAM` / `stream.log` capture hook is no longer implemented.
2. Remove credentials, private paths and user content; keep only the fields
   needed to explain the event shape.
3. Name the file and update this table. If adding regression coverage, wire the
   fixture into an explicit test or use an inline SDK message in the existing
   engine/event-mapper tests.

JSON-only fixtures should contain one JSON object per line with no trailing
commas. Verify them with `jq -c . < fixture.ndjson`. The second line of
`brainstorm-complete.ndjson` intentionally contains only `[BRAINSTORM_COMPLETE]`;
validate its first line separately with
`head -n 1 brainstorm-complete.ndjson | jq -c .` and preserve the raw fallback.
