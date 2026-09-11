import { EventEmitter } from 'node:events'
import { Readable, Writable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'

// ── Mock the spawn module before any imports that transitively load it ────────

// We use a factory that returns the same child object each time spawnAppServer()
// is called, so tests can interact with it directly.
function makeChild() {
  const written: string[] = []
  const stdin = new Writable({
    write(chunk, _enc, cb) {
      written.push(chunk.toString())
      cb()
    },
  })
  const stdout = new Readable({ read() {} })
  const stderr = new Readable({ read() {} })

  const emitter = new EventEmitter()

  const child = Object.assign(emitter, {
    stdin,
    stdout,
    stderr,
    pid: 12345 as number | undefined,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill: vi.fn<(signal?: NodeJS.Signals) => boolean>(),
    _written: written,
  })
  child.kill.mockImplementation((signal = 'SIGTERM') => {
    queueMicrotask(() => {
      if (child.exitCode !== null || child.signalCode !== null) return
      child.signalCode = signal
      child.emit('exit', null, signal)
    })
    return true
  })
  return child
}

let _child = makeChild()

vi.mock('../../server/services/agent/engines/codex/spawn.js', () => ({
  spawnAppServer: ({ signal }: { signal?: AbortSignal }) => {
    const child = _child
    signal?.addEventListener('abort', () => {
      const error = Object.assign(new Error('The operation was aborted'), {
        name: 'AbortError',
        code: 'ABORT_ERR',
      })
      child.emit('error', error)
    })
    return child
  },
  resolveCodexBinary: () => '/fake/codex',
}))

vi.mock('../../server/utils/paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../server/utils/paths.js')>()
  return { ...actual, getPackageVersion: () => '0.0.0-test' }
})

// Import AFTER mocks are installed
import { CODEX_HANDSHAKE_TIMEOUT_MS } from '../../server/services/agent/engines/codex/client.js'
import {
  CODEX_GRACEFUL_INTERRUPT_TIMEOUT_MS,
  CODEX_SUBAGENT_STALL_TIMEOUT_MS,
  CODEX_TURN_IDLE_TIMEOUT_MS,
  createCodexEngine,
} from '../../server/services/agent/engines/codex/engine.js'
import type { AgentEvent, StartOptions } from '../../server/services/agent/engines/types.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

const BASE_OPTIONS: StartOptions = {
  workspaceId: 'ws_1',
  workingDir: '/workspace',
  prompt: 'Hello agent',
  agentPermissionMode: 'bypass',
  backendUrl: 'http://localhost:3000',
  koboHome: '/home/.config/kobo',
  settings: {} as StartOptions['settings'],
}

/** Write a JSON-RPC line to child stdout. */
function pushLine(obj: unknown) {
  _child.stdout.push(`${JSON.stringify(obj)}\n`)
}

/** Initialize response (response to the "initialize" request). */
function pushInitializeResponse(id = 1) {
  pushLine({
    jsonrpc: '2.0',
    id,
    result: {
      userAgent: 'codex/test',
      codexHome: '/home/.codex',
      platformFamily: 'unix',
      platformOs: 'linux',
    },
  })
}

/** Thread start response. */
function pushThreadStartResponse(threadId: string, id = 2, model: unknown = 'gpt-resolved') {
  pushLine({
    jsonrpc: '2.0',
    id,
    result: {
      model,
      thread: {
        id: threadId,
        sessionId: 'sess_1',
        preview: '',
        ephemeral: false,
        modelProvider: 'openai',
        createdAt: 0,
        updatedAt: 0,
      },
    },
  })
}

/** Turn start response. */
function pushTurnStartResponse(turnId = 'turn_1', id = 3) {
  pushLine({ jsonrpc: '2.0', id, result: { turn: { id: turnId, status: 'inProgress' } } })
}

/** Notification helper. */
function pushNotification(method: string, params: unknown) {
  pushLine({ jsonrpc: '2.0', method, params })
}

/** Flush microtasks and give streams time to deliver. */
function flush(ms = 20) {
  return new Promise<void>((r) => setTimeout(r, ms))
}

/** Reset the child mock between tests. */
function resetChild() {
  _child = makeChild()
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('createCodexEngine — resolved default model', () => {
  it.each([
    { model: 'auto', resume: false, mode: 'plan' as const },
    { model: undefined, resume: false, mode: 'bypass' as const },
    { model: 'auto', resume: true, mode: 'bypass' as const },
    { model: undefined, resume: true, mode: 'plan' as const },
    { model: 'gpt-explicit', resume: false, mode: 'plan' as const },
    { model: 'gpt-explicit', resume: true, mode: 'bypass' as const },
  ])('uses the resolved thread model while resetting collaboration mode: %j', async ({ model, resume, mode }) => {
    resetChild()
    await createCodexEngine().start(
      {
        ...BASE_OPTIONS,
        model,
        agentPermissionMode: mode,
        ...(resume ? { resumeFromEngineSessionId: 'thr_model' } : {}),
      },
      () => {},
    )
    try {
      await flush(5)
      pushInitializeResponse()
      await flush(5)
      pushThreadStartResponse('thr_model', 2, 'gpt-resolved')
      await flush(5)
      const requests = _child._written.map((line) => JSON.parse(line))
      const thread = requests.find((request) => request.method === (resume ? 'thread/resume' : 'thread/start'))
      expect(thread.params.model).toBe(model === 'auto' ? undefined : model)
      const turn = requests.find((request) => request.method === 'turn/start')
      expect(turn?.params.collaborationMode).toMatchObject({
        mode: mode === 'plan' ? 'plan' : 'default',
        settings: { model: model && model !== 'auto' ? model : 'gpt-resolved' },
      })
    } finally {
      _child.kill('SIGTERM')
      await flush(5)
    }
  })

  it.each([null, '', 'auto', undefined])(
    'fails clearly when automatic selection has no resolved model: %j',
    async (model) => {
      resetChild()
      const events: AgentEvent[] = []
      await createCodexEngine().start({ ...BASE_OPTIONS, model: 'auto' }, (event) => events.push(event))
      try {
        await flush(5)
        pushInitializeResponse()
        await flush(5)
        if (model === undefined) pushLine({ jsonrpc: '2.0', id: 2, result: { thread: { id: 'thr_model' } } })
        else pushThreadStartResponse('thr_model', 2, model)
        await flush(5)
        expect(_child._written.some((line) => JSON.parse(line).method === 'turn/start')).toBe(false)
        expect(events).toContainEqual(
          expect.objectContaining({ kind: 'error', message: expect.stringContaining('resolved model') }),
        )
      } finally {
        _child.kill('SIGTERM')
        await flush(5)
      }
    },
  )
})

describe('createCodexEngine — happy path', () => {
  it('emits turn:completed before session:ended on a successful turn', async () => {
    resetChild()
    const engine = createCodexEngine()
    const events: AgentEvent[] = []

    const sessionEndedPromise = new Promise<void>((resolve) => {
      const proc = engine.start(BASE_OPTIONS, (ev) => {
        events.push(ev)
        if (ev.kind === 'session:ended') resolve()
      })
      void proc
    })

    await flush(10)

    // Drive the protocol
    pushInitializeResponse(1)
    await flush(5)
    pushThreadStartResponse('thr_happy', 2)
    await flush(5)
    pushTurnStartResponse('turn_1', 3)
    await flush(5)

    // Agent sends a message
    pushNotification('item/completed', {
      item: { id: 'item_0', type: 'agentMessage', text: 'Hello from agent' },
      threadId: 'thr_happy',
      turnId: 'turn_1',
      completedAtMs: Date.now(),
    })
    await flush(5)

    // Turn completes
    pushNotification('turn/completed', {
      threadId: 'thr_happy',
      turn: {
        id: 'turn_1',
        status: 'completed',
        startedAt: null,
        completedAt: null,
        durationMs: null,
        error: null,
      },
    })

    await sessionEndedPromise
    await flush(10)

    const kinds = events.map((e) => e.kind)
    expect(kinds).toContain('session:started')
    expect(kinds).toContain('message:text')
    expect(kinds).toContain('message:end')
    expect(kinds).toContain('turn:completed')
    expect(kinds).toContain('session:ended')
    expect(kinds.indexOf('turn:completed')).toBeLessThan(kinds.indexOf('session:ended'))

    const sessionStarted = events.find((e) => e.kind === 'session:started') as Extract<
      AgentEvent,
      { kind: 'session:started' }
    >
    expect(sessionStarted.engineSessionId).toBe('thr_happy')

    const sessionEnded = events.find((e) => e.kind === 'session:ended') as Extract<
      AgentEvent,
      { kind: 'session:ended' }
    >
    expect(sessionEnded.reason).toBe('completed')
    expect(sessionEnded.exitCode).toBe(0)
  })
})

describe('createCodexEngine — background subagents', () => {
  it('keeps app-server alive after the parent turn until the child thread becomes idle', async () => {
    resetChild()
    const events: AgentEvent[] = []
    let resolveEnded: () => void = () => {}
    const ended = new Promise<void>((resolve) => {
      resolveEnded = resolve
    })

    await createCodexEngine().start(BASE_OPTIONS, (event) => {
      events.push(event)
      if (event.kind === 'session:ended') resolveEnded()
    })

    await flush(10)
    pushInitializeResponse(1)
    await flush(5)
    pushThreadStartResponse('thr_parent', 2)
    await flush(5)
    pushTurnStartResponse('turn_1', 3)
    await flush(5)

    const collabItem = {
      id: 'spawn_1',
      type: 'collabAgentToolCall',
      tool: 'spawnAgent',
      status: 'completed',
      senderThreadId: 'thr_parent',
      receiverThreadIds: ['thr_child'],
      prompt: 'Review the pull request',
      model: null,
      agentsStates: { thr_child: { status: 'running', message: null } },
    }
    pushNotification('item/started', {
      item: { ...collabItem, status: 'inProgress', agentsStates: {} },
      threadId: 'thr_parent',
      turnId: 'turn_1',
    })
    pushNotification('item/completed', { item: collabItem, threadId: 'thr_parent', turnId: 'turn_1' })
    pushNotification('turn/completed', {
      threadId: 'thr_parent',
      turn: { id: 'turn_1', status: 'completed' },
    })
    await flush(20)

    expect(events.some((event) => event.kind === 'session:ended')).toBe(false)
    expect(_child.kill).not.toHaveBeenCalled()

    pushNotification('thread/status/changed', {
      threadId: 'thr_child',
      status: { type: 'idle' },
    })
    await ended
    await flush(10)

    expect(events).toContainEqual({ kind: 'session:ended', reason: 'completed', exitCode: 0 })
    expect(events.filter((event) => event.kind === 'subagent:progress' && event.status === 'done')).toHaveLength(1)
    expect(_child.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('force-ends the session if a spawned subagent thread never reports a terminal status', async () => {
    resetChild()
    vi.useFakeTimers()
    try {
      const events: AgentEvent[] = []

      await createCodexEngine().start(BASE_OPTIONS, (event) => events.push(event))

      await vi.advanceTimersByTimeAsync(10)
      pushInitializeResponse(1)
      await vi.advanceTimersByTimeAsync(5)
      pushThreadStartResponse('thr_parent', 2)
      await vi.advanceTimersByTimeAsync(5)
      pushTurnStartResponse('turn_1', 3)
      await vi.advanceTimersByTimeAsync(5)

      const collabItem = {
        id: 'spawn_1',
        type: 'collabAgentToolCall',
        tool: 'spawnAgent',
        status: 'completed',
        senderThreadId: 'thr_parent',
        receiverThreadIds: ['thr_child'],
        prompt: 'Review the pull request',
        model: null,
        agentsStates: { thr_child: { status: 'running', message: null } },
      }
      pushNotification('item/started', {
        item: { ...collabItem, status: 'inProgress', agentsStates: {} },
        threadId: 'thr_parent',
        turnId: 'turn_1',
      })
      pushNotification('item/completed', { item: collabItem, threadId: 'thr_parent', turnId: 'turn_1' })
      pushNotification('turn/completed', {
        threadId: 'thr_parent',
        turn: { id: 'turn_1', status: 'completed' },
      })
      await vi.advanceTimersByTimeAsync(20)

      expect(events.some((event) => event.kind === 'session:ended')).toBe(false)

      // thr_child never sends thread/status/changed or a terminal
      // item/completed — a dropped notification, or the sub-thread's own
      // process hanging. Without the stall watchdog this hangs forever
      // (turnLiveness stays paused, and nothing else resumes it).
      await vi.advanceTimersByTimeAsync(CODEX_SUBAGENT_STALL_TIMEOUT_MS + 1_000)

      expect(events).toContainEqual({ kind: 'session:ended', reason: 'error', exitCode: null })
      expect(_child.kill).toHaveBeenCalledWith('SIGTERM')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('createCodexEngine — active turn steering', () => {
  it('queues steering until the initial Codex turn is ready', async () => {
    resetChild()
    let resolveEnded: () => void = () => {}
    const ended = new Promise<void>((resolve) => {
      resolveEnded = resolve
    })
    const proc = await createCodexEngine().start(BASE_OPTIONS, (event) => {
      if (event.kind === 'session:ended') resolveEnded()
    })

    const steering = proc.sendMessage('Message en attente')
    expect(_child._written.some((line) => JSON.parse(line).method === 'turn/steer')).toBe(false)

    await flush(10)
    pushInitializeResponse(1)
    await flush(5)
    pushThreadStartResponse('thr_queued', 2)
    await flush(5)
    pushTurnStartResponse('turn_initial', 3)
    await flush(5)

    const request = _child._written
      .map((line) => JSON.parse(line) as { method?: string; id?: number; params?: unknown })
      .find((message) => message.method === 'turn/steer')
    expect(request).toMatchObject({
      params: {
        threadId: 'thr_queued',
        expectedTurnId: 'turn_initial',
      },
    })
    pushLine({ jsonrpc: '2.0', id: request?.id, result: { turnId: 'turn_queued' } })
    await expect(steering).resolves.toBeUndefined()

    pushNotification('turn/completed', {
      threadId: 'thr_queued',
      turn: {
        id: 'turn_queued',
        status: 'completed',
        startedAt: null,
        completedAt: null,
        durationMs: null,
        error: null,
      },
    })
    await ended
  })

  it('steers the running turn when a user chat message arrives', async () => {
    resetChild()
    let resolveEnded: () => void = () => {}
    const ended = new Promise<void>((resolve) => {
      resolveEnded = resolve
    })
    const proc = await createCodexEngine().start(BASE_OPTIONS, (event) => {
      if (event.kind === 'session:ended') resolveEnded()
    })

    await flush(10)
    pushInitializeResponse(1)
    await flush(5)
    pushThreadStartResponse('thr_steer', 2)
    await flush(5)
    pushTurnStartResponse('turn_active', 3)
    await flush(5)

    const steering = proc.sendMessage('Arrête et concentre-toi sur le test qui échoue.')
    await flush(5)

    const request = _child._written
      .map((line) => JSON.parse(line) as { method?: string; id?: number; params?: unknown })
      .find((message) => message.method === 'turn/steer')
    expect(request).toMatchObject({
      method: 'turn/steer',
      params: {
        threadId: 'thr_steer',
        expectedTurnId: 'turn_active',
        input: [{ type: 'text', text: 'Arrête et concentre-toi sur le test qui échoue.', text_elements: [] }],
      },
    })

    pushLine({ jsonrpc: '2.0', id: request?.id, result: { turnId: 'turn_steered' } })
    await expect(steering).resolves.toBeUndefined()

    pushNotification('turn/completed', {
      threadId: 'thr_steer',
      turn: {
        id: 'turn_steered',
        status: 'completed',
        startedAt: null,
        completedAt: null,
        durationMs: null,
        error: null,
      },
    })
    await ended
  })
})

describe('createCodexEngine — interruption', () => {
  it('asks Codex to interrupt the turn before terminating its process', async () => {
    resetChild()
    const proc = await createCodexEngine().start(BASE_OPTIONS, () => {})

    await flush(10)
    pushInitializeResponse(1)
    await flush(5)
    pushThreadStartResponse('thr_interrupt', 2)
    await flush(5)
    pushTurnStartResponse('turn_interrupt', 3)
    await flush(5)

    proc.interrupt()
    await flush(5)

    const interruptRequest = _child._written
      .map((line) => JSON.parse(line) as { method?: string; params?: unknown })
      .find((message) => message.method === 'turn/interrupt')
    expect(interruptRequest).toMatchObject({
      params: { threadId: 'thr_interrupt' },
    })
    expect(_child.kill).not.toHaveBeenCalled()
  })
})

describe('createCodexEngine — resume', () => {
  it('sends thread/resume (not thread/start) when resumeFromEngineSessionId is set', async () => {
    resetChild()
    const engine = createCodexEngine()
    const events: AgentEvent[] = []

    const sessionEndedPromise = new Promise<void>((resolve) => {
      void engine.start({ ...BASE_OPTIONS, resumeFromEngineSessionId: 'thr_old' }, (ev) => {
        events.push(ev)
        if (ev.kind === 'session:ended') resolve()
      })
    })

    await flush(10)

    // initialize
    pushInitializeResponse(1)
    await flush(5)

    // Respond to thread/resume (id=2)
    pushLine({
      jsonrpc: '2.0',
      id: 2,
      result: {
        model: 'gpt-resumed',
        thread: {
          id: 'thr_old',
          sessionId: 'sess_2',
          preview: '',
          ephemeral: false,
          modelProvider: 'openai',
          createdAt: 0,
          updatedAt: 0,
        },
      },
    })
    await flush(5)

    // turn/start response
    pushTurnStartResponse('turn_2', 3)
    await flush(5)

    // turn/completed
    pushNotification('turn/completed', {
      threadId: 'thr_old',
      turn: { id: 'turn_2', status: 'completed', startedAt: null, completedAt: null, durationMs: null, error: null },
    })

    await sessionEndedPromise
    await flush(10)

    // Verify that thread/resume was written to stdin (not thread/start)
    const written = _child._written
    const requests = written.map((line) => JSON.parse(line) as { method: string })
    const methods = requests.map((r) => r.method)
    expect(methods).toContain('thread/resume')
    expect(methods).not.toContain('thread/start')
  })
})

describe('createCodexEngine — interrupt', () => {
  it('handles an interrupt before Codex initialization completes', async () => {
    resetChild()
    const events: AgentEvent[] = []
    const sessionEndedPromise = new Promise<void>((resolve) => {
      void createCodexEngine()
        .start(BASE_OPTIONS, (event) => {
          events.push(event)
          if (event.kind === 'session:ended') resolve()
        })
        .then((proc) => {
          proc.interrupt()
          pushLine({ jsonrpc: '2.0', id: 1, error: { code: -32_000, message: 'interrupted during initialize' } })
        })
    })

    await sessionEndedPromise
    await flush(10)

    expect(events).toContainEqual({ kind: 'session:ended', reason: 'killed', exitCode: null })
  })

  it('emits session:ended with reason=killed when interrupt() is called', async () => {
    resetChild()
    const engine = createCodexEngine()
    const events: AgentEvent[] = []
    let resolveEnded: () => void = () => {}
    const sessionEndedPromise = new Promise<void>((resolve) => {
      resolveEnded = resolve
    })
    const proc = await engine.start(BASE_OPTIONS, (ev) => {
      events.push(ev)
      if (ev.kind === 'session:ended') resolveEnded()
    })

    await flush(5)

    // Drive initialize so the iterator gets past connect()
    pushInitializeResponse(1)
    await flush(5)
    pushThreadStartResponse('thr_interrupt', 2)
    await flush(5)
    pushTurnStartResponse('turn_1', 3)
    await flush(5)

    proc.interrupt()
    await flush(5)
    const request = _child._written
      .map((line) => JSON.parse(line) as { method?: string; id?: number })
      .find((message) => message.method === 'turn/interrupt')
    pushLine({ jsonrpc: '2.0', id: request?.id, result: {} })
    pushNotification('turn/completed', {
      threadId: 'thr_interrupt',
      turn: { id: 'turn_1', status: 'interrupted', startedAt: null, completedAt: null, durationMs: null, error: null },
    })

    await sessionEndedPromise
    await flush(10)

    const sessionEnded = events.find((e) => e.kind === 'session:ended') as Extract<
      AgentEvent,
      { kind: 'session:ended' }
    >
    expect(sessionEnded).toBeDefined()
    expect(sessionEnded.reason).toBe('killed')
  })
})

describe('createCodexEngine — child process errors', () => {
  it('ends the session and rejects queued messages when app-server fails', async () => {
    resetChild()
    const events: AgentEvent[] = []
    let resolveEnded!: () => void
    const ended = new Promise<void>((resolve) => {
      resolveEnded = resolve
    })
    const proc = await createCodexEngine().start(BASE_OPTIONS, (event) => {
      events.push(event)
      if (event.kind === 'session:ended') resolveEnded()
    })
    const queuedMessage = proc.sendMessage('message queued before startup')
    void Promise.resolve(queuedMessage).catch(() => {})

    await flush(10)
    const childError = Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' })
    _child.emit('error', childError)

    const outcome = await Promise.race([ended.then(() => 'ended'), flush(100).then(() => 'timeout')])
    if (outcome === 'timeout') {
      pushLine({ jsonrpc: '2.0', id: 1, error: { code: -32_000, message: childError.message } })
      await ended
    }

    expect(outcome).toBe('ended')
    expect(events).toContainEqual({ kind: 'error', category: 'spawn_failed', message: childError.message })
    expect(events).toContainEqual({ kind: 'session:ended', reason: 'error', exitCode: null })
    expect(events.filter((event) => event.kind === 'error' && event.category === 'spawn_failed')).toHaveLength(1)
    expect(events.filter((event) => event.kind === 'session:ended')).toHaveLength(1)
    await expect(queuedMessage).rejects.toThrow(childError.message)
  })

  it('ends the session and rejects queued messages when app-server exits during startup', async () => {
    resetChild()
    const events: AgentEvent[] = []
    let resolveEnded!: () => void
    const ended = new Promise<void>((resolve) => {
      resolveEnded = resolve
    })
    const proc = await createCodexEngine().start(BASE_OPTIONS, (event) => {
      events.push(event)
      if (event.kind === 'session:ended') resolveEnded()
    })
    const queuedMessage = proc.sendMessage('message queued before startup')
    void Promise.resolve(queuedMessage).catch(() => {})

    await flush(10)
    _child.emit('exit', 1, null)

    const outcome = await Promise.race([ended.then(() => 'ended'), flush(100).then(() => 'timeout')])

    expect(outcome).toBe('ended')
    expect(events).toContainEqual({
      kind: 'error',
      category: 'spawn_failed',
      message: 'Codex app-server exited unexpectedly with code 1',
    })
    expect(events).toContainEqual({ kind: 'session:ended', reason: 'error', exitCode: null })
    await expect(queuedMessage).rejects.toThrow('Codex app-server exited unexpectedly with code 1')
  })
})

describe('createCodexEngine — stop()', () => {
  it.each(['delayed-exit', 'no-exit', 'signal-failed'] as const)(
    'requires confirmed process exit after escalation: %s',
    async (scenario) => {
      resetChild()
      _child.kill.mockReturnValue(scenario !== 'signal-failed')
      vi.useFakeTimers()
      try {
        const proc = await createCodexEngine().start(BASE_OPTIONS, () => {})
        await vi.advanceTimersByTimeAsync(5)
        pushInitializeResponse()
        await vi.advanceTimersByTimeAsync(5)
        pushThreadStartResponse('thr_stop')
        await vi.advanceTimersByTimeAsync(5)
        pushTurnStartResponse()
        await vi.advanceTimersByTimeAsync(5)
        const initialListeners = _child.listenerCount('exit')

        let stopped = false
        const stopping = proc.stop().then(() => {
          stopped = true
        })
        const outcome = stopping.catch((error: Error) => error)
        await vi.advanceTimersByTimeAsync(5)
        const interrupt = _child._written.map((line) => JSON.parse(line)).find((m) => m.method === 'turn/interrupt')
        pushLine({ jsonrpc: '2.0', id: interrupt.id, result: {} })
        pushNotification('turn/completed', { threadId: 'thr_stop', turn: { id: 'turn_1', status: 'interrupted' } })
        await vi.advanceTimersByTimeAsync(3100)

        expect(_child.kill).toHaveBeenCalledWith('SIGKILL')
        expect(stopped).toBe(false)
        if (scenario === 'delayed-exit') {
          _child.signalCode = 'SIGKILL'
          _child.emit('exit', null, 'SIGKILL')
          await stopping
          expect(stopped).toBe(true)
        } else {
          await vi.advanceTimersByTimeAsync(3100)
          expect(await outcome).toEqual(expect.objectContaining({ message: expect.stringMatching(/did not exit/) }))
          expect(stopped).toBe(false)
          expect(_child.listenerCount('exit')).toBe(initialListeners)
        }
      } finally {
        vi.useRealTimers()
      }
    },
  )

  it('aborts the active session, kills the child, and resolves session:ended killed', async () => {
    resetChild()
    const engine = createCodexEngine()
    const events: AgentEvent[] = []

    let proc!: Awaited<ReturnType<typeof engine.start>>
    const sessionEndedPromise = new Promise<void>((resolve) => {
      void engine
        .start(BASE_OPTIONS, (ev) => {
          events.push(ev)
          if (ev.kind === 'session:ended') resolve()
        })
        .then((p) => {
          proc = p
        })
    })

    await flush(5)
    pushInitializeResponse(1)
    await flush(5)
    pushThreadStartResponse('thr_stop', 2)
    await flush(5)
    pushTurnStartResponse('turn_1', 3)
    await flush(5)

    const stopping = proc.stop()
    await flush(5)
    const request = _child._written
      .map((line) => JSON.parse(line) as { method?: string; id?: number })
      .find((message) => message.method === 'turn/interrupt')
    pushLine({ jsonrpc: '2.0', id: request?.id, result: {} })
    pushNotification('turn/completed', {
      threadId: 'thr_stop',
      turn: { id: 'turn_1', status: 'interrupted', startedAt: null, completedAt: null, durationMs: null, error: null },
    })
    await stopping
    await sessionEndedPromise

    const sessionEnded = events.find((e) => e.kind === 'session:ended') as Extract<
      AgentEvent,
      { kind: 'session:ended' }
    >
    expect(sessionEnded).toBeDefined()
    expect(sessionEnded.reason).toBe('killed')
    expect(_child.kill).toHaveBeenCalled()
    expect(proc.isAlive?.()).toBe(false)
  })

  it('is safe to call after the session has already ended', async () => {
    // Drive a full happy-path session then call stop() — should not throw and
    // must not double-emit session:ended.
    resetChild()
    const engine = createCodexEngine()
    const events: AgentEvent[] = []

    let proc!: Awaited<ReturnType<typeof engine.start>>
    const startPromise = engine
      .start(BASE_OPTIONS, (ev) => events.push(ev))
      .then((p) => {
        proc = p
      })

    await flush(5)
    pushInitializeResponse(1)
    await flush(5)
    pushThreadStartResponse('thr_clean', 2)
    await flush(5)
    pushTurnStartResponse('turn_1', 3)
    await flush(5)
    pushNotification('turn/completed', { turnId: 'turn_1', turn: { status: 'completed' } })
    await flush(20)

    await startPromise
    await flush(10)

    const beforeStop = events.filter((e) => e.kind === 'session:ended').length
    expect(beforeStop).toBe(1)

    await proc.stop()
    await flush(10)

    const afterStop = events.filter((e) => e.kind === 'session:ended').length
    expect(afterStop).toBe(1) // not duplicated
  })
})

describe('createCodexEngine — sendMessage after session ended', () => {
  it('rejects immediately with an agent-unavailable error instead of writing to the closed peer', async () => {
    // Drive a full happy-path session to completion (client.close() and
    // child.kill('SIGTERM') both run in the engine's `finally` block), then
    // simulate a chat message typed after that point — Kōbō's one-prompt-
    // one-turn contract means this is exactly the case that used to either
    // write to an already-closed JSON-RPC peer or hang for the full 120s
    // request timeout, with neither shape recognised by the orchestrator.
    resetChild()
    const engine = createCodexEngine()
    const events: AgentEvent[] = []

    let proc!: Awaited<ReturnType<typeof engine.start>>
    const startPromise = engine
      .start(BASE_OPTIONS, (ev) => events.push(ev))
      .then((p) => {
        proc = p
      })

    await flush(5)
    pushInitializeResponse(1)
    await flush(5)
    pushThreadStartResponse('thr_ended', 2)
    await flush(5)
    pushTurnStartResponse('turn_1', 3)
    await flush(5)
    pushNotification('turn/completed', { turnId: 'turn_1', turn: { status: 'completed' } })
    await flush(20)

    await startPromise
    await flush(10)

    expect(events.filter((e) => e.kind === 'session:ended')).toHaveLength(1)
    expect(proc.isAlive?.()).toBe(false)
    expect(_child.kill).toHaveBeenCalled()

    const writesBefore = _child._written.length

    // Must settle well before vitest's own test timeout — a stuck 120s
    // JSON-RPC wait would fail this test on its own.
    await expect(proc.sendMessage('typed after the session already ended')).rejects.toThrow(
      /agent is no longer running/i,
    )

    const wroteSteerRequest = _child._written
      .slice(writesBefore)
      .some((line) => JSON.parse(line).method === 'turn/steer')
    expect(wroteSteerRequest).toBe(false)
  })
})

describe('createCodexEngine — server request (approval flow)', () => {
  it('emits session:user-input-requested and resolves via resolvePendingUserInput', async () => {
    resetChild()
    const engine = createCodexEngine()
    const events: AgentEvent[] = []

    const userInputRequestedPromise = new Promise<void>((resolve) => {
      void engine
        .start(BASE_OPTIONS, (ev) => {
          events.push(ev)
          if (ev.kind === 'session:user-input-requested') resolve()
        })
        .then(async (proc) => {
          // Wait for the user-input-requested event, then resolve it
          await userInputRequestedPromise.then(async () => {
            await flush(5)
            const inputReq = events.find((e) => e.kind === 'session:user-input-requested') as Extract<
              AgentEvent,
              { kind: 'session:user-input-requested' }
            >
            if (inputReq) {
              proc.resolvePendingUserInput(inputReq.toolCallId, { kind: 'permission-allow' })
            }
          })
        })
    })

    await flush(5)

    pushInitializeResponse(1)
    await flush(5)
    pushThreadStartResponse('thr_approval', 2)
    await flush(5)
    pushTurnStartResponse('turn_1', 3)
    await flush(5)

    // Server sends a command execution approval request
    const callId = 'call_abc'
    pushLine({
      jsonrpc: '2.0',
      id: 100,
      method: 'item/commandExecution/requestApproval',
      params: {
        callId,
        threadId: 'thr_approval',
        turnId: 'turn_1',
        itemId: 'item_0',
        command: 'ls -la',
        cwd: '/workspace',
        reason: null,
      },
    })

    await userInputRequestedPromise
    await flush(20)

    // Check that session:user-input-requested was emitted
    const inputReq = events.find((e) => e.kind === 'session:user-input-requested') as Extract<
      AgentEvent,
      { kind: 'session:user-input-requested' }
    >
    expect(inputReq).toBeDefined()
    expect(inputReq.toolName).toBe('Bash')

    // Check that the approval response was written to stdin
    const written = _child._written
    const responses = written.map((line) => JSON.parse(line) as { id?: number; result?: unknown })
    const approvalResponse = responses.find((r) => r.id === 100)
    expect(approvalResponse).toBeDefined()
    expect(approvalResponse?.result).toEqual({ decision: 'accept' })
  })

  it('drains an outstanding approval request with an error response when the engine tears down mid-approval', async () => {
    resetChild()
    vi.useFakeTimers()
    try {
      const events: AgentEvent[] = []
      const engine = createCodexEngine()
      const proc = await engine.start(BASE_OPTIONS, (ev) => events.push(ev))

      await vi.advanceTimersByTimeAsync(5)
      pushInitializeResponse(1)
      await vi.advanceTimersByTimeAsync(5)
      pushThreadStartResponse('thr_1', 2)
      await vi.advanceTimersByTimeAsync(5)
      pushTurnStartResponse('turn_1', 3)
      await vi.advanceTimersByTimeAsync(5)

      pushLine({
        jsonrpc: '2.0',
        id: 100,
        method: 'item/commandExecution/requestApproval',
        params: {
          callId: 'call_teardown',
          threadId: 'thr_1',
          turnId: 'turn_1',
          itemId: 'item_0',
          command: 'ls',
          cwd: '/workspace',
          reason: null,
        },
      })
      await vi.advanceTimersByTimeAsync(20)
      expect(events.some((e) => e.kind === 'session:user-input-requested')).toBe(true)

      // Nobody ever answers the approval — the engine is torn down mid-flight
      // (e.g. the workspace is stopped/deleted while a permission card is up).
      const stopPromise = proc.stop()
      await vi.advanceTimersByTimeAsync(CODEX_GRACEFUL_INTERRUPT_TIMEOUT_MS * 2 + 100)
      await stopPromise

      const responses = _child._written.map((line) => JSON.parse(line) as { id?: number; error?: unknown })
      const response = responses.find((r) => r.id === 100)
      expect(response?.error).toBeDefined()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('createCodexEngine — quota error in stderr', () => {
  it('emits error/quota when stderr contains a quota error pattern', async () => {
    resetChild()
    const engine = createCodexEngine()
    const events: AgentEvent[] = []

    const quotaEmittedPromise = new Promise<void>((resolve) => {
      void engine.start(BASE_OPTIONS, (ev) => {
        events.push(ev)
        if (ev.kind === 'error' && ev.category === 'quota') resolve()
      })
    })

    await flush(5)

    // Push quota error to stderr BEFORE the initialize handshake
    _child.stderr.push('rate limit reached: you have exceeded your quota\n')

    await quotaEmittedPromise
    await flush(5)

    const quotaEvent = events.find(
      (e) => e.kind === 'error' && (e as Extract<AgentEvent, { kind: 'error' }>).category === 'quota',
    )
    expect(quotaEvent).toBeDefined()
    expect(quotaEvent).toMatchObject({ kind: 'error', category: 'quota' })
  })
})

describe('createCodexEngine — token usage', () => {
  it('emits usage event from thread/tokenUsage/updated notification', async () => {
    resetChild()
    const engine = createCodexEngine()
    const events: AgentEvent[] = []

    const sessionEndedPromise = new Promise<void>((resolve) => {
      void engine.start(BASE_OPTIONS, (ev) => {
        events.push(ev)
        if (ev.kind === 'session:ended') resolve()
      })
    })

    await flush(5)

    pushInitializeResponse(1)
    await flush(5)
    pushThreadStartResponse('thr_usage', 2)
    await flush(5)
    pushTurnStartResponse('turn_1', 3)
    await flush(5)

    // Token usage notification
    pushNotification('thread/tokenUsage/updated', {
      tokenUsage: {
        total: {
          totalTokens: 1000,
          inputTokens: 600,
          cachedInputTokens: 100,
          outputTokens: 300,
          reasoningOutputTokens: 100,
        },
        last: {
          totalTokens: 500,
          inputTokens: 300,
          cachedInputTokens: 50,
          outputTokens: 150,
          reasoningOutputTokens: 50,
        },
        modelContextWindow: 128000,
      },
    })
    await flush(5)

    // Turn completed
    pushNotification('turn/completed', {
      threadId: 'thr_usage',
      turn: { id: 'turn_1', status: 'completed', startedAt: null, completedAt: null, durationMs: null, error: null },
    })

    await sessionEndedPromise
    await flush(10)

    const usageEvent = events.find((e) => e.kind === 'usage') as Extract<AgentEvent, { kind: 'usage' }> | undefined
    expect(usageEvent).toBeDefined()
    expect(usageEvent?.inputTokens).toBe(300)
    // outputTokens = outputTokens + reasoningOutputTokens = 150 + 50 = 200
    expect(usageEvent?.outputTokens).toBe(200)
    expect(usageEvent?.cacheRead).toBe(50)
  })
})

describe('createCodexEngine — engineSessionId', () => {
  it('exposes the thread id from the start response as engineSessionId', async () => {
    resetChild()
    const engine = createCodexEngine()
    let proc: Awaited<ReturnType<typeof engine.start>> | undefined

    const procPromise = engine.start(BASE_OPTIONS, () => {})
    procPromise.then((p) => {
      proc = p
    })

    await flush(5)
    pushInitializeResponse(1)
    await flush(5)
    pushThreadStartResponse('thr_id_check', 2)
    await flush(10)

    expect(proc?.engineSessionId).toBe('thr_id_check')
  })
})

describe('createCodexEngine — turn liveness with multiple pending approvals', () => {
  it('does not resume the idle timer until every pending approval is resolved', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    resetChild()
    const engine = createCodexEngine()
    const events: AgentEvent[] = []
    let proc: Awaited<ReturnType<typeof engine.start>> | undefined

    void engine
      .start(BASE_OPTIONS, (ev) => events.push(ev))
      .then((p) => {
        proc = p
      })

    await flush(5)
    pushInitializeResponse(1)
    await flush(5)
    pushThreadStartResponse('thr_multi', 2)
    await flush(5)
    pushTurnStartResponse('turn_1', 3)
    await flush(5)

    // Two commands need approval in the same turn.
    pushLine({
      jsonrpc: '2.0',
      id: 100,
      method: 'item/commandExecution/requestApproval',
      params: {
        callId: 'call_a',
        threadId: 'thr_multi',
        turnId: 'turn_1',
        itemId: 'item_a',
        command: 'ls',
        cwd: '/workspace',
        reason: null,
      },
    })
    await flush(5)
    pushLine({
      jsonrpc: '2.0',
      id: 101,
      method: 'item/commandExecution/requestApproval',
      params: {
        callId: 'call_b',
        threadId: 'thr_multi',
        turnId: 'turn_1',
        itemId: 'item_b',
        command: 'pwd',
        cwd: '/workspace',
        reason: null,
      },
    })
    await flush(5)

    expect(proc).toBeDefined()
    // Resolve only the first approval — the second is still pending.
    proc!.resolvePendingUserInput('call_a', { kind: 'permission-allow' })
    await flush(5)

    // Jump past the 120s idle timeout: the turn must NOT time out, since a
    // human decision on call_b is still outstanding.
    await vi.advanceTimersByTimeAsync(CODEX_TURN_IDLE_TIMEOUT_MS + 1_000)

    const timeoutError = events.find((e) => e.kind === 'error' && e.message.includes('stopped reporting activity'))
    expect(timeoutError).toBeUndefined()

    vi.useRealTimers()
  })
})

describe('createCodexEngine — handshake liveness', () => {
  it('fails the session when the app-server never answers initialize', async () => {
    resetChild()
    vi.useFakeTimers()
    try {
      const engine = createCodexEngine()
      const events: AgentEvent[] = []
      void engine.start(BASE_OPTIONS, (ev) => events.push(ev))

      // The child stays alive and simply never replies. Before the fix this
      // parked the whole start path forever, with no event of any kind.
      await vi.advanceTimersByTimeAsync(CODEX_HANDSHAKE_TIMEOUT_MS + 1_000)

      expect(events).toContainEqual(expect.objectContaining({ kind: 'error', category: 'spawn_failed' }))
      expect(events).toContainEqual({ kind: 'session:ended', reason: 'error', exitCode: null })
    } finally {
      vi.useRealTimers()
    }
  })
})

it('keeps silent foreground tools alive and restores the stream deadline after completion', async () => {
  resetChild()
  vi.useFakeTimers()
  try {
    const events: AgentEvent[] = []
    await createCodexEngine().start(BASE_OPTIONS, (ev) => events.push(ev))
    await vi.advanceTimersByTimeAsync(10)
    pushInitializeResponse()
    await vi.advanceTimersByTimeAsync(5)
    pushThreadStartResponse('thread_tools')
    await vi.advanceTimersByTimeAsync(5)
    pushTurnStartResponse()
    await vi.advanceTimersByTimeAsync(5)
    const item = {
      id: 'silent',
      type: 'commandExecution',
      command: 'sleep 180',
      cwd: '/tmp',
      status: 'inProgress',
      commandActions: [],
      aggregatedOutput: '',
      exitCode: null,
      durationMs: null,
    }
    pushNotification('item/started', { threadId: 'thread_tools', turnId: 'turn_1', item })
    pushNotification('item/started', { threadId: 'thread_tools', turnId: 'turn_1', item: { ...item, id: 'second' } })
    await vi.advanceTimersByTimeAsync(CODEX_TURN_IDLE_TIMEOUT_MS + 10)
    expect(events.some((ev) => ev.kind === 'session:ended')).toBe(false)
    pushNotification('item/completed', {
      threadId: 'thread_tools',
      turnId: 'turn_1',
      item: { ...item, status: 'completed', exitCode: 0 },
    })
    await vi.advanceTimersByTimeAsync(CODEX_TURN_IDLE_TIMEOUT_MS + 10)
    expect(events.some((ev) => ev.kind === 'session:ended')).toBe(false)
    pushNotification('item/completed', {
      threadId: 'thread_tools',
      turnId: 'turn_1',
      item: { ...item, id: 'second', status: 'completed', exitCode: 0 },
    })
    await vi.advanceTimersByTimeAsync(CODEX_TURN_IDLE_TIMEOUT_MS + 10)
    expect(events.filter((ev) => ev.kind === 'session:ended')).toEqual([
      { kind: 'session:ended', reason: 'error', exitCode: null },
    ])
  } finally {
    vi.useRealTimers()
  }
})

it.each([false, true])('uses the stream deadline after a completed plan (foreground tool: %s)', async (withTool) => {
  resetChild()
  vi.useFakeTimers()
  try {
    const events: AgentEvent[] = []
    await createCodexEngine().start(BASE_OPTIONS, (ev) => events.push(ev))
    await vi.advanceTimersByTimeAsync(10)
    pushInitializeResponse()
    await vi.advanceTimersByTimeAsync(5)
    pushThreadStartResponse('thread_plan')
    await vi.advanceTimersByTimeAsync(5)
    pushTurnStartResponse()
    await vi.advanceTimersByTimeAsync(5)

    const tool = {
      id: 'silent',
      type: 'commandExecution',
      command: 'sleep 180',
      cwd: '/tmp',
      status: 'inProgress',
      commandActions: [],
      aggregatedOutput: '',
      exitCode: null,
      durationMs: null,
    }
    if (withTool) pushNotification('item/started', { threadId: 'thread_plan', turnId: 'turn_1', item: tool })
    pushNotification('item/completed', {
      threadId: 'thread_plan',
      turnId: 'turn_1',
      item: { id: 'plan_1', type: 'plan', text: '- Inspect code' },
    })

    if (withTool) {
      await vi.advanceTimersByTimeAsync(CODEX_TURN_IDLE_TIMEOUT_MS + 10)
      expect(events.some((ev) => ev.kind === 'session:ended')).toBe(false)
      pushNotification('item/completed', {
        threadId: 'thread_plan',
        turnId: 'turn_1',
        item: { ...tool, status: 'completed', exitCode: 0 },
      })
    }

    await vi.advanceTimersByTimeAsync(CODEX_TURN_IDLE_TIMEOUT_MS + 10)
    expect(events.filter((ev) => ev.kind === 'session:ended')).toEqual([
      { kind: 'session:ended', reason: 'error', exitCode: null },
    ])
  } finally {
    vi.useRealTimers()
  }
})

describe('canonical error and interrupt notifications', () => {
  it('keeps retryable structured errors transient and interrupts the active turn', async () => {
    resetChild()
    const events: AgentEvent[] = []
    const proc = await createCodexEngine().start(BASE_OPTIONS, (ev) => events.push(ev))
    await flush(10)
    pushInitializeResponse()
    await flush(5)
    pushThreadStartResponse('thr_contract')
    await flush(5)
    pushTurnStartResponse('turn_contract')
    await flush(5)
    pushNotification('error', {
      error: { message: 'temporarily unavailable' },
      willRetry: true,
      threadId: 'thr_contract',
      turnId: 'turn_contract',
    })
    await flush(5)
    expect(events.some((ev) => ev.kind === 'error')).toBe(false)
    proc.interrupt()
    await flush(5)
    const request = _child._written.map((line) => JSON.parse(line)).find((line) => line.method === 'turn/interrupt')
    pushLine({ jsonrpc: '2.0', id: request.id, result: {} })
    pushNotification('turn/completed', {
      threadId: 'thr_contract',
      turn: { id: 'turn_contract', status: 'completed', error: null },
    })
    await flush()
    expect(request.params).toEqual({ threadId: 'thr_contract', turnId: 'turn_contract' })
    expect(events.find((ev) => ev.kind === 'session:ended')).toMatchObject({ reason: 'completed' })
  })
})

it('correlates file approvals to the exact thread, turn and item without reusing other changes', async () => {
  resetChild()
  const events: AgentEvent[] = []
  await createCodexEngine().start(BASE_OPTIONS, (ev) => events.push(ev))
  await flush(10)
  pushInitializeResponse()
  await flush(5)
  pushThreadStartResponse('thr_files')
  await flush(5)
  pushTurnStartResponse('turn_files')
  await flush(5)
  const changes = [{ path: '/workspace/a.ts', kind: { type: 'add' }, diff: '+safe' }]
  pushNotification('item/started', {
    threadId: 'thr_files',
    turnId: 'turn_files',
    startedAtMs: 0,
    item: { id: 'edit_a', type: 'fileChange', changes, status: 'inProgress' },
  })
  for (const [id, threadId, turnId, itemId] of [
    [100, 'thr_files', 'turn_files', 'edit_a'],
    [101, 'thr_files', 'turn_files', 'edit_b'],
    [102, 'thr_other', 'turn_files', 'edit_a'],
    [103, 'thr_files', 'turn_other', 'edit_a'],
  ]) {
    pushLine({
      jsonrpc: '2.0',
      id,
      method: 'item/fileChange/requestApproval',
      params: { threadId, turnId, itemId, startedAtMs: 0, reason: null, grantRoot: null },
    })
  }
  await flush()
  const approvals = events.filter(
    (ev): ev is Extract<AgentEvent, { kind: 'session:user-input-requested' }> =>
      ev.kind === 'session:user-input-requested',
  )
  expect(approvals).toHaveLength(4)
  expect(approvals[0].payload).toMatchObject({ changes, cwd: '/workspace', operationApprovalAvailable: true })
  for (const approval of approvals.slice(1))
    expect(approval.payload).toMatchObject({ operationApprovalAvailable: false })
  pushNotification('turn/completed', { threadId: 'thr_files', turn: { id: 'turn_files', status: 'completed' } })
  await flush()
})
