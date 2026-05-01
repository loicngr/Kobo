import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initSchema } from '../server/db/schema.js'

vi.mock('../server/services/websocket-service.js', () => ({
  emit: vi.fn(),
  emitEphemeral: vi.fn(),
}))

vi.mock('../server/services/agent/orchestrator.js', () => ({
  startAgent: vi.fn(() => ({ agentSessionId: 'mock-agent-session-id' })),
  hasController: vi.fn(() => false),
}))

vi.mock('../server/services/settings-service.js', () => ({
  getProjectSettings: vi.fn(),
}))

let tmpDir: string
let dbPath: string

async function resetDb() {
  const { closeDb } = await import('../server/db/index.js')
  closeDb()
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'at-autoloop-'))
  dbPath = path.join(tmpDir, 'test.db')
  const db = new Database(dbPath)
  db.pragma('journal_mode=WAL')
  db.pragma('foreign_keys=ON')
  initSchema(db)
  db.close()
}

describe('auto-loop-service', () => {
  let wsId: string

  beforeEach(async () => {
    await resetDb()
    const { getDb } = await import('../server/db/index.js')
    getDb(dbPath)
    const { createWorkspace } = await import('../server/services/workspace-service.js')
    // Use the test's tmpDir as project path so the worktree pre-check
    // (fs.existsSync on projectPath/.worktrees/workingBranch) passes.
    const worktreesDir = path.join(tmpDir, '.worktrees', 'feature', 'x')
    fs.mkdirSync(worktreesDir, { recursive: true })
    const ws = createWorkspace({
      name: 'w',
      projectPath: tmpDir,
      sourceBranch: 'main',
      workingBranch: 'feature/x',
    })
    wsId = ws.id
    vi.clearAllMocks()
  })

  afterEach(async () => {
    const { closeDb } = await import('../server/db/index.js')
    closeDb()
    if (tmpDir && fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('getStatus returns defaults for a fresh workspace', async () => {
    const svc = await import('../server/services/auto-loop-service.js')
    const s = svc.getStatus(wsId)
    expect(s).toEqual({ auto_loop: false, auto_loop_ready: false, no_progress_streak: 0 })
  })

  it('enable throws when auto_loop_ready is false', async () => {
    const svc = await import('../server/services/auto-loop-service.js')
    expect(() => svc.enable(wsId)).toThrow(/ready/i)
  })

  it('enable sets the flag and emits autoloop:enabled', async () => {
    // Note: actual spawn behaviour is covered in Task 4's tests
    // (spawnNextIteration). Here we only verify the state change + event.
    const svc = await import('../server/services/auto-loop-service.js')
    const ws = await import('../server/services/websocket-service.js')
    svc._test_setAutoLoopReady(wsId, true)
    svc.enable(wsId)

    expect(svc.getStatus(wsId).auto_loop).toBe(true)
    expect(ws.emitEphemeral).toHaveBeenCalledWith(wsId, 'autoloop:enabled', {})
  })

  it('enable is no-op if no pending tasks', async () => {
    const svc = await import('../server/services/auto-loop-service.js')
    svc._test_setAutoLoopReady(wsId, true)
    svc.enable(wsId)
    const { startAgent } = await import('../server/services/agent/orchestrator.js')
    expect(startAgent).not.toHaveBeenCalled()
  })

  it('enable flips the flag but does NOT spawn when a controller is already running', async () => {
    // The agent is already doing something (mid-session toggle from the user).
    // We record the intent but let the current session run to completion —
    // onSessionEnded will pick up the next iteration.
    const orch = await import('../server/services/agent/orchestrator.js')
    const { createTask } = await import('../server/services/workspace-service.js')
    ;(orch.hasController as ReturnType<typeof vi.fn>).mockReturnValue(true)
    try {
      createTask(wsId, { title: 't1', isAcceptanceCriterion: false, sortOrder: 0 })

      const svc = await import('../server/services/auto-loop-service.js')
      svc._test_setAutoLoopReady(wsId, true)
      svc.enable(wsId)

      expect(svc.getStatus(wsId).auto_loop).toBe(true)
      expect(orch.startAgent).not.toHaveBeenCalled()
    } finally {
      // Restore default mock so this test doesn't poison the rest of the file.
      ;(orch.hasController as ReturnType<typeof vi.fn>).mockReturnValue(false)
    }
  })

  it('disable flips DB flag and emits autoloop:disabled event', async () => {
    const { createTask } = await import('../server/services/workspace-service.js')
    createTask(wsId, { title: 't', isAcceptanceCriterion: false, sortOrder: 0 })

    const svc = await import('../server/services/auto-loop-service.js')
    const ws = await import('../server/services/websocket-service.js')
    svc._test_setAutoLoopReady(wsId, true)
    svc.enable(wsId)
    vi.clearAllMocks()

    svc.disable(wsId, 'user-action')
    expect(svc.getStatus(wsId).auto_loop).toBe(false)
    expect(ws.emitEphemeral).toHaveBeenCalledWith(wsId, 'autoloop:disabled', { reason: 'user-action' })
  })

  it('disable is idempotent — second call does not emit again', async () => {
    const svc = await import('../server/services/auto-loop-service.js')
    const ws = await import('../server/services/websocket-service.js')
    svc.disable(wsId, 'user-action')
    svc.disable(wsId, 'user-action')
    expect(ws.emitEphemeral).not.toHaveBeenCalled()
  })

  it('forgetAutoLoopState is a no-op that does not throw', async () => {
    const svc = await import('../server/services/auto-loop-service.js')
    expect(() => svc.forgetAutoLoopState(wsId)).not.toThrow()
  })

  describe('onSessionEnded', () => {
    it('no-ops when workspace is in awaiting-user', async () => {
      const svc = await import('../server/services/auto-loop-service.js')
      const { createTask, updateWorkspaceStatus } = await import('../server/services/workspace-service.js')
      createTask(wsId, { title: 't1', isAcceptanceCriterion: false, sortOrder: 0 })
      svc._test_setAutoLoopReady(wsId, true)
      svc.enable(wsId)
      const db = (await import('../server/db/index.js')).getDb()
      // Force the workspace into awaiting-user (simulates a deferred turn).
      // Use raw SQL to bypass the VALID_TRANSITIONS guard — the test only
      // cares about the row state, not the transition graph here.
      void updateWorkspaceStatus
      db.prepare("UPDATE workspaces SET status = 'awaiting-user' WHERE id = ?").run(wsId)

      // Should NOT spawn next iteration nor disable.
      svc.onSessionEnded(wsId, 'completed', 0)
      // Auto-loop must still be on (the user reply will resume the deferred turn).
      expect(svc.getStatus(wsId).auto_loop).toBe(true)
    })

    it('stops on reason=error regardless of delta', async () => {
      const svc = await import('../server/services/auto-loop-service.js')
      const { createTask } = await import('../server/services/workspace-service.js')
      createTask(wsId, { title: 't1', isAcceptanceCriterion: false, sortOrder: 0 })
      svc._test_setAutoLoopReady(wsId, true)
      svc.enable(wsId)

      svc.onSessionEnded(wsId, 'error', 0)
      expect(svc.getStatus(wsId).auto_loop).toBe(false)
    })

    it('stops on reason=killed regardless of delta', async () => {
      const svc = await import('../server/services/auto-loop-service.js')
      const { createTask } = await import('../server/services/workspace-service.js')
      createTask(wsId, { title: 't1', isAcceptanceCriterion: false, sortOrder: 0 })
      svc._test_setAutoLoopReady(wsId, true)
      svc.enable(wsId)

      svc.onSessionEnded(wsId, 'killed', 1)
      expect(svc.getStatus(wsId).auto_loop).toBe(false)
    })

    it('resets streak when delta > 0', async () => {
      const svc = await import('../server/services/auto-loop-service.js')
      const { createTask } = await import('../server/services/workspace-service.js')
      createTask(wsId, { title: 't1', isAcceptanceCriterion: false, sortOrder: 0 })
      createTask(wsId, { title: 't2', isAcceptanceCriterion: false, sortOrder: 1 })
      svc._test_setAutoLoopReady(wsId, true)
      svc.enable(wsId)

      // Manually bump the streak first
      const db = (await import('../server/db/index.js')).getDb()
      db.prepare('UPDATE workspaces SET no_progress_streak = 2 WHERE id = ?').run(wsId)

      svc.onSessionEnded(wsId, 'completed', 1)
      expect(svc.getStatus(wsId).no_progress_streak).toBe(0)
    })

    it('increments streak until 3 then disables with reason=stall', async () => {
      const svc = await import('../server/services/auto-loop-service.js')
      const { createTask } = await import('../server/services/workspace-service.js')
      const ws = await import('../server/services/websocket-service.js')
      createTask(wsId, { title: 't1', isAcceptanceCriterion: false, sortOrder: 0 })
      svc._test_setAutoLoopReady(wsId, true)
      svc.enable(wsId)
      vi.clearAllMocks()

      svc.onSessionEnded(wsId, 'completed', 0)
      expect(svc.getStatus(wsId).no_progress_streak).toBe(1)
      expect(svc.getStatus(wsId).auto_loop).toBe(true)

      svc.onSessionEnded(wsId, 'completed', 0)
      expect(svc.getStatus(wsId).no_progress_streak).toBe(2)
      expect(svc.getStatus(wsId).auto_loop).toBe(true)

      svc.onSessionEnded(wsId, 'completed', 0)
      expect(svc.getStatus(wsId).auto_loop).toBe(false)
      expect(ws.emitEphemeral).toHaveBeenCalledWith(wsId, 'autoloop:disabled', { reason: 'stall' })
    })

    it('disables with reason=completed when all tasks done', async () => {
      const svc = await import('../server/services/auto-loop-service.js')
      const { createTask, updateTaskStatus } = await import('../server/services/workspace-service.js')
      const ws = await import('../server/services/websocket-service.js')
      const t1 = createTask(wsId, { title: 't1', isAcceptanceCriterion: false, sortOrder: 0 })
      svc._test_setAutoLoopReady(wsId, true)
      svc.enable(wsId)
      updateTaskStatus(t1.id, 'done')
      vi.clearAllMocks()

      svc.onSessionEnded(wsId, 'completed', 1)
      expect(svc.getStatus(wsId).auto_loop).toBe(false)
      expect(ws.emitEphemeral).toHaveBeenCalledWith(wsId, 'autoloop:disabled', { reason: 'completed' })
    })

    it('is a no-op when auto_loop is already false', async () => {
      const svc = await import('../server/services/auto-loop-service.js')
      const ws = await import('../server/services/websocket-service.js')
      svc.onSessionEnded(wsId, 'completed', 0)
      expect(ws.emitEphemeral).not.toHaveBeenCalled()
    })

    it('skips spawn when workspace is in quota status (lets backoff timer handle restart)', async () => {
      const svc = await import('../server/services/auto-loop-service.js')
      const orch = await import('../server/services/agent/orchestrator.js')
      const { createTask } = await import('../server/services/workspace-service.js')
      const db = (await import('../server/db/index.js')).getDb()

      createTask(wsId, { title: 't', isAcceptanceCriterion: false, sortOrder: 0 })
      svc._test_setAutoLoopReady(wsId, true)
      db.prepare("UPDATE workspaces SET auto_loop = 1, status = 'quota' WHERE id = ?").run(wsId)
      ;(orch.startAgent as ReturnType<typeof vi.fn>).mockClear()

      svc.onSessionEnded(wsId, 'completed', 0)

      expect(orch.startAgent).not.toHaveBeenCalled()
    })
  })

  describe('onQuotaBackoffExpired', () => {
    it('spawns next iteration when workspace is in quota status with auto_loop=1', async () => {
      const svc = await import('../server/services/auto-loop-service.js')
      const orch = await import('../server/services/agent/orchestrator.js')
      const { createTask } = await import('../server/services/workspace-service.js')
      const db = (await import('../server/db/index.js')).getDb()

      const task = createTask(wsId, { title: 'do X', isAcceptanceCriterion: false, sortOrder: 0 })
      svc._test_setAutoLoopReady(wsId, true)
      db.prepare("UPDATE workspaces SET auto_loop = 1, status = 'quota' WHERE id = ?").run(wsId)
      ;(orch.startAgent as ReturnType<typeof vi.fn>).mockClear()

      svc.onQuotaBackoffExpired(wsId)

      expect(orch.startAgent).toHaveBeenCalled()
      const args = (orch.startAgent as ReturnType<typeof vi.fn>).mock.calls[0] as unknown[]
      expect(args[0]).toBe(wsId)
      expect(args[4]).toBe(false) // resume=false
      expect(args[2] as string).toContain(task.id)
    })

    it('is a no-op when workspace is not in quota status', async () => {
      const svc = await import('../server/services/auto-loop-service.js')
      const orch = await import('../server/services/agent/orchestrator.js')
      const { createTask } = await import('../server/services/workspace-service.js')
      const db = (await import('../server/db/index.js')).getDb()

      createTask(wsId, { title: 't', isAcceptanceCriterion: false, sortOrder: 0 })
      svc._test_setAutoLoopReady(wsId, true)
      // status is 'idle' by default — not 'quota'
      db.prepare('UPDATE workspaces SET auto_loop = 1 WHERE id = ?').run(wsId)
      ;(orch.startAgent as ReturnType<typeof vi.fn>).mockClear()

      svc.onQuotaBackoffExpired(wsId)

      expect(orch.startAgent).not.toHaveBeenCalled()
    })

    it('is a no-op when auto_loop is disabled', async () => {
      const svc = await import('../server/services/auto-loop-service.js')
      const orch = await import('../server/services/agent/orchestrator.js')
      const { createTask } = await import('../server/services/workspace-service.js')
      const db = (await import('../server/db/index.js')).getDb()

      createTask(wsId, { title: 't', isAcceptanceCriterion: false, sortOrder: 0 })
      // auto_loop=0 but status=quota
      db.prepare("UPDATE workspaces SET auto_loop = 0, status = 'quota' WHERE id = ?").run(wsId)
      ;(orch.startAgent as ReturnType<typeof vi.fn>).mockClear()

      svc.onQuotaBackoffExpired(wsId)

      expect(orch.startAgent).not.toHaveBeenCalled()
    })
  })

  describe('pickNextTask (rule D)', () => {
    it('picks non-acceptance-criterion task before acceptance at same sort_order', async () => {
      const svc = await import('../server/services/auto-loop-service.js')
      const { createTask } = await import('../server/services/workspace-service.js')
      createTask(wsId, { title: 'crit', isAcceptanceCriterion: true, sortOrder: 0 })
      createTask(wsId, { title: 'impl', isAcceptanceCriterion: false, sortOrder: 0 })
      const picked = svc._test_pickNextTask(wsId)
      expect(picked?.title).toBe('impl')
    })

    it('picks lowest sort_order within non-acceptance tasks', async () => {
      const svc = await import('../server/services/auto-loop-service.js')
      const { createTask } = await import('../server/services/workspace-service.js')
      createTask(wsId, { title: 'late', isAcceptanceCriterion: false, sortOrder: 5 })
      createTask(wsId, { title: 'early', isAcceptanceCriterion: false, sortOrder: 1 })
      const picked = svc._test_pickNextTask(wsId)
      expect(picked?.title).toBe('early')
    })

    it('picks acceptance only when all implementation tasks are done', async () => {
      const svc = await import('../server/services/auto-loop-service.js')
      const { createTask, updateTaskStatus } = await import('../server/services/workspace-service.js')
      const impl = createTask(wsId, { title: 'impl', isAcceptanceCriterion: false, sortOrder: 0 })
      createTask(wsId, { title: 'crit', isAcceptanceCriterion: true, sortOrder: 0 })
      updateTaskStatus(impl.id, 'done')
      const picked = svc._test_pickNextTask(wsId)
      expect(picked?.title).toBe('crit')
    })

    it('returns null when nothing pending', async () => {
      const svc = await import('../server/services/auto-loop-service.js')
      expect(svc._test_pickNextTask(wsId)).toBeNull()
    })
  })

  describe('rehydrate', () => {
    it('spawns a new session for workspaces with auto_loop=true and pending tasks', async () => {
      const svc = await import('../server/services/auto-loop-service.js')
      const { createTask } = await import('../server/services/workspace-service.js')
      const db = (await import('../server/db/index.js')).getDb()
      createTask(wsId, { title: 't1', isAcceptanceCriterion: false, sortOrder: 0 })
      db.prepare('UPDATE workspaces SET auto_loop = 1, auto_loop_ready = 1 WHERE id = ?').run(wsId)

      const { startAgent } = await import('../server/services/agent/orchestrator.js')
      ;(startAgent as ReturnType<typeof vi.fn>).mockClear()

      svc.rehydrate()

      expect(startAgent).toHaveBeenCalled()
    })

    it('disables with reason=completed if no pending tasks remain', async () => {
      const svc = await import('../server/services/auto-loop-service.js')
      const db = (await import('../server/db/index.js')).getDb()
      db.prepare('UPDATE workspaces SET auto_loop = 1, auto_loop_ready = 1 WHERE id = ?').run(wsId)

      svc.rehydrate()

      expect(svc.getStatus(wsId).auto_loop).toBe(false)
    })

    it('skips archived workspaces', async () => {
      const svc = await import('../server/services/auto-loop-service.js')
      const { createTask, archiveWorkspace } = await import('../server/services/workspace-service.js')
      const db = (await import('../server/db/index.js')).getDb()
      createTask(wsId, { title: 't', isAcceptanceCriterion: false, sortOrder: 0 })
      db.prepare('UPDATE workspaces SET auto_loop = 1, auto_loop_ready = 1 WHERE id = ?').run(wsId)
      archiveWorkspace(wsId)
      const { startAgent } = await import('../server/services/agent/orchestrator.js')
      ;(startAgent as ReturnType<typeof vi.fn>).mockClear()

      svc.rehydrate()

      expect(startAgent).not.toHaveBeenCalled()
    })
  })

  describe('spawnNextIteration', () => {
    it('calls startAgent with resume=false and emits iteration-started event', async () => {
      const svc = await import('../server/services/auto-loop-service.js')
      const ws = await import('../server/services/websocket-service.js')
      const { startAgent } = await import('../server/services/agent/orchestrator.js')
      const { createTask } = await import('../server/services/workspace-service.js')
      const task = createTask(wsId, { title: 'implement X', isAcceptanceCriterion: false, sortOrder: 0 })
      svc._test_setAutoLoopReady(wsId, true)
      svc.enable(wsId)

      expect(startAgent).toHaveBeenCalled()
      const args = (startAgent as ReturnType<typeof vi.fn>).mock.calls[0] as unknown[]
      expect(args[0]).toBe(wsId)
      expect(args[4]).toBe(false) // resume=false
      const prompt = args[2] as string
      expect(prompt).toContain(task.id)
      expect(prompt).toContain('implement X')
      expect(prompt).toContain('kobo__mark_task_done')

      expect(ws.emitEphemeral).toHaveBeenCalledWith(
        wsId,
        'autoloop:iteration-started',
        expect.objectContaining({
          taskId: task.id,
          taskTitle: 'implement X',
          tasksPending: 1,
          tasksDone: 0,
        }),
      )
    })

    it('disables AND re-throws from enable() when startAgent throws on the initial spawn', async () => {
      // Surfacing the failure at enable() is important: without it the HTTP
      // POST /auto-loop returns 200 for what's actually a failed enable, and
      // the client won't see the disable for another tick.
      const svc = await import('../server/services/auto-loop-service.js')
      const ws = await import('../server/services/websocket-service.js')
      const orch = await import('../server/services/agent/orchestrator.js')
      const { createTask } = await import('../server/services/workspace-service.js')
      ;(orch.startAgent as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error('boom')
      })
      createTask(wsId, { title: 't', isAcceptanceCriterion: false, sortOrder: 0 })
      svc._test_setAutoLoopReady(wsId, true)

      expect(() => svc.enable(wsId)).toThrow(/boom/)
      expect(svc.getStatus(wsId).auto_loop).toBe(false)
      expect(ws.emitEphemeral).toHaveBeenCalledWith(wsId, 'autoloop:disabled', { reason: 'error' })
    })

    it('swallows startAgent throw in onSessionEnded (not in enable path) and auto-disables', async () => {
      const svc = await import('../server/services/auto-loop-service.js')
      const ws = await import('../server/services/websocket-service.js')
      const orch = await import('../server/services/agent/orchestrator.js')
      const { createTask } = await import('../server/services/workspace-service.js')
      createTask(wsId, { title: 't1', isAcceptanceCriterion: false, sortOrder: 0 })
      createTask(wsId, { title: 't2', isAcceptanceCriterion: false, sortOrder: 1 })
      svc._test_setAutoLoopReady(wsId, true)
      // Flip auto_loop on directly (skip the enable path which would spawn).
      const db = (await import('../server/db/index.js')).getDb()
      db.prepare('UPDATE workspaces SET auto_loop = 1 WHERE id = ?').run(wsId)
      // Make future spawns throw — simulating a mid-loop failure.
      ;(orch.startAgent as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error('boom')
      })
      vi.clearAllMocks()
      // onSessionEnded should NOT throw, but should auto-disable.
      expect(() => svc.onSessionEnded(wsId, 'completed', 1)).not.toThrow()
      expect(svc.getStatus(wsId).auto_loop).toBe(false)
      expect(ws.emitEphemeral).toHaveBeenCalledWith(wsId, 'autoloop:disabled', { reason: 'error' })
    })
  })

  describe('onSessionEnded — armed but not yet ready (auto_loop_ready=false)', () => {
    it('keeps auto_loop=1 armed when brainstorming ends with no tasks and auto_loop_ready=false', async () => {
      const svc = await import('../server/services/auto-loop-service.js')
      const ws = await import('../server/services/websocket-service.js')
      const db = (await import('../server/db/index.js')).getDb()
      // Workspace created with autoLoop=true but no grooming yet
      db.prepare('UPDATE workspaces SET auto_loop = 1, auto_loop_ready = 0 WHERE id = ?').run(wsId)
      vi.clearAllMocks()

      svc.onSessionEnded(wsId, 'completed', 0)

      // Should NOT disable — loop is armed, waiting for grooming
      expect(svc.getStatus(wsId).auto_loop).toBe(true)
      expect(ws.emitEphemeral).not.toHaveBeenCalledWith(wsId, 'autoloop:disabled', expect.anything())
    })

    it('does not increment no_progress_streak when auto_loop_ready=false', async () => {
      const svc = await import('../server/services/auto-loop-service.js')
      const db = (await import('../server/db/index.js')).getDb()
      db.prepare('UPDATE workspaces SET auto_loop = 1, auto_loop_ready = 0 WHERE id = ?').run(wsId)

      svc.onSessionEnded(wsId, 'completed', 0)

      expect(svc.getStatus(wsId).no_progress_streak).toBe(0)
    })

    it('still disables on error/killed even when auto_loop_ready=false', async () => {
      const svc = await import('../server/services/auto-loop-service.js')
      const db = (await import('../server/db/index.js')).getDb()
      db.prepare('UPDATE workspaces SET auto_loop = 1, auto_loop_ready = 0 WHERE id = ?').run(wsId)

      svc.onSessionEnded(wsId, 'error', 0)

      expect(svc.getStatus(wsId).auto_loop).toBe(false)
    })
  })

  describe('onAutoLoopReadySet', () => {
    it('spawns first iteration when auto_loop=1 and pending tasks exist', async () => {
      const svc = await import('../server/services/auto-loop-service.js')
      const orch = await import('../server/services/agent/orchestrator.js')
      const { createTask } = await import('../server/services/workspace-service.js')
      const db = (await import('../server/db/index.js')).getDb()

      createTask(wsId, { title: 'implement X', isAcceptanceCriterion: false, sortOrder: 0 })
      db.prepare('UPDATE workspaces SET auto_loop = 1, auto_loop_ready = 1 WHERE id = ?').run(wsId)
      ;(orch.startAgent as ReturnType<typeof vi.fn>).mockClear()

      svc.onAutoLoopReadySet(wsId)

      expect(orch.startAgent).toHaveBeenCalled()
    })

    it('is a no-op when auto_loop=0 (not armed)', async () => {
      const svc = await import('../server/services/auto-loop-service.js')
      const orch = await import('../server/services/agent/orchestrator.js')
      const { createTask } = await import('../server/services/workspace-service.js')
      const db = (await import('../server/db/index.js')).getDb()

      createTask(wsId, { title: 't', isAcceptanceCriterion: false, sortOrder: 0 })
      db.prepare('UPDATE workspaces SET auto_loop = 0, auto_loop_ready = 1 WHERE id = ?').run(wsId)
      ;(orch.startAgent as ReturnType<typeof vi.fn>).mockClear()

      svc.onAutoLoopReadySet(wsId)

      expect(orch.startAgent).not.toHaveBeenCalled()
    })

    it('is a no-op when no pending tasks', async () => {
      const svc = await import('../server/services/auto-loop-service.js')
      const orch = await import('../server/services/agent/orchestrator.js')
      const db = (await import('../server/db/index.js')).getDb()

      db.prepare('UPDATE workspaces SET auto_loop = 1, auto_loop_ready = 1 WHERE id = ?').run(wsId)
      ;(orch.startAgent as ReturnType<typeof vi.fn>).mockClear()

      svc.onAutoLoopReadySet(wsId)

      expect(orch.startAgent).not.toHaveBeenCalled()
    })

    it('is a no-op when a controller is already running', async () => {
      const svc = await import('../server/services/auto-loop-service.js')
      const orch = await import('../server/services/agent/orchestrator.js')
      const { createTask } = await import('../server/services/workspace-service.js')
      const db = (await import('../server/db/index.js')).getDb()

      createTask(wsId, { title: 't', isAcceptanceCriterion: false, sortOrder: 0 })
      db.prepare('UPDATE workspaces SET auto_loop = 1, auto_loop_ready = 1 WHERE id = ?').run(wsId)
      ;(orch.hasController as ReturnType<typeof vi.fn>).mockReturnValue(true)
      ;(orch.startAgent as ReturnType<typeof vi.fn>).mockClear()

      try {
        svc.onAutoLoopReadySet(wsId)
        expect(orch.startAgent).not.toHaveBeenCalled()
      } finally {
        ;(orch.hasController as ReturnType<typeof vi.fn>).mockReturnValue(false)
      }
    })
  })

  describe('spawnNextIteration — E2E iteration prompt', () => {
    /** Helper: read the prompt arg passed to the most recent startAgent call. */
    async function getLastIterationPrompt(): Promise<string> {
      const orch = await import('../server/services/agent/orchestrator.js')
      const calls = (orch.startAgent as ReturnType<typeof vi.fn>).mock.calls
      const last = calls[calls.length - 1] as unknown[]
      return last[2] as string
    }

    // Earlier tests in this file install `mockImplementation(() => { throw … })`
    // on `orch.startAgent` to simulate failures. `vi.clearAllMocks()` clears
    // call history but NOT the implementation, so we must restore the happy
    // default here or every E2E test would inherit the throw.
    beforeEach(async () => {
      const orch = await import('../server/services/agent/orchestrator.js')
      ;(orch.startAgent as ReturnType<typeof vi.fn>).mockImplementation(() => ({
        agentSessionId: 'mock-agent-session-id',
      }))
    })

    it('injects the E2E block when task title starts with `[E2E] ` and framework is set', async () => {
      const svc = await import('../server/services/auto-loop-service.js')
      const settings = await import('../server/services/settings-service.js')
      const { createTask } = await import('../server/services/workspace-service.js')

      vi.mocked(settings.getProjectSettings).mockReturnValueOnce({
        e2e: { framework: 'cypress', skill: 'cy', prompt: 'pop' },
      } as never)
      createTask(wsId, { title: '[E2E] add login regression', isAcceptanceCriterion: false, sortOrder: 0 })
      svc._test_setAutoLoopReady(wsId, true)
      svc.enable(wsId)

      const prompt = await getLastIterationPrompt()
      expect(prompt).toContain('This is an **E2E regression test** task.')
      expect(prompt).toContain('Project E2E framework: cypress')
      expect(prompt).toContain('Use the `cy` skill for this task.')
      expect(prompt).toContain('Additional guidance: pop')
    })

    it('does NOT inject the E2E block when task is `[E2E] …` but framework is empty', async () => {
      const svc = await import('../server/services/auto-loop-service.js')
      const settings = await import('../server/services/settings-service.js')
      const { createTask } = await import('../server/services/workspace-service.js')

      vi.mocked(settings.getProjectSettings).mockReturnValueOnce({
        e2e: { framework: '', skill: '', prompt: '' },
      } as never)
      createTask(wsId, { title: '[E2E] add login regression', isAcceptanceCriterion: false, sortOrder: 0 })
      svc._test_setAutoLoopReady(wsId, true)
      svc.enable(wsId)

      const prompt = await getLastIterationPrompt()
      expect(prompt).not.toContain('This is an **E2E regression test** task.')
    })

    it('does NOT inject the E2E block for a regular non-E2E task even when framework is set', async () => {
      const svc = await import('../server/services/auto-loop-service.js')
      const settings = await import('../server/services/settings-service.js')
      const { createTask } = await import('../server/services/workspace-service.js')

      vi.mocked(settings.getProjectSettings).mockReturnValueOnce({
        e2e: { framework: 'cypress', skill: 'cy', prompt: 'pop' },
      } as never)
      createTask(wsId, { title: 'implement login API', isAcceptanceCriterion: false, sortOrder: 0 })
      svc._test_setAutoLoopReady(wsId, true)
      svc.enable(wsId)

      const prompt = await getLastIterationPrompt()
      expect(prompt).not.toContain('This is an **E2E regression test** task.')
    })

    it('does NOT inject the E2E block for lowercase `[e2e] …` (prefix match is case-sensitive)', async () => {
      const svc = await import('../server/services/auto-loop-service.js')
      const settings = await import('../server/services/settings-service.js')
      const { createTask } = await import('../server/services/workspace-service.js')

      vi.mocked(settings.getProjectSettings).mockReturnValueOnce({
        e2e: { framework: 'cypress', skill: 'cy', prompt: 'pop' },
      } as never)
      createTask(wsId, { title: '[e2e] add login regression', isAcceptanceCriterion: false, sortOrder: 0 })
      svc._test_setAutoLoopReady(wsId, true)
      svc.enable(wsId)

      const prompt = await getLastIterationPrompt()
      expect(prompt).not.toContain('This is an **E2E regression test** task.')
    })

    it('does NOT inject the E2E block for `[E2E]add` (missing trailing space)', async () => {
      const svc = await import('../server/services/auto-loop-service.js')
      const settings = await import('../server/services/settings-service.js')
      const { createTask } = await import('../server/services/workspace-service.js')

      vi.mocked(settings.getProjectSettings).mockReturnValueOnce({
        e2e: { framework: 'cypress', skill: 'cy', prompt: 'pop' },
      } as never)
      createTask(wsId, { title: '[E2E]add login regression', isAcceptanceCriterion: false, sortOrder: 0 })
      svc._test_setAutoLoopReady(wsId, true)
      svc.enable(wsId)

      const prompt = await getLastIterationPrompt()
      expect(prompt).not.toContain('This is an **E2E regression test** task.')
    })

    it('injects the finalization block when task title starts with `[FINAL] ` and prompt is set', async () => {
      const svc = await import('../server/services/auto-loop-service.js')
      const settings = await import('../server/services/settings-service.js')
      const { createTask } = await import('../server/services/workspace-service.js')

      vi.mocked(settings.getProjectSettings).mockReturnValueOnce({
        e2e: { framework: '', skill: '', prompt: '' },
        finalization: { prompt: 'Run lint and tests at the end.' },
      } as never)
      createTask(wsId, { title: '[FINAL] quality checks', isAcceptanceCriterion: false, sortOrder: 0 })
      svc._test_setAutoLoopReady(wsId, true)
      svc.enable(wsId)

      const prompt = await getLastIterationPrompt()
      expect(prompt).toContain('finalization task')
      expect(prompt).toContain('Run lint and tests at the end.')
    })

    it('does NOT inject the finalization block when prompt is empty', async () => {
      const svc = await import('../server/services/auto-loop-service.js')
      const settings = await import('../server/services/settings-service.js')
      const { createTask } = await import('../server/services/workspace-service.js')

      vi.mocked(settings.getProjectSettings).mockReturnValueOnce({
        e2e: { framework: '', skill: '', prompt: '' },
        finalization: { prompt: '' },
      } as never)
      createTask(wsId, { title: '[FINAL] quality checks', isAcceptanceCriterion: false, sortOrder: 0 })
      svc._test_setAutoLoopReady(wsId, true)
      svc.enable(wsId)

      const prompt = await getLastIterationPrompt()
      expect(prompt).not.toContain('finalization task')
    })

    it('does NOT inject the finalization block for `[FINAL]add` (missing trailing space)', async () => {
      const svc = await import('../server/services/auto-loop-service.js')
      const settings = await import('../server/services/settings-service.js')
      const { createTask } = await import('../server/services/workspace-service.js')

      vi.mocked(settings.getProjectSettings).mockReturnValueOnce({
        e2e: { framework: '', skill: '', prompt: '' },
        finalization: { prompt: 'Run lint and tests.' },
      } as never)
      createTask(wsId, { title: '[FINAL]add quality checks', isAcceptanceCriterion: false, sortOrder: 0 })
      svc._test_setAutoLoopReady(wsId, true)
      svc.enable(wsId)

      const prompt = await getLastIterationPrompt()
      expect(prompt).not.toContain('finalization task')
    })
  })
})
