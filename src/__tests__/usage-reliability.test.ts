import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runMigrations } from '../server/db/migrations.js'
import {
  clearReliabilityReset,
  computeEngineReliability,
  getReliabilityResetAt,
  resetReliability,
} from '../server/services/usage/reliability.js'

let db: Database.Database

function insertSession(session: {
  id: string
  engine?: string | null
  model?: string | null
  endReason?: string | null
  startedAt: string
  endedAt: string | null
}) {
  db.prepare(
    `INSERT INTO agent_sessions (id, workspace_id, engine, model, status, end_reason, started_at, ended_at)
     VALUES (?, 'w1', ?, ?, 'completed', ?, ?, ?)`,
  ).run(
    session.id,
    // `in` rather than `??`: a test passing null explicitly means null.
    'engine' in session ? session.engine : 'claude-code',
    'model' in session ? session.model : 'opus',
    session.endReason ?? null,
    session.startedAt,
    session.endedAt,
  )
}

beforeEach(() => {
  db = new Database(':memory:')
  runMigrations(db)
  db.prepare(
    `INSERT INTO workspaces (id, name, project_path, source_branch, working_branch, created_at, updated_at)
     VALUES ('w1', 'w', '/tmp/p', 'main', 'feat', '2026-01-01', '2026-01-01')`,
  ).run()
})

afterEach(() => db.close())

describe('computeEngineReliability', () => {
  it('ignores sessions that are still running', () => {
    insertSession({ id: 's1', startedAt: '2026-01-01T10:00:00.000Z', endedAt: null })

    expect(computeEngineReliability(db)).toEqual([])
  })

  it('counts each outcome separately per engine and model', () => {
    const base = { startedAt: '2026-01-01T10:00:00.000Z', endedAt: '2026-01-01T10:01:00.000Z' }
    insertSession({ ...base, id: 's1', endReason: 'completed' })
    insertSession({ ...base, id: 's2', endReason: 'completed' })
    insertSession({ ...base, id: 's3', endReason: 'watchdog' })
    insertSession({ ...base, id: 's4', endReason: 'killed' })
    insertSession({ ...base, id: 's5', model: 'sonnet', endReason: 'error' })

    const rows = computeEngineReliability(db)

    expect(rows).toHaveLength(2)
    const opus = rows.find((r) => r.model === 'opus')
    expect(opus).toMatchObject({ total: 4, completed: 2, watchdog: 1, killed: 1, error: 0 })
    expect(opus?.completedRatio).toBe(0.5)
    expect(rows.find((r) => r.model === 'sonnet')).toMatchObject({ total: 1, error: 1 })
  })

  it('counts a session that predates the end_reason column as unknown, never as a success', () => {
    // Migration 39 leaves old rows NULL on purpose. Folding them into
    // `completed` would quietly inflate every model's score.
    insertSession({
      id: 's1',
      endReason: null,
      startedAt: '2026-01-01T10:00:00.000Z',
      endedAt: '2026-01-01T10:01:00.000Z',
    })

    const [row] = computeEngineReliability(db)
    expect(row).toMatchObject({ total: 1, unknown: 1, completed: 0 })
    expect(row.completedRatio).toBe(0)
  })

  it('reports a median duration, so one session left open overnight does not skew it', () => {
    const day = '2026-01-01T'
    insertSession({ id: 's1', startedAt: `${day}10:00:00.000Z`, endedAt: `${day}10:01:00.000Z` })
    insertSession({ id: 's2', startedAt: `${day}10:00:00.000Z`, endedAt: `${day}10:02:00.000Z` })
    insertSession({ id: 's3', startedAt: `${day}10:00:00.000Z`, endedAt: `${day}18:00:00.000Z` })

    const [row] = computeEngineReliability(db)

    // Mean would be over two and a half hours; the median says two minutes.
    expect(row.medianDurationMs).toBe(2 * 60_000)
  })

  it('averages the two middle values when the count is even', () => {
    const day = '2026-01-01T'
    insertSession({ id: 's1', startedAt: `${day}10:00:00.000Z`, endedAt: `${day}10:01:00.000Z` })
    insertSession({ id: 's2', startedAt: `${day}10:00:00.000Z`, endedAt: `${day}10:03:00.000Z` })

    expect(computeEngineReliability(db)[0].medianDurationMs).toBe(2 * 60_000)
  })

  it('ignores a duration it cannot trust — clock gone backwards or unparsable dates — but still counts the session', () => {
    insertSession({ id: 's1', startedAt: '2026-01-01T10:05:00.000Z', endedAt: '2026-01-01T10:00:00.000Z' })
    insertSession({ id: 's2', startedAt: 'not-a-date', endedAt: '2026-01-01T10:00:00.000Z' })

    const [row] = computeEngineReliability(db)
    expect(row.total).toBe(2)
    expect(row.medianDurationMs).toBeNull()
  })

  it('orders ties deterministically, by engine then model', () => {
    const base = { startedAt: '2026-01-01T10:00:00.000Z', endedAt: '2026-01-01T10:01:00.000Z' }
    insertSession({ ...base, id: 's1', engine: 'codex', model: 'zeta' })
    insertSession({ ...base, id: 's2', engine: 'claude-code', model: 'sonnet' })
    insertSession({ ...base, id: 's3', engine: 'claude-code', model: 'opus' })

    expect(computeEngineReliability(db).map((r) => `${r.engine}/${r.model}`)).toEqual([
      'claude-code/opus',
      'claude-code/sonnet',
      'codex/zeta',
    ])
  })

  it('labels a session with no engine or model rather than dropping it', () => {
    insertSession({
      id: 's1',
      engine: null,
      model: null,
      endReason: 'completed',
      startedAt: '2026-01-01T10:00:00.000Z',
      endedAt: '2026-01-01T10:01:00.000Z',
    })

    expect(computeEngineReliability(db)[0]).toMatchObject({ engine: 'unknown', model: 'unknown', total: 1 })
  })
})

describe('reliability reset', () => {
  const base = { endReason: 'completed', startedAt: '2026-01-01T09:00:00.000Z' }

  it('has no reset by default, so every ended session counts', () => {
    insertSession({ ...base, id: 's1', endedAt: '2026-01-01T10:00:00.000Z' })
    insertSession({ ...base, id: 's2', endedAt: '2026-01-02T10:00:00.000Z' })

    expect(getReliabilityResetAt(db)).toBeNull()
    expect(computeEngineReliability(db)[0].total).toBe(2)
  })

  it('records the reset instant and returns it', () => {
    const resetAt = resetReliability(db, new Date('2026-01-01T12:00:00.000Z'))

    expect(resetAt).toBe('2026-01-01T12:00:00.000Z')
    expect(getReliabilityResetAt(db)).toBe('2026-01-01T12:00:00.000Z')
  })

  it('replaces an earlier reset rather than adding a row', () => {
    resetReliability(db, new Date('2026-01-01T12:00:00.000Z'))
    resetReliability(db, new Date('2026-01-03T12:00:00.000Z'))

    expect(getReliabilityResetAt(db)).toBe('2026-01-03T12:00:00.000Z')
    expect(db.prepare('SELECT COUNT(*) AS c FROM reliability_reset').get()).toEqual({ c: 1 })
  })

  it('excludes sessions that ended before the reset and keeps those ended after it', () => {
    insertSession({ ...base, id: 'before', endedAt: '2026-01-01T11:59:59.000Z' })
    insertSession({ ...base, id: 'after', model: 'sonnet', endedAt: '2026-01-01T12:00:01.000Z' })
    resetReliability(db, new Date('2026-01-01T12:00:00.000Z'))

    const rows = computeEngineReliability(db)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ model: 'sonnet', total: 1 })
  })

  it('counts a session running during the reset once it ends after it', () => {
    insertSession({ ...base, id: 'running', startedAt: '2026-01-01T11:00:00.000Z', endedAt: null })
    resetReliability(db, new Date('2026-01-01T12:00:00.000Z'))
    expect(computeEngineReliability(db)).toEqual([])

    db.prepare('UPDATE agent_sessions SET ended_at = ? WHERE id = ?').run('2026-01-01T13:00:00.000Z', 'running')

    expect(computeEngineReliability(db)[0].total).toBe(1)
  })

  it('compares parsed instants, not strings', () => {
    // 12:30Z written with an offset: string order would put it before the reset.
    insertSession({ ...base, id: 'offset', endedAt: '2026-01-01T11:30:00.000-01:00' })
    resetReliability(db, new Date('2026-01-01T12:00:00.000Z'))

    expect(computeEngineReliability(db)[0].total).toBe(1)
  })

  it('restores the full history when the reset is cleared, without touching sessions', () => {
    insertSession({ ...base, id: 's1', endedAt: '2026-01-01T10:00:00.000Z' })
    resetReliability(db, new Date('2026-01-01T12:00:00.000Z'))
    expect(computeEngineReliability(db)).toEqual([])

    clearReliabilityReset(db)

    expect(getReliabilityResetAt(db)).toBeNull()
    expect(computeEngineReliability(db)[0].total).toBe(1)
    expect(db.prepare('SELECT COUNT(*) AS c FROM agent_sessions').get()).toEqual({ c: 1 })
  })
})
