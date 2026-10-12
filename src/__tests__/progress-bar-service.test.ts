import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: undefined as unknown as Database.Database }))
vi.mock('../server/db/index.js', () => ({ getDb: () => state.db }))
vi.mock('../server/services/websocket-service.js', () => ({ emitEphemeral: vi.fn() }))

import { initSchema } from '../server/db/schema.js'
import * as progress from '../server/services/progress-bar-service.js'
import { emitEphemeral } from '../server/services/websocket-service.js'

const owner = { kind: 'internal' as const, workspaceId: 'w1', sessionId: 's1', launchId: 'launch1' }
const input = { activityKey: 'tests', label: 'Backend tests', current: 0, total: 10 }
beforeEach(() => {
  state.db = new Database(':memory:')
  state.db.pragma('foreign_keys=ON')
  initSchema(state.db)
  for (const id of ['w1', 'w2']) {
    state.db
      .prepare(`INSERT INTO workspaces(id,name,project_path,source_branch,working_branch,created_at,updated_at)
      VALUES (?,?,'/tmp','main','feature','now','now')`)
      .run(id, id)
    state.db
      .prepare(`INSERT INTO agent_sessions(id,workspace_id,started_at) VALUES (?,?,'now')`)
      .run(id === 'w1' ? 's1' : 's2', id)
  }
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-12T12:00:00Z'))
  vi.clearAllMocks()
})
afterEach(() => {
  state.db.close()
  vi.useRealTimers()
})

describe('session progress reporting', () => {
  it('creates a scoped public record and emits only after commit without chat history', () => {
    vi.mocked(emitEphemeral).mockImplementation((_ws, _type, record) => {
      expect(state.db.inTransaction).toBe(false)
      expect(
        state.db.prepare('SELECT id FROM session_progress_bars WHERE id=?').get((record as { id: string }).id),
      ).toBeTruthy()
    })
    const bar = progress.createProgressBar(owner, input)
    expect(bar).toMatchObject({
      workspaceId: 'w1',
      sessionId: 's1',
      label: input.label,
      status: 'running',
      revision: 1,
      sequence: 0,
      dismissedAt: null,
    })
    expect(bar).not.toHaveProperty('launchId')
    expect(progress.listProgressBars(owner).items).toEqual([bar])
    expect(emitEphemeral).toHaveBeenCalledWith('w1', 'progress:changed', bar, 's1')
    expect(state.db.prepare('SELECT count(*) AS n FROM ws_events').get()).toEqual({ n: 0 })
  })
  it('rejects mismatched sessions, malformed values and conflicting creation without broadcasting', () => {
    expect(() => progress.createProgressBar({ ...owner, sessionId: 's2' }, input)).toThrow()
    for (const bad of [
      { label: '' },
      { label: 'x'.repeat(201) },
      { current: NaN },
      { total: 0 },
      { current: 11 },
      { total: null },
      { step: 'x'.repeat(501) },
    ]) {
      expect(() => progress.createProgressBar(owner, { ...input, ...bad })).toThrow()
    }
    expect(emitEphemeral).not.toHaveBeenCalled()
    const bar = progress.createProgressBar(owner, input)
    expect(progress.createProgressBar(owner, input)).toEqual(bar)
    expect(() => progress.createProgressBar(owner, { ...input, label: 'Other' })).toThrow(/activity/i)
  })
  it('preserves dismissal through retries and ordered updates while new activities remain visible', () => {
    const bar = progress.createProgressBar(owner, input)
    const dismissed = progress.dismissProgressBar(owner, bar.id)
    expect(progress.dismissProgressBar(owner, bar.id)).toEqual(dismissed)
    const updated = progress.updateProgressBar(owner, bar.id, { sequence: 1, current: 4, total: 10 })
    expect(updated).toMatchObject({ current: 4, dismissedAt: dismissed.dismissedAt, revision: 3 })
    expect(progress.createProgressBar(owner, input)).toEqual(updated)
    expect(progress.updateProgressBar(owner, bar.id, { sequence: 1, current: 4, total: 10 })).toEqual(updated)
    expect(() => progress.updateProgressBar(owner, bar.id, { sequence: 1, current: 5, total: 10 })).toThrow()
    expect(() => progress.updateProgressBar(owner, bar.id, { sequence: 0, current: 2, total: 10 })).toThrow()
    expect(progress.createProgressBar(owner, { ...input, activityKey: 'next' }).dismissedAt).toBeNull()
  })
  it('rate limits running reports with retry guidance but accepts terminal reports immediately', () => {
    const bar = progress.createProgressBar(owner, input)
    progress.updateProgressBar(owner, bar.id, { sequence: 1, current: 4, total: 10 })
    expect(() => progress.updateProgressBar(owner, bar.id, { sequence: 2, current: 5, total: 10 })).toThrow(/retry/i)
    vi.advanceTimersByTime(1000)
    progress.updateProgressBar(owner, bar.id, { sequence: 2, current: 5, total: 10 })
    const done = progress.finishProgressBar(owner, bar.id, { sequence: 3, outcome: 'succeeded' })
    expect(done).toMatchObject({ status: 'succeeded', current: 5, completedAt: expect.any(String) })
    expect(progress.finishProgressBar(owner, bar.id, { sequence: 3, outcome: 'succeeded' })).toEqual(done)
    expect(() => progress.updateProgressBar(owner, bar.id, { sequence: 4, current: 10, total: 10 })).toThrow(
      /terminal/i,
    )
  })
  it('blocks other internal launches but permits explicitly scoped external management', () => {
    const bar = progress.createProgressBar(owner, input)
    expect(() =>
      progress.updateProgressBar({ ...owner, launchId: 'other' }, bar.id, { sequence: 1, step: 'Wrong' }),
    ).toThrow()
    expect(() => progress.dismissProgressBar({ workspaceId: 'w2', sessionId: 's2' }, bar.id)).toThrow()
    expect(
      progress.finishProgressBar({ kind: 'external', workspaceId: 'w1', sessionId: 's1' }, bar.id, {
        sequence: 1,
        outcome: 'failed',
      }).status,
    ).toBe('failed')
  })
  it('interrupts only internal reporting owned by the closed launch and preserves external reporting', () => {
    const bar = progress.createProgressBar(owner, input)
    const other = progress.createProgressBar({ ...owner, launchId: 'other' }, input)
    const external = progress.createProgressBar({ kind: 'external', workspaceId: 'w1', sessionId: 's1' }, input)
    progress.interruptProgressBarsForLaunch(owner.launchId)
    expect(progress.listProgressBars(owner).items.find((row) => row.id === bar.id)?.status).toBe('interrupted')
    progress.reconcileOrphanedProgressBars(['other'])
    expect(progress.listProgressBars(owner).items.find((row) => row.id === other.id)?.status).toBe('running')
    progress.reconcileOrphanedProgressBars()
    expect(progress.listProgressBars(owner).items.find((row) => row.id === external.id)?.status).toBe('running')
  })
  it('bounds running and retained rows without losing idempotency tombstones', () => {
    const first = progress.createProgressBar(owner, input)
    for (let i = 1; i < 32; i++) progress.createProgressBar(owner, { ...input, activityKey: String(i) })
    expect(() => progress.createProgressBar(owner, { ...input, activityKey: 'over' })).toThrow(/limit/i)
    expect(progress.createProgressBar(owner, input).id).toBe(first.id)
    expect(progress.listProgressBars({ ...owner, limit: 10 }).nextOffset).toBe(10)
    expect(progress.listProgressBars({ ...owner, limit: 10, offset: 30 }).items).toHaveLength(2)
    expect(() => progress.listProgressBars({ ...owner, limit: 101 })).toThrow()
    state.db.exec("UPDATE session_progress_bars SET status='failed'")
    for (let i = 32; i < 1000; i++) {
      const bar = progress.createProgressBar(owner, { ...input, activityKey: String(i) })
      progress.finishProgressBar(owner, bar.id, { sequence: 1, outcome: 'succeeded' })
    }
    expect(() => progress.createProgressBar(owner, { ...input, activityKey: 'over' })).toThrow(/limit/i)
    expect(progress.createProgressBar(owner, input).id).toBe(first.id)
  })
  it('emits nothing when a database mutation rolls back', () => {
    state.db.exec(`CREATE TRIGGER reject_progress BEFORE INSERT ON session_progress_bars
      BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END`)
    expect(() => progress.createProgressBar(owner, input)).toThrow('simulated write failure')
    expect(state.db.prepare('SELECT count(*) AS n FROM session_progress_bars').get()).toEqual({ n: 0 })
    expect(emitEphemeral).not.toHaveBeenCalled()
  })
  it('requires both numeric fields even when explicitly choosing indeterminate mode', () => {
    expect(() => progress.createProgressBar(owner, { activityKey: 'key', label: 'Tests', current: null })).toThrow()
    const bar = progress.createProgressBar(owner, { activityKey: 'key', label: 'Tests', current: null, total: null })
    expect(bar).toMatchObject({ current: null, total: null })
    expect(() => progress.updateProgressBar(owner, bar.id, { sequence: 1, current: null })).toThrow()
    expect(progress.updateProgressBar(owner, bar.id, { sequence: 1, current: 2, total: 10 }).current).toBe(2)
  })
  it('cascades workspace deletion', () => {
    progress.createProgressBar(owner, input)
    state.db.prepare('DELETE FROM workspaces WHERE id=?').run('w1')
    expect(state.db.prepare('SELECT count(*) AS n FROM session_progress_bars').get()).toEqual({ n: 0 })
  })
  it('cascades session deletion', () => {
    progress.createProgressBar(owner, input)
    state.db.prepare('DELETE FROM agent_sessions WHERE id=?').run('s1')
    expect(state.db.prepare('SELECT count(*) AS n FROM session_progress_bars').get()).toEqual({ n: 0 })
  })
})
