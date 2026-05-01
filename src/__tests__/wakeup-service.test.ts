import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initSchema } from '../server/db/schema.js'

// Mock the websocket-service so tests don't open sockets.
vi.mock('../server/services/websocket-service.js', () => ({
  emit: vi.fn(),
  emitEphemeral: vi.fn(),
}))

// Mock the orchestrator so scheduled fires never spawn real Claude processes.
vi.mock('../server/services/agent/orchestrator.js', () => ({
  startAgent: vi.fn(),
  hasController: vi.fn(() => false),
}))

let tmpDir: string
let dbPath: string

async function resetDb() {
  const { closeDb } = await import('../server/db/index.js')
  closeDb()
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'at-wakeup-test-'))
  dbPath = path.join(tmpDir, 'test.db')

  const db = new Database(dbPath)
  db.pragma('journal_mode=WAL')
  db.pragma('foreign_keys=ON')
  initSchema(db)
  db.close()
}

describe('wakeup-service', () => {
  let wsId: string

  beforeEach(async () => {
    await resetDb()
    const { getDb } = await import('../server/db/index.js')
    getDb(dbPath)

    const { createWorkspace } = await import('../server/services/workspace-service.js')
    const ws = createWorkspace({
      name: 'w',
      projectPath: '/tmp/proj',
      sourceBranch: 'main',
      workingBranch: 'feature/x',
    })
    wsId = ws.id

    vi.useFakeTimers({ shouldAdvanceTime: false })
    vi.setSystemTime(new Date('2026-04-22T10:00:00Z'))
    vi.clearAllMocks()
  })

  afterEach(async () => {
    vi.useRealTimers()
    const { closeDb } = await import('../server/db/index.js')
    closeDb()
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('schedule inserts a row with the correct target_at and emits wakeup:scheduled', async () => {
    const wakeupService = await import('../server/services/wakeup-service.js')
    const ws = await import('../server/services/websocket-service.js')

    wakeupService.schedule(wsId, 60, 'resume', 'because')

    const pending = wakeupService.getPending(wsId)
    expect(pending).toBeTruthy()
    expect(pending?.reason).toBe('because')
    expect(new Date(pending!.targetAt).getTime()).toBe(Date.now() + 60_000)

    expect(ws.emitEphemeral).toHaveBeenCalledWith(
      wsId,
      'wakeup:scheduled',
      expect.objectContaining({ reason: 'because' }),
    )
  })

  it('schedule replaces an existing pending wakeup for the same workspace', async () => {
    const wakeupService = await import('../server/services/wakeup-service.js')

    wakeupService.schedule(wsId, 60, 'first', 'r1')
    const first = wakeupService.getPending(wsId)
    wakeupService.schedule(wsId, 120, 'second', 'r2')
    const second = wakeupService.getPending(wsId)

    expect(second?.targetAt).not.toBe(first?.targetAt)
    expect(second?.reason).toBe('r2')
  })

  it('schedule clamps delaySeconds below 60 to 60', async () => {
    const wakeupService = await import('../server/services/wakeup-service.js')

    wakeupService.schedule(wsId, 5, 'resume', undefined)
    const pending = wakeupService.getPending(wsId)
    expect(new Date(pending!.targetAt).getTime()).toBe(Date.now() + 60_000)
  })

  it('schedule clamps delaySeconds above 3600 to 3600', async () => {
    const wakeupService = await import('../server/services/wakeup-service.js')

    wakeupService.schedule(wsId, 99_999, 'resume', undefined)
    const pending = wakeupService.getPending(wsId)
    expect(new Date(pending!.targetAt).getTime()).toBe(Date.now() + 3_600_000)
  })

  it('cancel clears the row, emits wakeup:cancelled with the reason', async () => {
    const wakeupService = await import('../server/services/wakeup-service.js')
    const ws = await import('../server/services/websocket-service.js')

    wakeupService.schedule(wsId, 60, 'resume', undefined)
    wakeupService.cancel(wsId, 'user-message')

    expect(wakeupService.getPending(wsId)).toBeNull()
    expect(ws.emitEphemeral).toHaveBeenCalledWith(wsId, 'wakeup:cancelled', { reason: 'user-message' })
  })

  it('cancel is idempotent — calling twice does not throw and emits only when a row existed', async () => {
    const wakeupService = await import('../server/services/wakeup-service.js')
    const ws = await import('../server/services/websocket-service.js')

    wakeupService.cancel(wsId, 'stopped') // nothing pending
    wakeupService.cancel(wsId, 'stopped')

    expect(ws.emitEphemeral).not.toHaveBeenCalled()
  })

  it('getPending returns null when no wakeup exists', async () => {
    const wakeupService = await import('../server/services/wakeup-service.js')
    expect(wakeupService.getPending(wsId)).toBeNull()
  })

  it('getPending returns targetAt and reason for a pending wakeup', async () => {
    const wakeupService = await import('../server/services/wakeup-service.js')

    wakeupService.schedule(wsId, 300, 'resume work', 'CI polling')
    const pending = wakeupService.getPending(wsId)
    expect(pending).toEqual({ targetAt: expect.any(String), reason: 'CI polling' })
  })

  describe('fire', () => {
    it('calls orchestrator.startAgent with the stored prompt when no controller is active', async () => {
      const wakeupService = await import('../server/services/wakeup-service.js')
      const orch = await import('../server/services/agent/orchestrator.js')
      ;(orch.hasController as ReturnType<typeof vi.fn>).mockReturnValue(false)

      wakeupService.schedule(wsId, 60, 'do stuff', 'because')
      await vi.advanceTimersByTimeAsync(60_000)

      expect(orch.startAgent).toHaveBeenCalled()
      const callArgs = (orch.startAgent as ReturnType<typeof vi.fn>).mock.calls[0] as unknown[]
      expect(callArgs[0]).toBe(wsId)
      expect(callArgs[2]).toBe('do stuff')
      expect(callArgs[4]).toBe(true) // resume flag
      expect(wakeupService.getPending(wsId)).toBeNull()
    })

    it('resumes the session that scheduled the wakeup, not the latest one', async () => {
      const wakeupService = await import('../server/services/wakeup-service.js')
      const orch = await import('../server/services/agent/orchestrator.js')
      ;(orch.hasController as ReturnType<typeof vi.fn>).mockReturnValue(false)

      wakeupService.schedule(wsId, 60, 'continue', 'soak', 'sess-original')
      await vi.advanceTimersByTimeAsync(60_000)

      const callArgs = (orch.startAgent as ReturnType<typeof vi.fn>).mock.calls[0] as unknown[]
      // startAgent(workspaceId, workingDir, prompt, model, resume, mode, existingSessionId, effort)
      expect(callArgs[6]).toBe('sess-original')
    })

    it('skips fire and emits wakeup:skipped when a controller is already active', async () => {
      const wakeupService = await import('../server/services/wakeup-service.js')
      const orch = await import('../server/services/agent/orchestrator.js')
      const ws = await import('../server/services/websocket-service.js')
      ;(orch.hasController as ReturnType<typeof vi.fn>).mockReturnValue(true)

      wakeupService.schedule(wsId, 60, 'do stuff', undefined)
      await vi.advanceTimersByTimeAsync(60_000)

      expect(orch.startAgent).not.toHaveBeenCalled()
      expect(ws.emitEphemeral).toHaveBeenCalledWith(wsId, 'wakeup:skipped', { reason: 'session-active' })
      expect(wakeupService.getPending(wsId)).toBeNull()
    })

    it('emits wakeup:skipped with fire-failed when startAgent throws', async () => {
      const wakeupService = await import('../server/services/wakeup-service.js')
      const orch = await import('../server/services/agent/orchestrator.js')
      const ws = await import('../server/services/websocket-service.js')
      ;(orch.hasController as ReturnType<typeof vi.fn>).mockReturnValue(false)
      ;(orch.startAgent as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error('boom')
      })

      wakeupService.schedule(wsId, 60, 'do stuff', undefined)
      await vi.advanceTimersByTimeAsync(60_000)

      expect(ws.emitEphemeral).toHaveBeenCalledWith(wsId, 'wakeup:skipped', { reason: 'fire-failed' })
      expect(wakeupService.getPending(wsId)).toBeNull()
    })

    it('replaces the <<autonomous-loop-dynamic>> sentinel with the continuation prompt at fire time', async () => {
      const wakeupService = await import('../server/services/wakeup-service.js')
      const orch = await import('../server/services/agent/orchestrator.js')
      ;(orch.hasController as ReturnType<typeof vi.fn>).mockReturnValue(false)

      wakeupService.schedule(wsId, 60, '<<autonomous-loop-dynamic>>', undefined)
      await vi.advanceTimersByTimeAsync(60_000)

      const callArgs = (orch.startAgent as ReturnType<typeof vi.fn>).mock.calls[0] as unknown[]
      expect(callArgs[2]).toBe('Continue where you left off.')
    })
  })

  describe('rehydrate', () => {
    it('registers a timer for a future pending wakeup', async () => {
      const wakeupService = await import('../server/services/wakeup-service.js')
      const orch = await import('../server/services/agent/orchestrator.js')
      ;(orch.hasController as ReturnType<typeof vi.fn>).mockReturnValue(false)

      const { getDb } = await import('../server/db/index.js')
      const db = getDb()
      const future = new Date(Date.now() + 90_000).toISOString()
      db.prepare(
        `INSERT INTO pending_wakeups (workspace_id, target_at, prompt, reason, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(wsId, future, 'resume', null, new Date().toISOString())

      wakeupService.rehydrate()
      await vi.advanceTimersByTimeAsync(90_000)

      expect(orch.startAgent).toHaveBeenCalled()
    })

    it('fires immediately a wakeup past-due by less than 5 min (grace window)', async () => {
      const wakeupService = await import('../server/services/wakeup-service.js')
      const orch = await import('../server/services/agent/orchestrator.js')
      ;(orch.hasController as ReturnType<typeof vi.fn>).mockReturnValue(false)

      const { getDb } = await import('../server/db/index.js')
      const db = getDb()
      const past = new Date(Date.now() - 2 * 60 * 1000).toISOString()
      db.prepare(
        `INSERT INTO pending_wakeups (workspace_id, target_at, prompt, reason, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(wsId, past, 'resume', null, new Date().toISOString())

      wakeupService.rehydrate()
      await vi.advanceTimersByTimeAsync(0)

      expect(orch.startAgent).toHaveBeenCalled()
    })

    it('deletes a wakeup past-due by more than 5 min without firing', async () => {
      const wakeupService = await import('../server/services/wakeup-service.js')
      const orch = await import('../server/services/agent/orchestrator.js')

      const { getDb } = await import('../server/db/index.js')
      const db = getDb()
      const veryPast = new Date(Date.now() - 10 * 60 * 1000).toISOString()
      db.prepare(
        `INSERT INTO pending_wakeups (workspace_id, target_at, prompt, reason, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(wsId, veryPast, 'resume', null, new Date().toISOString())

      wakeupService.rehydrate()
      await vi.advanceTimersByTimeAsync(0)

      expect(orch.startAgent).not.toHaveBeenCalled()
      expect(wakeupService.getPending(wsId)).toBeNull()
    })
  })
})
