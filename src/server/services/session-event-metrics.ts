import type Database from 'better-sqlite3'

/**
 * Recompute one session's persisted metrics from the events that remain, on an
 * explicit database handle.
 *
 * Until v36 an `AFTER DELETE ... FOR EACH ROW` trigger did this per deleted
 * row, re-aggregating the whole session every time — 79.7 s for 20 000 events,
 * with the SQLite write lock held throughout. The trigger is gone; every code
 * path that deletes `agent:event` rows while KEEPING the session calls this
 * once, at the end of its transaction.
 */
export function recomputeSessionMetricsOn(db: Database.Database, workspaceId: string, sessionId: string): void {
  db.prepare('DELETE FROM session_event_metrics WHERE workspace_id = ? AND session_id = ?').run(workspaceId, sessionId)
  db.prepare(
    `INSERT INTO session_event_metrics (
       workspace_id, session_id, tool_calls, errors, input_tokens, output_tokens
     )
     SELECT
       e.workspace_id,
       e.session_id,
       SUM(CASE WHEN json_extract(e.payload, '$.kind') = 'tool:call' THEN 1 ELSE 0 END),
       SUM(CASE
         WHEN json_extract(e.payload, '$.kind') = 'error'
           OR (json_extract(e.payload, '$.kind') = 'tool:result'
             AND json_extract(e.payload, '$.isError') = 1)
         THEN 1 ELSE 0
       END),
       MAX(CASE
         WHEN json_extract(e.payload, '$.kind') = 'usage'
           AND json_type(e.payload, '$.inputTokens') IN ('integer', 'real')
         THEN CAST(json_extract(e.payload, '$.inputTokens') AS INTEGER) ELSE 0
       END),
       MAX(CASE
         WHEN json_extract(e.payload, '$.kind') = 'usage'
           AND json_type(e.payload, '$.outputTokens') IN ('integer', 'real')
         THEN CAST(json_extract(e.payload, '$.outputTokens') AS INTEGER) ELSE 0
       END)
     FROM ws_events e
     JOIN agent_sessions s ON s.id = e.session_id AND s.workspace_id = e.workspace_id
     WHERE e.workspace_id = ?
       AND e.session_id = ?
       AND e.type = 'agent:event'
       AND json_valid(e.payload)
     GROUP BY e.workspace_id, e.session_id`,
  ).run(workspaceId, sessionId)
}
