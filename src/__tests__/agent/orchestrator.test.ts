import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent } from '../../server/services/agent/engines/types.js'
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

async function flushControllerStart(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('Orchestrator — startAgent', () => {
  beforeEach(async () => {
    vi.resetModules()
    await resetDb()
    const { _registerEngineForTest } = await import('../../server/services/agent/engines/registry.js')
    _registerEngineForTest({
      id: 'claude-code',
      displayName: 'Claude Code',
      capabilities: {
        models: [{ id: 'auto', label: 'Auto' }],
        permissionModes: ['bypass'],
        supportsResume: true,
        supportsMcp: true,
        supportsSkills: true,
      },
      async start(_opts, _onEvent) {
        return {
          pid: 1111,
          engineSessionId: 'session-id',
          sendMessage() {},
          interrupt() {},
          async stop() {},
        }
      },
    })
  })

  it('spawns a new SessionController for a workspace and records the agent session in DB', async () => {
    const { createWorkspace } = await import('../../server/services/workspace-service.js')
    const ws = createWorkspace({
      name: 'W',
      projectPath: '/tmp',
      sourceBranch: 'develop',
      workingBranch: 'feature/w',
    })
    const { startAgent, getAgentStatus, _getControllers } = await import('../../server/services/agent/orchestrator.js')
    // startAgent is sync. pid is undefined immediately because engine.start is async.
    const { agentSessionId, pid } = startAgent(ws.id, '/tmp', 'hi')
    expect(pid).toBeUndefined()
    expect(agentSessionId).toBeTypeOf('string')
    expect(getAgentStatus(ws.id)).toBe('running')
    // After the engine.start promise resolves, the controller has the pid
    await flushControllerStart()
    expect(_getControllers().get(ws.id)?.pid).toBe(1111)
  })

  it('records the model used to start the agent session', async () => {
    const { createWorkspace, listSessions } = await import('../../server/services/workspace-service.js')
    const ws = createWorkspace({
      name: 'W',
      projectPath: '/tmp',
      sourceBranch: 'develop',
      workingBranch: 'feature/model',
    })
    const { startAgent } = await import('../../server/services/agent/orchestrator.js')

    startAgent(ws.id, '/tmp', 'brainstorm', 'claude-opus-4-8')

    expect(listSessions(ws.id)[0]?.model).toBe('claude-opus-4-8')
  })

  it('throws if an agent is already running for the workspace', async () => {
    const { createWorkspace } = await import('../../server/services/workspace-service.js')
    const ws = createWorkspace({ name: 'W', projectPath: '/tmp', sourceBranch: 'develop', workingBranch: 'b' })
    const { startAgent } = await import('../../server/services/agent/orchestrator.js')
    startAgent(ws.id, '/tmp', 'hi')
    expect(() => startAgent(ws.id, '/tmp', 'hi')).toThrow(/already running/i)
  })

  it('refuses to start an archived workspace even when called outside the HTTP route', async () => {
    const { archiveWorkspace, createWorkspace } = await import('../../server/services/workspace-service.js')
    const ws = createWorkspace({ name: 'W', projectPath: '/tmp', sourceBranch: 'develop', workingBranch: 'b' })
    archiveWorkspace(ws.id)
    const { startAgent, _getControllers } = await import('../../server/services/agent/orchestrator.js')

    expect(() => startAgent(ws.id, '/tmp', 'hi')).toThrow(/archived/i)
    expect(_getControllers().has(ws.id)).toBe(false)
  })
})

describe('Orchestrator — stop / interrupt / sendMessage', () => {
  beforeEach(async () => {
    vi.resetModules()
    await resetDb()
    const { _registerEngineForTest } = await import('../../server/services/agent/engines/registry.js')
    _registerEngineForTest({
      id: 'claude-code',
      displayName: 'Claude Code',
      capabilities: {
        models: [{ id: 'auto', label: 'Auto' }],
        permissionModes: ['bypass'],
        supportsResume: true,
        supportsMcp: true,
        supportsSkills: true,
      },
      async start(_opts, _onEvent) {
        return {
          pid: 2222,
          engineSessionId: 'session-id',
          sendMessage() {},
          interrupt() {},
          async stop() {},
        }
      },
    })
  })

  it('stopAgent removes the controller and clears backoff timer', async () => {
    const { createWorkspace } = await import('../../server/services/workspace-service.js')
    const ws = createWorkspace({ name: 'W', projectPath: '/tmp', sourceBranch: 'd', workingBranch: 'b' })
    const { startAgent, stopAgent, getAgentStatus } = await import('../../server/services/agent/orchestrator.js')
    startAgent(ws.id, '/tmp', 'hi')
    stopAgent(ws.id)
    expect(getAgentStatus(ws.id)).toBeNull()
  })

  it('sendMessage rejects when no agent is running', async () => {
    const { sendMessage } = await import('../../server/services/agent/orchestrator.js')
    await expect(sendMessage('nope', 'hi')).rejects.toThrow(/No agent running/)
  })

  it('refuses a message addressed to a session other than the active controller', async () => {
    const { createWorkspace } = await import('../../server/services/workspace-service.js')
    const ws = createWorkspace({ name: 'W', projectPath: '/tmp', sourceBranch: 'd', workingBranch: 'b' })
    const { startAgent, sendMessage } = await import('../../server/services/agent/orchestrator.js')
    const { agentSessionId } = startAgent(ws.id, '/tmp', 'hi')
    await flushControllerStart()

    await expect(sendMessage(ws.id, 'wrong session', 'another-session')).rejects.toThrow(/is not active/)
    await expect(sendMessage(ws.id, 'right session', agentSessionId)).resolves.toBeUndefined()
  })

  it('getRunningCount reflects active controllers', async () => {
    const { createWorkspace } = await import('../../server/services/workspace-service.js')
    const ws = createWorkspace({ name: 'W', projectPath: '/tmp', sourceBranch: 'd', workingBranch: 'b' })
    const { startAgent, stopAgent, getRunningCount } = await import('../../server/services/agent/orchestrator.js')
    expect(getRunningCount()).toBe(0)
    startAgent(ws.id, '/tmp', 'hi')
    expect(getRunningCount()).toBe(1)
    stopAgent(ws.id)
    expect(getRunningCount()).toBe(0)
  })
})

describe('Orchestrator — lifecycle-safe fallback delivery', () => {
  beforeEach(async () => {
    vi.resetModules()
    vi.useRealTimers()
    await resetDb()
  })

  it('identifies the active controller session when the first send succeeds', async () => {
    const { createWorkspace } = await import('../../server/services/workspace-service.js')
    const ws = createWorkspace({ name: 'W', projectPath: '/tmp', sourceBranch: 'd', workingBranch: 'b' })
    const { _registerEngineForTest } = await import('../../server/services/agent/engines/registry.js')
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
      async start() {
        return {
          pid: 1,
          engineSessionId: 'sid-active',
          sendMessage() {},
          interrupt() {},
          async stop() {},
        }
      },
    })
    const { sendMessageForFallback, startAgent } = await import('../../server/services/agent/orchestrator.js')
    const active = startAgent(ws.id, '/tmp', 'hi')
    await flushControllerStart()

    await expect(sendMessageForFallback(ws.id, 'follow up')).resolves.toEqual({
      status: 'sent',
      sessionId: active.agentSessionId,
    })
  })

  it('reports stopped when stopAgent wins before fallback delivery resumes', async () => {
    const { createWorkspace } = await import('../../server/services/workspace-service.js')
    const ws = createWorkspace({ name: 'W', projectPath: '/tmp', sourceBranch: 'd', workingBranch: 'b' })
    const sendMessage = vi.fn(async () => undefined)
    const { _registerEngineForTest } = await import('../../server/services/agent/engines/registry.js')
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
      async start() {
        return {
          pid: 1,
          engineSessionId: 'sid-stopping',
          sendMessage,
          interrupt() {},
          async stop() {},
        }
      },
    })
    const { sendMessageForFallback, startAgent, stopAgent } = await import(
      '../../server/services/agent/orchestrator.js'
    )
    startAgent(ws.id, '/tmp', 'hi')
    await flushControllerStart()

    const delivery = sendMessageForFallback(ws.id, 'follow up')
    stopAgent(ws.id)

    await expect(delivery).resolves.toEqual({ status: 'stopped' })
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('waits for the rejecting controller to end before reporting the agent as stopped', async () => {
    vi.useFakeTimers()
    try {
      const { createWorkspace } = await import('../../server/services/workspace-service.js')
      const ws = createWorkspace({ name: 'W', projectPath: '/tmp', sourceBranch: 'd', workingBranch: 'b' })
      let emitEvent: (event: AgentEvent) => void = () => {}
      const { _registerEngineForTest } = await import('../../server/services/agent/engines/registry.js')
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
            engineSessionId: 'sid-rejecting',
            async sendMessage() {
              throw new Error('engine rejected steering')
            },
            interrupt() {},
            async stop() {},
          }
        },
      })
      const { FALLBACK_CONTROLLER_TURNOVER_POLL_MS, sendMessageForFallback, startAgent } = await import(
        '../../server/services/agent/orchestrator.js'
      )
      startAgent(ws.id, '/tmp', 'hi')
      await flushControllerStart()

      const delivery = sendMessageForFallback(ws.id, 'follow up')
      let settled = false
      void delivery.then(
        () => {
          settled = true
        },
        () => {
          settled = true
        },
      )
      await vi.advanceTimersByTimeAsync(0)

      expect(settled).toBe(false)

      emitEvent({ kind: 'session:ended', reason: 'completed', exitCode: 0 })
      await vi.advanceTimersByTimeAsync(FALLBACK_CONTROLLER_TURNOVER_POLL_MS)

      await expect(delivery).resolves.toEqual({ status: 'stopped' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('sends once to a replacement controller after the rejecting controller ends', async () => {
    vi.useFakeTimers()
    try {
      const { createWorkspace } = await import('../../server/services/workspace-service.js')
      const ws = createWorkspace({ name: 'W', projectPath: '/tmp', sourceBranch: 'd', workingBranch: 'b' })
      let firstEmitEvent: (event: AgentEvent) => void = () => {}
      const firstSend = vi.fn(async () => {
        throw new Error('engine rejected steering')
      })
      const replacementSend = vi.fn(async () => undefined)
      let starts = 0
      const { _registerEngineForTest } = await import('../../server/services/agent/engines/registry.js')
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
          starts += 1
          if (starts === 1) firstEmitEvent = onEvent
          return {
            pid: starts,
            engineSessionId: `sid-${starts}`,
            sendMessage: starts === 1 ? firstSend : replacementSend,
            interrupt() {},
            async stop() {},
          }
        },
      })
      const { FALLBACK_CONTROLLER_TURNOVER_POLL_MS, sendMessageForFallback, startAgent } = await import(
        '../../server/services/agent/orchestrator.js'
      )
      startAgent(ws.id, '/tmp', 'hi')
      await flushControllerStart()

      const delivery = sendMessageForFallback(ws.id, 'follow up')
      await vi.advanceTimersByTimeAsync(0)
      firstEmitEvent({ kind: 'session:ended', reason: 'completed', exitCode: 0 })
      const replacement = startAgent(ws.id, '/tmp', 'replacement')
      await flushControllerStart()
      await vi.advanceTimersByTimeAsync(FALLBACK_CONTROLLER_TURNOVER_POLL_MS)

      await expect(delivery).resolves.toEqual({ status: 'sent', sessionId: replacement.agentSessionId })
      expect(firstSend).toHaveBeenCalledOnce()
      expect(replacementSend).toHaveBeenCalledOnce()
      expect(replacementSend).toHaveBeenCalledWith('follow up')
    } finally {
      vi.useRealTimers()
    }
  })

  it('times out while the same rejecting controller remains registered', async () => {
    vi.useFakeTimers()
    try {
      const { createWorkspace } = await import('../../server/services/workspace-service.js')
      const ws = createWorkspace({ name: 'W', projectPath: '/tmp', sourceBranch: 'd', workingBranch: 'b' })
      const send = vi.fn(async () => {
        throw new Error('engine rejected steering')
      })
      const { _registerEngineForTest } = await import('../../server/services/agent/engines/registry.js')
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
        async start() {
          return {
            pid: 1,
            engineSessionId: 'sid-stuck',
            sendMessage: send,
            interrupt() {},
            async stop() {},
          }
        },
      })
      const {
        FALLBACK_CONTROLLER_TURNOVER_POLL_MS,
        FALLBACK_CONTROLLER_TURNOVER_TIMEOUT_MS,
        getRunningCount,
        sendMessageForFallback,
        startAgent,
      } = await import('../../server/services/agent/orchestrator.js')
      startAgent(ws.id, '/tmp', 'hi')
      await flushControllerStart()

      const delivery = sendMessageForFallback(ws.id, 'follow up')
      const rejection = expect(delivery).rejects.toThrow(/timed out waiting for agent controller turnover/i)
      await vi.advanceTimersByTimeAsync(FALLBACK_CONTROLLER_TURNOVER_TIMEOUT_MS + FALLBACK_CONTROLLER_TURNOVER_POLL_MS)

      await rejection
      expect(send).toHaveBeenCalledOnce()
      expect(getRunningCount()).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('propagates a replacement controller send rejection without retrying or removing it', async () => {
    vi.useFakeTimers()
    try {
      const { createWorkspace } = await import('../../server/services/workspace-service.js')
      const ws = createWorkspace({ name: 'W', projectPath: '/tmp', sourceBranch: 'd', workingBranch: 'b' })
      let firstEmitEvent: (event: AgentEvent) => void = () => {}
      const firstSend = vi.fn(async () => {
        throw new Error('first controller rejected')
      })
      const replacementSend = vi.fn(async () => {
        throw new Error('replacement rejected')
      })
      let starts = 0
      const { _registerEngineForTest } = await import('../../server/services/agent/engines/registry.js')
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
          starts += 1
          if (starts === 1) firstEmitEvent = onEvent
          return {
            pid: starts,
            engineSessionId: `sid-${starts}`,
            sendMessage: starts === 1 ? firstSend : replacementSend,
            interrupt() {},
            async stop() {},
          }
        },
      })
      const { FALLBACK_CONTROLLER_TURNOVER_POLL_MS, _getControllers, sendMessageForFallback, startAgent } =
        await import('../../server/services/agent/orchestrator.js')
      startAgent(ws.id, '/tmp', 'hi')
      await flushControllerStart()

      const delivery = sendMessageForFallback(ws.id, 'follow up')
      const rejection = expect(delivery).rejects.toThrow('replacement rejected')
      await vi.advanceTimersByTimeAsync(0)
      firstEmitEvent({ kind: 'session:ended', reason: 'completed', exitCode: 0 })
      const replacement = startAgent(ws.id, '/tmp', 'replacement')
      await flushControllerStart()
      await vi.advanceTimersByTimeAsync(FALLBACK_CONTROLLER_TURNOVER_POLL_MS)

      await rejection
      expect(firstSend).toHaveBeenCalledOnce()
      expect(replacementSend).toHaveBeenCalledOnce()
      expect(_getControllers().get(ws.id)?.agentSessionId).toBe(replacement.agentSessionId)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a replacement registered when the stopped controller emits session:ended late', async () => {
    const { createWorkspace } = await import('../../server/services/workspace-service.js')
    const ws = createWorkspace({ name: 'W', projectPath: '/tmp', sourceBranch: 'd', workingBranch: 'b' })
    let firstEmitEvent: (event: AgentEvent) => void = () => {}
    let starts = 0
    const { _registerEngineForTest } = await import('../../server/services/agent/engines/registry.js')
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
        starts += 1
        if (starts === 1) firstEmitEvent = onEvent
        return {
          pid: starts,
          engineSessionId: `sid-${starts}`,
          sendMessage() {},
          interrupt() {},
          async stop() {},
        }
      },
    })
    const { _getControllers, getRunningCount, startAgent, stopAgent } = await import(
      '../../server/services/agent/orchestrator.js'
    )
    startAgent(ws.id, '/tmp', 'first')
    await flushControllerStart()

    stopAgent(ws.id)
    const replacement = startAgent(ws.id, '/tmp', 'replacement')
    await flushControllerStart()
    firstEmitEvent({ kind: 'session:ended', reason: 'killed', exitCode: null })

    expect(getRunningCount()).toBe(1)
    expect(_getControllers().get(ws.id)?.agentSessionId).toBe(replacement.agentSessionId)
  })
})

describe('Orchestrator — event dispatch', () => {
  beforeEach(async () => {
    vi.resetModules()
    await resetDb()
  })

  it('transitions workspace to quota + schedules backoff on error{quota}', async () => {
    const { createWorkspace, getWorkspace, updateWorkspaceStatus } = await import(
      '../../server/services/workspace-service.js'
    )
    const ws = createWorkspace({ name: 'W', projectPath: '/tmp', sourceBranch: 'd', workingBranch: 'b' })
    // Need to be in 'executing' state for a valid transition to 'quota'
    updateWorkspaceStatus(ws.id, 'brainstorming')
    updateWorkspaceStatus(ws.id, 'executing')
    let emitEv: (e: AgentEvent) => void = () => {}
    const { _registerEngineForTest } = await import('../../server/services/agent/engines/registry.js')
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
      async start(_opts, onEvent) {
        emitEv = onEvent
        return { pid: 1, engineSessionId: 'sid', sendMessage() {}, interrupt() {}, async stop() {} }
      },
    })
    const { startAgent, _getRetryCounts } = await import('../../server/services/agent/orchestrator.js')
    const quotaBackoffService = await import('../../server/services/quota-backoff-service.js')
    startAgent(ws.id, '/tmp', 'hi')
    await flushControllerStart()
    emitEv({ kind: 'error', category: 'quota', message: 'rate limit' })
    // handleQuota is async — let microtasks settle so the arm() call lands.
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(getWorkspace(ws.id)?.status).toBe('quota')
    expect(quotaBackoffService.getPending(ws.id)).not.toBeNull()
    expect(_getRetryCounts().get(ws.id)).toBe(1)
    quotaBackoffService.cancel(ws.id, 'user')
    _getRetryCounts().clear()
  })

  it('keeps quota status and the backoff timer when session:ended arrives after a quota error', async () => {
    vi.useFakeTimers()
    try {
      const { createWorkspace, getWorkspace, updateWorkspaceStatus } = await import(
        '../../server/services/workspace-service.js'
      )
      const ws = createWorkspace({ name: 'W', projectPath: '/tmp', sourceBranch: 'd', workingBranch: 'b' })
      updateWorkspaceStatus(ws.id, 'brainstorming')
      updateWorkspaceStatus(ws.id, 'executing')
      let emitEv: (e: AgentEvent) => void = () => {}
      const { _registerEngineForTest } = await import('../../server/services/agent/engines/registry.js')
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
        async start(_opts, onEvent) {
          emitEv = onEvent
          return { pid: 1, engineSessionId: 'sid', sendMessage() {}, interrupt() {}, async stop() {} }
        },
      })
      const { startAgent, _getRetryCounts } = await import('../../server/services/agent/orchestrator.js')
      const quotaBackoffService = await import('../../server/services/quota-backoff-service.js')
      startAgent(ws.id, '/tmp', 'hi')
      await flushControllerStart()

      emitEv({ kind: 'error', category: 'quota', message: 'rate limit' })
      // handleQuota is async — settle microtasks so the arm() landed.
      await vi.advanceTimersByTimeAsync(0)
      expect(getWorkspace(ws.id)?.status).toBe('quota')
      expect(quotaBackoffService.getPending(ws.id)).not.toBeNull()

      emitEv({ kind: 'session:ended', reason: 'error', exitCode: 1 })
      await vi.advanceTimersByTimeAsync(0)

      expect(getWorkspace(ws.id)?.status).toBe('quota')
      expect(quotaBackoffService.getPending(ws.id)).not.toBeNull()
      expect(_getRetryCounts().get(ws.id)).toBe(1)

      quotaBackoffService.cancel(ws.id, 'user')
      _getRetryCounts().clear()
    } finally {
      vi.useRealTimers()
    }
  })

  it('transitions workspace to executing on session:brainstorm-complete', async () => {
    const { createWorkspace, getWorkspace, updateWorkspaceStatus } = await import(
      '../../server/services/workspace-service.js'
    )
    const ws = createWorkspace({ name: 'W', projectPath: '/tmp', sourceBranch: 'd', workingBranch: 'b' })
    updateWorkspaceStatus(ws.id, 'brainstorming')
    let emitEv: (e: AgentEvent) => void = () => {}
    const { _registerEngineForTest } = await import('../../server/services/agent/engines/registry.js')
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
      async start(_opts, onEvent) {
        emitEv = onEvent
        return { pid: 1, engineSessionId: 'sid', sendMessage() {}, interrupt() {}, async stop() {} }
      },
    })
    const { startAgent } = await import('../../server/services/agent/orchestrator.js')
    startAgent(ws.id, '/tmp', 'brainstorm')
    await flushControllerStart()
    emitEv({ kind: 'session:brainstorm-complete' })
    expect(getWorkspace(ws.id)?.status).toBe('executing')
  })

  it('onSessionEnded with exitCode 0 transitions workspace to completed', async () => {
    const { createWorkspace, getWorkspace, updateWorkspaceStatus } = await import(
      '../../server/services/workspace-service.js'
    )
    const ws = createWorkspace({ name: 'W', projectPath: '/tmp', sourceBranch: 'd', workingBranch: 'b' })
    updateWorkspaceStatus(ws.id, 'brainstorming')
    updateWorkspaceStatus(ws.id, 'executing')
    let emitEv: (e: AgentEvent) => void = () => {}
    const { _registerEngineForTest } = await import('../../server/services/agent/engines/registry.js')
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
      async start(_opts, onEvent) {
        emitEv = onEvent
        return { pid: 1, engineSessionId: 'sid', sendMessage() {}, interrupt() {}, async stop() {} }
      },
    })
    const { startAgent, _getControllers, _getRetryCounts } = await import('../../server/services/agent/orchestrator.js')
    startAgent(ws.id, '/tmp', 'hi')
    await flushControllerStart()
    emitEv({ kind: 'session:ended', reason: 'completed', exitCode: 0 })
    expect(getWorkspace(ws.id)?.status).toBe('completed')
    expect(_getControllers().has(ws.id)).toBe(false)
    expect(_getRetryCounts().has(ws.id)).toBe(false)
  })

  it('onSessionEnded with exitCode 1 transitions workspace to error', async () => {
    const { createWorkspace, getWorkspace, updateWorkspaceStatus } = await import(
      '../../server/services/workspace-service.js'
    )
    const ws = createWorkspace({ name: 'W', projectPath: '/tmp', sourceBranch: 'd', workingBranch: 'b' })
    updateWorkspaceStatus(ws.id, 'brainstorming')
    updateWorkspaceStatus(ws.id, 'executing')
    let emitEv: (e: AgentEvent) => void = () => {}
    const { _registerEngineForTest } = await import('../../server/services/agent/engines/registry.js')
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
      async start(_opts, onEvent) {
        emitEv = onEvent
        return { pid: 1, engineSessionId: 'sid', sendMessage() {}, interrupt() {}, async stop() {} }
      },
    })
    const { startAgent, _getControllers } = await import('../../server/services/agent/orchestrator.js')
    startAgent(ws.id, '/tmp', 'hi')
    await flushControllerStart()
    emitEv({ kind: 'session:ended', reason: 'error', exitCode: 1 })
    expect(getWorkspace(ws.id)?.status).toBe('error')
    expect(_getControllers().has(ws.id)).toBe(false)
  })
})

describe('Orchestrator — resume behaviour', () => {
  beforeEach(async () => {
    vi.resetModules()
    await resetDb()
    const { _registerEngineForTest } = await import('../../server/services/agent/engines/registry.js')
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
      async start(_opts, _onEvent) {
        return { pid: 7777, engineSessionId: 'sid-resume', sendMessage() {}, interrupt() {}, async stop() {} }
      },
    })
  })

  it('resumes an existing session without creating a new agent_sessions row', async () => {
    const { createWorkspace } = await import('../../server/services/workspace-service.js')
    const { getDb } = await import('../../server/db/index.js')
    const ws = createWorkspace({ name: 'W', projectPath: '/tmp', sourceBranch: 'd', workingBranch: 'b' })
    const db = getDb()
    const existingId = 'existing-session-id'
    db.prepare(
      'INSERT INTO agent_sessions (id, workspace_id, pid, status, engine_session_id, started_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(existingId, ws.id, null, 'completed', 'engine-sid-1', new Date().toISOString())

    const { startAgent } = await import('../../server/services/agent/orchestrator.js')
    const { agentSessionId } = startAgent(ws.id, '/tmp', 'resume me', undefined, true, 'auto-accept', existingId)

    expect(agentSessionId).toBe(existingId)
    const count = db.prepare('SELECT COUNT(*) AS c FROM agent_sessions WHERE workspace_id = ?').get(ws.id) as {
      c: number
    }
    expect(count.c).toBe(1)
    const row = db.prepare('SELECT status FROM agent_sessions WHERE id = ?').get(existingId) as { status: string }
    expect(row.status).toBe('running')
  })

  it('throws when trying to resume a non-existent session id', async () => {
    const { createWorkspace } = await import('../../server/services/workspace-service.js')
    const ws = createWorkspace({ name: 'W', projectPath: '/tmp', sourceBranch: 'd', workingBranch: 'b' })
    const { startAgent } = await import('../../server/services/agent/orchestrator.js')
    expect(() => startAgent(ws.id, '/tmp', 'ghost', undefined, true, 'auto-accept', 'does-not-exist')).toThrow(
      /Cannot resume session/,
    )
  })
})

describe('Orchestrator — watchdog', () => {
  beforeEach(async () => {
    vi.resetModules()
    await resetDb()
    const { _registerEngineForTest } = await import('../../server/services/agent/engines/registry.js')
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
      async start(_opts, _onEvent) {
        // Use an absurdly high PID that is certain not to exist on the host.
        return { pid: 999_999, engineSessionId: 'sid-dead', sendMessage() {}, interrupt() {}, async stop() {} }
      },
    })
  })

  it('watchdog removes a controller whose process is dead and flags agent_sessions as error', async () => {
    const { createWorkspace, updateWorkspaceStatus } = await import('../../server/services/workspace-service.js')
    const { getDb } = await import('../../server/db/index.js')
    const ws = createWorkspace({ name: 'W', projectPath: '/tmp', sourceBranch: 'd', workingBranch: 'b' })
    updateWorkspaceStatus(ws.id, 'brainstorming')
    updateWorkspaceStatus(ws.id, 'executing')
    const { startAgent, _runWatchdogForTest, _getControllers } = await import(
      '../../server/services/agent/orchestrator.js'
    )
    const { agentSessionId } = startAgent(ws.id, '/tmp', 'hi')
    await flushControllerStart()
    expect(_getControllers().has(ws.id)).toBe(true)

    _runWatchdogForTest()

    expect(_getControllers().has(ws.id)).toBe(false)
    const db = getDb()
    const row = db.prepare('SELECT status FROM agent_sessions WHERE id = ?').get(agentSessionId) as { status: string }
    expect(row.status).toBe('error')
  })
})

describe('Orchestrator — reconcileOrphanSessions', () => {
  beforeEach(async () => {
    vi.resetModules()
    await resetDb()
  })

  it('marks a running session with a dead PID as error and sets ended_at', async () => {
    const { createWorkspace } = await import('../../server/services/workspace-service.js')
    const { getDb } = await import('../../server/db/index.js')
    const ws = createWorkspace({ name: 'W', projectPath: '/tmp', sourceBranch: 'd', workingBranch: 'b' })
    const db = getDb()
    db.prepare(
      "INSERT INTO agent_sessions (id, workspace_id, pid, status, started_at) VALUES (?, ?, ?, 'running', ?)",
    ).run('orphan-sid', ws.id, 999_999, new Date().toISOString())

    const { reconcileOrphanSessions } = await import('../../server/services/agent/orchestrator.js')
    reconcileOrphanSessions()

    const row = db.prepare('SELECT status, ended_at FROM agent_sessions WHERE id = ?').get('orphan-sid') as {
      status: string
      ended_at: string | null
    }
    expect(row.status).toBe('error')
    expect(row.ended_at).not.toBeNull()
  })

  it('leaves a running session alone when its PID is still alive', async () => {
    const { createWorkspace } = await import('../../server/services/workspace-service.js')
    const { getDb } = await import('../../server/db/index.js')
    const ws = createWorkspace({ name: 'W', projectPath: '/tmp', sourceBranch: 'd', workingBranch: 'b' })
    const db = getDb()
    db.prepare(
      "INSERT INTO agent_sessions (id, workspace_id, pid, status, started_at) VALUES (?, ?, ?, 'running', ?)",
    ).run('alive-sid', ws.id, process.pid, new Date().toISOString())

    const { reconcileOrphanSessions } = await import('../../server/services/agent/orchestrator.js')
    reconcileOrphanSessions()

    const row = db.prepare('SELECT status, ended_at FROM agent_sessions WHERE id = ?').get('alive-sid') as {
      status: string
      ended_at: string | null
    }
    expect(row.status).toBe('running')
    expect(row.ended_at).toBeNull()
  })

  it('marks a running session with null PID as error', async () => {
    const { createWorkspace } = await import('../../server/services/workspace-service.js')
    const { getDb } = await import('../../server/db/index.js')
    const ws = createWorkspace({ name: 'W', projectPath: '/tmp', sourceBranch: 'd', workingBranch: 'b' })
    const db = getDb()
    db.prepare(
      "INSERT INTO agent_sessions (id, workspace_id, pid, status, started_at) VALUES (?, ?, NULL, 'running', ?)",
    ).run('null-pid-sid', ws.id, new Date().toISOString())

    const { reconcileOrphanSessions } = await import('../../server/services/agent/orchestrator.js')
    reconcileOrphanSessions()

    const row = db.prepare('SELECT status FROM agent_sessions WHERE id = ?').get('null-pid-sid') as { status: string }
    expect(row.status).toBe('error')
  })

  it('is a no-op when there are no running sessions', async () => {
    const { reconcileOrphanSessions } = await import('../../server/services/agent/orchestrator.js')
    expect(() => reconcileOrphanSessions()).not.toThrow()
  })
})

describe('Orchestrator — interruptAgent', () => {
  beforeEach(async () => {
    vi.resetModules()
    await resetDb()
  })

  it('throws when no agent is running for the workspace', async () => {
    const { interruptAgent, InterruptAgentError } = await import('../../server/services/agent/orchestrator.js')
    let thrown: unknown
    try {
      interruptAgent('nope')
    } catch (err) {
      thrown = err
    }

    expect(thrown).toBeInstanceOf(InterruptAgentError)
    expect(thrown).toMatchObject({
      code: 'no_agent_running',
      message: expect.stringMatching(/No agent running/),
    })
  })

  it('only interrupts the expected active session before disabling auto-loop', async () => {
    const { createWorkspace } = await import('../../server/services/workspace-service.js')
    const { getDb } = await import('../../server/db/index.js')
    const autoLoopService = await import('../../server/services/auto-loop-service.js')
    const ws = createWorkspace({ name: 'W', projectPath: '/tmp', sourceBranch: 'd', workingBranch: 'b' })
    getDb().prepare('UPDATE workspaces SET auto_loop = 1 WHERE id = ?').run(ws.id)
    let interruptCalls = 0
    const { _registerEngineForTest } = await import('../../server/services/agent/engines/registry.js')
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
      async start(_opts, _onEvent) {
        return {
          pid: 1234,
          engineSessionId: 'sid',
          sendMessage() {},
          interrupt() {
            interruptCalls++
          },
          async stop() {},
        }
      },
    })
    const { startAgent, interruptAgent, InterruptAgentError } = await import(
      '../../server/services/agent/orchestrator.js'
    )
    const { agentSessionId } = startAgent(ws.id, '/tmp', 'hi')
    await flushControllerStart()

    expect(() => interruptAgent(ws.id, { expectedSessionId: '', disableAutoLoop: true })).toThrow(/not active/)
    expect(interruptCalls).toBe(0)
    expect(autoLoopService.getStatus(ws.id).auto_loop).toBe(true)

    let thrown: unknown
    try {
      interruptAgent(ws.id, { expectedSessionId: 'stale-session', disableAutoLoop: true })
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(InterruptAgentError)
    expect(thrown).toMatchObject({
      code: 'session_not_active',
      message: expect.stringMatching(/not active/),
    })
    expect(interruptCalls).toBe(0)
    expect(autoLoopService.getStatus(ws.id).auto_loop).toBe(true)

    interruptAgent(ws.id, { expectedSessionId: agentSessionId, disableAutoLoop: true })
    expect(interruptCalls).toBe(1)
    expect(autoLoopService.getStatus(ws.id).auto_loop).toBe(false)
  })

  it('keeps auto-loop enabled when the controller interrupt fails', async () => {
    const { createWorkspace } = await import('../../server/services/workspace-service.js')
    const { getDb } = await import('../../server/db/index.js')
    const autoLoopService = await import('../../server/services/auto-loop-service.js')
    const ws = createWorkspace({ name: 'W', projectPath: '/tmp', sourceBranch: 'd', workingBranch: 'b' })
    getDb().prepare('UPDATE workspaces SET auto_loop = 1 WHERE id = ?').run(ws.id)
    const { _registerEngineForTest } = await import('../../server/services/agent/engines/registry.js')
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
      async start(_opts, _onEvent) {
        return {
          pid: 1234,
          engineSessionId: 'sid',
          sendMessage() {},
          interrupt() {
            throw new Error('interrupt failed')
          },
          async stop() {},
        }
      },
    })
    const { startAgent, interruptAgent, InterruptAgentError } = await import(
      '../../server/services/agent/orchestrator.js'
    )
    const { agentSessionId } = startAgent(ws.id, '/tmp', 'hi')
    await flushControllerStart()

    let thrown: unknown
    try {
      interruptAgent(ws.id, { expectedSessionId: agentSessionId, disableAutoLoop: true })
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(InterruptAgentError)
    expect(thrown).toMatchObject({
      code: 'interrupt_failed',
      message: expect.stringMatching(/Failed to interrupt agent.*interrupt failed/),
    })
    expect(autoLoopService.getStatus(ws.id).auto_loop).toBe(true)
  })
})
