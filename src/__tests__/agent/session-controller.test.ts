import { describe, expect, it, vi } from 'vitest'
import type { AgentEngine, AgentEvent, EngineProcess, StartOptions } from '../../server/services/agent/engines/types.js'

function fakeEngine(opts: { pid?: number; engineSessionId?: string } = {}): {
  engine: AgentEngine
  emit: (ev: AgentEvent) => void
  process: EngineProcess
  sentMessages: string[]
  stopCount: number
} {
  const sent: string[] = []
  let emitFn: (ev: AgentEvent) => void = () => {}
  let stopCount = 0
  const process: EngineProcess = {
    pid: opts.pid ?? 4242,
    engineSessionId: opts.engineSessionId,
    sendMessage(t) {
      sent.push(t)
    },
    interrupt() {},
    async stop() {
      stopCount++
    },
  }
  const engine: AgentEngine = {
    id: 'claude-code',
    displayName: 'Claude Code',
    capabilities: {
      models: [],
      permissionModes: ['auto-accept'],
      supportsResume: true,
      supportsMcp: true,
      supportsSkills: true,
    },
    async start(_opts: StartOptions, onEvent) {
      emitFn = onEvent
      return process
    },
  }
  return {
    engine,
    emit: (ev: AgentEvent) => emitFn(ev),
    process,
    sentMessages: sent,
    get stopCount() {
      return stopCount
    },
  }
}

const BASE_OPTS: StartOptions = {
  workspaceId: 'w1',
  workingDir: '/tmp',
  prompt: 'hi',
  permissionMode: 'auto-accept',
  backendUrl: 'http://127.0.0.1:3000',
  koboHome: '/tmp/kobo',
  settings: {
    dangerouslySkipPermissions: true,
  } as unknown as import('../../server/services/settings-service.js').EffectiveSettings,
}

describe('SessionController', () => {
  it('forwards every event to the onEvent handler', async () => {
    const { SessionController } = await import('../../server/services/agent/session-controller.js')
    const { engine, emit } = fakeEngine()
    const received: AgentEvent[] = []
    const ctrl = new SessionController('w1', 'sess-1', engine, (ev) => received.push(ev))
    await ctrl.start(BASE_OPTS)
    emit({ kind: 'message:text', messageId: 'm', text: 'hi', streaming: false })
    expect(received).toContainEqual({ kind: 'message:text', messageId: 'm', text: 'hi', streaming: false })
  })

  it('reports status as running after start, stopping after stop()', async () => {
    const { SessionController } = await import('../../server/services/agent/session-controller.js')
    const { engine } = fakeEngine()
    const ctrl = new SessionController('w1', 'sess-1', engine, () => {})
    await ctrl.start(BASE_OPTS)
    expect(ctrl.status).toBe('running')
    void ctrl.stop()
    expect(ctrl.status).toBe('stopping')
  })

  it('exposes the engine process pid', async () => {
    const { SessionController } = await import('../../server/services/agent/session-controller.js')
    const { engine } = fakeEngine({ pid: 12345 })
    const ctrl = new SessionController('w1', 'sess-1', engine, () => {})
    await ctrl.start(BASE_OPTS)
    expect(ctrl.pid).toBe(12345)
  })

  it('proxies sendMessage / interrupt to the engine', async () => {
    const { SessionController } = await import('../../server/services/agent/session-controller.js')
    const { engine, sentMessages } = fakeEngine()
    const ctrl = new SessionController('w1', 'sess-1', engine, () => {})
    await ctrl.start(BASE_OPTS)
    ctrl.sendMessage('hey')
    expect(sentMessages).toEqual(['hey'])
  })

  it('throws on a second start() call (re-entrancy guard)', async () => {
    const { SessionController } = await import('../../server/services/agent/session-controller.js')
    const { engine } = fakeEngine()
    const ctrl = new SessionController('w1', 'sess-1', engine, () => {})
    await ctrl.start(BASE_OPTS)
    await expect(ctrl.start(BASE_OPTS)).rejects.toThrow(/already started/i)
  })
})

describe('SessionController — post-compact reminder', () => {
  it('injects a task/criteria reminder into the engine stdin on session:compacted', async () => {
    vi.resetModules()
    vi.doMock('../../server/services/workspace-service.js', () => ({
      getWorkspace: () => ({ id: 'w1', name: 'Sample', archivedAt: null }),
      listTasks: () => [
        { id: 't1', title: 'Write X', status: 'todo', isAcceptanceCriterion: false },
        { id: 't2', title: 'Y passes', status: 'todo', isAcceptanceCriterion: true },
      ],
    }))
    const { SessionController } = await import('../../server/services/agent/session-controller.js')
    const { engine, emit, sentMessages } = fakeEngine()
    const received: AgentEvent[] = []
    const ctrl = new SessionController('w1', 'sess-1', engine, (ev) => received.push(ev))
    await ctrl.start(BASE_OPTS)
    emit({ kind: 'session:compacted' })

    expect(sentMessages.length).toBe(1)
    const reminder = sentMessages[0]
    expect(reminder).toContain('Sample')
    expect(reminder).toContain('Write X')
    expect(reminder).toContain('Y passes')
    expect(received).toContainEqual({ kind: 'session:compacted' })
  })
})
