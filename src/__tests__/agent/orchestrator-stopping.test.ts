import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEngine } from '../../server/services/agent/engines/types.js'
import { resetDb } from '../helpers/reset-db.js'

vi.mock('../../server/services/websocket-service.js', () => ({
  emit: vi.fn(),
  emitEphemeral: vi.fn(),
}))

vi.mock('../../server/services/settings-service.js', () => ({
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

  it('evicts a controller that never honours its own stop, after the bounded timeout', async () => {
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
    expect(orch.hasController(ws.id)).toBe(false)
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
