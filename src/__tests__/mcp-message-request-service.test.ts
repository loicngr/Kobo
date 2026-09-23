import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { runMigrations } from '../server/db/migrations.js'
import {
  finishMessageRequest,
  markMessageDispatching,
  reconcileMessageRequests,
  reserveMessageRequest,
} from '../server/services/mcp-message-request-service.js'

let db: Database.Database
let directory: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'kobo-requests-'))
  db = new Database(join(directory, 'test.db'))
  db.pragma('foreign_keys=ON')
  db.pragma('journal_mode=WAL')
  runMigrations(db)
  for (const id of ['a', 'b'])
    db.prepare(
      "INSERT INTO workspaces(id,name,project_path,source_branch,working_branch,created_at,updated_at) VALUES (?,?,'/tmp','main','work','now','now')",
    ).run(id, id)
})
afterEach(() => {
  db.close()
  rmSync(directory, { recursive: true, force: true })
})

it('reserves once across database connections and isolates workspace keys', () => {
  const first = reserveMessageRequest(db, 'a', 'key', 'hello')
  expect(first.fresh).toBe(true)
  const other = new Database(db.name)
  try {
    expect(reserveMessageRequest(other, 'a', 'key', 'hello')).toMatchObject({
      fresh: false,
      result: { accepted: false, code: 'in_progress', requestId: first.requestId },
    })
    expect(reserveMessageRequest(other, 'b', 'key', 'hello').fresh).toBe(true)
  } finally {
    other.close()
  }
})

it('rejects key reuse with different content or requested session', () => {
  reserveMessageRequest(db, 'a', 'key', 'hello', 's')
  expect(reserveMessageRequest(db, 'a', 'key', 'hello ', 's')).toMatchObject({
    result: { code: 'idempotency_conflict' },
  })
  expect(reserveMessageRequest(db, 'a', 'key', 'hello', 'other')).toMatchObject({
    result: { code: 'idempotency_conflict' },
  })
})

it('replays accepted receipts after reopening and history deletion', () => {
  const request = reserveMessageRequest(db, 'a', 'key', 'hello')
  markMessageDispatching(db, request.requestId)
  finishMessageRequest(db, request.requestId, 'accepted', {
    accepted: true,
    requestId: request.requestId,
    sessionId: 's',
    eventId: 'event',
  })
  db.exec('DELETE FROM ws_events')
  const filename = db.name
  db.close()
  db = new Database(filename)
  expect(reserveMessageRequest(db, 'a', 'key', 'hello')).toMatchObject({
    fresh: false,
    result: { accepted: true, requestId: request.requestId, sessionId: 's', eventId: 'event', replayed: true },
  })
})

it('reconciles unfinished requests as unknown without overwriting final outcomes', () => {
  reserveMessageRequest(db, 'a', 'reserved', 'hello')
  const dispatch = reserveMessageRequest(db, 'a', 'dispatch', 'hello')
  markMessageDispatching(db, dispatch.requestId)
  const rejected = reserveMessageRequest(db, 'a', 'rejected', 'hello')
  finishMessageRequest(db, rejected.requestId, 'rejected', {
    accepted: false,
    requestId: rejected.requestId,
    code: 'delivery_rejected',
    message: 'archived',
  })
  reconcileMessageRequests(db)
  reconcileMessageRequests(db)
  for (const key of ['reserved', 'dispatch'])
    expect(reserveMessageRequest(db, 'a', key, 'hello')).toMatchObject({
      result: { accepted: false, code: 'delivery_unknown' },
    })
  expect(reserveMessageRequest(db, 'a', 'rejected', 'hello')).toMatchObject({ result: { code: 'delivery_rejected' } })
})

it('deletes receipts with their workspace', () => {
  reserveMessageRequest(db, 'a', 'key', 'hello')
  db.prepare('DELETE FROM workspaces WHERE id=?').run('a')
  expect(db.prepare('SELECT COUNT(*) AS n FROM mcp_message_requests').get()).toEqual({ n: 0 })
})
