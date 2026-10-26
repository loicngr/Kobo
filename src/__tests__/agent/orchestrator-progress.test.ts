import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MISTRAL_CAPABILITIES } from '../../server/services/agent/engines/mistral-vibe/capabilities.js'
import type { AgentEngine, AgentEvent, EngineProcess, StartOptions } from '../../server/services/agent/engines/types.js'
import { resetDb } from '../helpers/reset-db.js'

vi.mock('../../server/services/websocket-service.js', () => ({
  emit: vi.fn(),
  emitEphemeral: vi.fn(),
  broadcastAll: vi.fn(),
}))
vi.mock('../../server/services/settings-service.js', () => ({
  getGlobalSettings: () => ({ autoLoopMaxRetries: 5, memoryMode: 'hybrid' }),
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
        engineSessionId: `${id}-native-${starts.length}`,
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

describe('orchestrator progress capabilities', () => {
  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    await resetDb()
  })
  it.each(['claude-code', 'codex', 'mistral-vibe'] as const)(
    'scopes initial and resumed %s launches and preserves instructions',
    async (engineId) => {
      const workspace = await createWorkspace(engineId)
      const capture = makeEngine(engineId, true)
      const { _registerEngineForTest } = await import('../../server/services/agent/engines/registry.js')
      _registerEngineForTest(capture.engine)
      const orchestrator = await import('../../server/services/agent/orchestrator.js')
      const runtime = await import('../../server/services/progress-bar-runtime.js')
      const progress = await import('../../server/services/progress-bar-service.js')
      const initial = orchestrator.startAgent(workspace.id, workspace.projectPath, 'Custom Notion task')
      await flush()
      const opts = capture.starts[0]
      const token = opts.mcpServers!.find((s) => s.name === 'kobo-tasks')!.env.KOBO_PROGRESS_SESSION_TOKEN
      expect(token).toBeTruthy()
      const internal = await import('../../server/services/internal-mcp-capability-service.js')
      const managedEnv = opts.mcpServers!.find((s) => s.name === 'kobo-tasks')!.env
      expect(managedEnv).not.toHaveProperty('KOBO_NETWORK_TOKEN')
      expect(managedEnv).not.toHaveProperty('KOBO_DB_PATH')
      const internalToken = managedEnv.KOBO_MCP_SESSION_TOKEN
      expect(internal.authorizeInternalMcpTool(internalToken, 'create_task', {})).toMatchObject({
        workspaceId: workspace.id,
        sessionId: initial.agentSessionId,
      })
      const owner = runtime.resolveProgressCapability(token)
      expect(owner).toMatchObject({ workspaceId: workspace.id, sessionId: initial.agentSessionId })
      expect(opts.prompt).not.toContain('<kobo-progress-reporting>') // injected once by the engine builder
      const bar = progress.createProgressBar(owner, { activityKey: 'long-task', label: 'Long task' })
      const stopping = orchestrator.stopAgentAndWait(workspace.id)
      expect(() => runtime.resolveProgressCapability(token)).toThrow()
      expect(() => internal.authorizeInternalMcpTool(internalToken, 'create_task', {})).toThrow()
      expect(progress.listProgressBars(owner).items[0].status).toBe('running')
      await flush()
      capture.releaseStop()
      await stopping
      expect(progress.listProgressBars(owner).items[0]).toMatchObject({ id: bar.id, status: 'interrupted' })
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
      const token2 = capture.starts[1].mcpServers!.find((s) => s.name === 'kobo-tasks')!.env.KOBO_PROGRESS_SESSION_TOKEN
      expect(token2).not.toBe(token)
      const env2 = capture.starts[1].mcpServers!.find((s) => s.name === 'kobo-tasks')!.env
      expect(env2.KOBO_MCP_SESSION_TOKEN).not.toBe(internalToken)
      expect(env2.KOBO_MEMORY_SESSION_TOKEN).not.toBe(managedEnv.KOBO_MEMORY_SESSION_TOKEN)
      expect(() => internal.authorizeInternalMcpTool(internalToken, 'create_task', {})).toThrow()
      expect(() => internal.authorizeInternalMcpTool(env2.KOBO_MCP_SESSION_TOKEN, 'create_task', {})).not.toThrow()
      if (engineId === 'mistral-vibe') {
        const { buildMistralOptions } = await import(
          '../../server/services/agent/engines/mistral-vibe/options-builder.js'
        )
        const native = buildMistralOptions(capture.starts[1])
        const managed = native.mcpServers.find((server) => server.name === 'kobo-tasks')!
        expect('env' in managed ? managed.env : undefined).toEqual(
          Object.entries(env2).map(([name, value]) => ({ name, value })),
        )
      }
      expect(runtime.resolveProgressCapability(token2).launchId).not.toBe(owner.launchId)
      expect(capture.starts[1].prompt).not.toContain('<kobo-progress-reporting>')
      const stopping2 = orchestrator.stopAgentAndWait(workspace.id)
      await flush()
      capture.releaseStop()
      await stopping2
    },
  )

  it.each(['claude-code', 'codex'] as const)('enforces Plan in the managed MCP capability for %s', async (engineId) => {
    const workspace = await createWorkspace(engineId)
    const capture = makeEngine(engineId)
    const { _registerEngineForTest } = await import('../../server/services/agent/engines/registry.js')
    _registerEngineForTest(capture.engine)
    const orchestrator = await import('../../server/services/agent/orchestrator.js')
    const internal = await import('../../server/services/internal-mcp-capability-service.js')
    orchestrator.startAgent(workspace.id, workspace.projectPath, 'Plan only', undefined, false, 'plan')
    await flush()
    const token = capture.starts[0].mcpServers!.find((server) => server.name === 'kobo-tasks')!.env
      .KOBO_MCP_SESSION_TOKEN
    expect(() => internal.authorizeInternalMcpTool(token, 'list_tasks', {})).not.toThrow()
    expect(() => internal.authorizeInternalMcpTool(token, 'create_task', {})).toThrow(/read-only/)
    expect(() => internal.authorizeInternalMcpTool(token, 'delete_workspace', { workspace_id: 'other' })).toThrow(
      /read-only/,
    )
    await orchestrator.stopAgentAndWait(workspace.id)
    expect(() => internal.authorizeInternalMcpTool(token, 'list_tasks', {})).toThrow()
  })

  it.each(['claude-code', 'codex', 'mistral-vibe'] as const)(
    'persists prepared %s instructions once, scoped to the initial session without memory or capabilities',
    async (engineId) => {
      const workspace = await createWorkspace(engineId)
      const capture = makeEngine(engineId)
      const { _registerEngineForTest } = await import('../../server/services/agent/engines/registry.js')
      _registerEngineForTest(capture.engine)
      const memory = await import('../../server/services/memory-context-service.js')
      vi.spyOn(memory, 'buildMemoryContext').mockReturnValue({
        recordId: 'private-context',
        prompt: 'PRIVATE_MEMORY_BODY',
      } as never)
      vi.spyOn(memory, 'markMemoryContextSubmitted').mockImplementation(() => {})
      vi.spyOn(memory, 'markMemoryContextInitialized').mockImplementation(() => {})
      const { emit } = await import('../../server/services/websocket-service.js')
      const { buildKoboLaunchInstructions } = await import('../../shared/launch-instructions.js')
      const orchestrator = await import('../../server/services/agent/orchestrator.js')
      const { getWorkspace, setInitialPrompt } = await import('../../server/services/workspace-service.js')
      setInitialPrompt(workspace.id, 'Initial mission')
      const started = orchestrator.startAgent(
        workspace.id,
        workspace.projectPath,
        'Initial mission',
        undefined,
        false,
        'bypass',
        undefined,
        undefined,
        undefined,
        { persistInitialPrompt: true },
      )
      await flush()
      const opts = capture.starts[0]
      expect(opts.prompt).toContain('PRIVATE_MEMORY_BODY')
      expect(opts.autoLoop).toBe(false)
      expect(opts.onPromptPrepared).toBeTypeOf('function')
      const instructions = buildKoboLaunchInstructions({
        engine: engineId,
        permissionMode: 'bypass',
        progressReporting: true,
      })
      expect(getWorkspace(workspace.id)?.initialPrompt).toBe('Initial mission')
      opts.onPromptPrepared!(instructions)
      expect(getWorkspace(workspace.id)?.initialPrompt).toBeNull()
      opts.onPromptPrepared!(instructions)
      const messages = vi.mocked(emit).mock.calls.filter((call) => call[1] === 'user:message')
      expect(messages).toHaveLength(1)
      expect(messages[0][3]).toBe(started.agentSessionId)
      expect(messages[0][4]).toEqual({ requirePersistence: true })
      const content = (messages[0][2] as { content: string }).content
      expect(content).toContain('Initial mission')
      expect(content).toContain(instructions.promptPrefix)
      expect(content.split('<kobo-progress-reporting>')).toHaveLength(2)
      expect(content).toContain('workflow')
      expect(content).not.toContain('PRIVATE_MEMORY_BODY')
      for (const server of opts.mcpServers ?? [])
        for (const [name, value] of Object.entries(server.env))
          if (name.endsWith('TOKEN')) expect(content).not.toContain(value)
      await orchestrator.stopAgentAndWait(workspace.id)
      orchestrator.startAgent(
        workspace.id,
        workspace.projectPath,
        'Resume',
        undefined,
        true,
        undefined,
        started.agentSessionId,
      )
      await flush()
      expect(capture.starts[1].onPromptPrepared).toBeUndefined()
      await orchestrator.stopAgentAndWait(workspace.id)
    },
  )

  it('retains the pending initial prompt when memory preparation fails before the engine builder', async () => {
    const workspace = await createWorkspace()
    const capture = makeEngine('claude-code')
    const { _registerEngineForTest } = await import('../../server/services/agent/engines/registry.js')
    _registerEngineForTest(capture.engine)
    const { getWorkspace, setInitialPrompt } = await import('../../server/services/workspace-service.js')
    setInitialPrompt(workspace.id, 'Saved mission')
    const memory = await import('../../server/services/memory-context-service.js')
    vi.spyOn(memory, 'buildMemoryContext').mockImplementation(() => {
      throw new Error('memory unavailable')
    })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { emit } = await import('../../server/services/websocket-service.js')
    const orchestrator = await import('../../server/services/agent/orchestrator.js')
    orchestrator.startAgent(
      workspace.id,
      workspace.projectPath,
      'Saved mission',
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      undefined,
      { persistInitialPrompt: true },
    )
    await flush()
    expect(capture.starts).toHaveLength(0)
    expect(getWorkspace(workspace.id)?.initialPrompt).toBe('Saved mission')
    expect(vi.mocked(emit).mock.calls.filter((call) => call[1] === 'user:message')).toHaveLength(0)
    error.mockRestore()
  })

  it.each(['replaced', 'snapshot-failure'] as const)('keeps recoverable pending text after %s', async (scenario) => {
    const workspace = await createWorkspace()
    const capture = makeEngine('claude-code')
    const { _registerEngineForTest } = await import('../../server/services/agent/engines/registry.js')
    _registerEngineForTest(capture.engine)
    const { getWorkspace, setInitialPrompt } = await import('../../server/services/workspace-service.js')
    setInitialPrompt(workspace.id, 'Saved mission')
    const { emit } = await import('../../server/services/websocket-service.js')
    const orchestrator = await import('../../server/services/agent/orchestrator.js')
    orchestrator.startAgent(
      workspace.id,
      workspace.projectPath,
      'Saved mission',
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      undefined,
      { persistInitialPrompt: true },
    )
    await flush()
    const callback = capture.starts[0].onPromptPrepared!
    if (scenario === 'replaced') {
      setInitialPrompt(workspace.id, 'Replacement mission')
      callback({ promptPrefix: 'Prepared instructions', systemAppend: '' })
    } else {
      vi.mocked(emit).mockImplementationOnce(() => {
        throw new Error('snapshot unavailable')
      })
      expect(() => callback({ promptPrefix: 'Prepared instructions', systemAppend: '' })).toThrow(
        'snapshot unavailable',
      )
    }
    expect(getWorkspace(workspace.id)?.initialPrompt).toBe(
      scenario === 'replaced' ? 'Replacement mission' : 'Saved mission',
    )
    await orchestrator.stopAgentAndWait(workspace.id)
  })

  it('enforces read-only handoff generation without changing saved permission mode', async () => {
    const workspace = await createWorkspace()
    const capture = makeEngine('claude-code')
    const { _registerEngineForTest } = await import('../../server/services/agent/engines/registry.js')
    _registerEngineForTest(capture.engine)
    const orchestrator = await import('../../server/services/agent/orchestrator.js')
    orchestrator.startAgent(
      workspace.id,
      workspace.projectPath,
      'Handoff',
      undefined,
      false,
      'bypass',
      undefined,
      undefined,
      undefined,
      { handoffGeneration: true },
    )
    await flush()
    expect(capture.starts[0]).toMatchObject({ readOnly: true, agentPermissionMode: 'plan' })
    const { getWorkspace } = await import('../../server/services/workspace-service.js')
    expect(getWorkspace(workspace.id)?.agentPermissionMode).toBe(workspace.agentPermissionMode)
    await orchestrator.stopAgentAndWait(workspace.id)
  })

  it.each(['claude-code', 'mistral-vibe'] as const)(
    'does not interrupt %s reporting at logical end before actual closure',
    async (engineId) => {
      const workspace = await createWorkspace(engineId)
      const capture = makeEngine(engineId)
      let close!: () => void
      const closed = new Promise<void>((resolve) => {
        close = resolve
      })
      const original = capture.engine.start.bind(capture.engine)
      capture.engine.start = async (...args) => ({ ...(await original(...args)), closed })
      const { _registerEngineForTest } = await import('../../server/services/agent/engines/registry.js')
      _registerEngineForTest(capture.engine)
      const orchestrator = await import('../../server/services/agent/orchestrator.js')
      const runtime = await import('../../server/services/progress-bar-runtime.js')
      const progress = await import('../../server/services/progress-bar-service.js')
      orchestrator.startAgent(workspace.id, workspace.projectPath, 'Task')
      await flush()
      const token = capture.starts[0].mcpServers!.find((s) => s.name === 'kobo-tasks')!.env.KOBO_PROGRESS_SESSION_TOKEN
      const owner = runtime.resolveProgressCapability(token)
      progress.createProgressBar(owner, { activityKey: 'child', label: 'Child tests' })
      capture.events[0]({ kind: 'session:ended', reason: 'completed', exitCode: 0 })
      await flush()
      expect(runtime.resolveProgressCapability(token)).toEqual(owner)
      expect(progress.listProgressBars(owner).items[0].status).toBe('running')
      close()
      await flush()
      expect(() => runtime.resolveProgressCapability(token)).toThrow()
      expect(progress.listProgressBars(owner).items[0].status).toBe('interrupted')
    },
  )
  it('revokes a capability when synchronous dispatch admission fails', async () => {
    const workspace = await createWorkspace()
    const capture = makeEngine('claude-code')
    const { _registerEngineForTest } = await import('../../server/services/agent/engines/registry.js')
    _registerEngineForTest(capture.engine)
    const runtime = await import('../../server/services/progress-bar-runtime.js')
    const created = vi.spyOn(runtime, 'createProgressCapability')
    const orchestrator = await import('../../server/services/agent/orchestrator.js')
    expect(() =>
      orchestrator.startAgent(
        workspace.id,
        workspace.projectPath,
        'Task',
        undefined,
        false,
        undefined,
        undefined,
        undefined,
        () => {
          throw new Error('Admission closed')
        },
      ),
    ).toThrow('Admission closed')
    expect(() => runtime.resolveProgressCapability(created.mock.results[0].value.token)).toThrow()
    await flush()
    expect(capture.starts).toHaveLength(0)
  })
  it('revokes and interrupts a failed start without touching an external reporter', async () => {
    const workspace = await createWorkspace()
    const capture = makeEngine('claude-code')
    const runtime = await import('../../server/services/progress-bar-runtime.js')
    const progress = await import('../../server/services/progress-bar-service.js')
    let token = ''
    let owner: ReturnType<typeof runtime.resolveProgressCapability>
    capture.engine.start = async (options) => {
      token = options.mcpServers!.find((s) => s.name === 'kobo-tasks')!.env.KOBO_PROGRESS_SESSION_TOKEN
      owner = runtime.resolveProgressCapability(token)
      progress.createProgressBar(owner, { activityKey: 'internal', label: 'Internal' })
      progress.createProgressBar({ ...owner, kind: 'external' }, { activityKey: 'external', label: 'External' })
      throw new Error('Engine failed')
    }
    const { _registerEngineForTest } = await import('../../server/services/agent/engines/registry.js')
    _registerEngineForTest(capture.engine)
    const orchestrator = await import('../../server/services/agent/orchestrator.js')
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    orchestrator.startAgent(workspace.id, workspace.projectPath, 'Task')
    await flush()
    expect(() => runtime.resolveProgressCapability(token)).toThrow()
    expect(progress.listProgressBars(owner!).items.map((b) => [b.label, b.status])).toEqual(
      expect.arrayContaining([
        ['Internal', 'interrupted'],
        ['External', 'running'],
      ]),
    )
    errors.mockRestore()
  })
  it('revokes a queued replacement when stopping cancels its launch', async () => {
    const workspace = await createWorkspace()
    const capture = makeEngine('claude-code', true)
    const runtime = await import('../../server/services/progress-bar-runtime.js')
    const created = vi.spyOn(runtime, 'createProgressCapability')
    const { _registerEngineForTest } = await import('../../server/services/agent/engines/registry.js')
    _registerEngineForTest(capture.engine)
    const orchestrator = await import('../../server/services/agent/orchestrator.js')
    const { getDb } = await import('../../server/db/index.js')
    orchestrator.startAgent(workspace.id, workspace.projectPath, 'First')
    await flush()
    getDb().prepare("UPDATE workspaces SET status='idle' WHERE id=?").run(workspace.id)
    orchestrator.startAgent(workspace.id, workspace.projectPath, 'Replacement')
    await flush()
    const second = created.mock.results[1].value
    expect(runtime.resolveProgressCapability(second.token)).toEqual(second.owner)
    const stopping = orchestrator.stopAgentAndWait(workspace.id)
    expect(() => runtime.resolveProgressCapability(second.token)).toThrow()
    await flush()
    capture.releaseStop()
    await stopping
    await flush()
    expect(capture.starts).toHaveLength(1)
  })
})

describe('Mistral launch integration', () => {
  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    await resetDb()
  })
  it('ignores prepared-prompt and ready callbacks from a physically closed Mistral launch', async () => {
    const workspace = await createWorkspace('mistral-vibe')
    const capture = makeEngine('mistral-vibe')
    let settleReady!: () => void
    const ready = new Promise<void>((resolve) => {
      settleReady = resolve
    })
    const start = capture.engine.start.bind(capture.engine)
    capture.engine.start = async (...args) => ({ ...(await start(...args)), ready })
    const { _registerEngineForTest } = await import('../../server/services/agent/engines/registry.js')
    _registerEngineForTest(capture.engine)
    const memory = await import('../../server/services/memory-context-service.js')
    const initialized = vi.spyOn(memory, 'markMemoryContextInitialized')
    const orch = await import('../../server/services/agent/orchestrator.js')
    const { emit } = await import('../../server/services/websocket-service.js')
    orch.startAgent(
      workspace.id,
      workspace.projectPath,
      'First',
      'auto',
      false,
      'bypass',
      undefined,
      'auto',
      undefined,
      { persistInitialPrompt: true },
    )
    await flush()
    const callback = capture.starts[0].onPromptPrepared!
    await orch.stopAgentAndWait(workspace.id)
    await flush()
    vi.mocked(emit).mockClear()
    initialized.mockClear()
    const database = await import('../../server/db/index.js')
    database.closeDb()
    const dbRead = vi.spyOn(database, 'getDb').mockClear()
    callback({ promptPrefix: 'Stale launch instructions', systemAppend: '' })
    settleReady()
    await flush()
    expect(emit).not.toHaveBeenCalled()
    expect(initialized).not.toHaveBeenCalled()
    expect(dbRead).not.toHaveBeenCalled()
  })
  it('publishes Mistral completion only after native closure so queued chat can resume safely', async () => {
    const workspace = await createWorkspace('mistral-vibe')
    const capture = makeEngine('mistral-vibe')
    let close!: () => void
    const closed = new Promise<void>((resolve) => {
      close = resolve
    })
    const start = capture.engine.start.bind(capture.engine)
    capture.engine.start = async (...args) => ({
      ...(await start(...args)),
      ...(capture.starts.length === 1 ? { closed } : {}),
    })
    const { _registerEngineForTest } = await import('../../server/services/agent/engines/registry.js')
    _registerEngineForTest(capture.engine)
    const orch = await import('../../server/services/agent/orchestrator.js')
    const { emit } = await import('../../server/services/websocket-service.js')
    const terminalEvents = () =>
      vi
        .mocked(emit)
        .mock.calls.filter(
          (call) => call[1] === 'agent:event' && (call[2] as { kind?: string }).kind === 'session:ended',
        )
    const workspaces = await import('../../server/services/workspace-service.js')
    workspaces.updateWorkspaceStatus(workspace.id, 'brainstorming')
    const initial = orch.startAgent(workspace.id, workspace.projectPath, 'Initial native turn', 'auto')
    await flush()
    capture.events[0]({ kind: 'session:ended', reason: 'completed', exitCode: 0 })
    await flush()
    expect(terminalEvents()).toHaveLength(0)
    expect(orch.hasController(workspace.id)).toBe(true)
    expect(() => orch.assertImmediateMessageSupported(workspace.id)).toThrow('live message delivery is unsupported')
    close()
    await flush()
    expect(terminalEvents()).toHaveLength(1)
    expect(orch.hasController(workspace.id)).toBe(false)
    const { deliverWorkspaceMessage } = await import('../../server/services/workspace-message-service.js')
    await expect(
      deliverWorkspaceMessage(workspace.id, { content: 'Queued follow-up', sessionId: initial.agentSessionId }),
    ).resolves.toEqual({ sessionId: initial.agentSessionId })
    await flush()
    expect(capture.starts).toHaveLength(2)
    expect(capture.starts[1].resumeFromEngineSessionId).toBe('mistral-vibe-native-1')
    expect(capture.starts[1].prompt).toContain('Queued follow-up')
    await orch.stopAgentAndWait(workspace.id)
  })
})
