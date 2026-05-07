import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runMigrations } from '../server/db/migrations.js'
import { initSchema } from '../server/db/schema.js'

vi.mock('../server/services/websocket-service.js', () => ({
  emit: vi.fn(),
  emitEphemeral: vi.fn(),
}))

vi.mock('../server/services/agent/orchestrator.js', () => ({
  startAgent: vi.fn(),
  hasController: vi.fn(() => false),
}))

vi.mock('../server/services/settings-service.js', () => ({
  getGlobalSettings: vi.fn(() => ({
    worktreesPath: '',
    worktreesPrefixByProject: false,
  })),
  getProjectSettings: vi.fn(() => null),
}))

let tmpDir: string
let dbPath: string
let wsId: string

async function resetDb() {
  const { closeDb } = await import('../server/db/index.js')
  closeDb()
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'at-cron-test-'))
  dbPath = path.join(tmpDir, 'test.db')
  const db = new Database(dbPath)
  db.pragma('journal_mode=WAL')
  db.pragma('foreign_keys=ON')
  initSchema(db)
  runMigrations(db)
  db.close()
}

async function makeWorkspace(name = 'w'): Promise<string> {
  const { createWorkspace } = await import('../server/services/workspace-service.js')
  const ws = createWorkspace({ name, projectPath: '/tmp/p', sourceBranch: 'main', workingBranch: 'feature/x' })
  return ws.id
}

describe('cron-service — arm / cancel / get / list', () => {
  beforeEach(async () => {
    await resetDb()
    const { getDb } = await import('../server/db/index.js')
    getDb(dbPath)
    vi.useFakeTimers({ shouldAdvanceTime: false })
    vi.setSystemTime(new Date('2026-05-07T10:00:00Z'))
    vi.clearAllMocks()
    wsId = await makeWorkspace()
  })

  afterEach(async () => {
    vi.useRealTimers()
    const { closeDb } = await import('../server/db/index.js')
    closeDb()
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('arm() inserts a row, computes nextFireAt, and emits cron:created', async () => {
    const svc = await import('../server/services/cron-service.js')
    const ws = await import('../server/services/websocket-service.js')

    const cron = svc.arm(wsId, { expression: '*/5 * * * *', prompt: 'tick' })
    expect(cron.id).toBeTruthy()
    expect(cron.workspaceId).toBe(wsId)
    expect(cron.expression).toBe('*/5 * * * *')
    expect(cron.prompt).toBe('tick')
    expect(cron.label).toBeNull()
    expect(new Date(cron.nextFireAt).getTime()).toBeGreaterThan(Date.now())

    expect(svc.getCron(cron.id)?.id).toBe(cron.id)
    expect(svc.listForWorkspace(wsId)).toHaveLength(1)
    expect((ws.emitEphemeral as ReturnType<typeof vi.fn>).mock.calls).toContainEqual([
      wsId,
      'cron:created',
      expect.objectContaining({ cron: expect.objectContaining({ id: cron.id }) }),
    ])
  })

  it('arm() rejects an invalid cron expression without writing the row', async () => {
    const svc = await import('../server/services/cron-service.js')
    expect(() => svc.arm(wsId, { expression: 'not a cron', prompt: 'x' })).toThrowError(/invalid cron expression/i)
    expect(svc.listForWorkspace(wsId)).toHaveLength(0)
  })

  it('arm() rejects an expression whose next fire is < 60s in the future', async () => {
    const svc = await import('../server/services/cron-service.js')
    vi.setSystemTime(new Date('2026-05-07T10:00:30Z'))
    expect(() => svc.arm(wsId, { expression: '* * * * *', prompt: 'x' })).toThrowError(/too close to now/i)
  })

  it('arm() supports @hourly / @daily helpers via cron-parser', async () => {
    const svc = await import('../server/services/cron-service.js')
    const cron = svc.arm(wsId, { expression: '@hourly', prompt: 'h', label: 'every hour' })
    expect(cron.label).toBe('every hour')
    expect(cron.nextFireAt).toBe('2026-05-07T11:00:00.000Z')
  })

  it('cancel() removes the row, clears the timer, emits cron:cancelled, returns true', async () => {
    const svc = await import('../server/services/cron-service.js')
    const ws = await import('../server/services/websocket-service.js')
    const cron = svc.arm(wsId, { expression: '@hourly', prompt: 'tick' })
    const result = svc.cancel(cron.id, 'user')
    expect(result).toBe(true)
    expect(svc.getCron(cron.id)).toBeNull()
    expect(svc.listForWorkspace(wsId)).toHaveLength(0)
    expect((ws.emitEphemeral as ReturnType<typeof vi.fn>).mock.calls).toContainEqual([
      wsId,
      'cron:cancelled',
      { id: cron.id, reason: 'user' },
    ])
  })

  it('cancel() returns false on unknown id (idempotent, no emit)', async () => {
    const svc = await import('../server/services/cron-service.js')
    const ws = await import('../server/services/websocket-service.js')
    expect(svc.cancel('does-not-exist', 'user')).toBe(false)
    const cancelled = (ws.emitEphemeral as ReturnType<typeof vi.fn>).mock.calls.find(
      ([, type]) => type === 'cron:cancelled',
    )
    expect(cancelled).toBeUndefined()
  })

  it('listForWorkspace filters by workspace id', async () => {
    const svc = await import('../server/services/cron-service.js')
    const wsB = await makeWorkspace('B')
    svc.arm(wsId, { expression: '@hourly', prompt: 'a' })
    svc.arm(wsB, { expression: '@daily', prompt: 'b' })
    expect(svc.listForWorkspace(wsId)).toHaveLength(1)
    expect(svc.listForWorkspace(wsB)).toHaveLength(1)
    expect(svc.listAll()).toHaveLength(2)
  })

  it('cancelAllForWorkspace removes every cron for the workspace', async () => {
    const svc = await import('../server/services/cron-service.js')
    svc.arm(wsId, { expression: '@hourly', prompt: 'a' })
    svc.arm(wsId, { expression: '@daily', prompt: 'b' })
    expect(svc.listForWorkspace(wsId)).toHaveLength(2)
    expect(svc.cancelAllForWorkspace(wsId, 'archive')).toBe(2)
    expect(svc.listForWorkspace(wsId)).toHaveLength(0)
  })
})

describe('cron-service — fireOrSkip', () => {
  beforeEach(async () => {
    await resetDb()
    const { getDb } = await import('../server/db/index.js')
    getDb(dbPath)
    vi.useFakeTimers({ shouldAdvanceTime: false })
    vi.setSystemTime(new Date('2026-05-07T10:00:00Z'))
    vi.clearAllMocks()
    wsId = await makeWorkspace()
  })

  afterEach(async () => {
    vi.useRealTimers()
    const { closeDb } = await import('../server/db/index.js')
    closeDb()
    if (tmpDir && fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('skips fire when a controller is active and re-arms for the next occurrence', async () => {
    const orch = await import('../server/services/agent/orchestrator.js')
    ;(orch.hasController as ReturnType<typeof vi.fn>).mockReturnValue(true)
    const svc = await import('../server/services/cron-service.js')
    const ws = await import('../server/services/websocket-service.js')

    const cron = svc.arm(wsId, { expression: '@hourly', prompt: 'tick' })
    const firstNext = cron.nextFireAt

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000 + 100)

    expect(orch.startAgent).not.toHaveBeenCalled()
    const firedEvents = (ws.emitEphemeral as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([, type]) => type === 'cron:fired',
    )
    expect(firedEvents.length).toBeGreaterThanOrEqual(1)
    expect(firedEvents.at(-1)?.[2]).toMatchObject({ id: cron.id, status: 'skipped-active' })
    const persisted = svc.getCron(cron.id)
    expect(persisted).not.toBeNull()
    expect(new Date(persisted!.nextFireAt).getTime()).toBeGreaterThan(new Date(firstNext).getTime())
  })

  it('fires when no controller is active, calls orchestrator.startAgent with resume=true, recomputes next', async () => {
    const orch = await import('../server/services/agent/orchestrator.js')
    ;(orch.hasController as ReturnType<typeof vi.fn>).mockReturnValue(false)
    ;(orch.startAgent as ReturnType<typeof vi.fn>).mockReturnValue({ agentSessionId: 'resumed-id' })
    const svc = await import('../server/services/cron-service.js')
    const ws = await import('../server/services/websocket-service.js')

    const cron = svc.arm(wsId, { expression: '@hourly', prompt: 'tick' })
    const firstNext = cron.nextFireAt

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000 + 100)

    expect(orch.startAgent).toHaveBeenCalledTimes(1)
    const firedEvents = (ws.emitEphemeral as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([, type]) => type === 'cron:fired',
    )
    expect(firedEvents.at(-1)?.[2]).toMatchObject({ id: cron.id, status: 'fired' })
    const persisted = svc.getCron(cron.id)
    expect(persisted!.lastFiredAt).not.toBeNull()
    expect(new Date(persisted!.nextFireAt).getTime()).toBeGreaterThan(new Date(firstNext).getTime())
  })

  it('does not fire if the cron row was deleted between arm and timer (race)', async () => {
    const orch = await import('../server/services/agent/orchestrator.js')
    const svc = await import('../server/services/cron-service.js')

    const cron = svc.arm(wsId, { expression: '@hourly', prompt: 'tick' })
    svc.cancel(cron.id, 'user')
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000 + 100)

    expect(orch.startAgent).not.toHaveBeenCalled()
  })

  it('logs and re-arms when orchestrator.startAgent throws (does not lose the cron)', async () => {
    const orch = await import('../server/services/agent/orchestrator.js')
    ;(orch.startAgent as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('boom')
    })
    const svc = await import('../server/services/cron-service.js')
    const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {})

    const cron = svc.arm(wsId, { expression: '@hourly', prompt: 'tick' })
    const firstNext = cron.nextFireAt
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000 + 100)

    expect(consoleErr).toHaveBeenCalled()
    const persisted = svc.getCron(cron.id)
    expect(persisted).not.toBeNull()
    expect(new Date(persisted!.nextFireAt).getTime()).toBeGreaterThan(new Date(firstNext).getTime())

    consoleErr.mockRestore()
  })
})

describe('cron-service — restoreOnBoot', () => {
  beforeEach(async () => {
    await resetDb()
    const { getDb } = await import('../server/db/index.js')
    getDb(dbPath)
    vi.useFakeTimers({ shouldAdvanceTime: false })
    vi.setSystemTime(new Date('2026-05-07T10:00:00Z'))
    vi.clearAllMocks()
    wsId = await makeWorkspace()
  })

  afterEach(async () => {
    vi.useRealTimers()
    const { closeDb } = await import('../server/db/index.js')
    closeDb()
    if (tmpDir && fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('arms a future row as-is', async () => {
    const { getDb } = await import('../server/db/index.js')
    const db = getDb()
    db.prepare(
      `INSERT INTO pending_crons (id, workspace_id, expression, prompt, next_fire_at, created_at)
       VALUES ('c1', ?, '@hourly', 'tick', '2026-05-07T11:00:00Z', '2026-05-07T10:00:00Z')`,
    ).run(wsId)

    const svc = await import('../server/services/cron-service.js')
    svc.restoreOnBoot()

    expect(svc._timers.has('c1')).toBe(true)
    expect(svc.getCron('c1')?.nextFireAt).toBe('2026-05-07T11:00:00.000Z')
  })

  it('skip-all-missed: recomputes next() when stored target is in the past', async () => {
    const { getDb } = await import('../server/db/index.js')
    const db = getDb()
    db.prepare(
      `INSERT INTO pending_crons (id, workspace_id, expression, prompt, next_fire_at, created_at)
       VALUES ('c1', ?, '@hourly', 'tick', '2026-05-07T05:00:00Z', '2026-05-07T05:00:00Z')`,
    ).run(wsId)

    const svc = await import('../server/services/cron-service.js')
    svc.restoreOnBoot()

    const cron = svc.getCron('c1')!
    expect(cron.nextFireAt).toBe('2026-05-07T11:00:00.000Z')
    expect(svc._timers.has('c1')).toBe(true)
  })

  it('drops rows pointing at archived workspaces', async () => {
    const { archiveWorkspace } = await import('../server/services/workspace-service.js')
    archiveWorkspace(wsId)
    const { getDb } = await import('../server/db/index.js')
    const db = getDb()
    db.prepare(
      `INSERT INTO pending_crons (id, workspace_id, expression, prompt, next_fire_at, created_at)
       VALUES ('c1', ?, '@hourly', 'tick', '2026-05-07T11:00:00Z', '2026-05-07T10:00:00Z')`,
    ).run(wsId)

    const svc = await import('../server/services/cron-service.js')
    svc.restoreOnBoot()

    expect(svc.getCron('c1')).toBeNull()
    expect(svc._timers.has('c1')).toBe(false)
  })
})
