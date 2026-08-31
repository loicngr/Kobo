import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initSchema } from '../server/db/schema.js'
import {
  countPrunableWsEvents,
  pruneWsEvents,
  resolveRetentionConfig,
} from '../server/services/ws-events-retention-service.js'

let tmpDir: string
let db: Database.Database

const NOW_MS = Date.parse('2026-08-29T12:00:00.000Z')
const daysAgo = (days: number): string => new Date(NOW_MS - days * 24 * 60 * 60 * 1000).toISOString()

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kobo-retention-'))
  db = new Database(path.join(tmpDir, 'test.db'))
  db.pragma('journal_mode=WAL')
  db.pragma('foreign_keys=ON')
  initSchema(db)
  const now = daysAgo(0)
  db.prepare(
    `INSERT INTO workspaces (id, name, project_path, source_branch, working_branch, model, created_at, updated_at)
     VALUES ('ws-1', 'w', '/tmp/w', 'main', 'feature/w', 'claude-opus-4-8', ?, ?)`,
  ).run(now, now)
  db.prepare(
    "INSERT INTO agent_sessions (id, workspace_id, status, started_at) VALUES ('s-1', 'ws-1', 'completed', ?)",
  ).run(now)
})

afterEach(() => {
  db.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

/** Insert `count` agent events dated `ageDays` ago, ids prefixed by `prefix`. */
function seedEvents(prefix: string, count: number, ageDays: number, kind = 'message:text'): void {
  const insert = db.prepare(
    'INSERT INTO ws_events (id, workspace_id, type, payload, session_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  )
  const at = daysAgo(ageDays)
  const many = db.transaction(() => {
    for (let i = 0; i < count; i++) {
      insert.run(`${prefix}-${i}`, 'ws-1', 'agent:event', JSON.stringify({ kind }), 's-1', at)
    }
  })
  many()
}

describe('resolveRetentionConfig()', () => {
  it('defaults to DISABLED when the settings say nothing — the feature is opt-in', () => {
    expect(resolveRetentionConfig({})).toEqual({ retentionDays: 0, keepPerWorkspace: 0 })
  })

  it('reads an explicitly chosen window as it is', () => {
    expect(resolveRetentionConfig({ wsEventsRetentionDays: 7, wsEventsKeepPerWorkspace: 10 })).toEqual({
      retentionDays: 7,
      keepPerWorkspace: 10,
    })
  })

  it('falls back to disabled on an invalid value rather than guessing a window', () => {
    expect(resolveRetentionConfig({ wsEventsRetentionDays: -5 }).retentionDays).toBe(0)
    expect(resolveRetentionConfig({ wsEventsRetentionDays: 1.5 }).retentionDays).toBe(0)
  })
})

describe('countPrunableWsEvents()', () => {
  it('counts what a given window would delete, without deleting anything', () => {
    seedEvents('old', 40, 90)
    seedEvents('recent', 5, 1)

    expect(countPrunableWsEvents(db, { retentionDays: 30, keepPerWorkspace: 10 }, NOW_MS)).toBe(35)
    expect((db.prepare('SELECT COUNT(*) AS c FROM ws_events').get() as { c: number }).c).toBe(45)
  })

  it('counts zero when retention is disabled', () => {
    seedEvents('old', 40, 900)
    expect(countPrunableWsEvents(db, { retentionDays: 0, keepPerWorkspace: 0 }, NOW_MS)).toBe(0)
  })
})

describe('pruneWsEvents()', () => {
  it('deletes events older than the window while keeping the recent tail', () => {
    seedEvents('old', 40, 90)
    seedEvents('recent', 5, 1)

    const result = pruneWsEvents(db, { retentionDays: 30, keepPerWorkspace: 10 }, NOW_MS)

    // 45 rows, the 10 newest are protected by the tail, so 35 of the 40 old ones go.
    expect(result.deleted).toBe(35)
    expect((db.prepare('SELECT COUNT(*) AS c FROM ws_events').get() as { c: number }).c).toBe(10)
    expect((db.prepare("SELECT COUNT(*) AS c FROM ws_events WHERE id LIKE 'recent-%'").get() as { c: number }).c).toBe(
      5,
    )
  })

  it('does nothing at all with the default, disabled configuration', () => {
    seedEvents('old', 40, 900)
    const result = pruneWsEvents(db, resolveRetentionConfig({}), NOW_MS)
    expect(result).toMatchObject({ deleted: 0, sessionsRecomputed: 0, vacuumed: false })
    expect((db.prepare('SELECT COUNT(*) AS c FROM ws_events').get() as { c: number }).c).toBe(40)
  })

  it('never touches workspaces, sessions or tasks', () => {
    seedEvents('old', 40, 90)
    pruneWsEvents(db, { retentionDays: 30, keepPerWorkspace: 0 }, NOW_MS)
    expect((db.prepare('SELECT COUNT(*) AS c FROM workspaces').get() as { c: number }).c).toBe(1)
    expect((db.prepare('SELECT COUNT(*) AS c FROM agent_sessions').get() as { c: number }).c).toBe(1)
  })

  it('recomputes the metrics of every session it touched, once', () => {
    seedEvents('old', 6, 90, 'tool:call')
    seedEvents('recent', 2, 1, 'tool:call')
    expect(
      (db.prepare('SELECT tool_calls FROM session_event_metrics').get() as { tool_calls: number }).tool_calls,
    ).toBe(8)

    const result = pruneWsEvents(db, { retentionDays: 30, keepPerWorkspace: 2 }, NOW_MS)

    expect(result.deleted).toBe(6)
    expect(result.sessionsRecomputed).toBe(1)
    expect(
      (db.prepare('SELECT tool_calls FROM session_event_metrics').get() as { tool_calls: number }).tool_calls,
    ).toBe(2)
  })

  it('reclaims free pages instead of leaving a 95 %-empty file behind', () => {
    seedEvents('old', 6_000, 90)
    pruneWsEvents(db, { retentionDays: 30, keepPerWorkspace: 0 }, NOW_MS)

    const freelist = db.pragma('freelist_count', { simple: true }) as number
    const pageCount = db.pragma('page_count', { simple: true }) as number
    expect(freelist / pageCount).toBeLessThan(0.25)
  })
})
