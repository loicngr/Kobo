import type * as acp from '@agentclientprotocol/sdk'
import { describe, expect, it, vi } from 'vitest'
import { createMistralEventMapper } from '../../server/services/agent/engines/mistral-vibe/event-mapper.js'
import { createMistralServerRequests } from '../../server/services/agent/engines/mistral-vibe/server-requests.js'
import type { AgentEvent, PendingUserInputResponse } from '../../server/services/agent/engines/types.js'

const options: acp.PermissionOption[] = [
  { kind: 'allow_always', optionId: 'permanent', name: 'Always' },
  { kind: 'allow_once', optionId: 'yes-1', name: 'Once' },
  { kind: 'reject_once', optionId: 'no-1', name: 'Deny' },
]
const permission: acp.RequestPermissionRequest = { sessionId: 's', toolCall: { toolCallId: 't' }, options }
const form: acp.CreateElicitationRequest = {
  sessionId: 's',
  toolCallId: 't',
  mode: 'form',
  message: 'Choose',
  requestedSchema: {
    properties: {
      text_id: { type: 'string', minLength: 2, maxLength: 10 },
      choice_id: {
        type: 'string',
        oneOf: [
          { const: 'a,b', title: 'A, B' },
          { const: 'c', title: 'C' },
        ],
      },
      multi_id: {
        type: 'array',
        minItems: 1,
        maxItems: 2,
        items: {
          anyOf: [
            { const: 'One, Two', title: 'One, Two' },
            { const: 'Three', title: 'Three' },
          ],
        },
      },
    },
    required: ['text_id', 'choice_id', 'multi_id'],
  },
}
function context<T>(
  params: T,
  requestId: number | string = 1,
  signal = new AbortController().signal,
): acp.ClientRequestContext<T> {
  return { params, requestId, signal, method: 'test', agent: {} as acp.ClientContext }
}
function setup(overrides: { readOnly?: boolean; autoApprove?: (name: string, payload: unknown) => boolean } = {}) {
  const events: AgentEvent[] = []
  const mapper = createMistralEventMapper('launch', () => {})
  mapper.beginLive()
  mapper.onUpdate({
    sessionId: 's',
    update: {
      sessionUpdate: 'tool_call',
      toolCallId: 't',
      title: 'Spoofed title',
      kind: 'execute',
      rawInput: { command: 'pwd' },
      _meta: { tool_name: 'bash', effect_kind: 'shell' },
    },
  })
  const getTool = vi.fn(mapper.getTool)
  const bridge = createMistralServerRequests({
    sessionId: 's',
    readOnly: false,
    emit: (e) => events.push(e),
    getTool,
    canonicalToolCallId: mapper.canonicalToolCallId,
    ...overrides,
  })
  function key(kind: 'question' | 'permission') {
    const event = events.find((event) => event.kind === 'session:user-input-requested' && event.requestKind === kind)
    if (event?.kind !== 'session:user-input-requested') throw new Error('No pending event')
    return event.toolCallId
  }
  return { bridge, mapper, events, getTool, key }
}

describe('Mistral native permissions', () => {
  it.each([
    ['permission-allow', 'yes-1'],
    ['permission-deny', 'no-1'],
  ] as const)('maps %s to the actual one-time option', async (kind, optionId) => {
    const { bridge, events, getTool } = setup()
    const pending = bridge.requestPermission(context(permission))
    expect(getTool).toHaveBeenCalledWith('t')
    expect(events).toEqual([
      expect.objectContaining({
        toolCallId: 'vibe:launch:tool:t',
        toolName: 'bash',
        payload: expect.objectContaining({ operationApprovalAvailable: true, rawInput: { command: 'pwd' } }),
      }),
    ])
    expect(bridge.resolvePendingUserInput('vibe:launch:tool:t', { kind })).toBe(true)
    expect(await pending).toEqual({ outcome: { outcome: 'selected', optionId } })
    expect(bridge.resolvePendingUserInput('vibe:launch:tool:t', { kind })).toBe(false)
  })
  it.each([
    { ...permission, sessionId: 'other' },
    { ...permission, toolCall: { toolCallId: 'unknown' } },
    { ...permission, options: [] },
    { ...permission, options: options.filter((o) => o.kind !== 'allow_once') },
    { ...permission, options: options.filter((o) => o.kind !== 'reject_once') },
    { ...permission, options: [...options, { ...options[1], kind: 'allow_always' as const }] },
  ])('cancels requests that cannot safely grant exactly once', async (request) => {
    const autoApprove = vi.fn(() => true)
    const { bridge, events } = setup({ autoApprove })
    expect(await bridge.requestPermission(context(request))).toEqual({ outcome: { outcome: 'cancelled' } })
    expect(events).toEqual([])
    expect(autoApprove).not.toHaveBeenCalled()
  })
  it('uses only programmatic identity and disables incomplete operation approval', async () => {
    const { bridge, mapper, events } = setup()
    mapper.onUpdate({
      sessionId: 's',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'partial',
        title: 'bash: pwd',
        kind: 'execute',
        _meta: { tool_name: 'bash', effect_kind: 'shell' },
      },
    })
    const pending = bridge.requestPermission(context({ ...permission, toolCall: { toolCallId: 'partial' } }))
    expect(events[0]).toMatchObject({ toolName: 'bash', payload: { operationApprovalAvailable: false } })
    bridge.cancelAll()
    expect(await pending).toEqual({ outcome: { outcome: 'cancelled' } })
    const second = setup()
    second.mapper.onUpdate({
      sessionId: 's',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'title',
        title: 'bash: pwd',
        kind: 'execute',
        rawInput: { command: 'pwd' },
      },
    })
    expect(
      await second.bridge.requestPermission(context({ ...permission, toolCall: { toolCallId: 'title' } })),
    ).toEqual({ outcome: { outcome: 'cancelled' } })
  })
  it('auto-approves through Kobo policy using the same payload, without native permanent options', async () => {
    const autoApprove = vi.fn(() => true)
    const { bridge, events } = setup({ autoApprove })
    expect(await bridge.requestPermission(context(permission))).toEqual({
      outcome: { outcome: 'selected', optionId: 'yes-1' },
    })
    expect(autoApprove).toHaveBeenCalledWith('bash', expect.objectContaining({ rawInput: { command: 'pwd' } }))
    expect(events).toEqual([])
  })
  it('never overwrites a pending callback on duplicate native tool ids', async () => {
    const { bridge } = setup()
    const pending = bridge.requestPermission(context(permission))
    expect(await bridge.requestPermission(context(permission, 2))).toEqual({ outcome: { outcome: 'cancelled' } })
    bridge.resolvePendingUserInput('vibe:launch:tool:t', { kind: 'permission-deny' })
    expect(await pending).toEqual({ outcome: { outcome: 'selected', optionId: 'no-1' } })
    expect(await bridge.requestPermission(context(permission, 3))).toEqual({ outcome: { outcome: 'cancelled' } })
  })

  it('does not grant when stopping starts during a policy callback', async () => {
    const { bridge } = setup({
      autoApprove: () => {
        bridge.cancelAll()
        return true
      },
    })
    expect(await bridge.requestPermission(context(permission))).toEqual({ outcome: { outcome: 'cancelled' } })
  })

  it('settles a native permission AbortSignal without accepting a late approval', async () => {
    const abort = new AbortController()
    const { bridge } = setup()
    const pending = bridge.requestPermission(context(permission, 1, abort.signal))
    abort.abort()
    expect(await pending).toEqual({ outcome: { outcome: 'cancelled' } })
    expect(bridge.resolvePendingUserInput('vibe:launch:tool:t', { kind: 'permission-allow' })).toBe(false)
  })
})

describe('Mistral native questions', () => {
  it('preserves form property ids and typed arrays containing commas', async () => {
    const { bridge, events, key } = setup()
    const pending = bridge.createElicitation(context(form))
    expect(events[0]).toMatchObject({
      toolName: 'AskUserQuestion',
      payload: {
        questions: [
          expect.objectContaining({ id: 'text_id', freeText: true }),
          expect.objectContaining({ id: 'choice_id', isOther: false }),
          expect.objectContaining({ id: 'multi_id', multiSelect: true, isOther: false }),
        ],
      },
    })
    expect(
      bridge.resolvePendingUserInput(key('question'), {
        kind: 'question',
        answers: { text_id: 'hello', choice_id: 'a,b', multi_id: 'ambiguous legacy display' },
        selections: { multi_id: ['One, Two', 'Three'] },
      }),
    ).toBe(true)
    expect(await pending).toEqual({
      action: 'accept',
      content: { text_id: 'hello', choice_id: 'a,b', multi_id: ['One, Two', 'Three'] },
    })
  })
  it.each<Omit<Extract<PendingUserInputResponse, { kind: 'question' }>, 'kind'>>([
    { answers: { text_id: 'x', choice_id: 'a,b' }, selections: { multi_id: ['Three'] } },
    { answers: { text_id: 'hello', choice_id: 'A, B' }, selections: { multi_id: ['Three'] } },
    { answers: { text_id: 'hello', choice_id: 'a,b', multi_id: 'One, Two, Three' } },
    { answers: { text_id: 'hello', choice_id: 'a,b' }, selections: { multi_id: ['One', 'Two'] } },
    { answers: { text_id: 'hello', choice_id: 'a,b' }, selections: { multi_id: ['Three', 'Three'] } },
    { answers: { text_id: 'hello', choice_id: 'a,b' }, selections: { multi_id: [] } },
    { answers: { text_id: 'hello', choice_id: 'a,b', unknown: 'ignored?' }, selections: { multi_id: ['Three'] } },
  ])('keeps the form pending after invalid answers without guessing selections', async (response) => {
    const { bridge, key } = setup()
    const pending = bridge.createElicitation(context(form))
    expect(() => bridge.resolvePendingUserInput(key('question'), { kind: 'question', ...response })).toThrow(
      /invalid response/i,
    )
    expect(bridge.resolvePendingUserInput(key('question'), { kind: 'question-cancel' })).toBe(true)
    expect(await pending).toEqual({ action: 'cancel' })
  })
  it.each([
    { ...form, mode: 'url', url: 'https://example.org', elicitationId: 'e' },
    { ...form, sessionId: 'wrong' },
    { ...form, requestedSchema: { properties: { flag: { type: 'boolean' } } } },
    { ...form, requestedSchema: { properties: { text: { type: 'string', pattern: 'unsafe' } } } },
    { ...form, requestedSchema: { properties: { text: { type: 'string', enum: ['same', 'same'] } } } },
    { ...form, requestedSchema: { properties: { text: { type: 'string', minLength: 20, maxLength: 2 } } } },
    { ...form, requestedSchema: { properties: {}, required: ['missing'] } },
  ])('declines unsupported forms without leaving a hanging callback', async (request) => {
    const { bridge, events } = setup()
    expect(await bridge.createElicitation(context(request))).toEqual({ action: 'decline' })
    expect(events).toEqual([])
  })
  it('supports optional fields and untitled enum arrays without inventing defaults', async () => {
    const { bridge, key } = setup()
    const pending = bridge.createElicitation(
      context({
        sessionId: 's',
        mode: 'form',
        message: 'Form',
        requestedSchema: {
          properties: {
            optional: { type: 'string', default: 'do not invent' },
            multi: { type: 'array', items: { type: 'string', enum: ['a,b', 'c'] } },
          },
        },
      }),
    )
    expect(
      bridge.resolvePendingUserInput(key('question'), { kind: 'question', answers: {}, selections: { multi: [] } }),
    ).toBe(true)
    expect(await pending).toEqual({ action: 'accept', content: { multi: [] } })
  })
  it('keeps permission and question callbacks independent even for the same native tool', async () => {
    const { bridge, key } = setup()
    const p = bridge.requestPermission(context(permission))
    const q = bridge.createElicitation(context(form))
    expect(key('question')).not.toBe(key('permission'))
    expect(() => bridge.resolvePendingUserInput(key('permission'), { kind: 'question-cancel' })).toThrow(
      /invalid response/i,
    )
    expect(() => bridge.resolvePendingUserInput(key('question'), { kind: 'permission-allow' })).toThrow(
      /invalid response/i,
    )
    expect(await bridge.createElicitation(context(form))).toEqual({ action: 'decline' })
    bridge.cancelAll()
    bridge.cancelAll()
    expect(await p).toEqual({ outcome: { outcome: 'cancelled' } })
    expect(await q).toEqual({ action: 'cancel' })
    expect(bridge.resolvePendingUserInput(key('permission'), { kind: 'permission-allow' })).toBe(false)
    expect(bridge.resolvePendingUserInput(key('question'), { kind: 'question', answers: {} })).toBe(false)
    expect(await bridge.requestPermission(context(permission, 99))).toEqual({ outcome: { outcome: 'cancelled' } })
    expect(await bridge.createElicitation(context(form, 99))).toEqual({ action: 'cancel' })
  })
  it('settles cancelled callbacks and ignores answers from a previous launch', async () => {
    const controller = new AbortController()
    const { bridge, key } = setup()
    const pending = bridge.createElicitation(context(form, 1, controller.signal))
    controller.abort()
    expect(await pending).toEqual({ action: 'cancel' })
    expect(bridge.resolvePendingUserInput(key('question'), { kind: 'question-cancel' })).toBe(false)
    const mapper = createMistralEventMapper('new-launch', () => {})
    const other = createMistralServerRequests({
      sessionId: 's',
      readOnly: false,
      emit: () => {},
      getTool: mapper.getTool,
      canonicalToolCallId: mapper.canonicalToolCallId,
    })
    const replacement = other.createElicitation(context(form))
    expect(other.resolvePendingUserInput(key('question'), { kind: 'question-cancel' })).toBe(false)
    other.cancelAll()
    expect(await replacement).toEqual({ action: 'cancel' })
  })
  it('cancels unexpected restricted requests immediately', async () => {
    const autoApprove = vi.fn(() => true)
    const { bridge, events } = setup({ readOnly: true, autoApprove })
    expect(await bridge.requestPermission(context(permission))).toEqual({ outcome: { outcome: 'cancelled' } })
    expect(await bridge.createElicitation(context(form))).toEqual({ action: 'cancel' })
    expect(autoApprove).not.toHaveBeenCalled()
    expect(events).toEqual([])
  })

  it('never emits a panel for an already aborted request', async () => {
    const abort = new AbortController()
    abort.abort()
    const { bridge, events } = setup()
    expect(await bridge.requestPermission(context(permission, 1, abort.signal))).toEqual({
      outcome: { outcome: 'cancelled' },
    })
    expect(await bridge.createElicitation(context(form, 2, abort.signal))).toEqual({ action: 'cancel' })
    expect(events).toEqual([])
  })

  it('notifies lifecycle owners until the last pending request settles', async () => {
    const counts: number[] = []
    const events: AgentEvent[] = []
    const mapper = createMistralEventMapper('launch', () => {})
    mapper.beginLive()
    mapper.onUpdate({
      sessionId: 's',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 't',
        title: 'Shell',
        kind: 'execute',
        rawInput: { command: 'pwd' },
        _meta: { tool_name: 'bash', effect_kind: 'shell' },
      },
    })
    const bridge = createMistralServerRequests({
      sessionId: 's',
      readOnly: false,
      emit: (e) => events.push(e),
      getTool: mapper.getTool,
      canonicalToolCallId: mapper.canonicalToolCallId,
      onPendingChange: (count) => counts.push(count),
    })
    const abort = new AbortController()
    const p = bridge.requestPermission(context(permission))
    const q = bridge.createElicitation(context(form, 2, abort.signal))
    abort.abort()
    expect(counts).toEqual([1, 2, 1])
    bridge.cancelAll()
    expect(counts).toEqual([1, 2, 1, 0])
    await Promise.all([p, q])
  })

  it('bounds pending callbacks and cancels the entire admitted set', async () => {
    const { bridge, events } = setup()
    const admitted = Array.from({ length: 32 }, (_, id) => bridge.createElicitation(context(form, id)))
    expect(await bridge.createElicitation(context(form, 33))).toEqual({ action: 'decline' })
    expect(events).toHaveLength(32)
    bridge.cancelAll()
    expect(await Promise.all(admitted)).toEqual(Array.from({ length: 32 }, () => ({ action: 'cancel' })))
  })
})
