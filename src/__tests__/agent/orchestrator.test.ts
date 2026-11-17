import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent } from '../../server/services/agent/engines/types.js'
import { DEFAULT_MEMORY_LIMITS } from '../../shared/memory-limits.js'
import { resetDb } from '../helpers/reset-db.js'

vi.mock('../../server/services/websocket-service.js', () => ({
  emit: vi.fn(),
  emitEphemeral: vi.fn(),
}))

const integrationSettings = vi.hoisted(() => ({
  notionEnabled: false,
  sentryEnabled: false,
  notionMcpKey: '',
  sentryMcpKey: '',
}))
vi.mock('../../server/services/settings-service.js', () => ({
  getMemoryLimits: () => ({ ...DEFAULT_MEMORY_LIMITS }),
  getGlobalSettings: () => ({ autoLoopMaxRetries: 5, ...integrationSettings }),
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

const startOptions = vi.fn()

async function flushControllerStart(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('Orchestrator — startAgent', () => {
  beforeEach(async () => {
    integrationSettings.notionEnabled = false
    integrationSettings.sentryEnabled = false
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
        supportsLiveSteering: true,
        supportsReadOnly: true,
        supportsSkills: true,
        supportsSubagents: false,
        supportsQuotaStatus: false,
      },
      async start(_opts, _onEvent) {
        startOptions(_opts)
        return {
          pid: 1111,
          engineSessionId: 'session-id',
          sendMessage() {},
          interrupt() {},
          async stop() {},
          resolvePendingUserInput: () => false,
        }
      },
    })
  })

  it.each(['claude-code', 'codex'])(
    'injects enabled managed integrations and their current namespace into %s launches',
    async (engineId) => {
      integrationSettings.notionEnabled = true
      integrationSettings.sentryEnabled = true
      const { saveIntegrationConfig } = await import('../../server/services/integration-config-service.js')
      saveIntegrationConfig('notion', {
        command: 'node',
        args: ['notion-test.js'],
        env: { NOTION_TOKEN: 'synthetic-token' },
      })
      saveIntegrationConfig('sentry', {
        command: 'node',
        args: ['sentry-test.js'],
        env: { SENTRY_ACCESS_TOKEN: 'synthetic-token' },
      })
      const { _registerEngineForTest, resolveEngine } = await import('../../server/services/agent/engines/registry.js')
      if (engineId === 'codex') _registerEngineForTest({ ...resolveEngine('claude-code'), id: 'codex' })
      const { createWorkspace } = await import('../../server/services/workspace-service.js')
      const ws = createWorkspace({
        name: 'Managed MCP',
        projectPath: '/tmp',
        sourceBranch: 'main',
        workingBranch: 'managed-mcp',
        engine: engineId,
      })
      const { startAgent } = await import('../../server/services/agent/orchestrator.js')
      startOptions.mockClear()
      startAgent(ws.id, '/tmp', 'Read my ticket')
      await flushControllerStart()
      const options = startOptions.mock.calls[0][0]
      expect(options.mcpServers).toHaveLength(3)
      expect(options.mcpServers[0].name).toBe('kobo-tasks')
      for (const server of options.mcpServers.slice(1)) {
        expect(options.prompt).toContain(server.name)
        expect(server.command).toBe('node')
      }
      expect(options.prompt).not.toContain('synthetic-token')

      const next = createWorkspace({
        name: 'Managed MCP again',
        projectPath: '/tmp',
        sourceBranch: 'main',
        workingBranch: 'managed-mcp-again',
        engine: engineId,
      })
      startAgent(next.id, '/tmp', 'Read my ticket')
      await flushControllerStart()
      const nextServers = startOptions.mock.calls[1][0].mcpServers.slice(1)
      const names = options.mcpServers.slice(1).map((server: { name: string }) => server.name)
      const nextNames = nextServers.map((server: { name: string }) => server.name)
      if (engineId === 'claude-code') expect(nextNames).toEqual(names)
      else for (const name of nextNames) expect(names).not.toContain(name)
    },
  )

  it('launches a review session with an automatic return read-only in plan mode, whatever mode is requested', async () => {
    const { createWorkspace, createIdleSession } = await import('../../server/services/workspace-service.js')
    const ws = createWorkspace({ name: 'Review', projectPath: '/tmp', sourceBranch: 'main', workingBranch: 'review' })
    const original = createIdleSession(ws.id)
    const review = createIdleSession(ws.id)
    const { registerReviewReturn } = await import('../../server/services/review-return-service.js')
    const configuration = {
      engine: 'claude-code',
      model: 'auto',
      reasoningEffort: 'auto',
      agentPermissionMode: 'bypass',
    }
    registerReviewReturn({
      workspaceId: ws.id,
      reviewSessionId: review.id,
      originalSessionId: original.id,
      original: configuration,
      review: configuration,
    } as never)
    const { startAgent } = await import('../../server/services/agent/orchestrator.js')
    startOptions.mockClear()
    startAgent(ws.id, '/tmp', 'Review the branch', undefined, false, 'bypass', review.id)
    await flushControllerStart()
    expect(startOptions.mock.calls[0][0]).toMatchObject({ readOnly: true, agentPermissionMode: 'plan' })
  })

  it('does not restrict an ordinary launch', async () => {
    const { createWorkspace } = await import('../../server/services/workspace-service.js')
    const ws = createWorkspace({ name: 'Plain', projectPath: '/tmp', sourceBranch: 'main', workingBranch: 'plain' })
    const { startAgent } = await import('../../server/services/agent/orchestrator.js')
    startOptions.mockClear()
    startAgent(ws.id, '/tmp', 'Work', undefined, false, 'bypass')
    await flushControllerStart()
    expect(startOptions.mock.calls[0][0]).toMatchObject({ readOnly: false, agentPermissionMode: 'bypass' })
  })

  it('injects the workspace policy before the user prompt without altering its constraints', async () => {
    const { createWorkspace } = await import('../../server/services/workspace-service.js')
    const workspace = createWorkspace({
      name: 'Policy',
      projectPath: '/tmp',
      sourceBranch: 'main',
      workingBranch: 'policy',
      workflowPolicy: { commit: 'automatic', push: 'manual' },
    })
    const { startAgent } = await import('../../server/services/agent/orchestrator.js')
    startOptions.mockClear()
    startAgent(workspace.id, '/tmp', 'Do not commit any changes.')
    await flushControllerStart()
    expect(startOptions).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: expect.stringContaining('commit: automatic') }),
    )
    expect(startOptions).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: expect.stringContaining('more restrictive user instructions') }),
    )
    expect(startOptions).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: expect.stringContaining('Do not commit any changes.') }),
    )
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
        supportsLiveSteering: true,
        supportsReadOnly: true,
        supportsSkills: true,
        supportsSubagents: false,
        supportsQuotaStatus: false,
      },
      async start(_opts, _onEvent) {
        return {
          pid: 2222,
          engineSessionId: 'session-id',
          sendMessage() {},
          interrupt() {},
          async stop() {},
          resolvePendingUserInput: () => false,
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
    // stopAgent is fire-and-forget: the controller stays registered, in
    // `stopping` state, until the engine's stop() promise actually resolves (D1).
    expect(getAgentStatus(ws.id)).toBe('stopping')
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(getAgentStatus(ws.id)).toBeNull()
  })

  it('stopAllAgents waits for and removes every live controller', async () => {
    const { createWorkspace } = await import('../../server/services/workspace-service.js')
    const first = createWorkspace({ name: 'First', projectPath: '/tmp', sourceBranch: 'd', workingBranch: 'first' })
    const second = createWorkspace({ name: 'Second', projectPath: '/tmp', sourceBranch: 'd', workingBranch: 'second' })
    const { startAgent, stopAllAgents, getRunningCount } = await import('../../server/services/agent/orchestrator.js')
    startAgent(first.id, '/tmp', 'hi')
    startAgent(second.id, '/tmp', 'hi')
    await flushControllerStart()

    await stopAllAgents()

    expect(getRunningCount()).toBe(0)
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
    // stopAgent is fire-and-forget: the controller stays registered, in
    // `stopping` state, until the engine's stop() promise actually resolves (D1).
    expect(getRunningCount()).toBe(1)
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(getRunningCount()).toBe(0)
  })
})

describe('Orchestrator - forced stop for an update', () => {
  let hangingStop = false
  let stopGate: Promise<void> | undefined
  let starts = 0

  beforeEach(async () => {
    hangingStop = false
    stopGate = undefined
    starts = 0
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
        supportsLiveSteering: true,
        supportsReadOnly: true,
        supportsSkills: true,
        supportsSubagents: false,
        supportsQuotaStatus: false,
      },
      async start(_opts, onEvent) {
        const hang = hangingStop
        starts++
        return {
          pid: 3333,
          engineSessionId: 'session-id',
          sendMessage() {},
          interrupt() {},
          // Like a real engine, a confirmed stop reports the end of its session.
          stop: () => {
            if (hang) return new Promise<void>(() => {})
            const end = () => onEvent({ kind: 'session:ended', reason: 'killed', exitCode: null })
            if (stopGate) return stopGate.then(end)
            end()
            return Promise.resolve()
          },
          resolvePendingUserInput: () => false,
        }
      },
    })
  })

  async function twoWorkspaces() {
    const { createWorkspace } = await import('../../server/services/workspace-service.js')
    return [
      createWorkspace({ name: 'First', projectPath: '/tmp', sourceBranch: 'd', workingBranch: 'first' }),
      createWorkspace({ name: 'Second', projectPath: '/tmp', sourceBranch: 'd', workingBranch: 'second' }),
    ]
  }

  it('stops every live controller with the shutdown cause without shutting Kōbō down', async () => {
    const [first, second] = await twoWorkspaces()
    const agents = await import('../../server/services/agent/orchestrator.js')
    agents.startAgent(first.id, '/tmp', 'hi')
    agents.startAgent(second.id, '/tmp', 'hi')
    await flushControllerStart()
    const stopped = [...agents._getControllers().values()]

    expect(await agents.stopAgentsForUpdate()).toEqual({ stopped: 2, unconfirmed: 0 })

    expect(stopped.map((ctrl) => ctrl.stopCause)).toEqual(['shutdown', 'shutdown'])
    expect(agents.getRunningCount()).toBe(0)
    expect(agents.isShuttingDown()).toBe(false)
    expect(() => agents.startAgent(first.id, '/tmp', 'again')).not.toThrow()
  })

  it('reports an unconfirmed stop and keeps that controller owned', async () => {
    const [first] = await twoWorkspaces()
    const agents = await import('../../server/services/agent/orchestrator.js')
    hangingStop = true
    agents.startAgent(first.id, '/tmp', 'hi')
    await flushControllerStart()

    expect(await agents.stopAgentsForUpdate(20)).toEqual({ stopped: 0, unconfirmed: 1 })

    expect(agents._getControllers().get(first.id)?.status).toBe('stopping')
    expect(agents.isIdleForForcedUpdate()).toBe(false)
  })

  it('ignores the workspace status but not a running session row', async () => {
    const [first] = await twoWorkspaces()
    const agents = await import('../../server/services/agent/orchestrator.js')
    const { getDb } = await import('../../server/db/index.js')
    getDb().prepare("UPDATE workspaces SET status = 'executing' WHERE id = ?").run(first.id)
    expect(agents.isIdleForUpdate()).toBe(false)
    expect(agents.isIdleForForcedUpdate()).toBe(true)
    getDb()
      .prepare('INSERT INTO agent_sessions (id, workspace_id, status, started_at) VALUES (?, ?, ?, ?)')
      .run('running', first.id, 'running', new Date().toISOString())
    expect(agents.isIdleForForcedUpdate()).toBe(false)
  })

  const owner = 'd'.repeat(32)

  /** A handed-out stopAgents request, as the host updater sees it after its poll. */
  async function handedOutRequest(): Promise<string> {
    const trigger = await import('../../server/services/update-trigger-service.js')
    trigger.resetUpdateTriggerForTests()
    trigger.pollUpdateTrigger(Date.now(), { skipBackup: false, stopAgents: true })
    const { id } = trigger.requestUpdate({ skipBackup: false, stopAgents: true })
    trigger.pollUpdateTrigger(Date.now(), { skipBackup: false, stopAgents: true })
    return id
  }

  async function maintenanceCall(method: string, path: string, body: unknown) {
    const { default: app } = await import('../../server/routes/maintenance.js')
    return app.request(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  it('reserves before stopping and keeps the reservation once every stop is confirmed', async () => {
    const [first, second] = await twoWorkspaces()
    const agents = await import('../../server/services/agent/orchestrator.js')
    const maintenance = await import('../../server/services/update-maintenance-service.js')
    agents.startAgent(first.id, '/tmp', 'hi')
    agents.startAgent(second.id, '/tmp', 'hi')
    await flushControllerStart()
    const stopped = [...agents._getControllers().values()]
    const id = await handedOutRequest()
    const { getDb } = await import('../../server/db/index.js')
    // Statuses an engine may leave behind; the forced path does not wait for reconciliation.
    getDb().prepare("UPDATE workspaces SET status = 'executing'").run()

    const res = await maintenanceCall('POST', '/update-trigger/stop-agents', { id, owner })

    expect(await res.json()).toEqual({ protocol: 1, stopped: 2, unconfirmed: 0, reserved: true })
    expect(res.status).toBe(200)
    expect(stopped.map((ctrl) => ctrl.stopCause)).toEqual(['shutdown', 'shutdown'])
    expect(maintenance.isUpdateMaintenanceActive()).toBe(true)
    expect(agents.isShuttingDown()).toBe(true)
    expect(() => agents.startAgent(first.id, '/tmp', 'again')).toThrow(/maintenance/i)
  })

  it('defers capacity checks and a pending review return while the reservation is held', async () => {
    const [first, second] = await twoWorkspaces()
    const agents = await import('../../server/services/agent/orchestrator.js')
    const reviews = await import('../../server/services/review-return-service.js')
    const { agentSessionId: reviewSessionId } = agents.startAgent(first.id, '/tmp', 'review')
    agents.startAgent(second.id, '/tmp', 'hi')
    await flushControllerStart()
    const configuration = {
      engine: 'claude-code',
      model: 'auto',
      reasoningEffort: 'auto',
      agentPermissionMode: 'bypass' as const,
    }
    reviews.registerReviewReturn({
      workspaceId: first.id,
      reviewSessionId,
      originalSessionId: (await import('../../server/services/workspace-service.js')).createIdleSession(first.id).id,
      original: configuration,
      review: configuration,
      reviewPrompt: 'Review the work',
    })
    const id = await handedOutRequest()
    const launchesBefore = starts

    expect((await maintenanceCall('POST', '/update-trigger/stop-agents', { id, owner })).status).toBe(200)
    agents.notifyCapacityAvailable(first.id)
    agents.resumePendingReviewReturns()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    await new Promise<void>((resolve) => setTimeout(resolve, 0))

    expect(starts).toBe(launchesBefore)
    expect(agents.getRunningCount()).toBe(0)
    expect(reviews.getReviewReturn(first.id)?.phase).toBe('reviewing')
  })

  it('releases the reservation and answers busy when a stop is not confirmed', async () => {
    const [first] = await twoWorkspaces()
    const agents = await import('../../server/services/agent/orchestrator.js')
    const maintenance = await import('../../server/services/update-maintenance-service.js')
    hangingStop = true
    agents.startAgent(first.id, '/tmp', 'hi')
    await flushControllerStart()
    const id = await handedOutRequest()

    vi.useFakeTimers()
    try {
      const pending = maintenanceCall('POST', '/update-trigger/stop-agents', { id, owner })
      await vi.advanceTimersByTimeAsync(agents.STOP_AGENT_TIMEOUT_MS)
      const res = await pending
      expect(res.status).toBe(409)
      expect(await res.json()).toEqual({ error: 'Kōbō is busy', code: 'busy', stopped: 0, unconfirmed: 1 })
    } finally {
      vi.useRealTimers()
    }
    expect(maintenance.isUpdateMaintenanceActive()).toBe(false)
    expect(agents.isShuttingDown()).toBe(false)
    expect(agents._getControllers().get(first.id)?.status).toBe('stopping')
  })

  async function insertHandoff(workspaceId: string, state: string): Promise<void> {
    const { getDb } = await import('../../server/db/index.js')
    const now = new Date().toISOString()
    getDb()
      .prepare(
        `INSERT INTO session_handoffs (id, workspace_id, request_id, request_fingerprint, source_configuration,
         target_configuration, generate_summary, state, created_at, updated_at)
         VALUES (?, ?, 'request', '{}', '{}', '{}', 0, ?, ?, ?)`,
      )
      .run(`handoff-${state}`, workspaceId, state, now, now)
  }

  it.each(['stopping', 'generating', 'starting'])(
    'refuses while a session handoff is %s, stopping nothing and reserving nothing',
    async (state) => {
      const [first] = await twoWorkspaces()
      const agents = await import('../../server/services/agent/orchestrator.js')
      const maintenance = await import('../../server/services/update-maintenance-service.js')
      agents.startAgent(first.id, '/tmp', 'hi')
      await flushControllerStart()
      const id = await handedOutRequest()
      await insertHandoff(first.id, state)

      const res = await maintenanceCall('POST', '/update-trigger/stop-agents', { id, owner })

      expect(res.status).toBe(409)
      expect(await res.json()).toEqual({ error: 'Kōbō is busy', code: 'busy', stopped: 0, unconfirmed: 0 })
      expect(maintenance.isUpdateMaintenanceActive()).toBe(false)
      expect(agents._getControllers().get(first.id)?.status).toBe('running')
    },
  )

  it.each(['failed', 'interrupted'])('does not refuse for a %s handoff awaiting a decision', async (state) => {
    const [first] = await twoWorkspaces()
    const agents = await import('../../server/services/agent/orchestrator.js')
    agents.startAgent(first.id, '/tmp', 'hi')
    await flushControllerStart()
    const id = await handedOutRequest()
    await insertHandoff(first.id, state)
    // fail() and startup reconciliation leave the transfer's stop handler registered until a decision.
    const { registerHandoffStopHandler } = await import('../../server/services/session-handoff-runtime.js')
    registerHandoffStopHandler(first.id, { requested() {}, settled() {}, shutdown() {} })

    const res = await maintenanceCall('POST', '/update-trigger/stop-agents', { id, owner })

    expect(await res.json()).toEqual({ protocol: 1, stopped: 1, unconfirmed: 0, reserved: true })
  })

  it.each([
    ['the same owner', owner],
    ['another owner', 'f'.repeat(32)],
  ])('refuses with conflict when %s already holds a reservation, touching nothing', async (_label, holder) => {
    const [first] = await twoWorkspaces()
    const agents = await import('../../server/services/agent/orchestrator.js')
    const maintenance = await import('../../server/services/update-maintenance-service.js')
    agents.startAgent(first.id, '/tmp', 'hi')
    await flushControllerStart()
    const id = await handedOutRequest()
    expect(maintenance.acquireUpdateMaintenance(holder, () => true)).toBe('acquired')

    const res = await maintenanceCall('POST', '/update-trigger/stop-agents', { id, owner })

    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'Update already reserved', code: 'conflict', stopped: 0, unconfirmed: 0 })
    expect(agents._getControllers().get(first.id)?.status).toBe('running')
    expect(maintenance.isUpdateMaintenanceActive()).toBe(true)
    expect(maintenance.releaseUpdateMaintenance(holder)).toBe(true)
  })

  it('refuses an overlapping call with the same owner and lets the first outcome stand', async () => {
    const [first] = await twoWorkspaces()
    const agents = await import('../../server/services/agent/orchestrator.js')
    const maintenance = await import('../../server/services/update-maintenance-service.js')
    let finishStop!: () => void
    stopGate = new Promise<void>((resolve) => {
      finishStop = resolve
    })
    agents.startAgent(first.id, '/tmp', 'hi')
    await flushControllerStart()
    const id = await handedOutRequest()

    const firstCall = maintenanceCall('POST', '/update-trigger/stop-agents', { id, owner })
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    const second = await maintenanceCall('POST', '/update-trigger/stop-agents', { id, owner })
    expect(second.status).toBe(409)
    expect(await second.json()).toMatchObject({ code: 'conflict', stopped: 0, unconfirmed: 0 })
    expect(maintenance.isUpdateMaintenanceActive()).toBe(true)

    finishStop()
    const res = await firstCall
    expect(await res.json()).toEqual({ protocol: 1, stopped: 1, unconfirmed: 0, reserved: true })
    expect(maintenance.isUpdateMaintenanceActive()).toBe(true)
  })

  it.each(['stop', 'idle check'])(
    'releases and resumes exactly once when the %s throws, answering an error',
    async (failing) => {
      await twoWorkspaces()
      const agents = await import('../../server/services/agent/orchestrator.js')
      const maintenance = await import('../../server/services/update-maintenance-service.js')
      const id = await handedOutRequest()
      if (failing === 'stop') vi.spyOn(agents, 'stopAgentsForUpdate').mockRejectedValueOnce(new Error('boom'))
      else
        vi.spyOn(agents, 'isIdleForForcedUpdate').mockImplementationOnce(() => {
          throw new Error('boom')
        })
      const release = vi.spyOn(maintenance, 'releaseUpdateMaintenance')
      const resume = vi.spyOn(agents, 'resumeAfterUpdateMaintenance')

      const res = await maintenanceCall('POST', '/update-trigger/stop-agents', { id, owner })

      expect(res.status).toBe(500)
      expect(release).toHaveBeenCalledTimes(1)
      expect(release).toHaveBeenCalledWith(owner)
      expect(resume).toHaveBeenCalledTimes(1)
      expect(maintenance.isUpdateMaintenanceActive()).toBe(false)
    },
  )

  it('reserves for a forced update when a workspace is still marked executing but no agent runs', async () => {
    await twoWorkspaces()
    const { getDb } = await import('../../server/db/index.js')
    const maintenance = await import('../../server/services/update-maintenance-service.js')
    const trigger = await import('../../server/services/update-trigger-service.js')
    getDb().prepare("UPDATE workspaces SET status = 'executing'").run()
    trigger.resetUpdateTriggerForTests()
    trigger.pollUpdateTrigger(Date.now(), { skipBackup: false, stopAgents: true })
    expect(trigger.getUpdateTriggerState()).toMatchObject({ busy: true, runningAgents: 0 })
    expect(() => trigger.requestUpdate({ skipBackup: false, stopAgents: false })).toThrow(trigger.UpdateTriggerError)
    const { id } = trigger.requestUpdate({ skipBackup: false, stopAgents: true })
    trigger.pollUpdateTrigger(Date.now(), { skipBackup: false, stopAgents: true })

    const res = await maintenanceCall('POST', '/update-trigger/stop-agents', { id, owner })

    expect(await res.json()).toEqual({ protocol: 1, stopped: 0, unconfirmed: 0, reserved: true })
    expect(res.status).toBe(200)
    expect(maintenance.isUpdateMaintenanceActive()).toBe(true)
  })

  it('neutralises a request accepted under a spoofed poll once an older updater takes it', async () => {
    await twoWorkspaces()
    const maintenance = await import('../../server/services/update-maintenance-service.js')
    const trigger = await import('../../server/services/update-trigger-service.js')
    const { default: app } = await import('../../server/routes/maintenance.js')
    trigger.resetUpdateTriggerForTests()
    await app.request('/update-trigger/poll?skipBackup=1&stopAgents=1')
    const { id } = trigger.requestUpdate({ skipBackup: true, stopAgents: true })

    const polled = await (await app.request('/update-trigger/poll')).json()

    expect(polled.request).toMatchObject({ id, skipBackup: false, stopAgents: false })
    const res = await maintenanceCall('POST', '/update-trigger/stop-agents', { id, owner })
    expect(res.status).toBe(409)
    expect(maintenance.isUpdateMaintenanceActive()).toBe(false)
  })

  it('releases nothing on success', async () => {
    await twoWorkspaces()
    const agents = await import('../../server/services/agent/orchestrator.js')
    const maintenance = await import('../../server/services/update-maintenance-service.js')
    const id = await handedOutRequest()
    const release = vi.spyOn(maintenance, 'releaseUpdateMaintenance')
    const resume = vi.spyOn(agents, 'resumeAfterUpdateMaintenance')

    expect((await maintenanceCall('POST', '/update-trigger/stop-agents', { id, owner })).status).toBe(200)

    expect(release).not.toHaveBeenCalled()
    expect(resume).not.toHaveBeenCalled()
    expect(maintenance.isUpdateMaintenanceActive()).toBe(true)
  })

  it('leaves a refused update terminal, with no running agent, once the updater releases its reservation', async () => {
    const [first, second] = await twoWorkspaces()
    const agents = await import('../../server/services/agent/orchestrator.js')
    const trigger = await import('../../server/services/update-trigger-service.js')
    agents.startAgent(first.id, '/tmp', 'hi')
    agents.startAgent(second.id, '/tmp', 'hi')
    await flushControllerStart()
    const id = await handedOutRequest()

    expect((await maintenanceCall('POST', '/update-trigger/stop-agents', { id, owner })).status).toBe(200)
    expect(trigger.reportUpdateTrigger(id, 'refused', 'busy')).toBe(true)
    expect((await maintenanceCall('DELETE', '/update', { owner })).status).toBe(200)

    const state = trigger.getUpdateTriggerState()
    expect(state.status).toMatchObject({ id, phase: 'refused', reason: 'busy' })
    expect(state.inProgress).toBe(false)
    expect(state.runningAgents).toBe(0)
    expect(agents.isShuttingDown()).toBe(false)
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
        supportsLiveSteering: true,
        supportsReadOnly: true,
        supportsSkills: true,
        supportsSubagents: false,
        supportsQuotaStatus: false,
      },
      async start() {
        return {
          pid: 1,
          engineSessionId: 'sid-active',
          sendMessage() {},
          interrupt() {},
          async stop() {},
          resolvePendingUserInput: () => false,
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
        supportsLiveSteering: true,
        supportsReadOnly: true,
        supportsSkills: true,
        supportsSubagents: false,
        supportsQuotaStatus: false,
      },
      async start() {
        return {
          pid: 1,
          engineSessionId: 'sid-stopping',
          sendMessage,
          interrupt() {},
          async stop() {},
          resolvePendingUserInput: () => false,
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
          supportsLiveSteering: true,
          supportsReadOnly: true,
          supportsSkills: true,
          supportsSubagents: false,
          supportsQuotaStatus: false,
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
            resolvePendingUserInput: () => false,
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
          supportsLiveSteering: true,
          supportsReadOnly: true,
          supportsSkills: true,
          supportsSubagents: false,
          supportsQuotaStatus: false,
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
            resolvePendingUserInput: () => false,
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
          supportsLiveSteering: true,
          supportsReadOnly: true,
          supportsSkills: true,
          supportsSubagents: false,
          supportsQuotaStatus: false,
        },
        async start() {
          return {
            pid: 1,
            engineSessionId: 'sid-stuck',
            sendMessage: send,
            interrupt() {},
            async stop() {},
            resolvePendingUserInput: () => false,
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
          supportsLiveSteering: true,
          supportsReadOnly: true,
          supportsSkills: true,
          supportsSubagents: false,
          supportsQuotaStatus: false,
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
            resolvePendingUserInput: () => false,
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
        supportsLiveSteering: true,
        supportsReadOnly: true,
        supportsSkills: true,
        supportsSubagents: false,
        supportsQuotaStatus: false,
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
          resolvePendingUserInput: () => false,
        }
      },
    })
    const { _getControllers, getRunningCount, startAgent, stopAgentAndWait } = await import(
      '../../server/services/agent/orchestrator.js'
    )
    startAgent(ws.id, '/tmp', 'first')
    await flushControllerStart()

    await stopAgentAndWait(ws.id)
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
        supportsLiveSteering: true,
        supportsReadOnly: true,
        supportsSkills: true,
        supportsSubagents: false,
        supportsQuotaStatus: false,
      },
      async start(_opts, onEvent) {
        emitEv = onEvent
        return {
          pid: 1,
          engineSessionId: 'sid',
          sendMessage() {},
          interrupt() {},
          async stop() {},
          resolvePendingUserInput: () => false,
        }
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

  it.each([false, true])(
    'recovers on a new tool call, including before the quota lookup resolves (early=%s)',
    async (early) => {
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
          supportsLiveSteering: true,
          supportsReadOnly: true,
          supportsSkills: true,
          supportsSubagents: false,
          supportsQuotaStatus: false,
        },
        async start(_opts, onEvent) {
          emitEv = onEvent
          return {
            pid: 1,
            engineSessionId: 'sid',
            sendMessage() {},
            interrupt() {},
            async stop() {},
            resolvePendingUserInput: () => false,
          }
        },
      })
      const { startAgent, _getRetryCounts } = await import('../../server/services/agent/orchestrator.js')
      const quotaBackoffService = await import('../../server/services/quota-backoff-service.js')
      startAgent(ws.id, '/tmp', 'hi')
      await flushControllerStart()
      emitEv({ kind: 'error', category: 'quota', message: 'rate limit' })
      if (early)
        emitEv({ kind: 'tool:call', messageId: 'resumed-message', toolCallId: 'early-tool', name: 'Read', input: {} })
      // Let the pending usage lookup settle before checking for stale retries.
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      if (!early) {
        expect(getWorkspace(ws.id)?.status).toBe('quota')
        expect(quotaBackoffService.getPending(ws.id)).not.toBeNull()
        expect(_getRetryCounts().get(ws.id)).toBe(1)
      }
      emitEv({ kind: 'tool:call', messageId: 'resumed-message', toolCallId: 'resumed-tool', name: 'Read', input: {} })
      expect(getWorkspace(ws.id)?.status).toBe('executing')
      expect(quotaBackoffService.getPending(ws.id)).toBeNull()
      expect(_getRetryCounts().has(ws.id)).toBe(false)
      emitEv({ kind: 'session:ended', reason: 'completed', exitCode: 0 })
      expect(getWorkspace(ws.id)?.status).not.toBe('quota')
      quotaBackoffService.cancel(ws.id, 'user')
      _getRetryCounts().clear()
    },
  )

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
          supportsLiveSteering: true,
          supportsReadOnly: true,
          supportsSkills: true,
          supportsSubagents: false,
          supportsQuotaStatus: false,
        },
        async start(_opts, onEvent) {
          emitEv = onEvent
          return {
            pid: 1,
            engineSessionId: 'sid',
            sendMessage() {},
            interrupt() {},
            async stop() {},
            resolvePendingUserInput: () => false,
          }
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
        supportsLiveSteering: true,
        supportsReadOnly: true,
        supportsSkills: true,
        supportsSubagents: false,
        supportsQuotaStatus: false,
      },
      async start(_opts, onEvent) {
        emitEv = onEvent
        return {
          pid: 1,
          engineSessionId: 'sid',
          sendMessage() {},
          interrupt() {},
          async stop() {},
          resolvePendingUserInput: () => false,
        }
      },
    })
    const { startAgent } = await import('../../server/services/agent/orchestrator.js')
    startAgent(ws.id, '/tmp', 'brainstorm')
    await flushControllerStart()
    emitEv({ kind: 'session:brainstorm-complete' })
    expect(getWorkspace(ws.id)?.status).toBe('executing')
  })

  it.each([
    { reason: 'completed', exitCode: 0, status: 'completed' },
    { reason: 'watchdog', exitCode: null, status: 'idle' },
    { reason: 'watchdog', exitCode: 1, status: 'error' },
    { reason: 'error', exitCode: null, status: 'error' },
  ] as const)(
    'onSessionEnded with $reason and exitCode $exitCode transitions workspace to $status',
    async ({ reason, exitCode, status }) => {
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
          supportsLiveSteering: true,
          supportsReadOnly: true,
          supportsSkills: true,
          supportsSubagents: false,
          supportsQuotaStatus: false,
        },
        async start(_opts, onEvent) {
          emitEv = onEvent
          return {
            pid: 1,
            engineSessionId: 'sid',
            sendMessage() {},
            interrupt() {},
            async stop() {},
            resolvePendingUserInput: () => false,
          }
        },
      })
      const { startAgent, _getControllers, _getRetryCounts } = await import(
        '../../server/services/agent/orchestrator.js'
      )
      const { agentSessionId } = startAgent(ws.id, '/tmp', 'hi')
      await flushControllerStart()
      emitEv({ kind: 'session:ended', reason, exitCode })
      expect(getWorkspace(ws.id)?.status).toBe(status)
      const { getDb } = await import('../../server/db/index.js')
      expect(getDb().prepare('SELECT end_reason FROM agent_sessions WHERE id = ?').get(agentSessionId)).toEqual({
        end_reason: reason,
      })
      expect(_getControllers().has(ws.id)).toBe(false)
      expect(_getRetryCounts().has(ws.id)).toBe(false)
    },
  )

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
        supportsLiveSteering: true,
        supportsReadOnly: true,
        supportsSkills: true,
        supportsSubagents: false,
        supportsQuotaStatus: false,
      },
      async start(_opts, onEvent) {
        emitEv = onEvent
        return {
          pid: 1,
          engineSessionId: 'sid',
          sendMessage() {},
          interrupt() {},
          async stop() {},
          resolvePendingUserInput: () => false,
        }
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
        supportsLiveSteering: true,
        supportsReadOnly: true,
        supportsSkills: true,
        supportsSubagents: false,
        supportsQuotaStatus: false,
      },
      async start(_opts, _onEvent) {
        return {
          pid: 7777,
          engineSessionId: 'sid-resume',
          sendMessage() {},
          interrupt() {},
          async stop() {},
          resolvePendingUserInput: () => false,
        }
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
    const { agentSessionId } = startAgent(ws.id, '/tmp', 'resume me', undefined, true, 'bypass', existingId)

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
    expect(() => startAgent(ws.id, '/tmp', 'ghost', undefined, true, 'bypass', 'does-not-exist')).toThrow(
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
        supportsLiveSteering: true,
        supportsReadOnly: true,
        supportsSkills: true,
        supportsSubagents: false,
        supportsQuotaStatus: false,
      },
      async start(_opts, _onEvent) {
        // D1 — the pid is never a liveness criterion; an explicit `isAlive`
        // returning false is what the watchdog now acts on.
        return {
          pid: 999_999,
          engineSessionId: 'sid-dead',
          sendMessage() {},
          interrupt() {},
          async stop() {},
          resolvePendingUserInput: () => false,
          isAlive: () => false,
        }
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

  it('marks a running session as error even when its recorded pid is still alive', async () => {
    // D1 — the `controllers` map is the only liveness source of truth, and it
    // is empty by definition at boot. The pid column is never consulted, so a
    // pid that happens to be alive (recycled by another program after a
    // machine restart, or `process.pid` itself here) changes nothing.
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
    expect(row.status).toBe('error')
    expect(row.ended_at).not.toBeNull()
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
        supportsLiveSteering: true,
        supportsReadOnly: true,
        supportsSkills: true,
        supportsSubagents: false,
        supportsQuotaStatus: false,
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
          resolvePendingUserInput: () => false,
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
        supportsLiveSteering: true,
        supportsReadOnly: true,
        supportsSkills: true,
        supportsSubagents: false,
        supportsQuotaStatus: false,
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
          resolvePendingUserInput: () => false,
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

describe('Orchestrator - stopSubagents', () => {
  beforeEach(async () => {
    vi.resetModules()
    await resetDb()
  })

  async function startWithProcess(extra: Record<string, unknown>) {
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
        supportsLiveSteering: true,
        supportsReadOnly: true,
        supportsSkills: true,
        supportsSubagents: true,
        supportsQuotaStatus: false,
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
          resolvePendingUserInput: () => false,
          ...extra,
        }
      },
    })
    const orchestrator = await import('../../server/services/agent/orchestrator.js')
    orchestrator.startAgent(ws.id, '/tmp', 'hi')
    await flushControllerStart()
    return { ws, orchestrator, interruptCalls: () => interruptCalls }
  }

  it('throws no_agent_running when no agent is running', async () => {
    const { stopSubagents, StopSubagentsError } = await import('../../server/services/agent/orchestrator.js')
    let thrown: unknown
    try {
      stopSubagents('nope')
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(StopSubagentsError)
    expect(thrown).toMatchObject({ code: 'no_agent_running' })
  })

  it('throws unsupported when the engine cannot stop a single sub-agent', async () => {
    const { ws, orchestrator } = await startWithProcess({})
    let thrown: unknown
    try {
      orchestrator.stopSubagents(ws.id)
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(orchestrator.StopSubagentsError)
    expect(thrown).toMatchObject({ code: 'unsupported' })
  })

  it('passes the id to the engine and returns the count, without interrupting the turn', async () => {
    const stopSubagentsMock = vi.fn((_ids?: string[]) => 1)
    const { ws, orchestrator, interruptCalls } = await startWithProcess({ stopSubagents: stopSubagentsMock })

    expect(orchestrator.stopSubagents(ws.id, 'toolu_a')).toBe(1)
    expect(stopSubagentsMock).toHaveBeenCalledWith(['toolu_a'])
    expect(interruptCalls()).toBe(0)
  })

  it('stops every sub-agent when no id is given, even when none is running', async () => {
    const stopSubagentsMock = vi.fn((_ids?: string[]) => 0)
    const { ws, orchestrator } = await startWithProcess({ stopSubagents: stopSubagentsMock })

    expect(orchestrator.stopSubagents(ws.id)).toBe(0)
    expect(stopSubagentsMock).toHaveBeenCalledWith(undefined)
  })

  it('throws subagent_not_running when the targeted sub-agent is not running', async () => {
    const { ws, orchestrator } = await startWithProcess({ stopSubagents: () => 0 })
    let thrown: unknown
    try {
      orchestrator.stopSubagents(ws.id, 'gone')
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(orchestrator.StopSubagentsError)
    expect(thrown).toMatchObject({ code: 'subagent_not_running' })
  })
})

describe('isAgentUnavailableError', () => {
  it('recognises every shape that means "resume instead of rejecting"', async () => {
    const { isAgentUnavailableError } = await import('../../server/services/agent/orchestrator.js')

    expect(isAgentUnavailableError("No agent running for workspace 'w1'")).toBe(true)
    // Thrown by the Claude engine once a one-prompt-one-turn session closed
    // its stdin — the shape that used to silently drop the user's message.
    expect(isAgentUnavailableError('Claude input stream is closed')).toBe(true)
    expect(isAgentUnavailableError('Claude agent is no longer running')).toBe(true)
  })

  it('never swallows a stop in progress or an unstarted controller', async () => {
    const { isAgentUnavailableError } = await import('../../server/services/agent/orchestrator.js')

    // Resuming during a teardown would start a second agent on the worktree —
    // exactly the race the stopping state exists to close. Reject visibly.
    expect(isAgentUnavailableError('SessionController is stopping')).toBe(false)
    expect(isAgentUnavailableError('SessionController not started')).toBe(false)
    expect(isAgentUnavailableError('Claude input queue is full (max 20 messages)')).toBe(false)
    expect(isAgentUnavailableError('ENOSPC: no space left on device')).toBe(false)
  })

  it('recognises the Codex engine reusing the "agent is no longer running" shape', async () => {
    const { isAgentUnavailableError } = await import('../../server/services/agent/orchestrator.js')

    // Thrown by the Codex engine's sendMessage guard (codex/engine.ts) once a
    // session has fully ended (JSON-RPC peer closed, child killed) and a
    // message arrives afterward — Codex's own equivalent of the Claude
    // "stdin closed" case above. It deliberately reuses this already-
    // recognized substring instead of a fourth, engine-specific pattern.
    expect(isAgentUnavailableError('Codex agent is no longer running')).toBe(true)
  })

  it('distinguishes a Codex session that never reached its first turn from one that already ended', async () => {
    const { isAgentUnavailableError } = await import('../../server/services/agent/orchestrator.js')

    // Thrown before discoveredSessionId/activeTurnId are ever established.
    // Unlike the ended-session case above, resuming here could mask a
    // genuine startup failure (bad model config, broken install) behind a
    // silent resume loop — so it deliberately stays an unrecognized, visible
    // rejection, the Codex analogue of Claude's "SessionController not
    // started" exclusion.
    expect(isAgentUnavailableError('Codex session is not ready to receive a message')).toBe(false)
    // The ended-after-a-turn case above, for direct contrast in this same test.
    expect(isAgentUnavailableError('Codex agent is no longer running')).toBe(true)
  })
})
