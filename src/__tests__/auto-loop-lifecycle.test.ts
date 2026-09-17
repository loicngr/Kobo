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
  runningAgentCount: vi.fn(() => 0),
  isShuttingDown: vi.fn(() => false),
  resetAutoLoopRetries: vi.fn(),
}))

vi.mock('../server/services/cleanup-script-service.js', () => ({ onAutoLoopCompleted: vi.fn() }))

vi.mock('../server/services/lifecycle-hook-service.js', () => ({
  onAutoLoopDisabled: vi.fn(async () => {}),
}))

vi.mock('../server/services/settings-service.js', () => ({
  getProjectSettings: vi.fn(),
  getGlobalSettings: vi.fn(() => ({
    worktreesPath: '',
    worktreesPrefixByProject: false,
  })),
  // Finalization now resolves through the project||global cascade; default to
  // empty (inherit) so only the dedicated finalization tests opt into a prompt.
  getEffectiveFinalization: vi.fn(() => ({ prompt: '' })),
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

describe('durable auto-loop lifecycle', () => {
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

  it('rejects archived workspaces before changing loop intent', async () => {
    const { getDb } = await import('../server/db/index.js')
    const svc = await import('../server/services/auto-loop-service.js')
    const { createTask } = await import('../server/services/workspace-service.js')
    createTask(wsId, { title: 'work', sortOrder: 0 })
    getDb().prepare('UPDATE workspaces SET auto_loop_ready=1, archived_at=? WHERE id=?').run('now', wsId)
    expect(() => svc.enable(wsId)).toThrow(/archived/)
    expect(svc.getStatus(wsId).auto_loop).toBe(false)
  })

  it('selects acceptance criteria before finalization even with a lower final order', async () => {
    const svc = await import('../server/services/auto-loop-service.js')
    const { createTask } = await import('../server/services/workspace-service.js')
    createTask(wsId, { title: '[FINAL] verify', sortOrder: 0 })
    const criterion = createTask(wsId, { title: 'criterion', isAcceptanceCriterion: true, sortOrder: 1 })
    expect(svc._test_pickNextTask(wsId)?.id).toBe(criterion.id)
  })

  it('resumes interrupted grooming instead of declaring empty work completed', async () => {
    const { getDb } = await import('../server/db/index.js')
    const svc = await import('../server/services/auto-loop-service.js')
    const orch = await import('../server/services/agent/orchestrator.js')
    getDb().prepare('UPDATE workspaces SET auto_loop=1 WHERE id=?').run(wsId)
    svc.rehydrate()
    expect(orch.startAgent).toHaveBeenCalledWith(
      wsId,
      expect.any(String),
      expect.stringMatching(/grooming/i),
      expect.any(String),
      true,
      expect.any(String),
      undefined,
      expect.any(String),
    )
    expect(svc.getStatus(wsId).auto_loop).toBe(true)
  })

  it('diagnoses stagnation then blocks without losing unfinished intent', async () => {
    const svc = await import('../server/services/auto-loop-service.js')
    const { createTask } = await import('../server/services/workspace-service.js')
    const orch = await import('../server/services/agent/orchestrator.js')
    createTask(wsId, { title: 'work', sortOrder: 0 })
    svc._test_setAutoLoopReady(wsId, true)
    svc.enable(wsId)
    for (let i = 0; i < 3; i++) svc.onSessionEnded(wsId, 'completed', 0)
    expect(svc.getStatus(wsId).auto_loop).toBe(true)
    expect(orch.startAgent).toHaveBeenLastCalledWith(
      wsId,
      expect.any(String),
      expect.stringMatching(/diagnostic/i),
      expect.any(String),
      expect.any(Boolean),
      expect.any(String),
      undefined,
      expect.any(String),
    )
    for (let i = 0; i < 3; i++) svc.onSessionEnded(wsId, 'completed', 0)
    expect(svc.getStatus(wsId)).toMatchObject({ auto_loop: true, state: 'blocked' })
    vi.clearAllMocks()
    svc.rehydrate()
    expect(orch.startAgent).not.toHaveBeenCalled()
  })

  it('creates a final verification before completing a legacy mission', async () => {
    const { getDb } = await import('../server/db/index.js')
    const svc = await import('../server/services/auto-loop-service.js')
    const { createTask, listTasks } = await import('../server/services/workspace-service.js')
    const task = createTask(wsId, { title: 'legacy work', sortOrder: 0 })
    getDb().prepare("UPDATE tasks SET status='done' WHERE id=?").run(task.id)
    getDb().prepare('UPDATE workspaces SET auto_loop=1,auto_loop_ready=1 WHERE id=?').run(wsId)
    svc.rehydrate()
    expect(svc.getStatus(wsId).auto_loop).toBe(true)
    expect(listTasks(wsId).some((t) => t.title.startsWith('[FINAL]') && t.status === 'pending')).toBe(true)
  })
  it('finishes verified work before considering a stale diagnostic counter', async () => {
    const { getDb } = await import('../server/db/index.js')
    const svc = await import('../server/services/auto-loop-service.js')
    const { createTask, updateTask, listTasks } = await import('../server/services/workspace-service.js')
    const { setRuntime } = await import('../server/services/auto-loop-state-service.js')
    const task = createTask(wsId, { title: 'work', sortOrder: 0 })
    svc._test_setAutoLoopReady(wsId, true)
    svc.enable(wsId)
    const verification = { method: 'test', summary: 'passed', checks: [{ name: 'suite', status: 'passed' as const }] }
    updateTask(task.id, { status: 'done', verification })
    updateTask(listTasks(wsId).find((t) => t.role === 'finalization')!.id, { status: 'done', verification })
    setRuntime(wsId, { diagnostic_attempts: 3 })
    getDb().prepare('UPDATE workspaces SET no_progress_streak=5 WHERE id=?').run(wsId)
    svc.onSessionEnded(wsId, 'completed', 0)
    expect(svc.getStatus(wsId)).toMatchObject({ auto_loop: false, state: 'completed' })
  })

  it('does not recreate a quota timer for an explicitly blocked mission on boot', async () => {
    const { getDb } = await import('../server/db/index.js')
    const svc = await import('../server/services/auto-loop-service.js')
    const quota = await import('../server/services/quota-backoff-service.js')
    getDb().prepare("UPDATE workspaces SET auto_loop=1,status='quota' WHERE id=?").run(wsId)
    svc.block(wsId, 'engine-stop-unconfirmed')
    svc.rehydrate()
    expect(quota.getPending(wsId)).toBeNull()
    quota.cancel(wsId, 'completed')
  })

  it('uses the explicit role rather than a renamed work task prefix', async () => {
    const svc = await import('../server/services/auto-loop-service.js')
    const { createTask, updateTask } = await import('../server/services/workspace-service.js')
    const work = createTask(wsId, { title: 'work', sortOrder: 0 })
    updateTask(work.id, { title: '[FINAL] just a title' })
    createTask(wsId, { title: 'criterion', isAcceptanceCriterion: true, sortOrder: 1 })
    expect(svc._test_pickNextTask(wsId)?.id).toBe(work.id)
  })
  it.each([false, true])('resumes grooming after quota with a partial task list=%s', async (partial) => {
    const { getDb } = await import('../server/db/index.js')
    const svc = await import('../server/services/auto-loop-service.js')
    const orch = await import('../server/services/agent/orchestrator.js')
    const { createTask, listTasks } = await import('../server/services/workspace-service.js')
    if (partial) createTask(wsId, { title: 'partial grooming', sortOrder: 0 })
    getDb().prepare("UPDATE workspaces SET auto_loop=1,auto_loop_ready=0,status='quota' WHERE id=?").run(wsId)
    svc.onQuotaBackoffExpired(wsId)
    expect(svc.getStatus(wsId)).toMatchObject({ auto_loop: true, auto_loop_ready: false, phase: 'grooming' })
    expect(orch.startAgent).toHaveBeenCalledWith(
      wsId,
      expect.any(String),
      expect.stringContaining('resume grooming'),
      expect.any(String),
      true,
      expect.any(String),
      undefined,
      expect.any(String),
    )
    expect(listTasks(wsId)).toHaveLength(partial ? 1 : 0)
  })
})
