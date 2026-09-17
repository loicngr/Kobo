import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest'
import type { AgentEngine, AgentEvent } from '../server/services/agent/engines/types.js'

vi.mock('../server/services/websocket-service.js', () => ({ emit: vi.fn(), emitEphemeral: vi.fn() }))
vi.mock('../server/services/lifecycle-hook-service.js', () => ({
  onSessionEnded: vi.fn(async () => {}),
  onAutoLoopDisabled: vi.fn(async () => {}),
}))
vi.mock('../server/services/cleanup-script-service.js', () => ({
  onSessionEnded: vi.fn(),
  onAutoLoopCompleted: vi.fn(),
}))
vi.mock('../server/services/forge/resolve.js', () => ({ resolveForge: () => 'none' }))
vi.mock('../server/services/usage/poller.js', () => ({ refreshNow: vi.fn().mockResolvedValue(null) }))
vi.mock('../server/services/settings-service.js', () => ({
  getGlobalSettings: () => ({
    autoLoopMaxRetries: 5,
    maxConcurrentAgents: 0,
    skillSuite: 'superpowers',
    worktreesPath: '',
    worktreesPrefixByProject: false,
  }),
  getEffectiveSettings: () => ({
    model: 'auto',
    dangerouslySkipPermissions: true,
    prPromptTemplate: '',
    gitConventions: '',
    sourceBranch: 'main',
    devServer: null,
    setupScript: '',
    notionStatusProperty: '',
    notionInProgressStatus: '',
  }),
  getProjectSettings: () => null,
  getEffectiveFinalization: () => ({}),
}))
let id: string
let orch: typeof import('../server/services/agent/orchestrator.js')
let loop: typeof import('../server/services/auto-loop-service.js')
let quota: typeof import('../server/services/quota-backoff-service.js')
let db: ReturnType<typeof import('../server/db/index.js')['getDb']>
let starts: Mock<AgentEngine['start']>
let emitter: (event: AgentEvent) => void
beforeEach(async () => {
  vi.resetModules()
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-17T10:00:00Z'))
  const { resetDb } = await import('./helpers/reset-db.js')
  await resetDb()
  const { getDb } = await import('../server/db/index.js')
  db = getDb()
  const { createWorkspace, createTask } = await import('../server/services/workspace-service.js')
  id = createWorkspace({ name: 'audit', projectPath: '/tmp', sourceBranch: 'main', workingBranch: 'audit' }).id
  createTask(id, { title: 'unfinished', isAcceptanceCriterion: false, sortOrder: 0 })
  db.prepare(
    "UPDATE workspaces SET auto_loop=1,auto_loop_ready=1,status='executing',worktree_path='/tmp' WHERE id=?",
  ).run(id)
  const { _registerEngineForTest } = await import('../server/services/agent/engines/registry.js')
  starts = vi.fn<AgentEngine['start']>(async (_opts, onEvent) => {
    emitter = onEvent
    return {
      pid: undefined,
      engineSessionId: 'audit-engine',
      isAlive: () => false,
      sendMessage() {},
      interrupt() {},
      async stop() {},
      resolvePendingUserInput: () => false,
    }
  })
  _registerEngineForTest({
    id: 'claude-code',
    displayName: 'Audit fake',
    capabilities: {
      models: [],
      permissionModes: ['bypass'],
      supportsResume: true,
      supportsMcp: true,
      supportsSkills: true,
      supportsSubagents: false,
      supportsQuotaStatus: false,
    },
    start: starts,
  })
  orch = await import('../server/services/agent/orchestrator.js')
  loop = await import('../server/services/auto-loop-service.js')
  quota = await import('../server/services/quota-backoff-service.js')
})
afterEach(async () => {
  vi.clearAllTimers()
  vi.useRealTimers()
  const { closeDb } = await import('../server/db/index.js')
  closeDb()
})
async function flush() {
  for (let i = 0; i < 12; i++) await Promise.resolve()
}
describe('auto-loop recovery integration', () => {
  it.each(['per_task', 'continuous'])(
    'keeps successful instruction intake outside the stagnation budget in %s mode',
    async (mode) => {
      const { createTask } = await import('../server/services/workspace-service.js')
      db.prepare('UPDATE workspaces SET auto_loop_session_mode=? WHERE id=?').run(mode, id)
      loop.queueInstruction(id, 'Add requirement 1', 'intake-1')
      await flush()
      const firstSession = orch._getControllers().get(id)!.agentSessionId

      for (let n = 1; n <= 6; n++) {
        expect(starts.mock.lastCall?.[0].prompt).toContain('integrate user instructions')
        emitter({ kind: 'session:started', engineSessionId: 'audit-engine' })
        if (mode === 'continuous') expect(orch._getControllers().get(id)!.agentSessionId).toBe(firstSession)
        createTask(id, { title: `Requirement ${n}` })
        if (n < 6) loop.queueInstruction(id, `Add requirement ${n + 1}`, `intake-${n + 1}`)
        emitter({ kind: 'session:ended', reason: 'completed', exitCode: 0 })
        await flush()
        expect(loop.getStatus(id)).toMatchObject({ state: 'active', no_progress_streak: 0, diagnostic_attempts: 0 })
      }

      expect(starts).toHaveBeenCalledTimes(7)
      expect(starts.mock.lastCall?.[0].prompt).not.toContain('integrate user instructions')
      // Delivered instructions on a reused session must not exempt subsequent work.
      emitter({ kind: 'session:ended', reason: 'completed', exitCode: 0 })
      await flush()
      expect(loop.getStatus(id).no_progress_streak).toBe(1)
    },
  )

  it.each([0, 2])('preserves %i diagnostic attempts during instruction intake', async (attempts) => {
    const { setRuntime } = await import('../server/services/auto-loop-state-service.js')
    const { createTask } = await import('../server/services/workspace-service.js')
    db.prepare('UPDATE workspaces SET no_progress_streak=3 WHERE id=?').run(id)
    setRuntime(id, { diagnostic_attempts: attempts })
    loop.queueInstruction(id, 'Add a requirement before continuing', 'diagnostic-intake')
    await flush()
    expect(starts.mock.lastCall?.[0].prompt).toContain('integrate user instructions')
    expect(loop.getStatus(id).diagnostic_attempts).toBe(attempts)

    createTask(id, { title: 'Added requirement' })
    emitter({ kind: 'session:ended', reason: 'completed', exitCode: 0 })
    await flush()
    expect(loop.getStatus(id)).toMatchObject({
      state: 'active',
      no_progress_streak: 3,
      diagnostic_attempts: attempts + 1,
    })
    if (attempts === 0) expect(starts.mock.lastCall?.[0].prompt).toContain('[Kōbō auto-loop — diagnostic]')

    // Only actual work attempts consume the remaining bounded recovery budget.
    for (let n = attempts; n < 3; n++) {
      emitter({ kind: 'session:ended', reason: 'completed', exitCode: 0 })
      await flush()
    }
    expect(loop.getStatus(id)).toMatchObject({ auto_loop: true, state: 'blocked' })
  })

  it.each(['wakeup', 'cron'])('releases a planned %s after a manual workspace quota expires', async (schedule) => {
    db.prepare("UPDATE workspaces SET auto_loop=0,status='quota' WHERE id=?").run(id)
    quota.arm(id, 120_000, { resetsAt: null, source: 'fallback_ladder', reason: 'quota', retryCount: 1 })
    const prompt = 'Resume the explicitly scheduled work'
    if (schedule === 'wakeup') {
      const wakeup = await import('../server/services/wakeup-service.js')
      wakeup.schedule(id, 60, prompt, undefined)
    } else {
      const cron = await import('../server/services/cron-service.js')
      cron.arm(id, { expression: '* * * * *', prompt })
    }

    await vi.advanceTimersByTimeAsync(119_999)
    expect(starts).not.toHaveBeenCalled()
    expect(quota.getPending(id)).not.toBeNull()
    await vi.advanceTimersByTimeAsync(15_001)
    expect(quota.getPending(id)).toBeNull()
    expect(starts).toHaveBeenCalledTimes(1)
    expect(starts.mock.lastCall?.[0].prompt).toContain(prompt)
    expect(loop.getStatus(id).auto_loop).toBe(false)
  })

  it('does not start a manual workspace merely because its quota expires', async () => {
    db.prepare("UPDATE workspaces SET auto_loop=0,status='quota' WHERE id=?").run(id)
    quota.arm(id, 60_000, { resetsAt: null, source: 'fallback_ladder', reason: 'quota', retryCount: 1 })
    await vi.advanceTimersByTimeAsync(60_001)
    expect(quota.getPending(id)).toBeNull()
    expect(starts).not.toHaveBeenCalled()
    expect(db.prepare('SELECT status FROM workspaces WHERE id=?').get(id)).toEqual({ status: 'quota' })
  })

  it.each([0, 4])(
    'charges one retry for a watchdog diagnostic and its terminal event after %i failures',
    async (previous) => {
      orch._getRetryCounts().set(id, previous)
      orch.startAgent(id, '/tmp', 'work')
      await flush()
      emitter({
        kind: 'error',
        category: 'other',
        message: 'Session force-ended: background subagents stopped reporting activity (watchdog).',
      })
      const firstBackoff = quota.getPending(id)
      emitter({ kind: 'session:ended', reason: 'watchdog', exitCode: null })
      await flush()
      expect(quota.getPending(id)).toEqual(firstBackoff)
      expect(quota.getPending(id)).toMatchObject({ reason: 'transient', retryCount: previous + 1 })
      expect(loop.getStatus(id).state).not.toBe('blocked')
    },
  )

  it('deduplicates repeated error surfaces and permits another incident after actual recovery', async () => {
    orch.startAgent(id, '/tmp', 'work')
    await flush()
    emitter({ kind: 'error', category: 'other', message: 'HTTP 500 Internal Server Error' })
    emitter({ kind: 'error', category: 'spawn_failed', message: 'HTTP 500 Internal Server Error' })
    expect(quota.getPending(id)).toMatchObject({ retryCount: 1 })
    emitter({ kind: 'tool:call', messageId: 'recovery-message', toolCallId: 'recovered-tool', name: 'Read', input: {} })
    expect(quota.getPending(id)).toBeNull()
    emitter({ kind: 'error', category: 'other', message: 'HTTP 502 Bad Gateway' })
    expect(quota.getPending(id)).toMatchObject({ reason: 'transient', retryCount: 1 })
  })
  it('marks in-flight instructions unknown when a technical replacement stops their session', async () => {
    starts.mockImplementationOnce(async (_options, onEvent) => {
      emitter = onEvent
      return {
        pid: undefined,
        engineSessionId: 'audit-engine',
        isAlive: () => true,
        sendMessage() {},
        interrupt() {},
        resolvePendingUserInput: () => false,
        async stop() {
          onEvent({ kind: 'session:ended', reason: 'killed', exitCode: null })
        },
      }
    })
    const messages = await import('../server/services/auto-loop-message-service.js')
    messages.enqueueLoopMessage(id, 'Preserve the API', 'technical-stop-instruction')
    messages.claimLoopMessages(id)
    const session = orch.startAgent(id, '/tmp', 'work')
    messages.bindLoopMessages(id, session.agentSessionId)
    await flush()
    await orch.stopAgentAndWait(id, undefined, 'replacement')
    expect(messages.listLoopMessages(id)).toEqual([expect.objectContaining({ state: 'unknown' })])
    expect(loop.getStatus(id)).toMatchObject({ state: 'blocked', reason: 'message-delivery-unknown' })
  })
  it('does not replay queued instructions after a transient failure leaves their delivery unknown', async () => {
    const messages = await import('../server/services/auto-loop-message-service.js')
    messages.enqueueLoopMessage(id, 'Keep the public API stable', 'instruction-1')
    messages.claimLoopMessages(id)
    const session = orch.startAgent(id, '/tmp', 'work with the instruction')
    messages.bindLoopMessages(id, session.agentSessionId)
    await flush()
    emitter({ kind: 'error', category: 'other', message: 'HTTP 500 Internal Server Error' })
    emitter({ kind: 'session:ended', reason: 'error', exitCode: null })
    await flush()
    expect(messages.listLoopMessages(id)).toEqual([expect.objectContaining({ state: 'unknown' })])
    expect(loop.getStatus(id)).toMatchObject({ state: 'blocked', reason: 'message-delivery-unknown' })
    expect(quota.getPending(id)).toBeNull()
    expect(starts).toHaveBeenCalledTimes(1)
  })
  it('visibly blocks an unconfirmed close without releasing ownership or restarting after late closure', async () => {
    let close!: () => void
    const closed = new Promise<void>((resolve) => {
      close = resolve
    })
    starts.mockImplementationOnce(async (_options, onEvent) => {
      emitter = onEvent
      return {
        pid: undefined,
        engineSessionId: 'audit-engine',
        closed,
        isAlive: () => true,
        sendMessage() {},
        interrupt() {},
        async stop() {},
        resolvePendingUserInput: () => false,
      }
    })
    orch.startAgent(id, '/tmp', 'work')
    await flush()
    emitter({ kind: 'session:ended', reason: 'watchdog', exitCode: null })
    await vi.advanceTimersByTimeAsync(orch.STOP_AGENT_TIMEOUT_MS)
    expect(loop.getStatus(id)).toMatchObject({ state: 'blocked', reason: 'engine-stop-unconfirmed', auto_loop: true })
    expect(orch.hasController(id)).toBe(true)
    close()
    await flush()
    expect(starts).toHaveBeenCalledTimes(1)
    expect(quota.getPending(id)).toBeNull()
  })
  it('treats HTTP 429 as quota even when surfaced as a generic SDK exception', async () => {
    starts.mockRejectedValueOnce(new Error('HTTP 429 Too Many Requests'))
    orch.startAgent(id, '/tmp', 'work')
    await flush()
    expect(loop.getStatus(id).auto_loop).toBe(true)
    expect(quota.getPending(id)).toMatchObject({ reason: 'quota' })
  })

  it('preserves loop intent as blocked when transient retries are exhausted', async () => {
    orch._getRetryCounts().set(id, 5)
    await orch._handleTransientAutoLoopFailure(id)
    expect(loop.getStatus(id)).toMatchObject({ auto_loop: true, state: 'blocked', reason: 'retry-exhausted' })
    expect(quota.getPending(id)).toBeNull()
  })
  it('retains ownership until the engine closes and handles one terminal event', async () => {
    let close!: () => void
    const closed = new Promise<void>((resolve) => {
      close = resolve
    })
    starts.mockImplementationOnce(async (_options, onEvent) => {
      emitter = onEvent
      return {
        pid: undefined,
        engineSessionId: 'audit-engine',
        closed,
        isAlive: () => true,
        sendMessage() {},
        interrupt() {},
        async stop() {},
        resolvePendingUserInput: () => false,
      }
    })
    const first = orch.startAgent(id, '/tmp', 'work')
    await flush()
    const firstEmitter = emitter
    firstEmitter({ kind: 'session:ended', reason: 'completed', exitCode: 0 })
    firstEmitter({ kind: 'session:ended', reason: 'completed', exitCode: 0 })
    await flush()
    expect(starts).toHaveBeenCalledTimes(1)
    expect(orch._getControllers().get(id)?.agentSessionId).toBe(first.agentSessionId)
    close()
    await flush()
    expect(starts).toHaveBeenCalledTimes(2)
    expect(loop.getStatus(id).no_progress_streak).toBe(1)
  })
  it('counts neither metadata touches nor a previously reached task milestone as progress', async () => {
    db.prepare('UPDATE workspaces SET auto_loop=0 WHERE id=?').run(id)
    const spy = vi.spyOn(loop, 'onSessionEnded')
    const task = db.prepare('SELECT id FROM tasks WHERE workspace_id=?').get(id) as { id: string }
    const statuses = ['pending', 'in_progress', 'pending', 'in_progress', 'done']
    const expected = [0, 1, 0, 0, 1]
    for (let n = 0; n < statuses.length; n++) {
      orch.startAgent(id, '/tmp', 'work')
      await flush()
      db.prepare('UPDATE tasks SET status=?,updated_at=? WHERE id=?').run(statuses[n], `updated-${n}`, task.id)
      emitter({ kind: 'session:ended', reason: 'completed', exitCode: 0 })
      await flush()
      expect(spy).toHaveBeenLastCalledWith(id, 'completed', expected[n], false)
    }
  })
  it('honors a known quota reset several days away', async () => {
    orch._test_setRateLimitInfo(id, { buckets: [{ id: 'weekly', usedPct: 100, resetsAt: '2026-09-20T10:00:00Z' }] })
    expect(await orch.computeQuotaBackoffMs(id, 0)).toMatchObject({
      delayMs: 3 * 24 * 3600000 + 30000,
      source: 'rate_limit_info',
    })
  })
  it('a genuine quota does not exhaust the transient failure budget', async () => {
    orch._getRetryCounts().set(id, 5)
    await orch._handleQuota(id)
    expect(loop.getStatus(id).auto_loop).toBe(true)
    expect(quota.getPending(id)).not.toBeNull()
  })

  it('control: recognized category-other HTTP 500 schedules durable retry', async () => {
    orch.startAgent(id, '/tmp', 'work')
    await flush()
    emitter({ kind: 'error', category: 'other', message: 'HTTP 500 Internal Server Error' })
    emitter({ kind: 'session:ended', reason: 'error', exitCode: null })
    await flush()
    expect(loop.getStatus(id).auto_loop).toBe(true)
    expect(quota.getPending(id)).toMatchObject({ reason: 'transient', retryCount: 1 })
  })
  it('control: explicit user stop disables the loop and cancels retry', async () => {
    orch.startAgent(id, '/tmp', 'work')
    await flush()
    quota.arm(id, 3600000, { resetsAt: null, source: 'fallback_ladder', reason: 'quota', retryCount: 1 })
    await orch.stopAgentAndWait(id)
    await vi.advanceTimersByTimeAsync(1)
    expect(loop.getStatus(id).auto_loop).toBe(false)
    expect(quota.getPending(id)).toBeNull()
    expect(orch.hasController(id)).toBe(false)
  })
  it('control: existing persisted quota backoff resumes after boot', async () => {
    db.prepare("UPDATE workspaces SET status='quota' WHERE id=?").run(id)
    quota.arm(id, 60000, { resetsAt: null, source: 'fallback_ladder', reason: 'quota', retryCount: 1 })
    quota.suspendForShutdown()
    orch.reconcileOrphanSessions()
    loop.rehydrate()
    orch.restoreRetryCountsFromDb()
    quota.restoreOnBoot((wid, p) => loop.onQuotaBackoffExpired(wid, p))
    await vi.advanceTimersByTimeAsync(60001)
    expect(starts).toHaveBeenCalledTimes(1)
    expect(loop.getStatus(id).auto_loop).toBe(true)
  })

  it('dead-engine watchdog schedules recovery for its own unfinished loop', async () => {
    orch.startAgent(id, '/tmp', 'work')
    await flush()
    orch._runWatchdogForTest()
    await vi.advanceTimersByTimeAsync(1)
    expect(loop.getStatus(id).auto_loop).toBe(true)
    expect(orch.hasController(id) || quota.getPending(id) !== null).toBe(true)
  })
  it('orphan quota state without a timer is recovered at boot', async () => {
    const poller = await import('../server/services/usage/poller.js')
    vi.mocked(poller.refreshNow).mockImplementationOnce(() => new Promise(() => {}))
    void orch._handleQuota(id)
    expect(db.prepare('SELECT status FROM workspaces WHERE id=?').get(id)).toEqual({ status: 'quota' })
    expect(quota.getPending(id)).not.toBeNull()
    orch.reconcileOrphanSessions()
    loop.rehydrate()
    orch.restoreRetryCountsFromDb()
    quota.restoreOnBoot((wid, p) => loop.onQuotaBackoffExpired(wid, p))
    await vi.advanceTimersByTimeAsync(1)
    expect(orch.hasController(id) || quota.getPending(id) !== null).toBe(true)
  })
  it('wakeup honors an active quota backoff', async () => {
    db.prepare("UPDATE workspaces SET status='quota' WHERE id=?").run(id)
    quota.arm(id, 3600000, { resetsAt: null, source: 'fallback_ladder', reason: 'quota', retryCount: 1 })
    const wakeup = await import('../server/services/wakeup-service.js')
    wakeup.schedule(id, 60, 'check background work', undefined)
    await vi.advanceTimersByTimeAsync(60001)
    expect(starts).not.toHaveBeenCalled()
  })
  it('cron honors an active quota backoff', async () => {
    db.prepare("UPDATE workspaces SET status='quota' WHERE id=?").run(id)
    quota.arm(id, 3600000, { resetsAt: null, source: 'fallback_ladder', reason: 'quota', retryCount: 1 })
    const cron = await import('../server/services/cron-service.js')
    cron.arm(id, { expression: '* * * * *', prompt: 'periodic check' })
    await vi.advanceTimersByTimeAsync(60001)
    expect(starts).not.toHaveBeenCalled()
  })
  it('a plain upstream HTTP 502 is retried rather than disabling the loop', async () => {
    orch.startAgent(id, '/tmp', 'work')
    await flush()
    emitter({ kind: 'error', category: 'other', message: 'HTTP 502 Bad Gateway' })
    emitter({ kind: 'session:ended', reason: 'error', exitCode: null })
    await flush()
    expect(loop.getStatus(id).auto_loop).toBe(true)
    expect(quota.getPending(id)).not.toBeNull()
  })
  it('Codex idle watchdog preserves the loop for recovery', async () => {
    orch.startAgent(id, '/tmp', 'work')
    await flush()
    emitter({ kind: 'error', category: 'other', message: 'Codex stopped reporting activity for this turn' })
    emitter({ kind: 'session:ended', reason: 'error', exitCode: null })
    await flush()
    expect(loop.getStatus(id).auto_loop).toBe(true)
    expect(quota.getPending(id)).not.toBeNull()
  })
  it('Codex quota fallback reads Codex account usage, not Claude account usage', async () => {
    db.prepare("UPDATE workspaces SET engine='codex' WHERE id=?").run(id)
    const poller = await import('../server/services/usage/poller.js')
    vi.mocked(poller.refreshNow).mockClear()
    await orch.computeQuotaBackoffMs(id, 0)
    expect(poller.refreshNow).not.toHaveBeenCalledWith('claude-code')
  })
  it('an upstream 500 thrown by engine.start preserves unfinished loop for retry', async () => {
    starts.mockRejectedValueOnce(new Error('HTTP 500 Internal Server Error'))
    orch.startAgent(id, '/tmp', 'work')
    await flush()
    expect(loop.getStatus(id).auto_loop).toBe(true)
    expect(quota.getPending(id)).not.toBeNull()
  })
})
