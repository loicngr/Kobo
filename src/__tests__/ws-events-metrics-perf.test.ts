// The AFTER DELETE trigger on ws_events re-aggregated the whole session for
// EVERY deleted row: 79.7 s for 20 000 events, 106.6 s through a cascade, with
// the SQLite write lock held throughout. This test pins the budget.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initSchema } from '../server/db/schema.js'

let tmpDir: string
let db: Database.Database

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kobo-metrics-perf-'))
  db = new Database(path.join(tmpDir, 'test.db'))
  db.pragma('journal_mode=WAL')
  db.pragma('foreign_keys=ON')
  initSchema(db)
})

afterEach(() => {
  db.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

/** Seed one workspace + one session + `count` agent events. */
function seed(count: number): void {
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO workspaces (id, name, project_path, source_branch, working_branch, model, created_at, updated_at)
     VALUES ('ws-1', 'perf', '/tmp/p', 'main', 'feature/p', 'claude-opus-4-8', ?, ?)`,
  ).run(now, now)
  db.prepare(
    `INSERT INTO agent_sessions (id, workspace_id, status, started_at)
     VALUES ('session-1', 'ws-1', 'completed', ?)`,
  ).run(now)

  const insert = db.prepare(
    'INSERT INTO ws_events (id, workspace_id, type, payload, session_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  )
  const insertMany = db.transaction((n: number) => {
    for (let i = 0; i < n; i++) {
      insert.run(`e${i}`, 'ws-1', 'agent:event', '{"kind":"tool:call"}', 'session-1', now)
    }
  })
  insertMany(count)
}

describe('ws_events deletion performance', () => {
  it('deletes a workspace carrying 20 000 events in under a second', () => {
    seed(20_000)
    expect(db.prepare('SELECT COUNT(*) AS c FROM ws_events').get()).toEqual({ c: 20_000 })

    const started = performance.now()
    db.prepare("DELETE FROM workspaces WHERE id = 'ws-1'").run()
    const elapsedMs = performance.now() - started

    expect(db.prepare('SELECT COUNT(*) AS c FROM ws_events').get()).toEqual({ c: 0 })
    expect(db.prepare('SELECT COUNT(*) AS c FROM session_event_metrics').get()).toEqual({ c: 0 })
    expect(elapsedMs).toBeLessThan(1_000)
  }, 180_000)

  it('leaves no AFTER DELETE trigger on ws_events in a fresh install', () => {
    const triggers = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all() as Array<{ name: string }>
    ).map((row) => row.name)
    expect(triggers).toContain('trg_ws_events_metrics_insert')
    expect(triggers).not.toContain('trg_ws_events_metrics_delete')
  })

  it('serves the five hot queries from an index instead of a full scan', () => {
    const plan = (sql: string, ...params: string[]): string =>
      (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>)
        .map((row) => row.detail)
        .join(' | ')

    expect(plan('SELECT * FROM tasks WHERE workspace_id = ? ORDER BY sort_order ASC', 'x')).toContain(
      'idx_tasks_workspace_sort',
    )
    expect(plan('SELECT * FROM agent_sessions WHERE workspace_id = ? ORDER BY started_at DESC LIMIT 1', 'x')).toContain(
      'idx_agent_sessions_workspace_started',
    )
    expect(
      plan('SELECT id FROM agent_sessions WHERE engine_session_id = ? ORDER BY started_at DESC LIMIT 1', 'x'),
    ).toContain('idx_agent_sessions_engine_session')
    expect(plan('SELECT * FROM workspaces WHERE archived_at IS NULL ORDER BY updated_at DESC')).toContain(
      'idx_workspaces_archived_updated',
    )
    expect(plan('SELECT tool_calls FROM session_event_metrics WHERE session_id = ?', 'x')).toContain(
      'idx_session_event_metrics_session',
    )
  })
})
