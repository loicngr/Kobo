import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, getDb } from '../server/db/index.js'
import { initSchema } from '../server/db/schema.js'
import {
  previewWsEventsRetention,
  runWsEventsRetention,
  stopWsEventsRetention,
} from '../server/services/ws-events-retention-worker-service.js'

let tmpDir: string
const NOW = Date.parse('2026-10-01T12:00:00.000Z')
const OLD = '2020-01-01T00:00:00.000Z'
const RECENT = '2026-10-01T00:00:00.000Z'

beforeEach(() => {
  closeDb()
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kobo-retention-worker-'))
  const db = getDb(path.join(tmpDir, 'test.db'))
  initSchema(db)
  for (const id of ['one', 'two']) {
    db.prepare(`INSERT INTO workspaces(id, name, project_path, source_branch, working_branch, created_at, updated_at)
      VALUES (?, ?, '/tmp', 'main', 'feature', ?, ?)`).run(id, id, RECENT, RECENT)
    db.prepare(`INSERT INTO agent_sessions(id, workspace_id, status, started_at) VALUES (?, ?, 'completed', ?)`).run(
      `session-${id}`,
      id,
      RECENT,
    )
  }
})

afterEach(async () => {
  await stopWsEventsRetention()
  closeDb()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function seed(workspaceId: string, count: number, date = OLD): void {
  const db = getDb()
  const insert = db.prepare(`INSERT INTO ws_events(id, workspace_id, type, payload, session_id, created_at)
    VALUES (?, ?, 'agent:event', '{"kind":"tool:call"}', ?, ?)`)
  db.transaction(() => {
    for (let i = 0; i < count; i++)
      insert.run(`${workspaceId}-${date}-${i}`, workspaceId, `session-${workspaceId}`, date)
  })()
}

function count(workspaceId: string): number {
  return (
    getDb().prepare('SELECT COUNT(*) AS count FROM ws_events WHERE workspace_id = ?').get(workspaceId) as {
      count: number
    }
  ).count
}

describe('retention worker', () => {
  it('previews the same retention policy without changing the history', async () => {
    seed('one', 20)
    seed('one', 3, RECENT)
    seed('two', 6)
    expect(await previewWsEventsRetention({ retentionDays: 30, keepPerWorkspace: 10 }, NOW)).toEqual({
      deletable: 13,
      total: 29,
    })
    expect(count('one')).toBe(23)
    expect(count('two')).toBe(6)
  })

  it('preserves separate workspace tails, recent events, metrics and search deletion tracking', async () => {
    seed('one', 1_100)
    seed('one', 3, RECENT)
    seed('two', 120)
    const result = await runWsEventsRetention({ retentionDays: 30, keepPerWorkspace: 10 }, NOW)
    expect(result).toMatchObject({ deleted: 1_203, sessionsRecomputed: 2, vacuumed: false })
    expect(count('one')).toBe(10)
    expect(count('two')).toBe(10)
    expect(getDb().prepare('SELECT tool_calls FROM session_event_metrics ORDER BY workspace_id').all()).toEqual([
      { tool_calls: 10 },
      { tool_calls: 10 },
    ])
    expect(
      (
        getDb().prepare("SELECT COUNT(*) AS count FROM search_changes WHERE operation = 'delete'").get() as {
          count: number
        }
      ).count,
    ).toBe(1_203)
  })

  it('allows event loop work and a concurrent writer while deleting a large history', async () => {
    seed('one', 25_000)
    let ticks = 0
    let wrote = false
    const timer = setInterval(() => {
      ticks++
      const remaining = count('one')
      if (!wrote && remaining < 25_000 && remaining > 10) {
        seed('one', 1, RECENT)
        wrote = true
      }
    }, 5)
    try {
      const pending = runWsEventsRetention({ retentionDays: 30, keepPerWorkspace: 10 }, NOW)
      const result = await pending
      expect(result.deleted).toBe(24_990)
      expect(ticks).toBeGreaterThan(2)
      expect(wrote).toBe(true)
      expect(count('one')).toBe(11)
      expect(getDb().prepare("SELECT tool_calls FROM session_event_metrics WHERE workspace_id = 'one'").get()).toEqual({
        tool_calls: 11,
      })
    } finally {
      clearInterval(timer)
    }
  }, 15_000)

  it('coalesces simultaneous maintenance requests without launching competing passes', async () => {
    seed('one', 1_000)
    const first = runWsEventsRetention({ retentionDays: 30, keepPerWorkspace: 10 }, NOW)
    const second = runWsEventsRetention({ retentionDays: 30, keepPerWorkspace: 10 }, NOW + 1_000)
    expect(second).toBe(first)
    expect((await first).deleted).toBe(990)
    expect((await second).deleted).toBe(990)
  })

  it('does not launch destructive maintenance for a disabled configuration', async () => {
    seed('one', 30)
    expect(await runWsEventsRetention({ retentionDays: 0, keepPerWorkspace: 0 }, NOW)).toMatchObject({ deleted: 0 })
    expect(count('one')).toBe(30)
  })

  it('waits for worker shutdown before the main database can be closed', async () => {
    seed('one', 5_000)
    const pending = runWsEventsRetention({ retentionDays: 30, keepPerWorkspace: 10 }, NOW)
    const outcome = pending.catch((error: Error) => error.message)
    await stopWsEventsRetention()
    expect(await outcome).toMatch(/stopped/)
    closeDb()
    const reopened = getDb(path.join(tmpDir, 'test.db'))
    expect((reopened.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check).toBe('ok')
  })
})
