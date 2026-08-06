import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initSchema } from '../server/db/schema.js'
import type { AgentEvent } from '../server/services/agent/engines/types.js'

vi.mock('../server/services/websocket-service.js', () => ({
  emit: vi.fn(),
  emitEphemeral: vi.fn(),
}))

vi.mock('../server/services/agent/event-router.js', () => ({
  routeEvent: vi.fn(),
}))

vi.mock('../server/services/auto-loop-service.js', () => ({
  onSessionEnded: vi.fn(),
  disable: vi.fn(),
  forgetAutoLoopState: vi.fn(),
  rehydrate: vi.fn(),
  onQuotaBackoffExpired: vi.fn(),
  getStatus: vi.fn(() => ({ auto_loop: false, auto_loop_ready: false, no_progress_streak: 0 })),
}))

vi.mock('../server/services/cleanup-script-service.js', () => ({
  onSessionEnded: vi.fn(),
  onAutoLoopCompleted: vi.fn(),
}))

vi.mock('../server/utils/process-tracker.js', () => ({
  unregisterProcess: vi.fn(),
}))

vi.mock('../server/services/usage/poller.js', () => ({
  refreshNow: vi.fn().mockResolvedValue(null),
}))

vi.mock('../server/services/settings-service.js', () => ({
  getGlobalSettings: () => ({ autoLoopMaxRetries: 5 }),
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

async function flushControllerStart(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
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

  it('forgetTasksDoneSnapshot clears every session snapshot for the workspace', async () => {
    const orch = await import('../server/services/agent/orchestrator.js')
    await setWorkspaceExecuting(wsId)
    orch.__test__.handleEvent(wsId, 'sess-1', {
      kind: 'session:started',
      engineSessionId: 'eng-1',
    })
    orch.__test__.handleEvent(wsId, 'sess-2', {
      kind: 'session:started',
      engineSessionId: 'eng-2',
    })
    orch.forgetTasksDoneSnapshot(wsId)
    const { listTasks, updateTaskStatus } = await import('../server/services/workspace-service.js')
    const secondTask = listTasks(wsId).find((task) => task.title === 't2')
    if (!secondTask) throw new Error('test setup')
    updateTaskStatus(secondTask.id, 'done')
    const autoLoop = await import('../server/services/auto-loop-service.js')
    orch.__test__.handleEvent(wsId, 'sess-1', {
      kind: 'session:ended',
      reason: 'completed',
      exitCode: 0,
    })
    orch.__test__.handleEvent(wsId, 'sess-2', {
      kind: 'session:ended',
      reason: 'completed',
      exitCode: 0,
    })
    expect(autoLoop.onSessionEnded).toHaveBeenNthCalledWith(1, wsId, 'completed', 0)
    expect(autoLoop.onSessionEnded).toHaveBeenNthCalledWith(2, wsId, 'completed', 0)
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

  it('isolates a replacement lifecycle from the stopped controller late session:ended', async () => {
    const orch = await import('../server/services/agent/orchestrator.js')
    const autoLoop = await import('../server/services/auto-loop-service.js')
    const cleanupScript = await import('../server/services/cleanup-script-service.js')
    const processTracker = await import('../server/utils/process-tracker.js')
    const quotaBackoff = await import('../server/services/quota-backoff-service.js')
    const { _registerEngineForTest } = await import('../server/services/agent/engines/registry.js')
    const { getWorkspace, listTasks, updateTaskStatus } = await import('../server/services/workspace-service.js')
    await setWorkspaceExecuting(wsId)

    const emitters: Array<(event: AgentEvent) => void> = []
    _registerEngineForTest({
      id: 'claude-code',
      displayName: 'Claude Code',
      capabilities: {
        models: [],
        permissionModes: ['bypass'],
        supportsResume: true,
        supportsMcp: true,
        supportsSkills: true,
      },
      async start(_options, onEvent) {
        emitters.push(onEvent)
        return {
          pid: emitters.length,
          engineSessionId: `engine-${emitters.length}`,
          sendMessage() {},
          interrupt() {},
          async stop() {},
        }
      },
    })

    const first = orch.startAgent(wsId, '/tmp/p', 'first')
    await flushControllerStart()
    emitters[0]?.({ kind: 'session:started', engineSessionId: 'engine-1' })
    orch.stopAgent(wsId)

    const replacement = orch.startAgent(wsId, '/tmp/p', 'replacement')
    await flushControllerStart()
    emitters[1]?.({ kind: 'session:started', engineSessionId: 'engine-2' })
    emitters[1]?.({
      kind: 'error',
      category: 'resume_failed',
      message: 'replacement resume failed',
    })
    const secondTask = listTasks(wsId).find((task) => task.title === 't2')
    if (!secondTask) throw new Error('test setup')
    updateTaskStatus(secondTask.id, 'done')

    orch._getRetryCounts().set(wsId, 2)
    quotaBackoff.arm(wsId, 60_000, { resetsAt: null, source: 'fallback_ladder' })
    vi.clearAllMocks()

    emitters[0]?.({ kind: 'session:ended', reason: 'killed', exitCode: null })

    expect(orch._getControllers().get(wsId)?.agentSessionId).toBe(replacement.agentSessionId)
    expect(getWorkspace(wsId)).toMatchObject({ status: 'executing', hasUnread: false })
    expect(orch._getRetryCounts().get(wsId)).toBe(2)
    expect(quotaBackoff.getPending(wsId)).not.toBeNull()
    expect(processTracker.unregisterProcess).not.toHaveBeenCalled()
    expect(autoLoop.onSessionEnded).not.toHaveBeenCalled()
    expect(autoLoop.disable).not.toHaveBeenCalled()
    expect(cleanupScript.onSessionEnded).not.toHaveBeenCalled()

    emitters[1]?.({ kind: 'session:ended', reason: 'error', exitCode: 1 })

    expect(autoLoop.onSessionEnded).toHaveBeenCalledOnce()
    expect(autoLoop.onSessionEnded).toHaveBeenCalledWith(wsId, 'completed', 1)
    expect(cleanupScript.onSessionEnded).toHaveBeenCalledOnce()
    expect(processTracker.unregisterProcess).toHaveBeenCalledOnce()
    const rows = (await import('../server/db/index.js'))
      .getDb()
      .prepare('SELECT id, status FROM agent_sessions WHERE id IN (?, ?) ORDER BY id')
      .all(first.agentSessionId, replacement.agentSessionId) as Array<{ id: string; status: string }>
    expect(rows).toEqual(
      expect.arrayContaining([
        { id: first.agentSessionId, status: 'error' },
        { id: replacement.agentSessionId, status: 'error' },
      ]),
    )
  })

  it('finalizes a manually stopped session without advancing auto-loop or running cleanup', async () => {
    const orch = await import('../server/services/agent/orchestrator.js')
    const autoLoop = await import('../server/services/auto-loop-service.js')
    const cleanupScript = await import('../server/services/cleanup-script-service.js')
    const processTracker = await import('../server/utils/process-tracker.js')
    const { _registerEngineForTest } = await import('../server/services/agent/engines/registry.js')
    await setWorkspaceExecuting(wsId)

    let emitEvent: (event: AgentEvent) => void = () => {}
    _registerEngineForTest({
      id: 'claude-code',
      displayName: 'Claude Code',
      capabilities: {
        models: [],
        permissionModes: ['bypass'],
        supportsResume: true,
        supportsMcp: true,
        supportsSkills: true,
      },
      async start(_options, onEvent) {
        emitEvent = onEvent
        return {
          pid: 1,
          engineSessionId: 'manual-stop-engine',
          sendMessage() {},
          interrupt() {},
          async stop() {},
        }
      },
    })

    const session = orch.startAgent(wsId, '/tmp/p', 'manual stop')
    await flushControllerStart()
    emitEvent({ kind: 'session:started', engineSessionId: 'manual-stop-engine' })
    orch._getRetryCounts().set(wsId, 2)
    orch.stopAgent(wsId)
    vi.clearAllMocks()

    emitEvent({ kind: 'session:ended', reason: 'killed', exitCode: null })

    expect(orch._getControllers().has(wsId)).toBe(false)
    expect(orch._getRetryCounts().has(wsId)).toBe(false)
    expect(processTracker.unregisterProcess).toHaveBeenCalledOnce()
    expect(autoLoop.onSessionEnded).not.toHaveBeenCalled()
    expect(cleanupScript.onSessionEnded).not.toHaveBeenCalled()
    const row = (await import('../server/db/index.js'))
      .getDb()
      .prepare('SELECT status, ended_at FROM agent_sessions WHERE id = ?')
      .get(session.agentSessionId) as { status: string; ended_at: string | null }
    expect(row.status).toBe('error')
    expect(row.ended_at).not.toBeNull()
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

  it('calls onQuotaBackoffExpired when the backoff timer fires (auto_loop enabled)', async () => {
    const orch = await import('../server/services/agent/orchestrator.js')
    const autoLoop = await import('../server/services/auto-loop-service.js')
    const { getDb } = await import('../server/db/index.js')
    const db = getDb()

    db.prepare("UPDATE workspaces SET auto_loop = 1, status = 'quota' WHERE id = ?").run(wsId)
    orch.forgetRateLimitInfo(wsId)

    await orch.__test__.handleQuota(wsId)
    vi.advanceTimersByTime(15 * 60 * 1000 + 1000)

    expect(autoLoop.onQuotaBackoffExpired).toHaveBeenCalledWith(wsId)
  })

  it('calls onQuotaBackoffExpired when the backoff timer fires (auto_loop disabled — service no-ops)', async () => {
    // Under the new design, orchestrator hands off uniformly to
    // quotaBackoffService → auto-loop-service. The latter is responsible for
    // checking `auto_loop=1` and no-op'ing for non-auto-loop workspaces. From
    // the orchestrator's perspective the call always lands.
    const orch = await import('../server/services/agent/orchestrator.js')
    const autoLoop = await import('../server/services/auto-loop-service.js')
    const { getDb } = await import('../server/db/index.js')
    const db = getDb()

    db.prepare("UPDATE workspaces SET auto_loop = 0, status = 'quota' WHERE id = ?").run(wsId)
    orch.forgetRateLimitInfo(wsId)

    await orch.__test__.handleQuota(wsId)
    vi.advanceTimersByTime(15 * 60 * 1000 + 1000)

    expect(autoLoop.onQuotaBackoffExpired).toHaveBeenCalledWith(wsId)
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

  it('clears every stale engine_session_id for the current workspace so the next resume starts fresh', async () => {
    const orch = await import('../server/services/agent/orchestrator.js')
    const db = (await import('../server/db/index.js')).getDb()
    await setWorkspaceExecuting(wsId)

    // Seed two stale engine session ids: the current failure and an older row
    // that must not be selected by the next resume fallback.
    db.prepare(
      "INSERT INTO agent_sessions (id, workspace_id, pid, status, engine_session_id, started_at) VALUES ('sess-old', ?, null, 'error', 'stale-old', datetime('now', '-1 day'))",
    ).run(wsId)
    db.prepare(
      "INSERT INTO agent_sessions (id, workspace_id, pid, status, engine_session_id, started_at) VALUES ('sess-1', ?, null, 'running', 'stale-123', datetime('now'))",
    ).run(wsId)

    orch.__test__.handleEvent(wsId, 'sess-1', {
      kind: 'error',
      category: 'resume_failed',
      message: 'No conversation found with session ID: stale-123',
    })
    orch.__test__.handleEvent(wsId, 'sess-1', { kind: 'session:ended', reason: 'error', exitCode: 1 })

    const rows = db
      .prepare('SELECT engine_session_id FROM agent_sessions WHERE workspace_id = ? ORDER BY id')
      .all(wsId) as Array<{ engine_session_id: string | null }>
    expect(rows).toEqual([{ engine_session_id: null }, { engine_session_id: null }])
  })
})
