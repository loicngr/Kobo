import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent } from '../../server/services/agent/engines/types.js'
import { resetDb } from '../helpers/reset-db.js'

vi.mock('../../server/services/websocket-service.js', () => ({ emit: vi.fn(), emitEphemeral: vi.fn() }))
vi.mock('../../server/services/settings-service.js', () => ({
  getGlobalSettings: () => ({ autoLoopMaxRetries: 5 }),
  getProjectSettings: () => ({ forge: 'none' }),
  getEffectiveSettings: () => ({ model: 'auto', sessionEndedScript: '', autoLoopDisabledScript: '' }),
  getEffectiveFinalization: () => ({ prompt: '' }),
}))
vi.mock('../../server/services/usage/poller.js', () => ({ refreshNow: vi.fn().mockResolvedValue(null) }))

async function fixture() {
  const workspace = await import('../../server/services/workspace-service.js')
  const orch = await import('../../server/services/agent/orchestrator.js')
  const { _registerEngineForTest } = await import('../../server/services/agent/engines/registry.js')
  const send = vi.fn()
  let alive = true
  const callbacks: Array<(event: AgentEvent) => void> = []
  _registerEngineForTest({
    id: 'claude-code',
    displayName: 'Claude',
    capabilities: {
      models: [],
      permissionModes: ['bypass'],
      supportsResume: true,
      supportsMcp: true,
      supportsSkills: true,
      supportsSubagents: false,
      supportsQuotaStatus: false,
    },
    async start(_options, onEvent) {
      callbacks.push(onEvent)
      return {
        pid: undefined,
        engineSessionId: undefined,
        sendMessage: send,
        interrupt() {},
        async stop() {},
        isAlive: () => alive,
        resolvePendingUserInput: () => true,
      }
    },
  })
  const ws = workspace.createWorkspace({
    name: 'W',
    projectPath: '/tmp',
    sourceBranch: 'develop',
    workingBranch: 'compact',
  })
  workspace.updateWorkspaceStatus(ws.id, 'brainstorming')
  orch.startAgent(ws.id, '/tmp', 'Hello')
  await Promise.resolve()
  await Promise.resolve()
  return {
    ws,
    orch,
    workspace,
    send,
    callbacks,
    emit: (event: AgentEvent) => callbacks.at(-1)!(event),
    status: () => workspace.getWorkspace(ws.id)?.status,
    die: () => {
      alive = false
    },
  }
}

describe('workspace compaction lifecycle', () => {
  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    await resetDb()
  })

  it.each<AgentEvent>([{ kind: 'session:compacting', active: false }, { kind: 'session:compacted' }])(
    'restores the previous state after $kind, even with duplicate starts',
    async (endEvent) => {
      const f = await fixture()
      f.emit({ kind: 'session:compacting', active: true })
      f.emit({ kind: 'session:compacting', active: true })
      expect(f.status()).toBe('compacting')
      f.emit(endEvent)
      expect(f.status()).toBe('brainstorming')
    },
  )

  it.each<AgentEvent>([
    { kind: 'message:text', messageId: 'child', text: 'Done', streaming: false },
    { kind: 'tool:call', messageId: 'child', toolCallId: 'tool', name: 'Read', input: {} },
    { kind: 'session:brainstorm-complete' },
    {
      kind: 'session:user-input-requested',
      requestKind: 'question',
      toolCallId: 'question',
      toolName: 'AskUserQuestion',
      payload: {},
    },
  ])('waits for the engine compaction signal when receiving $kind without parent provenance', async (event) => {
    const f = await fixture()
    f.emit({ kind: 'session:compacting', active: true })
    f.emit(event)
    expect(f.status()).toBe('compacting')
    f.emit({ kind: 'session:compacted' })
    expect(f.status()).toBe(event.kind === 'session:user-input-requested' ? 'awaiting-user' : 'brainstorming')
  })

  it('restores a pending question rather than executing', async () => {
    const f = await fixture()
    f.emit({
      kind: 'session:user-input-requested',
      requestKind: 'question',
      toolCallId: 'question',
      toolName: 'AskUserQuestion',
      payload: {},
    })
    f.emit({ kind: 'session:compacting', active: true })
    expect(f.status()).toBe('compacting')
    f.emit({ kind: 'session:compacted' })
    expect(f.status()).toBe('awaiting-user')
  })

  it('keeps compacting after answering an older pending question, then restores the original phase', async () => {
    const f = await fixture()
    f.emit({
      kind: 'session:user-input-requested',
      requestKind: 'question',
      toolCallId: 'question',
      toolName: 'AskUserQuestion',
      payload: {},
    })
    f.emit({ kind: 'session:compacting', active: true })
    await f.orch.answerPendingQuestion(f.ws.id, { Question: 'Answer' }, 'question')
    expect(f.status()).toBe('compacting')
    f.emit({ kind: 'session:compacted' })
    expect(f.status()).toBe('brainstorming')
  })

  it('blocks both delivery paths without cancelling a scheduled wakeup', async () => {
    const f = await fixture()
    const wakeup = await import('../../server/services/wakeup-service.js')
    wakeup.schedule(f.ws.id, 60, 'Check later', undefined)
    f.emit({ kind: 'session:compacting', active: true })
    await expect(f.orch.sendMessage(f.ws.id, 'New')).rejects.toThrow(/compacting/i)
    await expect(f.orch.sendMessageForFallback(f.ws.id, 'New')).rejects.toThrow(/compacting/i)
    expect(f.send).not.toHaveBeenCalled()
    expect(wakeup.getPending(f.ws.id)).not.toBeNull()
    await f.orch.stopAgentAndWait(f.ws.id)
  })

  it.each(['stop', 'end', 'error', 'dead', 'boot'])('clears compaction on %s', async (mode) => {
    const f = await fixture()
    f.emit({ kind: 'session:compacting', active: true })
    expect(f.status()).toBe('compacting')
    if (mode === 'stop') await f.orch.stopAgentAndWait(f.ws.id)
    else if (mode === 'end') f.emit({ kind: 'session:ended', reason: 'completed', exitCode: 0 })
    else if (mode === 'error') f.emit({ kind: 'session:ended', reason: 'error', exitCode: 1 })
    else if (mode === 'dead') {
      f.die()
      f.orch._runWatchdogForTest()
    } else f.orch.reconcileOrphanSessions()
    expect(f.status()).toBe(mode === 'end' ? 'completed' : mode === 'error' || mode === 'dead' ? 'error' : 'idle')
  })

  it('never broadcasts a late compaction start while stopping', async () => {
    const f = await fixture()
    const websocket = await import('../../server/services/websocket-service.js')
    const stop = f.orch.stopAgentAndWait(f.ws.id)
    vi.mocked(websocket.emitEphemeral).mockClear()
    f.emit({ kind: 'session:compacting', active: true })
    expect(
      vi
        .mocked(websocket.emitEphemeral)
        .mock.calls.some((call) => call[1] === 'agent:event' && (call[2] as AgentEvent).kind === 'session:compacting'),
    ).toBe(false)
    expect(f.status()).toBe('idle')
    await stop
  })

  it('ignores old controller compaction events after replacement', async () => {
    const f = await fixture()
    const old = f.callbacks[0]!
    old({ kind: 'session:compacting', active: true })
    await f.orch.stopAgentAndWait(f.ws.id)
    f.orch.startAgent(f.ws.id, '/tmp', 'Next')
    await Promise.resolve()
    await Promise.resolve()
    f.emit({ kind: 'session:started', engineSessionId: 'next' })
    f.emit({ kind: 'session:compacting', active: true })
    old({ kind: 'session:compacting', active: false })
    old({ kind: 'session:compacted' })
    expect(f.status()).toBe('compacting')
    f.emit({ kind: 'session:compacted' })
    expect(f.status()).toBe('executing')
    old({ kind: 'session:compacting', active: true })
    expect(f.status()).toBe('executing')
  })
})
