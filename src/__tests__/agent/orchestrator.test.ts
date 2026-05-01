import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent } from '../../server/services/agent/engines/types.js'
import { resetDb } from '../helpers/reset-db.js'

vi.mock('../../server/services/websocket-service.js', () => ({
  emit: vi.fn(),
  emitEphemeral: vi.fn(),
}))

vi.mock('../../server/services/settings-service.js', () => ({
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

  it('throws if an agent is already running for the workspace', async () => {
    const { createWorkspace } = await import('../../server/services/workspace-service.js')
    const ws = createWorkspace({ name: 'W', projectPath: '/tmp', sourceBranch: 'develop', workingBranch: 'b' })
    const { startAgent } = await import('../../server/services/agent/orchestrator.js')
    startAgent(ws.id, '/tmp', 'hi')
    expect(() => startAgent(ws.id, '/tmp', 'hi')).toThrow(/already running/i)
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

  it('sendMessage throws when no agent is running', async () => {
    const { sendMessage } = await import('../../server/services/agent/orchestrator.js')
    expect(() => sendMessage('nope', 'hi')).toThrow(/No agent running/)
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
    const { startAgent, _getBackoffTimers, _getRetryCounts } = await import(
      '../../server/services/agent/orchestrator.js'
    )
    startAgent(ws.id, '/tmp', 'hi')
    await flushControllerStart()
    emitEv({ kind: 'error', category: 'quota', message: 'rate limit' })
    expect(getWorkspace(ws.id)?.status).toBe('quota')
    expect(_getBackoffTimers().has(ws.id)).toBe(true)
    expect(_getRetryCounts().get(ws.id)).toBe(1)
    for (const t of _getBackoffTimers().values()) clearTimeout(t)
    _getBackoffTimers().clear()
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
      const { startAgent, _getBackoffTimers, _getRetryCounts } = await import(
        '../../server/services/agent/orchestrator.js'
      )
      startAgent(ws.id, '/tmp', 'hi')
      await flushControllerStart()

      emitEv({ kind: 'error', category: 'quota', message: 'rate limit' })
      expect(getWorkspace(ws.id)?.status).toBe('quota')
      expect(_getBackoffTimers().has(ws.id)).toBe(true)

      emitEv({ kind: 'session:ended', reason: 'error', exitCode: 1 })

      expect(getWorkspace(ws.id)?.status).toBe('quota')
      expect(_getBackoffTimers().has(ws.id)).toBe(true)
      expect(_getRetryCounts().get(ws.id)).toBe(1)

      for (const t of _getBackoffTimers().values()) clearTimeout(t)
      _getBackoffTimers().clear()
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
    const { interruptAgent } = await import('../../server/services/agent/orchestrator.js')
    expect(() => interruptAgent('nope')).toThrow(/No agent running/)
  })

  it('proxies the call to the controller', async () => {
    const { createWorkspace } = await import('../../server/services/workspace-service.js')
    const ws = createWorkspace({ name: 'W', projectPath: '/tmp', sourceBranch: 'd', workingBranch: 'b' })
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
    const { startAgent, interruptAgent } = await import('../../server/services/agent/orchestrator.js')
    startAgent(ws.id, '/tmp', 'hi')
    await flushControllerStart()
    interruptAgent(ws.id)
    expect(interruptCalls).toBe(1)
  })
})
