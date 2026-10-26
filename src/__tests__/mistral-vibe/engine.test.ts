import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import type * as acp from '@agentclientprotocol/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { VibeAcpHandlers } from '../../server/services/agent/engines/mistral-vibe/client.js'
import type { AgentEvent, StartOptions } from '../../server/services/agent/engines/types.js'

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  connect: vi.fn(),
  request: vi.fn(),
  close: vi.fn(),
  policy: vi.fn(),
}))
vi.mock('../../server/services/agent/engines/mistral-vibe/spawn.js', () => ({ spawnVibeAcp: mocks.spawn }))
vi.mock('../../server/services/agent/engines/mistral-vibe/client.js', () => ({
  connectVibeAcp: mocks.connect,
  requestVibeAcp: mocks.request,
  closeVibeAcpSession: mocks.close,
}))
vi.mock('../../server/services/workspace-permission-policy-service.js', () => ({
  isWorkspacePermissionAllowed: mocks.policy,
  isOperationApprovalAvailable: () => false,
}))

import { createMistralVibeEngine } from '../../server/services/agent/engines/mistral-vibe/engine.js'
import { SessionController } from '../../server/services/agent/session-controller.js'

function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
const options: StartOptions = {
  workspaceId: 'workspace',
  workingDir: '/tmp/project',
  prompt: 'Mission',
  backendUrl: 'http://127.0.0.1',
  koboHome: '/tmp/kobo',
  settings: {} as StartOptions['settings'],
  agentPermissionMode: 'interactive',
}
const modes = {
  currentModeId: 'ask',
  availableModes: [
    { id: 'ask', name: 'Ask' },
    { id: 'accept-edits', name: 'Accept Edits' },
    { id: 'auto-approve', name: 'Auto Approve' },
  ],
}
const modeConfig = (currentValue = 'ask') => [
  {
    id: 'mode',
    type: 'select',
    name: 'Mode',
    currentValue,
    options: modes.availableModes.map(({ id, name }) => ({ value: id, name })),
  },
]
let handlers: VibeAcpHandlers
let closed: ReturnType<typeof deferred>
let transportClosed: ReturnType<typeof deferred>
let prompt: ReturnType<typeof deferred<acp.PromptResponse>>
let stop: ReturnType<typeof vi.fn>
let events: AgentEvent[]
let child: ChildProcess
const tick = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve(undefined)
}
function update(update: acp.SessionUpdate, sessionId = 'native') {
  handlers.sessionUpdate?.({ params: { sessionId, update } } as Parameters<
    NonNullable<VibeAcpHandlers['sessionUpdate']>
  >[0])
}
async function launch(overrides: Partial<StartOptions> = {}) {
  const process = await createMistralVibeEngine().start({ ...options, ...overrides }, (event) => events.push(event))
  await tick()
  return process
}
beforeEach(() => {
  vi.clearAllMocks()
  events = []
  closed = deferred()
  transportClosed = deferred()
  prompt = deferred<acp.PromptResponse>()
  child = Object.assign(new EventEmitter(), { pid: 123, exitCode: null, signalCode: null }) as unknown as ChildProcess
  stop = vi.fn(() => closed.promise)
  mocks.spawn.mockReturnValue({ child, closed: closed.promise, stop })
  mocks.connect.mockImplementation((_child, value) => {
    handlers = value
    return { closed: transportClosed.promise, close: vi.fn() }
  })
  mocks.close.mockResolvedValue(undefined)
  mocks.policy.mockReturnValue(false)
  mocks.request.mockImplementation(async (_connection, method, params) => {
    switch (method) {
      case 'initialize':
        return { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { close: {} } } }
      case 'session/new':
        return { sessionId: 'native', modes, configOptions: modeConfig() }
      case 'session/load':
        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'REPLAY' } }, params.sessionId)
        return { modes, configOptions: modeConfig() }
      case 'session/set_config_option':
        return { configOptions: modeConfig(params.value) }
      case 'session/prompt':
        return prompt.promise
      default:
        throw new Error(`Unexpected ${method}`)
    }
  })
})
afterEach(() => vi.useRealTimers())

describe('Mistral Vibe engine lifecycle', () => {
  it.each([
    { agentPermissionMode: 'plan' as const },
    { readOnly: true },
    { model: 'bad\0value' },
    { effort: 'x'.repeat(257) },
  ])('rejects %j before spawning', async (overrides) => {
    await expect(launch(overrides)).rejects.toThrow()
    expect(mocks.spawn).not.toHaveBeenCalled()
  })
  it('returns process ownership before initialization and does not credit replay or dispatch', async () => {
    const initializing = deferred<unknown>()
    mocks.request.mockImplementationOnce(() => initializing.promise)
    const process = await launch({ resumeFromEngineSessionId: 'native' })
    expect(process.pid).toBe(123)
    let accepted = false
    void process.initialPromptAccepted?.then(() => {
      accepted = true
    })
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'REPLAY' } })
    initializing.resolve({ protocolVersion: 1, agentCapabilities: { loadSession: true } })
    await process.ready
    expect(accepted).toBe(false)
    expect(events.filter((e) => e.kind === 'message:text')).toEqual([])
    expect(mocks.request.mock.calls[1]?.[2]).toEqual({ sessionId: 'native', cwd: '/tmp/project', mcpServers: [] })
    expect(mocks.request.mock.calls.map((call) => call[1])).toEqual([
      'initialize',
      'session/load',
      'session/set_config_option',
      'session/prompt',
    ])
  })
  it.each([
    { name: 'empty', entries: [] },
    {
      name: 'nonempty',
      entries: [{ content: 'Inspect the project', priority: 'medium' as const, status: 'pending' as const }],
    },
  ])('rejects the stronger receipt after $name plan-only output and ambiguous prompt failure', async ({ entries }) => {
    const process = await launch()
    await process.ready
    let accepted = false
    void process.initialPromptAccepted?.then(
      () => {
        accepted = true
      },
      () => {},
    )
    update({ sessionUpdate: 'plan', entries })
    await tick()
    expect(events).toContainEqual(expect.objectContaining({ kind: 'tool:call', name: 'TodoWrite' }))
    expect(accepted).toBe(false)
    prompt.reject(new Error('Disconnected before prompt consumption was confirmed'))
    await expect(process.initialPromptAccepted).rejects.toThrow()
    expect(accepted).toBe(false)
    expect(events.some((event) => event.kind === 'turn:completed')).toBe(false)
  })
  it.each(['tool_call', 'tool_call_update'] as const)(
    'accepts genuine native %s before prompt completion',
    async (sessionUpdate) => {
      const process = await launch()
      update({
        sessionUpdate,
        toolCallId: 'native-tool',
        title: 'Run test',
        kind: 'execute',
        status: 'in_progress',
        rawInput: { command: 'test' },
        _meta: { tool_name: 'bash', effect_kind: 'shell' },
      })
      await process.initialPromptAccepted
      prompt.reject(new Error('Later transport failure'))
      await tick()
      await expect(process.initialPromptAccepted).resolves.toBeUndefined()
      expect(events).toContainEqual(expect.objectContaining({ kind: 'tool:call', name: 'bash' }))
    },
  )
  it('accepts only owned current foreground output, flushes before one terminal event and waits for native closure', async () => {
    vi.useFakeTimers()
    const process = await launch()
    let accepted = false
    let physicallyClosed = false
    void process.initialPromptAccepted?.then(() => {
      accepted = true
    })
    void process.closed?.then(() => {
      physicallyClosed = true
    })
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'child' } }, 'foreign')
    await vi.advanceTimersByTimeAsync(40)
    expect(accepted).toBe(false)
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Live' } })
    await vi.advanceTimersByTimeAsync(40)
    expect(accepted).toBe(true)
    prompt.resolve({ stopReason: 'end_turn' })
    await tick()
    expect(events.map((event) => event.kind)).toEqual([
      'session:started',
      'message:text',
      'message:end',
      'turn:completed',
      'session:ended',
    ])
    expect(physicallyClosed).toBe(false)
    expect(stop).toHaveBeenCalledOnce()
    await stop.mock.calls[0]![0]()
    expect(mocks.close).toHaveBeenCalledWith(expect.anything(), { sessionId: 'native', active: false, canClose: true })
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'late' } })
    transportClosed.resolve(undefined)
    closed.resolve(undefined)
    await process.closed
    await tick()
    expect(physicallyClosed).toBe(true)
    expect(events.filter((event) => event.kind === 'session:ended')).toHaveLength(1)
    expect(events.filter((event) => event.kind === 'message:text')).toHaveLength(1)
    expect(() => process.sendMessage('later')).toThrow('agent is no longer running')
  })
  it('accepts successful completion without output, while busy sends remain unsupported until physical closure', async () => {
    const process = await launch()
    expect(() => process.sendMessage('busy')).toThrow(/unsupported/i)
    expect(() => process.sendMessage('busy')).not.toThrow(/agent is no longer running/)
    prompt.resolve({ stopReason: 'end_turn' })
    await process.initialPromptAccepted
    await tick()
    expect(() => process.sendMessage('closing')).toThrow(/unsupported/i)
  })
  it.each(['max_tokens', 'max_turn_requests', 'refusal', 'cancelled'] as const)(
    'preserves terminal %s without success or duplicate diagnostics',
    async (stopReason) => {
      const process = await launch()
      prompt.resolve({ stopReason })
      await expect(process.initialPromptAccepted).rejects.toThrow()
      await tick()
      expect(events.filter((e) => e.kind === 'turn:completed')).toHaveLength(0)
      expect(events.filter((e) => e.kind === 'session:ended')).toHaveLength(1)
      expect(events.filter((e) => e.kind === 'error')).toHaveLength(1)
      expect(events).toContainEqual(expect.objectContaining({ kind: 'error', code: `acp_${stopReason}` }))
      expect(events).toContainEqual({ kind: 'session:ended', reason: 'error', exitCode: null })
    },
  )
  it.each(['stop', 'interrupt'] as const)('does not invent a cancellation error after local %s', async (method) => {
    const process = await launch()
    const stopping = process[method]()
    prompt.resolve({ stopReason: 'cancelled' })
    await tick()
    expect(events.filter((event) => event.kind === 'error')).toEqual([])
    expect(events.filter((event) => event.kind === 'session:ended')).toEqual([
      { kind: 'session:ended', reason: 'killed', exitCode: null },
    ])
    closed.resolve(undefined)
    await stopping
  })
  it.each(['initialize', 'session/new', 'session/set_config_option', 'session/load'])(
    'cleans up failed %s setup without losing controller ownership',
    async (method) => {
      const original = mocks.request.getMockImplementation()!
      mocks.request.mockImplementation((connection, requested, params) =>
        requested === method
          ? Promise.reject(new Error('private-token failed'))
          : original(connection, requested, params),
      )
      stop.mockRejectedValue(new Error('unconfirmed shutdown'))
      const controller = new SessionController('workspace', 'row', createMistralVibeEngine(), (event) =>
        events.push(event),
      )
      await controller.start({
        ...options,
        ...(method === 'session/load' ? { resumeFromEngineSessionId: 'native' } : {}),
      })
      await expect(controller.engineProcess!.ready).rejects.toThrow()
      await tick()
      expect(controller.isClosed).toBe(false)
      expect(events.filter((e) => e.kind === 'session:ended')).toHaveLength(1)
      expect(mocks.request.mock.calls.some((call) => call[1] === 'session/prompt')).toBe(false)
      expect(JSON.stringify(events)).not.toContain('private-token')
      await expect(controller.stop()).rejects.toThrow('unconfirmed shutdown')
      expect(controller.isClosed).toBe(false)
      closed.resolve(undefined)
      await controller.closed
    },
  )
  it.each([
    ['initialize', { protocolVersion: 99, agentCapabilities: {} }],
    ['initialize', { protocolVersion: 1, agentCapabilities: { loadSession: 'yes' } }],
    ['session/new', { sessionId: 'native' }],
    ['session/new', { sessionId: '', modes, configOptions: modeConfig() }],
    ['session/set_config_option', { configOptions: modeConfig('auto-approve') }],
  ])('rejects invalid unchecked %s response before prompt', async (method, response) => {
    const original = mocks.request.getMockImplementation()!
    mocks.request.mockImplementation((connection, requested, params) =>
      requested === method ? Promise.resolve(response) : original(connection, requested, params),
    )
    const process = await launch()
    await expect(process.ready).rejects.toThrow()
    expect(mocks.request.mock.calls.some((call) => call[1] === 'session/prompt')).toBe(false)
    expect(stop).toHaveBeenCalledOnce()
  })
  it('refuses setup questions before dispatch instead of replaying a human-input panel', async () => {
    const original = mocks.request.getMockImplementation()!
    let replayAnswer: unknown
    mocks.request.mockImplementation(async (connection, method, params) => {
      if (method === 'session/set_config_option') {
        replayAnswer = await handlers.createElicitation!({
          params: {
            sessionId: 'native',
            mode: 'form',
            message: 'Old question',
            requestedSchema: { type: 'object', properties: { q: { type: 'string' } } },
          },
          signal: new AbortController().signal,
          requestId: 1,
        } as unknown as Parameters<NonNullable<VibeAcpHandlers['createElicitation']>>[0])
      }
      return original(connection, method, params)
    })
    const process = await launch()
    expect(replayAnswer).toEqual({ action: 'cancel' })
    await process.ready
    expect(events.filter((event) => event.kind === 'session:user-input-requested')).toEqual([])
  })
  it('does not retry failed load as a fresh session', async () => {
    const original = mocks.request.getMockImplementation()!
    mocks.request.mockImplementation((connection, method, params) =>
      method === 'session/load' ? Promise.reject(new Error('session not found')) : original(connection, method, params),
    )
    const process = await launch({ resumeFromEngineSessionId: 'native' })
    await expect(process.ready).rejects.toThrow()
    expect(mocks.request.mock.calls.some((call) => call[1] === 'session/new')).toBe(false)
    expect(events).toContainEqual(
      expect.objectContaining({ kind: 'error', category: 'other', code: 'acp_load_failed' }),
    )
  })
  it.each([
    ['Missing API key for provider; private-token', 'acp_auth_required', 'other'],
    ['429 quota exceeded private-token', 'acp_quota', 'quota'],
    ['disconnected private-token', 'acp_prompt_failed', 'other'],
  ])('sanitizes %s and rejects uncertain consumption', async (message, code, category) => {
    const process = await launch()
    prompt.reject(new Error(message))
    await expect(process.initialPromptAccepted).rejects.toThrow()
    await tick()
    expect(events).toContainEqual(expect.objectContaining({ kind: 'error', code, category }))
    expect(JSON.stringify(events)).not.toContain('private-token')
    expect(mocks.request.mock.calls.filter((call) => call[1] === 'session/prompt')).toHaveLength(1)
  })
  it('handles setup EOF and ignores a late initialization response after stop', async () => {
    const initialize = deferred<unknown>()
    mocks.request.mockImplementationOnce(() => initialize.promise)
    const process = await launch()
    transportClosed.resolve(undefined)
    await expect(process.ready).rejects.toThrow()
    await tick()
    initialize.resolve({ protocolVersion: 1, agentCapabilities: {} })
    await tick()
    expect(mocks.request).toHaveBeenCalledTimes(1)
    expect(events.filter((e) => e.kind === 'session:ended')).toHaveLength(1)
  })
  it('stops during setup before dispatch and awaits physical closure', async () => {
    const initialize = deferred<unknown>()
    mocks.request.mockImplementationOnce(() => initialize.promise)
    const process = await launch()
    const stopping = process.stop()
    await expect(process.ready).rejects.toThrow()
    initialize.resolve({ protocolVersion: 1, agentCapabilities: {} })
    await tick()
    expect(mocks.request).toHaveBeenCalledTimes(1)
    closed.resolve(undefined)
    await stopping
    expect(events.filter((e) => e.kind === 'session:ended')).toEqual([
      { kind: 'session:ended', reason: 'killed', exitCode: null },
    ])
  })
  it('keeps prompts beyond 120 seconds when the watchdog is disabled', async () => {
    vi.useFakeTimers()
    const process = await launch()
    await vi.advanceTimersByTimeAsync(121_000)
    expect(stop).not.toHaveBeenCalled()
    prompt.resolve({ stopReason: 'end_turn' })
    await process.initialPromptAccepted
  })
  it('expires foreground silence at 120 seconds and closes the SDK only after native closure', async () => {
    vi.useFakeTimers()
    const process = await launch({ watchdogEnabled: true })
    const sdkClose = mocks.connect.mock.results[0]!.value.close
    await vi.advanceTimersByTimeAsync(119_999)
    expect(stop).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(stop).toHaveBeenCalledOnce()
    expect(sdkClose).not.toHaveBeenCalled()
    await stop.mock.calls[0]![0]()
    expect(mocks.close).toHaveBeenCalledWith(expect.anything(), { sessionId: 'native', active: true, canClose: true })
    closed.resolve(undefined)
    await process.closed
    await tick()
    expect(sdkClose).toHaveBeenCalledOnce()
  })
  it('refreshes tool liveness on nonterminal native progress and restores foreground timeout after completion', async () => {
    vi.useFakeTimers()
    await launch({ watchdogEnabled: true })
    update({
      sessionUpdate: 'tool_call',
      toolCallId: 't',
      title: 'Run',
      kind: 'execute',
      status: 'in_progress',
      rawInput: { command: 'test' },
      _meta: { tool_name: 'bash', effect_kind: 'shell' },
    })
    await vi.advanceTimersByTimeAsync(29 * 60_000)
    update({ sessionUpdate: 'tool_call_update', toolCallId: 't', status: 'in_progress', rawOutput: 'progress' })
    await vi.advanceTimersByTimeAsync(29 * 60_000)
    expect(stop).not.toHaveBeenCalled()
    update({ sessionUpdate: 'tool_call_update', toolCallId: 't', status: 'completed' })
    await vi.advanceTimersByTimeAsync(119_999)
    expect(stop).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(stop).toHaveBeenCalledOnce()
  })
  it('looks up native tools and applies workspace remembered policy before admitting a permission callback', async () => {
    mocks.policy.mockReturnValue(true)
    await launch()
    update({
      sessionUpdate: 'tool_call',
      toolCallId: 'native-tool',
      title: 'Run',
      kind: 'execute',
      status: 'in_progress',
      rawInput: { command: 'pwd' },
      _meta: { tool_name: 'bash', effect_kind: 'shell' },
    })
    const result = await handlers.requestPermission!({
      params: {
        sessionId: 'native',
        toolCall: { toolCallId: 'native-tool' },
        options: [
          { kind: 'allow_once', optionId: 'yes', name: 'Yes' },
          { kind: 'reject_once', optionId: 'no', name: 'No' },
        ],
      },
      signal: new AbortController().signal,
      requestId: 2,
    } as unknown as Parameters<NonNullable<VibeAcpHandlers['requestPermission']>>[0])
    expect(result).toEqual({ outcome: { outcome: 'selected', optionId: 'yes' } })
    expect(mocks.policy).toHaveBeenCalledWith('workspace', {
      engine: 'mistral-vibe',
      toolName: 'bash',
      payload: expect.objectContaining({ rawInput: { command: 'pwd' }, effectKind: 'shell', kind: 'execute' }),
    })
    expect(events.filter((event) => event.kind === 'session:user-input-requested')).toHaveLength(0)
  })
  it('uses 120 seconds of foreground silence and 30 minutes with unresolved tools', async () => {
    vi.useFakeTimers()
    await launch({ watchdogEnabled: true })
    update({
      sessionUpdate: 'tool_call',
      toolCallId: 't',
      title: 'Run',
      kind: 'execute',
      status: 'in_progress',
      rawInput: { command: 'test' },
      _meta: { tool_name: 'bash', effect_kind: 'shell' },
    })
    await vi.advanceTimersByTimeAsync(120_001)
    expect(stop).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(30 * 60_000 - 120_001)
    expect(events).toContainEqual(expect.objectContaining({ kind: 'session:ended', reason: 'watchdog' }))
    expect(stop).toHaveBeenCalledOnce()
  })
  it('pauses for overlapping human callbacks, forwards live presence, and cancels questions on stop', async () => {
    vi.useFakeTimers()
    const process = await launch({ watchdogEnabled: true })
    const ask = (requestId = 1) =>
      handlers.createElicitation!({
        params: {
          sessionId: 'native',
          mode: 'form',
          message: 'Choose',
          requestedSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
        },
        signal: new AbortController().signal,
        requestId,
      } as unknown as Parameters<NonNullable<VibeAcpHandlers['createElicitation']>>[0])
    const response = ask()
    const secondResponse = ask(2)
    const pending = events.find((e) => e.kind === 'session:user-input-requested')
    expect(pending?.kind).toBe('session:user-input-requested')
    if (pending?.kind !== 'session:user-input-requested') throw new Error('Missing question')
    expect(process.hasPendingUserInput?.(pending.toolCallId)).toBe(true)
    await vi.advanceTimersByTimeAsync(31 * 60_000)
    expect(stop).not.toHaveBeenCalled()
    expect(process.resolvePendingUserInput(pending.toolCallId, { kind: 'question', answers: { q: 'answer' } })).toBe(
      true,
    )
    await expect(response).resolves.toEqual({ action: 'accept', content: { q: 'answer' } })
    await vi.advanceTimersByTimeAsync(121_000)
    expect(stop).not.toHaveBeenCalled()
    const stopping = process.stop()
    await expect(secondResponse).resolves.toEqual({ action: 'cancel' })
    expect(process.hasPendingUserInput?.(pending.toolCallId)).toBe(false)
    await expect(Promise.resolve(ask())).resolves.toEqual({ action: 'cancel' })
    closed.resolve(undefined)
    await stopping
    expect(mocks.close).not.toHaveBeenCalled() // Runtime invokes its cooperative callback, not the engine directly.
  })
})

it.each([false, true])('reports a validated native model without configuring it (resume=%s)', async (resume) => {
  const request = mocks.request.getMockImplementation()!
  mocks.request.mockImplementation(async (...args) => {
    const response = await request(...args)
    if (['session/new', 'session/load', 'session/set_config_option'].includes(args[1]))
      response.configOptions.push({
        id: 'model',
        type: 'select',
        currentValue: 'native-custom',
        options: [{ value: 'native-custom', name: 'Custom' }],
      })
    return response
  })
  const process = await launch({ model: 'auto', ...(resume ? { resumeFromEngineSessionId: 'native' } : {}) })
  await process.ready
  expect(events).toContainEqual({ kind: 'session:started', engineSessionId: 'native', model: 'native-custom' })
  expect(
    mocks.request.mock.calls.filter((call) => call[1] === 'session/set_config_option').map((call) => call[2]),
  ).toEqual([{ sessionId: 'native', configId: 'mode', value: 'ask' }])
})

it.each([null, '', ' ', 42])('rejects malformed native model metadata %j before prompting', async (value) => {
  const request = mocks.request.getMockImplementation()!
  mocks.request.mockImplementation(async (...args) => {
    const response = await request(...args)
    if (args[1] === 'session/new')
      response.configOptions.push({ id: 'model', type: 'select', currentValue: value, options: [] })
    return response
  })
  const process = await launch()
  await expect(process.ready).rejects.toThrow()
  expect(mocks.request.mock.calls.some((call) => call[1] === 'session/prompt')).toBe(false)
})

it.each([false, true])(
  'confirms mode, explicit model and model-specific thinking before prompt (resume=%s)',
  async (resume) => {
    const original = mocks.request.getMockImplementation()!
    let model = 'first'
    let thinking = 'high'
    mocks.request.mockImplementation(async (connection, method, params) => {
      if (method === 'session/set_config_option') {
        if (params.configId === 'model') {
          model = params.value
          thinking = 'off'
        }
        if (params.configId === 'thinking') thinking = params.value
      }
      const response = await original(connection, method, params)
      if (response.configOptions)
        response.configOptions = [
          ...modeConfig(),
          {
            id: 'model',
            type: 'select',
            currentValue: model,
            options: ['first', 'second'].map((value) => ({ value, name: value })),
          },
          {
            id: 'thinking',
            type: 'select',
            currentValue: thinking,
            options: (model === 'first' ? ['high'] : ['off', 'max']).map((value) => ({ value, name: value })),
          },
        ]
      return response
    })
    const process = await launch({
      model: 'second',
      effort: 'max',
      ...(resume ? { resumeFromEngineSessionId: 'native' } : {}),
    })
    await process.ready
    expect(mocks.request.mock.calls.map((call) => [call[1], call[2].configId])).toEqual([
      ['initialize', undefined],
      [resume ? 'session/load' : 'session/new', undefined],
      ['session/set_config_option', 'mode'],
      ['session/set_config_option', 'model'],
      ['session/set_config_option', 'thinking'],
      ['session/prompt', undefined],
    ])
    expect(events).toContainEqual({ kind: 'session:started', engineSessionId: 'native', model: 'second' })
  },
)

it.each(['model', 'thinking'])('never prompts when native %s refuses explicit confirmation', async (configId) => {
  const original = mocks.request.getMockImplementation()!
  mocks.request.mockImplementation(async (...args) => {
    const response = await original(...args)
    if (response.configOptions)
      response.configOptions = [
        ...modeConfig(),
        {
          id: configId,
          type: 'select',
          currentValue: 'old',
          options: ['old', 'requested'].map((value) => ({ value, name: value })),
        },
      ]
    return response
  })
  const process = await launch(configId === 'model' ? { model: 'requested' } : { effort: 'requested' })
  await expect(process.ready).rejects.toThrow(/unavailable|overridden/)
  expect(mocks.request.mock.calls.some((call) => call[1] === 'session/prompt')).toBe(false)
  expect(stop).toHaveBeenCalledOnce()
})
