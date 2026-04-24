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

vi.mock('../server/services/agent/event-router.js', () => ({
  routeEvent: vi.fn(),
}))

vi.mock('../server/services/auto-loop-service.js', () => ({
  onSessionEnded: vi.fn(),
  forgetAutoLoopState: vi.fn(),
  rehydrate: vi.fn(),
  onQuotaBackoffExpired: vi.fn(),
}))

vi.mock('../server/services/settings-service.js', () => ({
  getEffectiveSettings: () => ({
    model: 'claude-opus-4-7',
    dangerouslySkipPermissions: true,
    prPromptTemplate: '',
    gitConventions: '',
    sourceBranch: 'develop',
    devServer: null,
    setupScript: '',
    notionStatusProperty: '',
    notionInProgressStatus: '',
  }),
}))

let tmpDir: string
let dbPath: string

async function resetDb() {
  const { closeDb } = await import('../server/db/index.js')
  closeDb()
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'at-orch-autoloop-'))
  dbPath = path.join(tmpDir, 'test.db')
  const db = new Database(dbPath)
  db.pragma('journal_mode=WAL')
  db.pragma('foreign_keys=ON')
  initSchema(db)
  db.close()
}

async function setWorkspaceExecuting(workspaceId: string): Promise<void> {
  const { updateWorkspaceStatus } = await import('../server/services/workspace-service.js')
  updateWorkspaceStatus(workspaceId, 'brainstorming')
  updateWorkspaceStatus(workspaceId, 'executing')
}

describe('orchestrator auto-loop integration', () => {
  let wsId: string

  beforeEach(async () => {
    await resetDb()
    const { getDb } = await import('../server/db/index.js')
    getDb(dbPath)
    const { createWorkspace, createTask, updateTaskStatus } = await import('../server/services/workspace-service.js')
    const ws = createWorkspace({
      name: 'w',
      projectPath: '/tmp/p',
      sourceBranch: 'main',
      workingBranch: 'feature/x',
    })
    wsId = ws.id
    // 2 tasks, 1 done → baseline 1
    const t1 = createTask(wsId, { title: 't1', isAcceptanceCriterion: false, sortOrder: 0 })
    createTask(wsId, { title: 't2', isAcceptanceCriterion: false, sortOrder: 1 })
    updateTaskStatus(t1.id, 'done')
    vi.clearAllMocks()
  })

  afterEach(async () => {
    const { closeDb } = await import('../server/db/index.js')
    closeDb()
    if (tmpDir && fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('session:started snapshots done-count, session:ended computes delta', async () => {
    const orch = await import('../server/services/agent/orchestrator.js')
    const autoLoop = await import('../server/services/auto-loop-service.js')
    await setWorkspaceExecuting(wsId)

    orch.__test__.handleEvent(wsId, 'sess-1', {
      kind: 'session:started',
      engineSessionId: 'eng-1',
    })

    // Mark task 2 done during the session
    const { listTasks, updateTaskStatus } = await import('../server/services/workspace-service.js')
    const t2 = listTasks(wsId).find((t) => t.title === 't2')
    if (!t2) throw new Error('test setup')
    updateTaskStatus(t2.id, 'done')

    orch.__test__.handleEvent(wsId, 'sess-1', {
      kind: 'session:ended',
      reason: 'completed',
      exitCode: 0,
    })

    expect(autoLoop.onSessionEnded).toHaveBeenCalledWith(wsId, 'completed', 1)
  })

  it('session:ended without prior session:started falls back to delta=0', async () => {
    const orch = await import('../server/services/agent/orchestrator.js')
    const autoLoop = await import('../server/services/auto-loop-service.js')
    await setWorkspaceExecuting(wsId)

    orch.__test__.handleEvent(wsId, 'sess-1', {
      kind: 'session:ended',
      reason: 'completed',
      exitCode: 0,
    })

    expect(autoLoop.onSessionEnded).toHaveBeenCalledWith(wsId, 'completed', 0)
  })

  it('forgetTasksDoneSnapshot clears the snapshot', async () => {
    const orch = await import('../server/services/agent/orchestrator.js')
    await setWorkspaceExecuting(wsId)
    orch.__test__.handleEvent(wsId, 'sess-1', {
      kind: 'session:started',
      engineSessionId: 'eng-1',
    })
    orch.forgetTasksDoneSnapshot(wsId)
    const autoLoop = await import('../server/services/auto-loop-service.js')
    orch.__test__.handleEvent(wsId, 'sess-1', {
      kind: 'session:ended',
      reason: 'completed',
      exitCode: 0,
    })
    expect(autoLoop.onSessionEnded).toHaveBeenCalledWith(wsId, 'completed', 0)
  })

  // Regression for C1: the internal cleanup that removes the controller from
  // the map must run BEFORE autoLoopService.onSessionEnded, otherwise the
  // auto-loop's spawnNextIteration sees a still-populated controller map and
  // startAgent throws. Previous implementation tests hid the bug because they
  // mocked hasController. Here we test the ORDER explicitly.
  it('calls internal onSessionEnded (controller cleanup) BEFORE autoLoopService.onSessionEnded', async () => {
    const orch = await import('../server/services/agent/orchestrator.js')
    const autoLoop = await import('../server/services/auto-loop-service.js')
    await setWorkspaceExecuting(wsId)

    // Track call order between the UPDATE on agent_sessions (done by internal
    // onSessionEnded) and autoLoopService.onSessionEnded.
    const callOrder: string[] = []
    ;(autoLoop.onSessionEnded as ReturnType<typeof vi.fn>).mockImplementation(() => {
      callOrder.push('autoLoopService.onSessionEnded')
    })

    // Spy on the DB update that internal onSessionEnded does — use a Proxy
    // around getDb to record when the `UPDATE agent_sessions SET status` runs.
    const { getDb } = await import('../server/db/index.js')
    const db = getDb()
    const originalPrepare = db.prepare.bind(db)
    const spy = vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
      if (sql.includes('UPDATE agent_sessions SET status')) {
        callOrder.push('internal.onSessionEnded')
      }
      return originalPrepare(sql)
    })

    try {
      orch.__test__.handleEvent(wsId, 'sess-1', {
        kind: 'session:started',
        engineSessionId: 'eng-1',
      })
      orch.__test__.handleEvent(wsId, 'sess-1', {
        kind: 'session:ended',
        reason: 'completed',
        exitCode: 0,
      })

      expect(callOrder).toEqual(['internal.onSessionEnded', 'autoLoopService.onSessionEnded'])
    } finally {
      spy.mockRestore()
    }
  })
})

describe('handleQuota auto-loop timer', () => {
  let wsId: string

  beforeEach(async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-23T10:00:00Z'))
    await resetDb()
    const { getDb } = await import('../server/db/index.js')
    getDb(dbPath)
    const { createWorkspace } = await import('../server/services/workspace-service.js')
    const ws = createWorkspace({
      name: 'quota-ws',
      projectPath: '/tmp/p',
      sourceBranch: 'main',
      workingBranch: 'feature/x',
    })
    wsId = ws.id
    vi.clearAllMocks()
  })

  afterEach(async () => {
    vi.useRealTimers()
    const { closeDb } = await import('../server/db/index.js')
    closeDb()
    if (tmpDir && fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('calls onQuotaBackoffExpired instead of startAgent when auto_loop is enabled', async () => {
    const orch = await import('../server/services/agent/orchestrator.js')
    const autoLoop = await import('../server/services/auto-loop-service.js')
    const { getDb } = await import('../server/db/index.js')
    const db = getDb()

    db.prepare("UPDATE workspaces SET auto_loop = 1, status = 'quota' WHERE id = ?").run(wsId)
    orch.forgetRateLimitInfo(wsId)

    orch.__test__.handleQuota(wsId)
    vi.advanceTimersByTime(15 * 60 * 1000 + 1000)

    expect(autoLoop.onQuotaBackoffExpired).toHaveBeenCalledWith(wsId)
  })

  it('calls startAgent (not onQuotaBackoffExpired) when auto_loop is disabled', async () => {
    const orch = await import('../server/services/agent/orchestrator.js')
    const autoLoop = await import('../server/services/auto-loop-service.js')
    const { getDb } = await import('../server/db/index.js')
    const db = getDb()

    // auto_loop stays 0 (default), set status to quota manually
    db.prepare("UPDATE workspaces SET auto_loop = 0, status = 'quota' WHERE id = ?").run(wsId)
    orch.forgetRateLimitInfo(wsId)

    orch.__test__.handleQuota(wsId)
    vi.advanceTimersByTime(15 * 60 * 1000 + 1000)

    expect(autoLoop.onQuotaBackoffExpired).not.toHaveBeenCalled()
    // startAgent is NOT mocked in this file — the real one would throw, but
    // the timer catches it. We just verify onQuotaBackoffExpired was skipped.
  })
})

describe('resume_failed error handling', () => {
  let wsId: string

  beforeEach(async () => {
    await resetDb()
    const { getDb } = await import('../server/db/index.js')
    getDb(dbPath)
    const { createWorkspace } = await import('../server/services/workspace-service.js')
    const ws = createWorkspace({
      name: 'rf-ws',
      projectPath: '/tmp/p',
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

  it('passes reason=completed to autoLoopService.onSessionEnded after resume_failed (not error)', async () => {
    const orch = await import('../server/services/agent/orchestrator.js')
    const autoLoop = await import('../server/services/auto-loop-service.js')
    await setWorkspaceExecuting(wsId)

    orch.__test__.handleEvent(wsId, 'sess-1', { kind: 'session:started', engineSessionId: 'stale-123' })
    orch.__test__.handleEvent(wsId, 'sess-1', {
      kind: 'error',
      category: 'resume_failed',
      message: 'No conversation found with session ID: stale-123',
    })
    orch.__test__.handleEvent(wsId, 'sess-1', { kind: 'session:ended', reason: 'error', exitCode: 1 })

    expect(autoLoop.onSessionEnded).toHaveBeenCalledWith(wsId, 'completed', expect.any(Number))
  })

  it('sets workspace status to completed (not error) after resume_failed', async () => {
    const orch = await import('../server/services/agent/orchestrator.js')
    const { getWorkspace } = await import('../server/services/workspace-service.js')

    // Put workspace in executing first so the completed transition is valid
    const db = (await import('../server/db/index.js')).getDb()
    db.prepare("UPDATE workspaces SET status = 'executing' WHERE id = ?").run(wsId)

    orch.__test__.handleEvent(wsId, 'sess-1', {
      kind: 'error',
      category: 'resume_failed',
      message: 'No conversation found with session ID: stale-123',
    })
    orch.__test__.handleEvent(wsId, 'sess-1', { kind: 'session:ended', reason: 'error', exitCode: 1 })

    const ws = getWorkspace(wsId)
    expect(ws?.status).toBe('completed')
  })

  it('clears the stale engine_session_id from DB so the next resume starts fresh', async () => {
    const orch = await import('../server/services/agent/orchestrator.js')
    const db = (await import('../server/db/index.js')).getDb()
    await setWorkspaceExecuting(wsId)

    // Seed a stale engine_session_id
    db.prepare(
      "INSERT INTO agent_sessions (id, workspace_id, pid, status, engine_session_id, started_at) VALUES ('sess-1', ?, null, 'running', 'stale-123', datetime('now'))",
    ).run(wsId)

    orch.__test__.handleEvent(wsId, 'sess-1', {
      kind: 'error',
      category: 'resume_failed',
      message: 'No conversation found with session ID: stale-123',
    })
    orch.__test__.handleEvent(wsId, 'sess-1', { kind: 'session:ended', reason: 'error', exitCode: 1 })

    const row = db.prepare('SELECT engine_session_id FROM agent_sessions WHERE workspace_id = ?').get(wsId) as
      | { engine_session_id: string | null }
      | undefined
    expect(row?.engine_session_id).toBeNull()
  })
})
