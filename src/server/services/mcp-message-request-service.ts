import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import { nanoid } from 'nanoid'

export type MessageRequestResult =
  | { accepted: true; requestId: string; sessionId?: string; eventId: string; replayed?: boolean }
  | {
      accepted: false
      requestId: string
      code: 'in_progress' | 'delivery_unknown' | 'idempotency_conflict' | 'delivery_rejected'
      message: string
    }
type State = 'reserved' | 'dispatching' | 'accepted' | 'rejected' | 'unknown'
interface Row {
  request_id: string
  fingerprint: string
  state: State
  result_json: string | null
}

export function reserveMessageRequest(
  db: Database.Database,
  workspaceId: string,
  key: string,
  content: string,
  sessionId?: string,
): { fresh: true; requestId: string } | { fresh: false; requestId: string; result: MessageRequestResult } {
  const fingerprint = createHash('sha256')
    .update(JSON.stringify([content, sessionId ?? null]))
    .digest('hex')
  return db
    .transaction(() => {
      const requestId = `mcp-${nanoid()}`
      const now = new Date().toISOString()
      const inserted = db
        .prepare(`INSERT INTO mcp_message_requests(workspace_id,idempotency_key,request_id,fingerprint,state,created_at,updated_at)
      VALUES (?,?,?,?,'reserved',?,?) ON CONFLICT(workspace_id,idempotency_key) DO NOTHING`)
        .run(workspaceId, key, requestId, fingerprint, now, now)
      if (inserted.changes) return { fresh: true as const, requestId }
      const row = db
        .prepare(
          'SELECT request_id,fingerprint,state,result_json FROM mcp_message_requests WHERE workspace_id=? AND idempotency_key=?',
        )
        .get(workspaceId, key) as Row
      let result: MessageRequestResult
      if (row.fingerprint !== fingerprint)
        result = {
          accepted: false,
          requestId: row.request_id,
          code: 'idempotency_conflict',
          message: 'This key was already used for different content or a different session',
        }
      else if (row.result_json) {
        result = JSON.parse(row.result_json) as MessageRequestResult
        if (result.accepted) result = { ...result, replayed: true }
      } else
        result = {
          accepted: false,
          requestId: row.request_id,
          code: row.state === 'unknown' ? 'delivery_unknown' : 'in_progress',
          message:
            row.state === 'unknown'
              ? 'Delivery may have occurred; inspect history before sending a new request'
              : 'This request is still in progress; retry the same key to check its outcome',
        }
      return { fresh: false as const, requestId: row.request_id, result }
    })
    .immediate()
}

export function markMessageDispatching(db: Database.Database, requestId: string): void {
  const result = db
    .prepare("UPDATE mcp_message_requests SET state='dispatching',updated_at=? WHERE request_id=? AND state='reserved'")
    .run(new Date().toISOString(), requestId)
  if (result.changes !== 1) throw new Error('MCP request is no longer reserved')
}

export function finishMessageRequest(
  db: Database.Database,
  requestId: string,
  state: 'accepted' | 'rejected' | 'unknown',
  result: MessageRequestResult,
): void {
  const changed = db
    .prepare(`UPDATE mcp_message_requests SET state=?,result_json=?,event_id=?,session_id=?,updated_at=?
    WHERE request_id=? AND state IN ('reserved','dispatching')`)
    .run(
      state,
      JSON.stringify(result),
      result.accepted ? result.eventId : null,
      result.accepted ? (result.sessionId ?? null) : null,
      new Date().toISOString(),
      requestId,
    )
  if (changed.changes !== 1) throw new Error('MCP request is no longer pending')
}

/** Backend startup only: never assume an interrupted engine delivery did not happen. */
export function reconcileMessageRequests(db: Database.Database): void {
  db.prepare(
    "UPDATE mcp_message_requests SET state='unknown',updated_at=? WHERE state IN ('reserved','dispatching')",
  ).run(new Date().toISOString())
}
