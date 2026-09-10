import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEngine, AgentEvent } from '../../server/services/agent/engines/types.js'
import { resetDb } from '../helpers/reset-db.js'

vi.mock('../../server/services/websocket-service.js', () => ({
  emit: vi.fn(),
  emitEphemeral: vi.fn(),
}))

vi.mock('../../server/services/settings-service.js', () => ({
  getGlobalSettings: () => ({ autoLoopMaxRetries: 5 }),
  getProjectSettings: () => ({ forge: 'none' }),
  getEffectiveFinalization: () => ({ prompt: '' }),
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
    sessionEndedScript: '',
    autoLoopDisabledScript: '',
  }),
}))

vi.mock('../../server/services/usage/poller.js', () => ({
  refreshNow: vi.fn().mockResolvedValue(null),
}))

/** Two macrotask ticks drain every microtask queued in between. */
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

/** Engine whose stop() only settles when the test releases it. */
function makeGatedEngine(): {
  engine: AgentEngine
  releaseStop: () => void
  startCount: () => number
} {
  let resolveStop: (() => void) | undefined
  let startCount = 0
  const engine: AgentEngine = {
    id: 'claude-code',
    displayName: 'Claude Code',
    capabilities: {
      models: [{ id: 'auto', label: 'Auto' }],
      permissionModes: ['bypass'],
      supportsResume: true,
      supportsMcp: true,
      supportsSkills: true,
      supportsSubagents: false,
      supportsQuotaStatus: false,
    },
    async start() {
      startCount++
      return {
        pid: undefined,
        engineSessionId: undefined,
        isAlive: () => true,
        sendMessage() {},
        interrupt() {},
        stop() {
          return new Promise<void>((resolve) => {
            resolveStop = resolve
          })
        },
        resolvePendingUserInput: () => false,
      }
    },
  }
  return {
    engine,
    releaseStop: () => resolveStop?.(),
    startCount: () => startCount,
  }
}

describe('Orchestrator — stopping window', () => {
  let gated: ReturnType<typeof makeGatedEngine>

  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    await resetDb()
    gated = makeGatedEngine()
    const { _registerEngineForTest } = await import('../../server/services/agent/engines/registry.js')
    _registerEngineForTest(gated.engine)
  })

  it('keeps the controller registered, in stopping state, until the engine has actually stopped', async () => {
    const { createWorkspace } = await import('../../server/services/workspace-service.js')
    const ws = createWorkspace({
      name: 'W',
      projectPath: '/tmp',
      sourceBranch: 'develop',
      workingBranch: 'feature/stopping',
    })
    const orch = await import('../../server/services/agent/orchestrator.js')

    orch.startAgent(ws.id, '/tmp', 'hi')
    await flush()
    expect(orch.getAgentStatus(ws.id)).toBe('running')

    const stopped = orch.stopAgentAndWait(ws.id)
    await flush()

    // The engine has NOT died yet. Cron and auto-loop both guard on
    // `hasController`, so this must still report an agent on the worktree.
    expect(orch.hasController(ws.id)).toBe(true)
    expect(orch.getAgentStatus(ws.id)).toBe('stopping')

    gated.releaseStop()
    await expect(stopped).resolves.toBe('stopped')
    expect(orch.hasController(ws.id)).toBe(false)
    expect(orch.getAgentStatus(ws.id)).toBeNull()
  })

  it('does not start the replacement engine before the evicted zombie has stopped', async () => {
    const { createWorkspace } = await import('../../server/services/workspace-service.js')
    const { getDb } = await import('../../server/db/index.js')
    const ws = createWorkspace({
      name: 'W',
      projectPath: '/tmp',
      sourceBranch: 'develop',
      workingBranch: 'feature/zombie',
    })
    const orch = await import('../../server/services/agent/orchestrator.js')

    orch.startAgent(ws.id, '/tmp', 'first')
    await flush()
    expect(gated.startCount()).toBe(1)

    // The workspace is logically done but the SDK iterator is still parked —
    // this is the zombie-eviction path.
    getDb().prepare("UPDATE workspaces SET status = 'idle' WHERE id = ?").run(ws.id)

    orch.startAgent(ws.id, '/tmp', 'second')
    await flush()

    // The zombie has not released its stop() yet: starting a second engine
    // here would put two agents on the same worktree.
    expect(gated.startCount()).toBe(1)

    gated.releaseStop()
    await flush()
    expect(gated.startCount()).toBe(2)
  })

  it('retains an unconfirmed controller after the bounded timeout', async () => {
    const { createWorkspace } = await import('../../server/services/workspace-service.js')
    const ws = createWorkspace({
      name: 'W',
      projectPath: '/tmp',
      sourceBranch: 'develop',
      workingBranch: 'feature/deaf',
    })
    const orch = await import('../../server/services/agent/orchestrator.js')

    orch.startAgent(ws.id, '/tmp', 'hi')
    await flush()

    // Never release the stop — the engine ignores it entirely.
    const outcome = await orch.stopAgentAndWait(ws.id, 20)

    expect(outcome).toBe('timeout')
    expect(orch.hasController(ws.id)).toBe(true)
    expect(() => orch.startAgent(ws.id, '/tmp', 'replacement')).toThrow(/stopping/i)
    gated.releaseStop()
    await flush()
    expect(orch.hasController(ws.id)).toBe(false)
  })

  it('cancels a zombie replacement when the user stops before its engine starts', async () => {
    const { createWorkspace } = await import('../../server/services/workspace-service.js')
    const { getDb } = await import('../../server/db/index.js')
    const orch = await import('../../server/services/agent/orchestrator.js')
    const ws = createWorkspace({
      name: 'W',
      projectPath: '/tmp',
      sourceBranch: 'develop',
      workingBranch: 'feature/cancel-replacement',
    })
    orch.startAgent(ws.id, '/tmp', 'first')
    await flush()
    getDb().prepare("UPDATE workspaces SET status = 'idle' WHERE id = ?").run(ws.id)
    const replacement = orch.startAgent(ws.id, '/tmp', 'replacement')
    await flush()

    const stopped = orch.stopAgentAndWait(ws.id)
    gated.releaseStop()
    await expect(stopped).resolves.toBe('stopped')
    await flush()

    expect(gated.startCount()).toBe(1)
    expect(orch.hasController(ws.id)).toBe(false)
    const row = getDb()
      .prepare('SELECT status, end_reason, ended_at FROM agent_sessions WHERE id = ?')
      .get(replacement.agentSessionId)
    expect(row).toEqual({ status: 'error', end_reason: 'killed', ended_at: expect.any(String) })
    const { emit } = await import('../../server/services/websocket-service.js')
    expect(
      vi
        .mocked(emit)
        .mock.calls.some(
          ([, , event]) =>
            (event as AgentEvent).kind === 'error' && (event as { category?: string }).category === 'spawn_failed',
        ),
    ).toBe(false)
  })

  it('retains the controller on a failed stop and permits a later retry', async () => {
    const { createWorkspace } = await import('../../server/services/workspace-service.js')
    const ws = createWorkspace({
      name: 'W',
      projectPath: '/tmp',
      sourceBranch: 'develop',
      workingBranch: 'feature/stop-failed',
    })
    const orch = await import('../../server/services/agent/orchestrator.js')
    orch.startAgent(ws.id, '/tmp', 'hi')
    await flush()
    const ep = orch._getControllers().get(ws.id)!.engineProcess!
    vi.spyOn(ep, 'stop').mockRejectedValueOnce(new Error('stop failed')).mockResolvedValueOnce()
    await expect(orch.stopAgentAndWait(ws.id)).resolves.toBe('failed')
    expect(orch.hasController(ws.id)).toBe(true)
    await expect(orch.stopAgentAndWait(ws.id)).resolves.toBe('stopped')
    expect(orch.hasController(ws.id)).toBe(false)
  })

  it('refuses a new agent while the workspace lifecycle guard is held', async () => {
    const { createWorkspace } = await import('../../server/services/workspace-service.js')
    const { withWorkspaceLifecycleGuard } = await import('../../server/utils/workspace-lifecycle-guard.js')
    const ws = createWorkspace({
      name: 'W',
      projectPath: '/tmp',
      sourceBranch: 'develop',
      workingBranch: 'feature/purging',
    })
    const orch = await import('../../server/services/agent/orchestrator.js')
    await withWorkspaceLifecycleGuard(ws.id, async () => {
      expect(() => orch.startAgent(ws.id, '/tmp', 'hi')).toThrow(/operation is in progress/)
      expect(orch.hasController(ws.id)).toBe(false)
    })
    expect(gated.startCount()).toBe(0)
  })

  it('notifies capacity waiters only after a manual stop is confirmed', async () => {
    const { createWorkspace } = await import('../../server/services/workspace-service.js')
    const loops = await import('../../server/services/auto-loop-service.js')
    const resume = vi.spyOn(loops, 'resumeWaitingWorkspaces').mockImplementation(() => {})
    const ws = createWorkspace({
      name: 'W',
      projectPath: '/tmp',
      sourceBranch: 'develop',
      workingBranch: 'feature/slot',
    })
    const orch = await import('../../server/services/agent/orchestrator.js')
    orch.startAgent(ws.id, '/tmp', 'hi')
    await flush()
    const pending = orch.stopAgentAndWait(ws.id)
    await flush()
    expect(resume).not.toHaveBeenCalled()
    gated.releaseStop()
    await pending
    await flush()
    expect(resume).toHaveBeenCalledTimes(1)
  })

  it('does not restart a manually stopped loop when another workspace later stops', async () => {
    const { createWorkspace, createTask } = await import('../../server/services/workspace-service.js')
    const { getDb } = await import('../../server/db/index.js')
    const orch = await import('../../server/services/agent/orchestrator.js')
    const a = createWorkspace({
      name: 'A',
      projectPath: '/tmp',
      sourceBranch: 'develop',
      workingBranch: 'feature/manual-a',
    })
    const b = createWorkspace({
      name: 'B',
      projectPath: '/tmp',
      sourceBranch: 'develop',
      workingBranch: 'feature/manual-b',
    })
    createTask(a.id, { title: 'Pending work' })
    getDb()
      .prepare('UPDATE workspaces SET auto_loop = 1, auto_loop_ready = 1, worktree_path = ? WHERE id = ?')
      .run(process.env.KOBO_HOME, a.id)
    orch.startAgent(a.id, '/tmp', 'A')
    orch.startAgent(b.id, '/tmp', 'B')
    await flush()
    const stopA = orch.stopAgentAndWait(a.id)
    await flush()
    gated.releaseStop()
    await stopA
    await flush()
    expect(orch.hasController(a.id)).toBe(false)

    const stopB = orch.stopAgentAndWait(b.id)
    await flush()
    gated.releaseStop()
    await stopB
    await flush()
    expect(orch.hasController(a.id)).toBe(false)
    const loops = await import('../../server/services/auto-loop-service.js')
    expect(loops.getStatus(a.id).auto_loop).toBe(false)
  })

  it('disables a waiting auto-loop even when there is no controller to stop', async () => {
    const { createWorkspace } = await import('../../server/services/workspace-service.js')
    const { getDb } = await import('../../server/db/index.js')
    const orch = await import('../../server/services/agent/orchestrator.js')
    const loops = await import('../../server/services/auto-loop-service.js')
    const ws = createWorkspace({
      name: 'Waiting',
      projectPath: '/tmp',
      sourceBranch: 'develop',
      workingBranch: 'feature/stop-waiting',
    })
    getDb().prepare('UPDATE workspaces SET auto_loop = 1, auto_loop_ready = 1 WHERE id = ?').run(ws.id)

    await expect(orch.stopAgentAndWait(ws.id)).resolves.toBe('not-running')
    expect(loops.getStatus(ws.id).auto_loop).toBe(false)
  })

  it('preserves auto-loop during internal zombie replacement', async () => {
    const { createWorkspace } = await import('../../server/services/workspace-service.js')
    const { getDb } = await import('../../server/db/index.js')
    const orch = await import('../../server/services/agent/orchestrator.js')
    const loops = await import('../../server/services/auto-loop-service.js')
    const ws = createWorkspace({
      name: 'Loop',
      projectPath: '/tmp',
      sourceBranch: 'develop',
      workingBranch: 'feature/replace-loop',
    })
    orch.startAgent(ws.id, '/tmp', 'first')
    await flush()
    getDb().prepare("UPDATE workspaces SET auto_loop = 1, status = 'idle' WHERE id = ?").run(ws.id)
    orch.startAgent(ws.id, '/tmp', 'replacement')
    await flush()
    expect(loops.getStatus(ws.id).auto_loop).toBe(true)
    gated.releaseStop()
    await flush()
    expect(gated.startCount()).toBe(2)
    expect(loops.getStatus(ws.id).auto_loop).toBe(true)
  })

  it.each(['resume', 'user-stop', 'capacity'] as const)(
    'settles a residual quota controller before retrying: %s',
    async (scenario) => {
      const { createWorkspace, createTask } = await import('../../server/services/workspace-service.js')
      const { getDb } = await import('../../server/db/index.js')
      const orch = await import('../../server/services/agent/orchestrator.js')
      const loops = await import('../../server/services/auto-loop-service.js')
      const quota = await import('../../server/services/quota-backoff-service.js')
      const ws = createWorkspace({ name: 'Quota', projectPath: '/tmp', sourceBranch: 'main', workingBranch: 'quota' })
      createTask(ws.id, { title: 'Pending' })
      orch.startAgent(ws.id, '/tmp', 'first')
      await flush()
      getDb()
        .prepare(
          "UPDATE workspaces SET auto_loop = 1, auto_loop_ready = 1, status = 'quota', worktree_path = ? WHERE id = ?",
        )
        .run(process.env.KOBO_HOME, ws.id)
      quota.arm(ws.id, 0, { resetsAt: null, source: 'fallback_ladder', reason: 'quota', retryCount: 2 })
      await flush()
      expect(orch.getAgentStatus(ws.id)).toBe('stopping')
      expect(gated.startCount()).toBe(1)
      // Repeated callbacks cannot arrange a second replacement.
      loops.onQuotaBackoffExpired(ws.id)
      let manualStop: Promise<unknown> | undefined
      let capacity: ReturnType<typeof vi.spyOn> | undefined
      let settings: ReturnType<typeof vi.spyOn> | undefined
      if (scenario === 'user-stop') manualStop = orch.stopAgentAndWait(ws.id)
      if (scenario === 'capacity') {
        const service = await import('../../server/services/settings-service.js')
        settings = vi.spyOn(service, 'getGlobalSettings').mockReturnValue({ maxConcurrentAgents: 1 } as never)
        capacity = vi.spyOn(orch, 'runningAgentCount').mockReturnValue(1)
      }
      try {
        gated.releaseStop()
        await manualStop
        await flush()
        expect(gated.startCount()).toBe(scenario === 'resume' ? 2 : 1)
        if (scenario === 'capacity') {
          capacity!.mockReturnValue(0)
          loops.resumeWaitingWorkspaces()
          loops.resumeWaitingWorkspaces()
          await flush()
          expect(gated.startCount()).toBe(2)
        }
        if (scenario === 'user-stop') expect(loops.getStatus(ws.id).auto_loop).toBe(false)
      } finally {
        capacity?.mockRestore()
        settings?.mockRestore()
      }
    },
  )

  it.each([false, true])(
    'keeps a durable retry after stop timeout, cancellable after late exit: %s',
    async (cancel) => {
      const { createWorkspace, createTask } = await import('../../server/services/workspace-service.js')
      const { getDb } = await import('../../server/db/index.js')
      const orch = await import('../../server/services/agent/orchestrator.js')
      const quota = await import('../../server/services/quota-backoff-service.js')
      const ws = createWorkspace({ name: 'Quota', projectPath: '/tmp', sourceBranch: 'main', workingBranch: 'quota' })
      createTask(ws.id, { title: 'Pending' })
      orch.startAgent(ws.id, '/tmp', 'first')
      await flush()
      getDb()
        .prepare(
          "UPDATE workspaces SET auto_loop = 1, auto_loop_ready = 1, status = 'quota', worktree_path = ? WHERE id = ?",
        )
        .run(process.env.KOBO_HOME, ws.id)
      vi.useFakeTimers()
      try {
        quota.arm(ws.id, 0, { resetsAt: null, source: 'fallback_ladder', reason: 'quota', retryCount: 3 })
        await vi.advanceTimersByTimeAsync(orch.STOP_AGENT_TIMEOUT_MS + 1)
        expect(orch.getAgentStatus(ws.id)).toBe('stopping')
        expect(gated.startCount()).toBe(1)
        expect(quota.getPending(ws.id)?.retryCount).toBe(3)
        gated.releaseStop()
        await vi.advanceTimersByTimeAsync(0)
        if (cancel) {
          await expect(orch.stopAgentAndWait(ws.id)).resolves.toBe('not-running')
          expect(quota.getPending(ws.id)).toBeNull()
        }
        await vi.advanceTimersByTimeAsync(20_000)
        expect(gated.startCount()).toBe(cancel ? 1 : 2)
      } finally {
        quota.cancel(ws.id, 'user')
        vi.useRealTimers()
      }
    },
  )

  it('preserves auto-loop when a deferred lifecycle callback is released during shutdown', async () => {
    const { createWorkspace, createTask } = await import('../../server/services/workspace-service.js')
    const { getDb } = await import('../../server/db/index.js')
    const orch = await import('../../server/services/agent/orchestrator.js')
    const loops = await import('../../server/services/auto-loop-service.js')
    const { withWorkspaceLifecycleGuard } = await import('../../server/utils/workspace-lifecycle-guard.js')
    const ws = createWorkspace({ name: 'Waiting', projectPath: '/tmp', sourceBranch: 'main', workingBranch: 'waiting' })
    createTask(ws.id, { title: 'Pending' })
    getDb()
      .prepare(
        "UPDATE workspaces SET auto_loop = 1, auto_loop_ready = 1, status = 'idle', worktree_path = ? WHERE id = ?",
      )
      .run(process.env.KOBO_HOME, ws.id)
    let release!: () => void
    const operation = withWorkspaceLifecycleGuard(
      ws.id,
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
    )
    try {
      loops.resumeWaitingWorkspaces()
      expect(gated.startCount()).toBe(0)
      await orch.stopAllAgents()
    } finally {
      release()
      await operation
    }
    await flush()
    expect(loops.getStatus(ws.id).auto_loop).toBe(true)
    expect(gated.startCount()).toBe(0)
    // A separate late ready notification reaches spawnNextIteration directly.
    loops.onAutoLoopReadySet(ws.id)
    expect(loops.getStatus(ws.id).auto_loop).toBe(true)
    expect(gated.startCount()).toBe(0)
  })

  it('can recover on reboot when shutdown interrupts a residual quota stop', async () => {
    const { createWorkspace, createTask } = await import('../../server/services/workspace-service.js')
    const { getDb, closeDb } = await import('../../server/db/index.js')
    const orch = await import('../../server/services/agent/orchestrator.js')
    const quota = await import('../../server/services/quota-backoff-service.js')
    const ws = createWorkspace({ name: 'Quota', projectPath: '/tmp', sourceBranch: 'main', workingBranch: 'quota' })
    createTask(ws.id, { title: 'Pending' })
    orch.startAgent(ws.id, '/tmp', 'first')
    await flush()
    getDb()
      .prepare(
        "UPDATE workspaces SET auto_loop = 1, auto_loop_ready = 1, status = 'quota', worktree_path = ? WHERE id = ?",
      )
      .run(process.env.KOBO_HOME, ws.id)
    const dbPath = getDb().name
    vi.useFakeTimers()
    try {
      quota.arm(ws.id, 0, { resetsAt: null, source: 'fallback_ladder', reason: 'quota', retryCount: 4 })
      await vi.advanceTimersByTimeAsync(0)
      const shutdown = orch.stopAllAgents()
      await vi.advanceTimersByTimeAsync(3_000)
      await shutdown
      expect(orch.getAgentStatus(ws.id)).toBe('stopping')
      expect(quota.getPending(ws.id)?.retryCount).toBe(4)
      // Finish the test double before simulating a new process with freshly imported services.
      gated.releaseStop()
      await vi.advanceTimersByTimeAsync(0)
      closeDb()
      vi.resetModules()
      const freshDb = await import('../../server/db/index.js')
      freshDb.getDb(dbPath)
      const registry = await import('../../server/services/agent/engines/registry.js')
      registry._registerEngineForTest(gated.engine)
      const freshOrch = await import('../../server/services/agent/orchestrator.js')
      const freshQuota = await import('../../server/services/quota-backoff-service.js')
      const freshLoops = await import('../../server/services/auto-loop-service.js')
      freshOrch.restoreRetryCountsFromDb()
      freshQuota.restoreOnBoot(freshLoops.onQuotaBackoffExpired)
      await vi.advanceTimersByTimeAsync(20_000)
      expect(gated.startCount()).toBe(2)
      expect(freshOrch._getRetryCounts().get(ws.id)).toBe(4)
      expect(freshLoops.getStatus(ws.id).auto_loop).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('preserves scheduled rows and auto-loop intent throughout shutdown, including late arms', async () => {
    const { createWorkspace } = await import('../../server/services/workspace-service.js')
    const { getDb } = await import('../../server/db/index.js')
    const orch = await import('../../server/services/agent/orchestrator.js')
    const quota = await import('../../server/services/quota-backoff-service.js')
    const wakeup = await import('../../server/services/wakeup-service.js')
    const cron = await import('../../server/services/cron-service.js')
    const loops = await import('../../server/services/auto-loop-service.js')
    const live = createWorkspace({ name: 'Live', projectPath: '/tmp', sourceBranch: 'main', workingBranch: 'live' })
    const waiting = createWorkspace({
      name: 'Waiting',
      projectPath: '/tmp',
      sourceBranch: 'main',
      workingBranch: 'waiting',
    })
    orch.startAgent(live.id, '/tmp', 'first')
    await flush()
    getDb().prepare("UPDATE workspaces SET auto_loop = 1, auto_loop_ready = 1, status = 'quota'").run()
    vi.useFakeTimers()
    try {
      for (const id of [live.id, waiting.id]) {
        quota.arm(id, 10, { resetsAt: null, source: 'fallback_ladder', reason: 'quota', retryCount: 2 })
        wakeup.schedule(id, 60, 'Wake later', undefined)
        cron.arm(id, { expression: '* * * * *', prompt: 'Cron later', oneShot: true })
      }
      const before = getDb().prepare('SELECT * FROM pending_quota_backoffs ORDER BY workspace_id').all()
      const shutdown = orch.stopAllAgents()
      await vi.advanceTimersByTimeAsync(20)
      expect(getDb().prepare('SELECT * FROM pending_quota_backoffs ORDER BY workspace_id').all()).toEqual(before)
      gated.releaseStop()
      await shutdown
      // An already-running hook/request can persist a new schedule after suspension.
      quota.arm(waiting.id, 10, { resetsAt: null, source: 'fallback_ladder', reason: 'quota', retryCount: 3 })
      wakeup.schedule(waiting.id, 60, 'Late wake', undefined)
      cron.arm(waiting.id, { expression: '* * * * *', prompt: 'Late cron', oneShot: true })
      const wakes = getDb().prepare('SELECT * FROM pending_wakeups ORDER BY workspace_id').all()
      const crons = getDb().prepare('SELECT * FROM pending_crons ORDER BY id').all()
      await vi.advanceTimersByTimeAsync(120_000)
      expect(quota.getPending(waiting.id)?.retryCount).toBe(3)
      expect(getDb().prepare('SELECT * FROM pending_wakeups ORDER BY workspace_id').all()).toEqual(wakes)
      expect(getDb().prepare('SELECT * FROM pending_crons ORDER BY id').all()).toEqual(crons)
      expect(loops.getStatus(waiting.id).auto_loop).toBe(true)
      expect(loops.getStatus(live.id).auto_loop).toBe(true)
      expect(gated.startCount()).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('preserves auto-loop when the backend shuts down', async () => {
    const { createWorkspace } = await import('../../server/services/workspace-service.js')
    const { getDb } = await import('../../server/db/index.js')
    const orch = await import('../../server/services/agent/orchestrator.js')
    const loops = await import('../../server/services/auto-loop-service.js')
    const ws = createWorkspace({
      name: 'Loop',
      projectPath: '/tmp',
      sourceBranch: 'develop',
      workingBranch: 'feature/shutdown-loop',
    })
    getDb().prepare('UPDATE workspaces SET auto_loop = 1 WHERE id = ?').run(ws.id)
    orch.startAgent(ws.id, '/tmp', 'first')
    await flush()
    const shutdown = orch.stopAllAgents()
    await flush()
    gated.releaseStop()
    await shutdown
    expect(loops.getStatus(ws.id).auto_loop).toBe(true)
  })

  it('cancels a pending replacement on shutdown after the predecessor leaves the controller map', async () => {
    const { createWorkspace } = await import('../../server/services/workspace-service.js')
    const { getDb } = await import('../../server/db/index.js')
    const orch = await import('../../server/services/agent/orchestrator.js')
    const ws = createWorkspace({
      name: 'W',
      projectPath: '/tmp',
      sourceBranch: 'develop',
      workingBranch: 'feature/shutdown-replacement',
    })
    orch.startAgent(ws.id, '/tmp', 'first')
    await flush()
    getDb().prepare("UPDATE workspaces SET status = 'idle' WHERE id = ?").run(ws.id)
    const replacement = orch.startAgent(ws.id, '/tmp', 'replacement')
    await flush()
    gated.releaseStop()
    // Stop in the real microtask window between the predecessor's removal
    // and the replacement's continuation, without editing either registry.
    for (let turn = 0; orch.hasController(ws.id) && turn < 30; turn++) await Promise.resolve()
    expect(orch.hasController(ws.id)).toBe(false)
    expect(gated.startCount()).toBe(1)

    await orch.stopAllAgents()
    await flush()

    expect(gated.startCount()).toBe(1)
    expect(orch.hasController(ws.id)).toBe(false)
    expect(
      getDb().prepare('SELECT end_reason FROM agent_sessions WHERE id = ?').get(replacement.agentSessionId),
    ).toEqual({ end_reason: 'killed' })
  })

  it('rejects new starts once shutdown has begun', async () => {
    const { createWorkspace } = await import('../../server/services/workspace-service.js')
    const orch = await import('../../server/services/agent/orchestrator.js')
    const ws = createWorkspace({
      name: 'W',
      projectPath: '/tmp',
      sourceBranch: 'develop',
      workingBranch: 'feature/no-start-after-shutdown',
    })
    await orch.stopAllAgents()

    expect(() => orch.startAgent(ws.id, '/tmp', 'late request')).toThrow(/shutting down/)
    expect(orch.hasController(ws.id)).toBe(false)
    expect(gated.startCount()).toBe(0)
  })

  it('reports not-running when no controller exists', async () => {
    const { createWorkspace } = await import('../../server/services/workspace-service.js')
    const ws = createWorkspace({
      name: 'W',
      projectPath: '/tmp',
      sourceBranch: 'develop',
      workingBranch: 'feature/none',
    })
    const orch = await import('../../server/services/agent/orchestrator.js')

    await expect(orch.stopAgentAndWait(ws.id)).resolves.toBe('not-running')
  })

  it('serializes the liveness of a running controller, with its last event time', async () => {
    const { createWorkspace } = await import('../../server/services/workspace-service.js')
    const ws = createWorkspace({
      name: 'W',
      projectPath: '/tmp',
      sourceBranch: 'develop',
      workingBranch: 'feature/liveness',
    })
    const orch = await import('../../server/services/agent/orchestrator.js')

    const { agentSessionId } = orch.startAgent(ws.id, '/tmp', 'hi')
    await flush()

    const liveness = orch.getAgentLiveness(ws.id)
    expect(liveness).not.toBeNull()
    expect(liveness?.status).toBe('running')
    expect(liveness?.agentSessionId).toBe(agentSessionId)
    expect(Number.isNaN(Date.parse(liveness?.startedAt ?? ''))).toBe(false)
    expect(Number.isNaN(Date.parse(liveness?.lastEventAt ?? ''))).toBe(false)

    expect(orch.getAllAgentLiveness()[ws.id]).toEqual(liveness)
  })

  it('reports no liveness at all for a workspace without a controller', async () => {
    const { createWorkspace } = await import('../../server/services/workspace-service.js')
    const ws = createWorkspace({
      name: 'W',
      projectPath: '/tmp',
      sourceBranch: 'develop',
      workingBranch: 'feature/no-liveness',
    })
    const orch = await import('../../server/services/agent/orchestrator.js')

    // This is exactly the F05 shape: the column says busy, memory says nothing.
    expect(orch.getAgentLiveness(ws.id)).toBeNull()
    expect(orch.getAllAgentLiveness()).toEqual({})
  })
})

describe('Orchestrator — stopping window suppresses revive side effects', () => {
  let gated: ReturnType<typeof makeGatedEngine>

  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    await resetDb()
    gated = makeGatedEngine()
    const { _registerEngineForTest } = await import('../../server/services/agent/engines/registry.js')
    _registerEngineForTest(gated.engine)
  })

  /** Start an agent, ask it to stop, and wait until its controller is registered in `stopping` state. */
  async function startAndBeginStopping(workspaceId: string): Promise<{
    agentSessionId: string
    stopped: ReturnType<typeof import('../../server/services/agent/orchestrator.js')['stopAgentAndWait']>
  }> {
    const orch = await import('../../server/services/agent/orchestrator.js')
    const { agentSessionId } = orch.startAgent(workspaceId, '/tmp', 'hi')
    await flush()
    const stopped = orch.stopAgentAndWait(workspaceId)
    await flush()
    expect(orch.getAgentStatus(workspaceId)).toBe('stopping')
    return { agentSessionId, stopped }
  }

  it('suppresses a legacy ScheduleWakeup re-arm while the controller is stopping, but still routes the event', async () => {
    const { createWorkspace } = await import('../../server/services/workspace-service.js')
    const wakeup = await import('../../server/services/wakeup-service.js')
    const websocket = await import('../../server/services/websocket-service.js')
    const scheduleSpy = vi.spyOn(wakeup, 'schedule').mockImplementation(() => undefined)
    const ws = createWorkspace({
      name: 'W',
      projectPath: '/tmp',
      sourceBranch: 'develop',
      workingBranch: 'feature/guard-wakeup',
    })
    const orch = await import('../../server/services/agent/orchestrator.js')
    const { agentSessionId, stopped } = await startAndBeginStopping(ws.id)

    const event: AgentEvent = {
      kind: 'tool:call',
      messageId: 'm1',
      toolCallId: 'c1',
      name: 'ScheduleWakeup',
      input: { delaySeconds: 60, prompt: 'resume', reason: 'CI' },
    }
    orch.__test__.handleEvent(ws.id, agentSessionId, event)

    expect(scheduleSpy).not.toHaveBeenCalled()
    expect(websocket.emit).toHaveBeenCalledWith(ws.id, 'agent:event', event, agentSessionId)

    gated.releaseStop()
    await stopped
  })

  it('suppresses a native CronCreate mirror while the controller is stopping, but still routes the event', async () => {
    const { createWorkspace } = await import('../../server/services/workspace-service.js')
    const cron = await import('../../server/services/cron-service.js')
    const websocket = await import('../../server/services/websocket-service.js')
    const armSpy = vi.spyOn(cron, 'arm').mockReturnValue({
      id: 'fake-cron',
      workspaceId: 'ws',
      expression: '*/5 * * * *',
      prompt: 'check',
      label: null,
      agentSessionId: null,
      nextFireAt: new Date().toISOString(),
      lastFiredAt: null,
      oneShot: false,
      createdAt: new Date().toISOString(),
    })
    const ws = createWorkspace({
      name: 'W',
      projectPath: '/tmp',
      sourceBranch: 'develop',
      workingBranch: 'feature/guard-cron',
    })
    const orch = await import('../../server/services/agent/orchestrator.js')
    const { agentSessionId, stopped } = await startAndBeginStopping(ws.id)

    const event: AgentEvent = {
      kind: 'tool:call',
      messageId: 'm1',
      toolCallId: 'c1',
      name: 'CronCreate',
      input: { prompt: 'check', cron: '*/5 * * * *' },
    }
    orch.__test__.handleEvent(ws.id, agentSessionId, event)

    expect(armSpy).not.toHaveBeenCalled()
    expect(websocket.emit).toHaveBeenCalledWith(ws.id, 'agent:event', event, agentSessionId)

    gated.releaseStop()
    await stopped
  })

  it('suppresses the quota backoff arm on an error/quota event while the controller is stopping, but still routes it', async () => {
    const { createWorkspace, updateWorkspaceStatus } = await import('../../server/services/workspace-service.js')
    const quotaBackoff = await import('../../server/services/quota-backoff-service.js')
    const websocket = await import('../../server/services/websocket-service.js')
    const armSpy = vi.spyOn(quotaBackoff, 'arm').mockImplementation(() => undefined)
    const ws = createWorkspace({
      name: 'W',
      projectPath: '/tmp',
      sourceBranch: 'develop',
      workingBranch: 'feature/guard-quota',
    })
    // Reach `executing` so the (guarded) handleQuota's internal
    // updateWorkspaceStatus(..., 'quota') would be a *valid* transition —
    // otherwise a rejected transition masks whether the guard did anything.
    updateWorkspaceStatus(ws.id, 'brainstorming')
    updateWorkspaceStatus(ws.id, 'executing')
    const orch = await import('../../server/services/agent/orchestrator.js')
    const { agentSessionId, stopped } = await startAndBeginStopping(ws.id)

    const event: AgentEvent = {
      kind: 'error',
      category: 'quota',
      message: 'quota exceeded',
    }
    orch.__test__.handleEvent(ws.id, agentSessionId, event)
    // handleQuota is invoked fire-and-forget (`void handleQuota(...)`) and
    // awaits computeQuotaBackoffMs before arming — let it settle.
    await flush()

    expect(armSpy).not.toHaveBeenCalled()
    expect(websocket.emit).toHaveBeenCalledWith(ws.id, 'agent:event', event, agentSessionId)

    gated.releaseStop()
    await stopped
  })

  it('suppresses the transient auto-loop retry arm on error/other while the controller is stopping, but still routes it', async () => {
    const { createWorkspace, updateWorkspaceStatus } = await import('../../server/services/workspace-service.js')
    const { getDb } = await import('../../server/db/index.js')
    const quotaBackoff = await import('../../server/services/quota-backoff-service.js')
    const websocket = await import('../../server/services/websocket-service.js')
    const armSpy = vi.spyOn(quotaBackoff, 'arm').mockImplementation(() => undefined)
    const ws = createWorkspace({
      name: 'W',
      projectPath: '/tmp',
      sourceBranch: 'develop',
      workingBranch: 'feature/guard-transient',
    })
    getDb().prepare('UPDATE workspaces SET auto_loop = 1 WHERE id = ?').run(ws.id)
    updateWorkspaceStatus(ws.id, 'brainstorming')
    updateWorkspaceStatus(ws.id, 'executing')
    const orch = await import('../../server/services/agent/orchestrator.js')
    const { agentSessionId, stopped } = await startAndBeginStopping(ws.id)

    const event: AgentEvent = {
      kind: 'error',
      category: 'other',
      message: 'Internal Server Error (HTTP 500)',
    }
    orch.__test__.handleEvent(ws.id, agentSessionId, event)
    // handleTransientAutoLoopFailure is also fire-and-forget — let it settle.
    await flush()

    expect(armSpy).not.toHaveBeenCalled()
    expect(websocket.emit).toHaveBeenCalledWith(ws.id, 'agent:event', event, agentSessionId)

    gated.releaseStop()
    await stopped
  })

  it('suppresses the watchdog-recovery retry arm on a session:ended(watchdog) while the controller is stopping, but still routes it', async () => {
    // A Claude-engine drain watchdog can force session:ended(reason: 'watchdog')
    // while stopController's own stop() is still in flight — `userInterrupted`
    // is only set by interrupt(), not by stop() (claude-code engine). Re-arming
    // a retry here would resurrect a session the user just told to stop.
    const { createWorkspace, updateWorkspaceStatus } = await import('../../server/services/workspace-service.js')
    const { getDb } = await import('../../server/db/index.js')
    const quotaBackoff = await import('../../server/services/quota-backoff-service.js')
    const websocket = await import('../../server/services/websocket-service.js')
    const armSpy = vi.spyOn(quotaBackoff, 'arm').mockImplementation(() => undefined)
    const ws = createWorkspace({
      name: 'W',
      projectPath: '/tmp',
      sourceBranch: 'develop',
      workingBranch: 'feature/guard-watchdog-recovery',
    })
    getDb().prepare('UPDATE workspaces SET auto_loop = 1 WHERE id = ?').run(ws.id)
    updateWorkspaceStatus(ws.id, 'brainstorming')
    updateWorkspaceStatus(ws.id, 'executing')
    const orch = await import('../../server/services/agent/orchestrator.js')
    const { agentSessionId, stopped } = await startAndBeginStopping(ws.id)

    const event: AgentEvent = {
      kind: 'session:ended',
      reason: 'watchdog',
      exitCode: null,
    }
    orch.__test__.handleEvent(ws.id, agentSessionId, event)
    await flush()

    expect(armSpy).not.toHaveBeenCalled()
    expect(websocket.emit).toHaveBeenCalledWith(ws.id, 'agent:event', event, agentSessionId)

    gated.releaseStop()
    await stopped
  })

  it('does not re-open awaiting-user on session:user-input-requested while the controller is stopping, but still routes it', async () => {
    const { createWorkspace, getWorkspace, updateWorkspaceStatus } = await import(
      '../../server/services/workspace-service.js'
    )
    const websocket = await import('../../server/services/websocket-service.js')
    const ws = createWorkspace({
      name: 'W',
      projectPath: '/tmp',
      sourceBranch: 'develop',
      workingBranch: 'feature/guard-user-input',
    })
    // Reach `executing` so `awaiting-user` would be a *valid* transition —
    // otherwise a rejected transition masks whether the guard did anything.
    updateWorkspaceStatus(ws.id, 'brainstorming')
    updateWorkspaceStatus(ws.id, 'executing')
    const orch = await import('../../server/services/agent/orchestrator.js')
    const { agentSessionId, stopped } = await startAndBeginStopping(ws.id)
    const statusBeforeEvent = getWorkspace(ws.id)?.status

    const event: AgentEvent = {
      kind: 'session:user-input-requested',
      requestKind: 'question',
      toolCallId: 'c1',
      toolName: 'AskUserQuestion',
      payload: { questions: [] },
    }
    orch.__test__.handleEvent(ws.id, agentSessionId, event)

    expect(getWorkspace(ws.id)?.status).toBe(statusBeforeEvent)
    expect(getWorkspace(ws.id)?.status).not.toBe('awaiting-user')
    // The whole branch is skipped, not just the status transition — no
    // question/permission should be enqueued for a controller that's stopping.
    expect(orch._getPendingQueue().get(ws.id) ?? []).toHaveLength(0)
    expect(websocket.emit).toHaveBeenCalledWith(ws.id, 'agent:event', event, agentSessionId)

    gated.releaseStop()
    await stopped
  })

  it('does not bounce a workspace back to executing on session:started while the controller is stopping, but still routes it', async () => {
    const { createWorkspace, getWorkspace } = await import('../../server/services/workspace-service.js')
    const { getDb } = await import('../../server/db/index.js')
    const websocket = await import('../../server/services/websocket-service.js')
    const ws = createWorkspace({
      name: 'W',
      projectPath: '/tmp',
      sourceBranch: 'develop',
      workingBranch: 'feature/guard-session-started',
    })
    const orch = await import('../../server/services/agent/orchestrator.js')
    const { agentSessionId, stopped } = await startAndBeginStopping(ws.id)

    // stopController normalizes awaiting-user -> idle synchronously; simulate
    // that end state directly so the late session:started has a terminal
    // status to (wrongly) bounce out of.
    getDb().prepare("UPDATE workspaces SET status = 'idle' WHERE id = ?").run(ws.id)

    const event: AgentEvent = {
      kind: 'session:started',
      engineSessionId: 'late-session',
    }
    orch.__test__.handleEvent(ws.id, agentSessionId, event)

    expect(getWorkspace(ws.id)?.status).toBe('idle')
    // Only the status-bounce is guarded — recording what the engine actually
    // reported is bookkeeping, not a revive side effect, and must stay
    // unconditional.
    expect(orch._getSessionIds().get(ws.id)).toBe('late-session')
    const row = getDb().prepare('SELECT engine_session_id FROM agent_sessions WHERE id = ?').get(agentSessionId) as {
      engine_session_id: string | null
    }
    expect(row.engine_session_id).toBe('late-session')
    expect(websocket.emit).toHaveBeenCalledWith(ws.id, 'agent:event', event, agentSessionId)

    gated.releaseStop()
    await stopped
  })

  it('does not bounce a workspace back to executing on session:brainstorm-complete while the controller is stopping, but still routes it', async () => {
    const { createWorkspace, getWorkspace } = await import('../../server/services/workspace-service.js')
    const { getDb } = await import('../../server/db/index.js')
    const websocket = await import('../../server/services/websocket-service.js')
    const ws = createWorkspace({
      name: 'W',
      projectPath: '/tmp',
      sourceBranch: 'develop',
      workingBranch: 'feature/guard-brainstorm-complete',
    })
    const orch = await import('../../server/services/agent/orchestrator.js')
    const { agentSessionId, stopped } = await startAndBeginStopping(ws.id)

    // stopController normalizes awaiting-user -> idle synchronously; simulate
    // that end state directly so the late [BRAINSTORM_COMPLETE] marker has a
    // non-executing status to (wrongly) bounce out of.
    getDb().prepare("UPDATE workspaces SET status = 'idle' WHERE id = ?").run(ws.id)

    const event: AgentEvent = {
      kind: 'session:brainstorm-complete',
    }
    orch.__test__.handleEvent(ws.id, agentSessionId, event)

    expect(getWorkspace(ws.id)?.status).toBe('idle')
    expect(websocket.emit).toHaveBeenCalledWith(ws.id, 'agent:event', event, agentSessionId)

    gated.releaseStop()
    await stopped
  })
})

describe('Orchestrator — watchdog respects the stopping window', () => {
  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    await resetDb()
  })

  it('does not evict or error a stopping controller whose death probe already reports dead', async () => {
    const { createWorkspace, getWorkspace } = await import('../../server/services/workspace-service.js')
    const websocket = await import('../../server/services/websocket-service.js')
    const { _registerEngineForTest } = await import('../../server/services/agent/engines/registry.js')

    let resolveStop: (() => void) | undefined
    const engine: AgentEngine = {
      id: 'claude-code',
      displayName: 'Claude Code',
      capabilities: {
        models: [{ id: 'auto', label: 'Auto' }],
        permissionModes: ['bypass'],
        supportsResume: true,
        supportsMcp: true,
        supportsSkills: true,
        supportsSubagents: false,
        supportsQuotaStatus: false,
      },
      async start() {
        return {
          pid: undefined,
          engineSessionId: undefined,
          // The engine's own iterator has already closed by the time the
          // watchdog sweeps — an honest, slow-but-successful voluntary stop,
          // well within STOP_AGENT_TIMEOUT_MS, is exactly what this regression
          // test guards.
          isAlive: () => false,
          sendMessage() {},
          interrupt() {},
          stop() {
            return new Promise<void>((resolve) => {
              resolveStop = resolve
            })
          },
          resolvePendingUserInput: () => false,
        }
      },
    }
    _registerEngineForTest(engine)

    const ws = createWorkspace({
      name: 'W',
      projectPath: '/tmp',
      sourceBranch: 'develop',
      workingBranch: 'feature/watchdog-stopping',
    })
    const orch = await import('../../server/services/agent/orchestrator.js')

    orch.startAgent(ws.id, '/tmp', 'hi')
    await flush()
    expect(orch.getAgentStatus(ws.id)).toBe('running')

    const stopped = orch.stopAgentAndWait(ws.id)
    await flush()
    expect(orch.getAgentStatus(ws.id)).toBe('stopping')

    orch._runWatchdogForTest()

    // Before D1 this controller could never be seen by the watchdog while
    // stopping (it was removed from `controllers` up-front). Now that it
    // survives the whole stop, the watchdog must explicitly skip it — its
    // death is already governed by stopController's own bounded deadline.
    expect(orch.hasController(ws.id)).toBe(true)
    expect(orch.getAgentStatus(ws.id)).toBe('stopping')
    expect(getWorkspace(ws.id)?.status).not.toBe('error')
    expect(websocket.emit).not.toHaveBeenCalled()

    resolveStop?.()
    await expect(stopped).resolves.toBe('stopped')
  })
})
