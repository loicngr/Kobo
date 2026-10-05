import { beforeEach, describe, expect, it, vi } from 'vitest'
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

function makeEngine(id: 'claude-code' | 'codex', gateStop = false): EngineCapture {
  const starts: StartOptions[] = []
  const events: Array<(event: AgentEvent) => void> = []
  const pendingStops: Array<() => void> = []
  const engine: AgentEngine = {
    id,
    displayName: id,
    capabilities: {
      models: [{ id: 'auto', label: 'Auto' }],
      permissionModes: ['bypass'],
      supportsResume: true,
      supportsMcp: true,
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

async function createWorkspace(engine: 'claude-code' | 'codex' = 'claude-code') {
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
    await resetDb()
  })

  it.each(['claude-code', 'codex'] as const)(
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

  it('resumes the same native conversation with only newly added memory', async () => {
    const { createMemory, resolveMemoryScope } = await import('../../server/services/memory-service.js')
    const workspace = await createWorkspace()
    const scope = resolveMemoryScope({ level: 'workspace', workspaceId: workspace.id })
    createMemory({
      scopeId: scope.id,
      key: 'old',
      title: 'Old',
      body: 'Already in conversation.',
      actor: { kind: 'human' },
    })
    const capture = makeEngine('claude-code')
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
    expect(capture.starts[1].resumeFromEngineSessionId).toBe('claude-code-native-1')
    expect(capture.starts[1].prompt).toContain('Added before resume.')
    expect(capture.starts[1].prompt).not.toContain('Already in conversation.')
    await orchestrator.stopAgentAndWait(workspace.id)
  })

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
