import { describe, expect, it } from 'vitest'
import type { AgentEngine, AgentEvent, EngineProcess, StartOptions } from '../../server/services/agent/engines/types.js'

function fakeEngine(
  opts: { pid?: number; engineSessionId?: string; sendMessage?: (text: string) => void | Promise<void> } = {},
): {
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
      return opts.sendMessage?.(t)
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
      permissionModes: ['bypass'],
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
  agentPermissionMode: 'bypass',
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
    await ctrl.sendMessage('hey')
    expect(sentMessages).toEqual(['hey'])
  })

  it('returns asynchronous sendMessage failures to its caller', async () => {
    const { SessionController } = await import('../../server/services/agent/session-controller.js')
    const { engine } = fakeEngine({
      sendMessage: async () => {
        throw new Error('Codex turn is closing')
      },
    })
    const ctrl = new SessionController('w1', 'sess-1', engine, () => {})
    await ctrl.start(BASE_OPTS)

    await expect(ctrl.sendMessage('hey')).rejects.toThrow('Codex turn is closing')
  })

  it('queues messages until the engine process is ready', async () => {
    const { SessionController } = await import('../../server/services/agent/session-controller.js')
    let releaseStart!: () => void
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve
    })
    const sentMessages: string[] = []
    const process: EngineProcess = {
      sendMessage(text) {
        sentMessages.push(text)
      },
      interrupt() {},
      async stop() {},
    }
    const engine: AgentEngine = {
      id: 'codex',
      displayName: 'Codex',
      capabilities: {
        models: [],
        permissionModes: ['bypass'],
        supportsResume: true,
        supportsMcp: true,
        supportsSkills: true,
      },
      async start() {
        await startGate
        return process
      },
    }
    const ctrl = new SessionController('w1', 'sess-1', engine, () => {})

    const starting = ctrl.start(BASE_OPTS)
    const sending = ctrl.sendMessage('queued')
    expect(sentMessages).toEqual([])

    releaseStart()
    await Promise.all([starting, sending])
    expect(sentMessages).toEqual(['queued'])
  })

  it('stops and clears a process that resolves after stop() was requested', async () => {
    const { SessionController } = await import('../../server/services/agent/session-controller.js')
    let releaseStart!: (process: EngineProcess) => void
    const startGate = new Promise<EngineProcess>((resolve) => {
      releaseStart = resolve
    })
    let stopCount = 0
    const process: EngineProcess = {
      pid: 12345,
      sendMessage() {},
      interrupt() {},
      async stop() {
        stopCount++
      },
    }
    const engine: AgentEngine = {
      id: 'codex',
      displayName: 'Codex',
      capabilities: {
        models: [],
        permissionModes: ['bypass'],
        supportsResume: true,
        supportsMcp: true,
        supportsSkills: true,
      },
      async start() {
        return startGate
      },
    }
    const ctrl = new SessionController('w1', 'sess-1', engine, () => {})

    const starting = ctrl.start(BASE_OPTS)
    await ctrl.stop()
    releaseStart(process)
    await starting

    expect(stopCount).toBe(1)
    expect(ctrl.status).toBe('stopping')
    expect(ctrl.engineProcess).toBeUndefined()
    expect(ctrl.pid).toBeUndefined()
  })

  it('throws on a second start() call (re-entrancy guard)', async () => {
    const { SessionController } = await import('../../server/services/agent/session-controller.js')
    const { engine } = fakeEngine()
    const ctrl = new SessionController('w1', 'sess-1', engine, () => {})
    await ctrl.start(BASE_OPTS)
    await expect(ctrl.start(BASE_OPTS)).rejects.toThrow(/already started/i)
  })
})
