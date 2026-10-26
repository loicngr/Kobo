import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MISTRAL_CAPABILITIES } from '../../server/services/agent/engines/mistral-vibe/capabilities.js'
import type { AgentEngine, AgentEvent, EngineProcess, StartOptions } from '../../server/services/agent/engines/types.js'
import { resetDb } from '../helpers/reset-db.js'

const networkSettings = vi.hoisted(() => ({
  agentWatchdogEnabled: false,
  networkAccessEnabled: true,
  networkAccessBehindProxy: false,
  networkAccessToken: 'test-network-token',
}))
vi.mock('@hono/node-server/conninfo', () => ({
  getConnInfo: () => ({ remote: { address: '127.0.0.1' } }),
}))
vi.mock('../../server/services/websocket-service.js', () => ({
  emit: vi.fn(),
  emitEphemeral: vi.fn(),
  broadcastAll: vi.fn(),
}))
vi.mock('../../server/services/settings-service.js', () => ({
  getGlobalSettings: () => ({ autoLoopMaxRetries: 5, memoryMode: 'hybrid', ...networkSettings }),
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
vi.mock('../../server/services/usage/poller.js', () => ({ refreshNow: vi.fn().mockResolvedValue(null) }))

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

interface EngineCapture {
  engine: AgentEngine
  starts: StartOptions[]
  events: Array<(event: AgentEvent) => void>
  releaseStop: () => void
}

function makeEngine(id: 'claude-code' | 'codex' | 'mistral-vibe', gateStop = false): EngineCapture {
  const starts: StartOptions[] = []
  const events: Array<(event: AgentEvent) => void> = []
  const pendingStops: Array<() => void> = []
  const engine: AgentEngine = {
    id,
    displayName: id,
    capabilities:
      id === 'mistral-vibe'
        ? { ...MISTRAL_CAPABILITIES }
        : {
            models: [{ id: 'auto', label: 'Auto' }],
            effortLevels: [{ id: 'auto', label: 'Auto' }],
            permissionModes: ['bypass'],
            supportsResume: true,
            supportsMcp: true,
            supportsLiveSteering: true,
            supportsReadOnly: true,
            supportsSkills: true,
            supportsSubagents: false,
            supportsQuotaStatus: false,
          },
    async start(options, onEvent) {
      starts.push(options)
      events.push(onEvent)
      const ready =
        options.model === 'ready-rejection' ? Promise.reject(new Error('native init failed')) : Promise.resolve()
      void ready.catch(() => {})
      const process: EngineProcess = {
        pid: undefined,
        engineSessionId: options.resumeFromEngineSessionId ?? `${id}-native-${starts.length}`,
        ready,
        isAlive: () => true,
        sendMessage() {},
        interrupt() {},
        async stop() {
          if (gateStop) await new Promise<void>((resolve) => pendingStops.push(resolve))
        },
        resolvePendingUserInput: () => false,
      }
      onEvent({ kind: 'session:started', engineSessionId: process.engineSessionId! })
      return process
    },
  }
  return { engine, starts, events, releaseStop: () => pendingStops.shift()?.() }
}

async function createWorkspace(engine: 'claude-code' | 'codex' | 'mistral-vibe' = 'claude-code') {
  const { createWorkspace } = await import('../../server/services/workspace-service.js')
  const workspace = createWorkspace({
    name: `Memory ${engine}`,
    projectPath: `/tmp/memory-${engine}`,
    sourceBranch: 'main',
    workingBranch: `feature/memory-${engine}`,
  })
  const { getDb } = await import('../../server/db/index.js')
  getDb().prepare('UPDATE workspaces SET engine = ? WHERE id = ?').run(engine, workspace.id)
  return workspace
}

describe('orchestrator memory context', () => {
  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    networkSettings.networkAccessBehindProxy = false
    networkSettings.agentWatchdogEnabled = false
    await resetDb()
  })

  it.each(['claude-code', 'codex', 'mistral-vibe'] as const)(
    'captures the global watchdog setting on each %s launch',
    async (engineId) => {
      const workspace = await createWorkspace(engineId)
      const capture = makeEngine(engineId)
      const { _registerEngineForTest } = await import('../../server/services/agent/engines/registry.js')
      _registerEngineForTest(capture.engine)
      const orchestrator = await import('../../server/services/agent/orchestrator.js')
      for (const enabled of [false, true, false]) {
        networkSettings.agentWatchdogEnabled = enabled
        orchestrator.startAgent(workspace.id, workspace.projectPath, 'Run task')
        await flush()
        expect(capture.starts.at(-1)?.watchdogEnabled).toBe(enabled)
        await orchestrator.stopAgentAndWait(workspace.id)
      }
    },
  )

  it.each([
    ['claude-code', false],
    ['claude-code', true],
    ['codex', false],
    ['codex', true],
    ['mistral-vibe', false],
    ['mistral-vibe', true],
  ] as const)('authenticates internal %s MCP calls with behind-proxy mode %s', async (engineId, behindProxy) => {
    networkSettings.networkAccessBehindProxy = behindProxy
    const workspace = await createWorkspace(engineId)
    const capture = makeEngine(engineId)
    const { _registerEngineForTest } = await import('../../server/services/agent/engines/registry.js')
    _registerEngineForTest(capture.engine)
    const orchestrator = await import('../../server/services/agent/orchestrator.js')
    const { Hono } = await import('hono')
    const { networkAuthMiddleware } = await import('../../server/middleware/network-auth-middleware.js')
    const { default: managedRoutes } = await import('../../server/routes/internal-mcp.js')
    const app = new Hono()
    app.use('/api/*', networkAuthMiddleware)
    app.route('/api/internal-mcp', managedRoutes)

    orchestrator.startAgent(workspace.id, workspace.projectPath, 'Long-running task')
    await flush()
    try {
      const env = capture.starts[0].mcpServers!.find((server) => server.name === 'kobo-tasks')!.env
      expect(env.KOBO_NETWORK_TOKEN).toBeUndefined()
      const call = async (name: string, args: Record<string, unknown> = {}, token = env.KOBO_MCP_SESSION_TOKEN) => {
        const response = await app.request('/api/internal-mcp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Kobo-Mcp-Session': token },
          body: JSON.stringify({ method: 'call', name, arguments: args }),
        })
        return { status: response.status, result: await response.json() }
      }
      const memory = await call('list_memory_scopes')
      expect(memory.status).toBe(200)
      expect(JSON.parse(memory.result.content[0].text)).toMatchObject({ items: expect.any(Array) })
      const progress = await call('create_progress_bar', { activity_key: 'proxy-test', label: 'Run tests' })
      expect(progress.status).toBe(200)
      expect(progress.result.isError).toBeUndefined()
      expect(progress.result.structuredContent).toMatchObject({ label: 'Run tests', workspaceId: workspace.id })
      expect((await call('list_memory_scopes', {}, 'invalid-capability')).status).toBe(403)
      // The administrator secret cannot be substituted for a launch capability.
      expect((await call('list_memory_scopes', {}, networkSettings.networkAccessToken)).status).toBe(403)
    } finally {
      await orchestrator.stopAgentAndWait(workspace.id)
    }
  })

  it.each(['claude-code', 'codex', 'mistral-vibe'] as const)(
    'passes one bounded memory prompt through %s StartOptions',
    async (engineId) => {
      const { createMemory, resolveMemoryScope } = await import('../../server/services/memory-service.js')
      const workspace = await createWorkspace(engineId)
      const scope = resolveMemoryScope({ level: 'workspace', workspaceId: workspace.id })
      createMemory({
        scopeId: scope.id,
        key: 'stable-fact',
        title: 'Stable fact',
        body: 'Persisted context.',
        actor: { kind: 'human' },
      })
      const capture = makeEngine(engineId)
      const { _registerEngineForTest } = await import('../../server/services/agent/engines/registry.js')
      _registerEngineForTest(capture.engine)
      const orchestrator = await import('../../server/services/agent/orchestrator.js')
      const { getDb } = await import('../../server/db/index.js')

      orchestrator.startAgent(workspace.id, workspace.projectPath, 'User task')
      await flush()

      expect(capture.starts).toHaveLength(1)
      expect(capture.starts[0].prompt.match(/<kobo-memory-context>/g)).toHaveLength(1)
      expect(capture.starts[0].prompt).toContain('Persisted context.')
      const state = getDb().prepare('SELECT state FROM memory_contexts WHERE workspace_id = ?').get(workspace.id)
      expect(state).toEqual({ state: 'initialized' })
      await orchestrator.stopAgentAndWait(workspace.id)
    },
  )

  it('lets a Codex workspace read approved project memory authored in a Claude workspace', async () => {
    const claudeWorkspace = await createWorkspace('claude-code')
    const codexWorkspace = await createWorkspace('codex')
    const { getDb } = await import('../../server/db/index.js')
    getDb()
      .prepare('UPDATE workspaces SET project_path = ? WHERE id = ?')
      .run(claudeWorkspace.projectPath, codexWorkspace.id)
    const claudeSession = (await import('../../server/services/workspace-service.js')).createIdleSession(
      claudeWorkspace.id,
    )
    const { resolveMemoryScope, createMemory } = await import('../../server/services/memory-service.js')
    const projectScope = resolveMemoryScope({ level: 'project', projectPath: claudeWorkspace.projectPath })
    createMemory({
      scopeId: projectScope.id,
      key: 'claude.shared.fact',
      title: 'Shared Claude fact',
      body: 'Use the verified shared convention.',
      actor: {
        kind: 'internal-agent',
        workspaceId: claudeWorkspace.id,
        sessionId: claudeSession.id,
        engine: 'claude-code',
      },
    })
    const capture = makeEngine('codex')
    const { _registerEngineForTest } = await import('../../server/services/agent/engines/registry.js')
    _registerEngineForTest(capture.engine)
    const orchestrator = await import('../../server/services/agent/orchestrator.js')

    orchestrator.startAgent(codexWorkspace.id, codexWorkspace.projectPath, 'Use shared context')
    await flush()

    expect(capture.starts[0]?.prompt).toContain('Use the verified shared convention.')
    await orchestrator.stopAgentAndWait(codexWorkspace.id)
  })

  it.each(['claude-code', 'mistral-vibe'] as const)(
    'resumes the same %s native conversation with only newly added memory',
    async (engineId) => {
      const { createMemory, resolveMemoryScope } = await import('../../server/services/memory-service.js')
      const workspace = await createWorkspace(engineId)
      const scope = resolveMemoryScope({ level: 'workspace', workspaceId: workspace.id })
      createMemory({
        scopeId: scope.id,
        key: 'old',
        title: 'Old',
        body: 'Already in conversation.',
        actor: { kind: 'human' },
      })
      const capture = makeEngine(engineId)
      const { _registerEngineForTest } = await import('../../server/services/agent/engines/registry.js')
      _registerEngineForTest(capture.engine)
      const orchestrator = await import('../../server/services/agent/orchestrator.js')

      const initial = orchestrator.startAgent(workspace.id, workspace.projectPath, 'First')
      await flush()
      await orchestrator.stopAgentAndWait(workspace.id)
      createMemory({
        scopeId: scope.id,
        key: 'new',
        title: 'New',
        body: 'Added before resume.',
        actor: { kind: 'human' },
      })

      orchestrator.startAgent(
        workspace.id,
        workspace.projectPath,
        'Resume',
        undefined,
        true,
        undefined,
        initial.agentSessionId,
      )
      await flush()

      expect(capture.starts).toHaveLength(2)
      expect(capture.starts[1].resumeFromEngineSessionId).toBe(`${engineId}-native-1`)
      expect(capture.starts[1].prompt).toContain('Added before resume.')
      expect(capture.starts[1].prompt).not.toContain('Already in conversation.')
      await orchestrator.stopAgentAndWait(workspace.id)
    },
  )

  it('opens exactly one new budget epoch only for confirmed compaction by the current controller', async () => {
    const workspace = await createWorkspace()
    const capture = makeEngine('claude-code')
    const { _registerEngineForTest } = await import('../../server/services/agent/engines/registry.js')
    _registerEngineForTest(capture.engine)
    const orchestrator = await import('../../server/services/agent/orchestrator.js')
    const { getDb } = await import('../../server/db/index.js')

    orchestrator.startAgent(workspace.id, workspace.projectPath, 'First')
    await flush()
    capture.events[0]({ kind: 'session:compacted' })
    capture.events[0]({ kind: 'session:compacted' })
    expect(getDb().prepare('SELECT MAX(epoch) AS epoch FROM memory_budget_contexts').get()).toEqual({ epoch: 1 })
    await orchestrator.stopAgentAndWait(workspace.id)
  })

  it('revokes the memory capability as soon as the controller starts stopping', async () => {
    const workspace = await createWorkspace()
    const capture = makeEngine('claude-code', true)
    const { _registerEngineForTest } = await import('../../server/services/agent/engines/registry.js')
    _registerEngineForTest(capture.engine)
    const orchestrator = await import('../../server/services/agent/orchestrator.js')
    const { getMemoryCapability } = await import('../../server/services/memory-agent-runtime.js')

    orchestrator.startAgent(workspace.id, workspace.projectPath, 'Stop me')
    await flush()
    const token = capture.starts[0].mcpServers?.find((server) => server.name === 'kobo-tasks')?.env
      .KOBO_MEMORY_SESSION_TOKEN
    expect(getMemoryCapability(token)).toBeDefined()

    const stopping = orchestrator.stopAgentAndWait(workspace.id)
    await flush()
    expect(getMemoryCapability(token)).toBeUndefined()
    capture.releaseStop()
    await stopping
  })

  it('opens a fresh epoch for every distinct compaction cycle and deduplicates repeated boundaries', async () => {
    const workspace = await createWorkspace()
    const capture = makeEngine('claude-code')
    const { _registerEngineForTest } = await import('../../server/services/agent/engines/registry.js')
    _registerEngineForTest(capture.engine)
    const orchestrator = await import('../../server/services/agent/orchestrator.js')
    const { getDb } = await import('../../server/db/index.js')

    orchestrator.startAgent(workspace.id, workspace.projectPath, 'First')
    await flush()
    capture.events[0]({ kind: 'session:compacting', active: true, compactionId: 'compact-a' })
    capture.events[0]({ kind: 'session:compacted', compactionId: 'compact-a' })
    capture.events[0]({ kind: 'session:compacted', compactionId: 'compact-a' })
    capture.events[0]({ kind: 'session:compacting', active: true, compactionId: 'compact-b' })
    capture.events[0]({ kind: 'session:compacted', compactionId: 'compact-b' })

    expect(getDb().prepare('SELECT MAX(epoch) AS epoch FROM memory_budget_contexts').get()).toEqual({ epoch: 2 })
    await orchestrator.stopAgentAndWait(workspace.id)
  })

  it('builds the replacement prompt after a zombie wait so a memory clear takes effect', async () => {
    const { createMemory, resolveMemoryScope, clearMemoryScope } = await import(
      '../../server/services/memory-service.js'
    )
    const workspace = await createWorkspace()
    const scope = resolveMemoryScope({ level: 'workspace', workspaceId: workspace.id })
    createMemory({
      scopeId: scope.id,
      key: 'temporary',
      title: 'Temporary',
      body: 'Must disappear before dispatch.',
      actor: { kind: 'human' },
    })
    const capture = makeEngine('claude-code', true)
    const { _registerEngineForTest } = await import('../../server/services/agent/engines/registry.js')
    _registerEngineForTest(capture.engine)
    const orchestrator = await import('../../server/services/agent/orchestrator.js')
    const { getDb } = await import('../../server/db/index.js')

    orchestrator.startAgent(workspace.id, workspace.projectPath, 'First task')
    await flush()
    getDb().prepare("UPDATE workspaces SET status = 'idle' WHERE id = ?").run(workspace.id)
    orchestrator.startAgent(workspace.id, workspace.projectPath, 'Replacement task')
    await flush()
    expect(capture.starts).toHaveLength(1)

    clearMemoryScope({ scopeId: scope.id, expectedRevision: 1, actor: { kind: 'human' } })
    capture.events[0]({ kind: 'session:compacted' })
    expect(getDb().prepare('SELECT MAX(epoch) AS epoch FROM memory_budget_contexts').get()).toEqual({ epoch: 0 })
    capture.releaseStop()
    await flush()

    expect(capture.starts).toHaveLength(2)
    expect(capture.starts[1].prompt).not.toContain('Must disappear before dispatch.')
    capture.events[0]({ kind: 'session:compacted' })
    expect(getDb().prepare('SELECT MAX(epoch) AS epoch FROM memory_budget_contexts').get()).toEqual({ epoch: 0 })
    capture.events[1]({ kind: 'session:compacted' })
    expect(getDb().prepare('SELECT MAX(epoch) AS epoch FROM memory_budget_contexts').get()).toEqual({ epoch: 1 })
    const stopping = orchestrator.stopAgentAndWait(workspace.id)
    await flush()
    capture.releaseStop()
    await stopping
  })

  it('does not inject handoff report-only turns and marks native initialization failure honestly', async () => {
    const workspace = await createWorkspace()
    const capture = makeEngine('claude-code')
    const { _registerEngineForTest } = await import('../../server/services/agent/engines/registry.js')
    _registerEngineForTest(capture.engine)
    const orchestrator = await import('../../server/services/agent/orchestrator.js')
    const { getDb } = await import('../../server/db/index.js')

    orchestrator.startAgent(
      workspace.id,
      workspace.projectPath,
      'Report only',
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      undefined,
      { handoffGeneration: true },
    )
    await flush()
    expect(capture.starts[0].prompt).not.toContain('<kobo-memory-context>')
    await orchestrator.stopAgentAndWait(workspace.id)

    const failed = makeEngine('claude-code')
    failed.engine.start = async (options) => {
      failed.starts.push(options)
      return {
        pid: undefined,
        engineSessionId: 'native-failed',
        ready: Promise.reject(new Error('native init failed')),
        sendMessage() {},
        interrupt() {},
        async stop() {},
        resolvePendingUserInput: () => false,
      }
    }
    _registerEngineForTest(failed.engine)
    const nextWorkspace = await createWorkspace()
    orchestrator.startAgent(nextWorkspace.id, nextWorkspace.projectPath, 'Fails initialization')
    await flush()
    const state = getDb().prepare('SELECT state FROM memory_contexts WHERE workspace_id = ?').get(nextWorkspace.id)
    expect(state).toEqual({ state: 'failed' })
  })
})

describe('Mistral launch integration', () => {
  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    await resetDb()
  })
  it.each(['plan', 'handoff'] as const)(
    'rejects unsupported %s launch before clearing grants, stopping or allocating state',
    async (kind) => {
      const workspace = await createWorkspace('mistral-vibe')
      const capture = makeEngine('mistral-vibe')
      const { _registerEngineForTest } = await import('../../server/services/agent/engines/registry.js')
      _registerEngineForTest(capture.engine)
      const orch = await import('../../server/services/agent/orchestrator.js')
      const { getDb } = await import('../../server/db/index.js')
      const policy = await import('../../server/services/workspace-permission-policy-service.js')
      orch.startAgent(workspace.id, workspace.projectPath, 'First', 'auto')
      await flush()
      getDb().prepare("UPDATE workspaces SET status='idle' WHERE id=?").run(workspace.id)
      const original = orch._getControllers().get(workspace.id)
      const clear = vi.spyOn(policy, 'clearTurnPermissions').mockClear()
      const count = () => getDb().prepare('SELECT COUNT(*) AS n FROM agent_sessions').get()
      const before = count()
      const launch = kind === 'handoff' ? { handoffGeneration: true } : undefined
      expect(() =>
        orch.startAgent(
          workspace.id,
          workspace.projectPath,
          'Unsupported',
          'auto',
          false,
          kind === 'plan' ? 'plan' : 'bypass',
          undefined,
          'auto',
          undefined,
          launch,
        ),
      ).toThrow('read-only')
      expect(clear).not.toHaveBeenCalled()
      expect(count()).toEqual(before)
      expect(orch._getControllers().get(workspace.id)).toBe(original)
      expect(original?.status).toBe('running')
      expect(capture.starts).toHaveLength(1)
      await orch.stopAgentAndWait(workspace.id)
    },
  )

  it('starts a native final reviewer with restricted memory/MCP grants independently of Interactive mode', async () => {
    const workspace = await createWorkspace('mistral-vibe')
    const capture = makeEngine('mistral-vibe')
    const { _registerEngineForTest } = await import('../../server/services/agent/engines/registry.js')
    _registerEngineForTest(capture.engine)
    const orch = await import('../../server/services/agent/orchestrator.js')
    const { createIdleSession } = await import('../../server/services/workspace-service.js')
    const session = createIdleSession(workspace.id)
    const { authorizeInternalMcpTool, resolveInternalMcpCapability } = await import(
      '../../server/services/internal-mcp-capability-service.js'
    )
    const { getMemoryCapability } = await import('../../server/services/memory-agent-runtime.js')
    orch.startAgent(
      workspace.id,
      workspace.projectPath,
      'Review only',
      'auto',
      false,
      'interactive',
      session.id,
      'auto',
      undefined,
      {
        mcpEnv: { KOBO_FINAL_REVIEW_TOKEN: 'test-report', KOBO_FINAL_REVIEW_SESSION_ID: session.id },
      },
    )
    await flush()
    try {
      expect(capture.starts).toHaveLength(1)
      const options = capture.starts[0]!
      expect(options).toMatchObject({ agentPermissionMode: 'interactive', readOnly: false })
      expect(options.prompt).toContain('Read-only launch: do not call remember or attempt writes.')
      const token = options.mcpServers!.find((server) => server.name === 'kobo-tasks')!.env.KOBO_MCP_SESSION_TOKEN
      const capability = resolveInternalMcpCapability(token)
      expect(capability.readOnly).toBe(true)
      expect(getMemoryCapability(capability.env.KOBO_MEMORY_SESSION_TOKEN)).toMatchObject({
        readOnly: true,
        sessionId: session.id,
      })
      for (const tool of ['list_memory_scopes', 'list_tasks', 'submit_final_review', 'create_progress_bar'])
        expect(() => authorizeInternalMcpTool(token, tool, {})).not.toThrow()
      for (const tool of ['remember', 'create_task', 'create_workspace', 'delete_workspace'])
        expect(() => authorizeInternalMcpTool(token, tool, {})).toThrow('read-only')
    } finally {
      await orch.stopAgentAndWait(workspace.id)
    }
  })

  it('preserves Mistral native resume identity after acp_load_failed without a fresh fallback', async () => {
    const workspace = await createWorkspace('mistral-vibe')
    const capture = makeEngine('mistral-vibe')
    const { _registerEngineForTest } = await import('../../server/services/agent/engines/registry.js')
    _registerEngineForTest(capture.engine)
    const orch = await import('../../server/services/agent/orchestrator.js')
    const { getDb } = await import('../../server/db/index.js')
    const first = orch.startAgent(workspace.id, workspace.projectPath, 'First', 'auto')
    await flush()
    await orch.stopAgentAndWait(workspace.id)
    const { createMemory, resolveMemoryScope } = await import('../../server/services/memory-service.js')
    const scope = resolveMemoryScope({ level: 'workspace', workspaceId: workspace.id })
    createMemory({
      scopeId: scope.id,
      key: 'resume-fact',
      title: 'Resume fact',
      body: 'Charge this uncertain native load conservatively.',
      actor: { kind: 'human' },
    })
    const saved = 'mistral-vibe-native-1'
    capture.engine.start = async (options, emit) => {
      capture.starts.push(options)
      capture.events.push(emit)
      return {
        pid: undefined,
        engineSessionId: saved,
        ready: Promise.reject(new Error('Native load failed')),
        sendMessage() {},
        interrupt() {},
        async stop() {},
        resolvePendingUserInput: () => false,
      }
    }
    orch.startAgent(workspace.id, workspace.projectPath, 'Resume', 'auto', true, undefined, first.agentSessionId)
    await flush()
    expect(capture.starts[1].resumeFromEngineSessionId).toBe(saved)
    expect(capture.starts[1].prompt).toContain('Charge this uncertain native load conservatively.')
    const budget = () =>
      getDb().prepare('SELECT id, epoch, cumulative_estimated_tokens FROM memory_budget_contexts').all() as Array<{
        id: string
        epoch: number
        cumulative_estimated_tokens: number
      }>
    const charged = budget()
    expect(charged).toHaveLength(1)
    expect(charged[0].epoch).toBe(0)
    expect(charged[0].cumulative_estimated_tokens).toBeGreaterThan(0)
    expect(getDb().prepare('SELECT state FROM memory_contexts ORDER BY rowid DESC LIMIT 1').get()).toEqual({
      state: 'failed',
    })
    capture.events[1]({
      kind: 'error',
      category: 'other',
      code: 'acp_load_failed',
      message: 'Mistral Vibe could not load the saved session',
    })
    capture.events[1]({ kind: 'session:ended', reason: 'error', exitCode: 1 })
    await flush()
    expect(
      getDb().prepare('SELECT engine_session_id FROM agent_sessions WHERE id=?').get(first.agentSessionId),
    ).toEqual({ engine_session_id: saved })
    expect(capture.starts).toHaveLength(2)
    expect(budget()).toEqual(charged)
    expect((await import('../../server/services/workspace-service.js')).getWorkspace(workspace.id)?.status).toBe(
      'error',
    )
  })

  it('keeps an exhausted Mistral memory ledger exhausted across repeated native resume', async () => {
    const workspace = await createWorkspace('mistral-vibe')
    const capture = makeEngine('mistral-vibe')
    const { _registerEngineForTest } = await import('../../server/services/agent/engines/registry.js')
    _registerEngineForTest(capture.engine)
    const orch = await import('../../server/services/agent/orchestrator.js')
    const { getDb } = await import('../../server/db/index.js')
    const { reserveMemoryBudget, reserveMemoryBudgetDenial } = await import(
      '../../server/services/memory-budget-service.js'
    )
    const first = orch.startAgent(workspace.id, workspace.projectPath, 'First', 'auto')
    await flush()
    await orch.stopAgentAndWait(workspace.id)
    const ledger = getDb()
      .prepare('SELECT id,epoch,cumulative_estimated_tokens AS charged FROM memory_budget_contexts')
      .get() as { id: string; epoch: number; charged: number }
    expect(reserveMemoryBudget({ budgetContextId: ledger.id, estimatedTokens: 5_500 - ledger.charged }).accepted).toBe(
      true,
    )
    expect(reserveMemoryBudgetDenial(ledger.id, 500).responseAllowed).toBe(true)
    const exhausted = getDb().prepare('SELECT id,epoch,cumulative_estimated_tokens FROM memory_budget_contexts').all()
    for (let attempt = 0; attempt < 2; attempt++) {
      orch.startAgent(workspace.id, workspace.projectPath, 'Resume', 'auto', true, undefined, first.agentSessionId)
      await flush()
      expect(capture.starts[attempt + 1]!.resumeFromEngineSessionId).toBe('mistral-vibe-native-1')
      expect(getDb().prepare('SELECT id,epoch,cumulative_estimated_tokens FROM memory_budget_contexts').all()).toEqual(
        exhausted,
      )
      expect(reserveMemoryBudget({ budgetContextId: ledger.id, estimatedTokens: 1 }).accepted).toBe(false)
      expect(reserveMemoryBudgetDenial(ledger.id, 1).responseAllowed).toBe(false)
      await orch.stopAgentAndWait(workspace.id)
    }
  })
})
