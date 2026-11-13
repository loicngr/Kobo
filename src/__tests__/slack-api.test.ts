import { beforeEach, describe, expect, it, vi } from 'vitest'

const webCtor = vi.hoisted(() => vi.fn())
const web = vi.hoisted(() => ({
  auth: { test: vi.fn() },
  chat: { postMessage: vi.fn(), update: vi.fn() },
  reactions: { add: vi.fn(), remove: vi.fn() },
  users: { conversations: vi.fn(), info: vi.fn() },
  conversations: { replies: vi.fn() },
}))
const sock = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events')
  const state = { client: null as FakeSocket | null, startError: null as Error | null, startHangs: false }
  class FakeSocket extends EventEmitter {
    shuttingDown = false
    start = vi.fn(async () => {
      this.shuttingDown = false
      if (state.startHangs) return new Promise<void>(() => undefined)
      if (state.startError) throw state.startError
    })
    disconnect = vi.fn(async () => {
      this.shuttingDown = true
    })
    constructor(readonly options: { autoReconnectEnabled?: boolean }) {
      super()
      state.client = this
      // Mirrors @slack/socket-mode 3.2.0: the client owns an `error` listener, and its async `close`
      // listener either emits `disconnected` or reconnects and rethrows a non-abort start failure.
      this.on('error', () => undefined)
      this.on('close', async () => {
        if (this.shuttingDown || options.autoReconnectEnabled === false) {
          this.emit('disconnected')
          return
        }
        await this.start()
      })
    }
  }
  return { state, FakeSocket }
})
const socketState = sock.state

vi.mock('@slack/web-api', () => ({
  WebClient: class {
    constructor(token: string, options: unknown) {
      webCtor(token, options)
    }
    auth = web.auth
    chat = web.chat
    reactions = web.reactions
    users = web.users
    conversations = web.conversations
  },
  LogLevel: { ERROR: 'error' },
}))
vi.mock('@slack/socket-mode', () => ({ SocketModeClient: sock.FakeSocket }))

import { createSlackApi, SlackApiError } from '../server/services/slack/slack-api.js'

const creds = { botToken: 'xoxb-secret-token', appToken: 'xapp-secret-token' }
const fetchMock = vi.fn()

function platformError(error: string) {
  return Object.assign(new Error(`An API error occurred: ${error} xoxb-secret-token`), {
    code: 'slack_webapi_platform_error',
    data: { ok: false, error },
  })
}

async function connected(api = createSlackApi(creds)) {
  web.auth.test.mockResolvedValue({ user_id: 'UBOT', user: 'kobo', team: 'Acme' })
  const events: unknown[] = []
  const conn: boolean[] = []
  const identity = await api.connect(
    (e) => events.push(e),
    (c) => conn.push(c),
  )
  return { api, events, conn, identity }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('fetch', fetchMock)
  socketState.client = null
  socketState.startError = null
  socketState.startHangs = false
})

describe('connect', () => {
  it('resolves with the bot identity from auth.test and reflects connection state', async () => {
    const { identity, conn } = await connected()
    expect(identity).toEqual({ botUserId: 'UBOT', botName: 'kobo', teamName: 'Acme' })
    expect(socketState.client?.start).toHaveBeenCalledOnce()
    socketState.client?.emit('connected')
    socketState.client?.emit('disconnected')
    expect(conn).toEqual([true, false])
  })

  it('acks the envelope before onEvent and maps the payload', async () => {
    const order: string[] = []
    const api = createSlackApi(creds)
    web.auth.test.mockResolvedValue({ user_id: 'UBOT', user: 'kobo', team: 'Acme' })
    await api.connect(
      () => order.push('event'),
      () => undefined,
    )
    const ack = vi.fn(async () => {
      order.push('ack')
    })
    socketState.client?.emit('slack_event', {
      ack,
      type: 'events_api',
      body: {
        event: {
          type: 'message',
          channel: 'C1',
          ts: '1.1',
          thread_ts: '1.0',
          user: 'U1',
          text: 'hi',
          extra: 'dropped',
          files: [
            {
              id: 'F1',
              name: 'a.png',
              mimetype: 'image/png',
              size: 3,
              url_private_download: 'https://files.slack.com/d',
              url_private: 'https://files.slack.com/p',
            },
            { id: 'F2', name: 'b.txt', mimetype: 'text/plain', size: 1, url_private: 'https://files.slack.com/b' },
            { id: 'F3', name: 'c', mimetype: 'x', size: 1 },
          ],
        },
      },
    })
    await vi.waitFor(() => expect(order).toEqual(['ack', 'event']))
  })

  it('maps fields and drops files without url', async () => {
    const { events } = await connected()
    socketState.client?.emit('slack_event', {
      ack: vi.fn(async () => undefined),
      type: 'events_api',
      body: {
        event: {
          type: 'message',
          channel: 'C1',
          ts: '2.2',
          user: 'U1',
          extra: 'x',
          files: [
            { id: 'F1', name: 'a', mimetype: 'm', size: 3, url_private_download: 'https://files.slack.com/d' },
            { id: 'F3', name: 'c', mimetype: 'x', size: 1 },
          ],
        },
      },
    })
    await vi.waitFor(() => expect(events).toHaveLength(1))
    expect(events[0]).toEqual({
      type: 'message',
      channel: 'C1',
      ts: '2.2',
      thread_ts: undefined,
      user: 'U1',
      bot_id: undefined,
      subtype: undefined,
      text: undefined,
      files: [{ id: 'F1', name: 'a', mimetype: 'm', size: 3, url: 'https://files.slack.com/d' }],
    })
  })

  it('acknowledges and drops other event types', async () => {
    const { events } = await connected()
    const ack = vi.fn(async () => undefined)
    socketState.client?.emit('slack_event', { ack, type: 'events_api', body: { event: { type: 'reaction_added' } } })
    socketState.client?.emit('slack_event', { ack, type: 'interactive', body: {} })
    await vi.waitFor(() => expect(ack).toHaveBeenCalledTimes(2))
    expect(events).toEqual([])
  })

  it('does not log the token when auth fails', async () => {
    const api = createSlackApi(creds)
    web.auth.test.mockRejectedValue(platformError('invalid_auth'))
    const err = await api
      .connect(
        () => undefined,
        () => undefined,
      )
      .catch((e) => e)
    expect(err).toBeInstanceOf(SlackApiError)
    expect(err.code).toBe('invalid_auth')
    expect(err.message).toBe('Slack API error: invalid_auth')
    expect(err.message).not.toContain('xoxb')
  })

  it('disconnect stops the socket client', async () => {
    const { api } = await connected()
    await api.disconnect()
    expect(socketState.client?.disconnect).toHaveBeenCalledOnce()
  })
})

describe('error mapping', () => {
  const cases: [unknown, string][] = [
    [platformError('token_revoked'), 'invalid_auth'],
    [platformError('not_authed'), 'invalid_auth'],
    [platformError('account_inactive'), 'invalid_auth'],
    [platformError('missing_scope'), 'missing_scope'],
    [platformError('channel_not_found'), 'not_in_channel'],
    [platformError('not_in_channel'), 'not_in_channel'],
    [platformError('ratelimited'), 'rate_limited'],
    [Object.assign(new Error('x'), { code: 'slack_webapi_rate_limited_error', retryAfter: 3 }), 'rate_limited'],
    [Object.assign(new Error('x'), { code: 'slack_webapi_request_error' }), 'network'],
    [Object.assign(new Error('x'), { code: 'slack_webapi_http_error' }), 'network'],
    [platformError('something_else'), 'unknown'],
    [new Error('boom'), 'unknown'],
  ]
  it.each(cases)('maps %# to %s', async (raw, code) => {
    web.chat.postMessage.mockRejectedValue(raw)
    const err = await createSlackApi(creds)
      .postMessage('C1', 'x')
      .catch((e) => e)
    expect(err).toBeInstanceOf(SlackApiError)
    expect(err.code).toBe(code)
    expect(err.message).toBe(`Slack API error: ${code}`)
  })
})

describe('messages and reactions', () => {
  it('postMessage returns ts and passes thread_ts', async () => {
    web.chat.postMessage.mockResolvedValue({ ts: '9.9' })
    await expect(createSlackApi(creds).postMessage('C1', 'hello', '1.0')).resolves.toBe('9.9')
    expect(web.chat.postMessage).toHaveBeenCalledWith({ channel: 'C1', text: 'hello', thread_ts: '1.0' })
  })

  it('treats already_reacted and no_reaction as success', async () => {
    const api = createSlackApi(creds)
    web.reactions.add.mockRejectedValue(platformError('already_reacted'))
    web.reactions.remove.mockRejectedValue(platformError('no_reaction'))
    await expect(api.addReaction('C1', '1.1', 'eyes')).resolves.toBeUndefined()
    await expect(api.removeReaction('C1', '1.1', 'eyes')).resolves.toBeUndefined()
    web.reactions.add.mockRejectedValue(platformError('missing_scope'))
    await expect(api.addReaction('C1', '1.1', 'eyes')).rejects.toMatchObject({ code: 'missing_scope' })
  })

  it('listChannels follows next_cursor across pages', async () => {
    web.users.conversations
      .mockResolvedValueOnce({ channels: [{ id: 'C1', name: 'a' }], response_metadata: { next_cursor: 'cur' } })
      .mockResolvedValueOnce({ channels: [{ id: 'C2', name: 'b' }], response_metadata: { next_cursor: '' } })
    await expect(createSlackApi(creds).listChannels()).resolves.toEqual([
      { id: 'C1', name: 'a' },
      { id: 'C2', name: 'b' },
    ])
    expect(web.users.conversations).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ types: 'public_channel,private_channel', exclude_archived: true }),
    )
    expect(web.users.conversations).toHaveBeenNthCalledWith(2, expect.objectContaining({ cursor: 'cur' }))
  })

  it('threadReplies maps to InboundEvent, limited, oldest first', async () => {
    web.conversations.replies.mockResolvedValue({
      messages: [
        { ts: '1.0', user: 'U1', text: 'a', thread_ts: '1.0' },
        { ts: '1.1', user: 'U2', text: 'b', thread_ts: '1.0' },
        { ts: '1.2', user: 'U3', text: 'c', thread_ts: '1.0' },
      ],
    })
    const out = await createSlackApi(creds).threadReplies('C1', '1.0', 2)
    expect(out.map((e) => e.ts)).toEqual(['1.0', '1.1'])
    expect(out[0]).toMatchObject({ type: 'message', channel: 'C1', text: 'a' })
    expect(web.conversations.replies).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'C1', ts: '1.0', limit: 2 }),
    )
  })

  it('userName caches, prefers display name and falls back to the id', async () => {
    const api = createSlackApi(creds)
    web.users.info.mockResolvedValueOnce({ user: { name: 'jd', profile: { display_name: 'Jane' } } })
    await expect(api.userName('U1')).resolves.toBe('Jane')
    await expect(api.userName('U1')).resolves.toBe('Jane')
    expect(web.users.info).toHaveBeenCalledTimes(1)
    web.users.info.mockRejectedValueOnce(platformError('user_not_found'))
    await expect(api.userName('U2')).resolves.toBe('U2')
  })
})

describe('downloadFile', () => {
  const file = (url: string) => ({ id: 'F1', name: 'a', mimetype: 'm', size: 1, url })
  const ok = (body = 'abc') => new Response(body, { status: 200 })

  it.each([
    'https://evil.example/x',
    'http://files.slack.com/x',
    'https://slack.com.evil.example/x',
    'https://evilslack.com/x',
    'not a url',
  ])('rejects %s without calling fetch', async (url) => {
    await expect(createSlackApi(creds).downloadFile(file(url))).rejects.toBeInstanceOf(SlackApiError)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('downloads from slack hosts with a Bearer header', async () => {
    fetchMock.mockResolvedValue(ok())
    const buf = await createSlackApi(creds).downloadFile(file('https://files.slack.com/x'))
    expect(buf.toString()).toBe('abc')
    const [, init] = fetchMock.mock.calls[0]
    expect(init.headers.Authorization).toBe('Bearer xoxb-secret-token')
    expect(init.redirect).toBe('manual')
    await createSlackApi(creds)
      .downloadFile(file('https://team.slack.com/x'))
      .catch(() => undefined)
  })

  it('rejects a non-OK status as network', async () => {
    fetchMock.mockResolvedValue(new Response('no', { status: 403 }))
    await expect(createSlackApi(creds).downloadFile(file('https://files.slack.com/x'))).rejects.toMatchObject({
      code: 'network',
    })
  })

  it('never follows a redirect to a foreign host', async () => {
    fetchMock.mockResolvedValue(
      new Response(null, { status: 302, headers: { location: 'https://evil.example/steal' } }),
    )
    await expect(createSlackApi(creds).downloadFile(file('https://files.slack.com/x'))).rejects.toBeInstanceOf(
      SlackApiError,
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('follows a redirect to another slack host', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://files.slack.com/y' } }))
      .mockResolvedValueOnce(ok('zz'))
    const buf = await createSlackApi(creds).downloadFile(file('https://team.slack.com/x'))
    expect(buf.toString()).toBe('zz')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

const envelope = (event: unknown) => ({ ack: vi.fn(async () => undefined), type: 'events_api', body: { event } })
const msg = (ts: string) => ({ type: 'message', channel: 'C1', ts, user: 'U1' })
const listener = () => socketState.client?.listeners('slack_event')[0] as (a: unknown) => Promise<void>

describe('fix round 1', () => {
  it('swallows a throwing onEvent and keeps delivering', async () => {
    const api = createSlackApi(creds)
    web.auth.test.mockResolvedValue({ user_id: 'UBOT', user: 'kobo', team: 'Acme' })
    const seen: string[] = []
    await api.connect(
      (e) => {
        seen.push(e.ts)
        if (e.ts === '1') throw new Error('db')
      },
      () => undefined,
    )
    await expect(listener()(envelope(msg('1')))).resolves.toBeUndefined()
    await expect(listener()(envelope(msg('2')))).resolves.toBeUndefined()
    expect(seen).toEqual(['1', '2'])
  })

  it('swallows a rejected promise returned by onEvent', async () => {
    const api = createSlackApi(creds)
    web.auth.test.mockResolvedValue({ user_id: 'UBOT', user: 'kobo', team: 'Acme' })
    const seen: string[] = []
    const handled: string[] = []
    await api.connect(
      ((e: { ts: string }) => {
        seen.push(e.ts)
        // A thenable records whether the wrapper consumed (awaited) the rejection it returns.
        return {
          // biome-ignore lint/suspicious/noThenProperty: deliberate thenable
          then(onFulfilled: () => unknown, onRejected: (err: unknown) => unknown) {
            handled.push(e.ts)
            return Promise.reject(new Error('async db')).then(onFulfilled, onRejected)
          },
        }
      }) as never,
      () => undefined,
    )
    await expect(listener()(envelope(msg('1')))).resolves.toBeUndefined()
    await new Promise((r) => setTimeout(r, 0))
    await expect(listener()(envelope(msg('2')))).resolves.toBeUndefined()
    expect(seen).toEqual(['1', '2'])
    expect(handled).toEqual(['1', '2'])
  })

  it('bounds WebClient waits', () => {
    createSlackApi(creds)
    expect(webCtor).toHaveBeenCalledWith(
      'xoxb-secret-token',
      expect.objectContaining({ timeout: 15_000, retryConfig: { retries: 2 }, rejectRateLimitedCalls: true }),
    )
  })

  it('gives fetch a signal and maps an abort to network', async () => {
    fetchMock.mockResolvedValue(new Response('abc', { status: 200 }))
    const f = { id: 'F', name: 'a', mimetype: 'm', size: 1, url: 'https://files.slack.com/x' }
    await createSlackApi(creds).downloadFile(f)
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal)
    fetchMock.mockRejectedValue(new DOMException('aborted', 'TimeoutError'))
    await expect(createSlackApi(creds).downloadFile(f)).rejects.toMatchObject({ code: 'network' })
  })

  it('disconnects a failed client and a replaced one', async () => {
    web.auth.test.mockResolvedValue({ user_id: 'UBOT', user: 'kobo', team: 'Acme' })
    const api = createSlackApi(creds)
    await api.connect(
      () => undefined,
      () => undefined,
    )
    const first = socketState.client
    await api.connect(
      () => undefined,
      () => undefined,
    )
    expect(first?.disconnect).toHaveBeenCalledOnce()
    const second = socketState.client
    socketState.startError = new Error('boom')
    await expect(
      api.connect(
        () => undefined,
        () => undefined,
      ),
    ).rejects.toBeInstanceOf(SlackApiError)
    socketState.startError = null
    expect(second?.disconnect).toHaveBeenCalledOnce()
    expect(socketState.client?.disconnect).toHaveBeenCalledOnce()
    expect(socketState.client?.listenerCount('slack_event')).toBe(0)
  })

  it('rejects a redirect with missing or invalid Location', async () => {
    const f = { id: 'F', name: 'a', mimetype: 'm', size: 1, url: 'https://files.slack.com/x' }
    fetchMock.mockResolvedValue(new Response(null, { status: 302 }))
    await expect(createSlackApi(creds).downloadFile(f)).rejects.toMatchObject({ code: 'network' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    fetchMock.mockResolvedValue(new Response(null, { status: 302, headers: { location: 'http://[bad' } }))
    await expect(createSlackApi(creds).downloadFile(f)).rejects.toMatchObject({ code: 'network' })
  })

  it('rejects an HTML login page for a non-HTML file as invalid_auth', async () => {
    const html = () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })
    const f = { id: 'F', name: 'a', mimetype: 'image/png', size: 1, url: 'https://files.slack.com/x' }
    fetchMock.mockResolvedValue(html())
    await expect(createSlackApi(creds).downloadFile(f)).rejects.toMatchObject({ code: 'invalid_auth' })
    fetchMock.mockResolvedValue(html())
    await expect(createSlackApi(creds).downloadFile({ ...f, mimetype: 'text/html' })).resolves.toBeInstanceOf(Buffer)
  })
})

describe('final review fixes', () => {
  it('C1: a socket close after the app token is revoked is no unhandled rejection and reports disconnected', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => unhandled.push(reason)
    process.on('unhandledRejection', onUnhandled)
    try {
      const { conn } = await connected()
      socketState.startError = platformError('invalid_auth')
      socketState.client?.emit('close')
      await new Promise((r) => setTimeout(r, 10))
      expect(unhandled).toEqual([])
      expect(conn).toEqual([false])
      socketState.client?.emit('error', new Error('socket error'))
      expect(conn).toEqual([false, false])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('C2: a start() that never settles rejects with network at the deadline and disconnects the client', async () => {
    vi.useFakeTimers()
    try {
      socketState.startHangs = true
      web.auth.test.mockResolvedValue({ user_id: 'UBOT', user: 'kobo', team: 'Acme' })
      const result = createSlackApi(creds)
        .connect(
          () => undefined,
          () => undefined,
        )
        .catch((e) => e)
      await vi.advanceTimersByTimeAsync(20_000)
      const settled = await Promise.race([result, Promise.resolve('still pending')])
      expect(settled).toBeInstanceOf(SlackApiError)
      expect((settled as SlackApiError).code).toBe('network')
      expect(socketState.client?.disconnect).toHaveBeenCalledOnce()
      expect(socketState.client?.listenerCount('slack_event')).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('I3: an app_mention envelope is acked and not forwarded', async () => {
    const { events } = await connected()
    const env = envelope({ type: 'app_mention', channel: 'C1', ts: '3.3', user: 'U1', text: '<@UBOT> hi' })
    await listener()(env)
    expect(env.ack).toHaveBeenCalledOnce()
    expect(events).toEqual([])
  })

  it('C1/C2: the socket client never reconnects on its own and bounds its HTTP calls', async () => {
    await connected()
    expect(socketState.client?.options).toEqual(
      expect.objectContaining({
        appToken: 'xapp-secret-token',
        autoReconnectEnabled: false,
        clientOptions: { timeout: 15_000, retryConfig: { retries: 2 } },
      }),
    )
  })
})

describe('buttons', () => {
  const interactive = (body: unknown) => ({ ack: vi.fn(async () => undefined), type: 'interactive', body })
  const clickBody = (over: Record<string, unknown> = {}) => ({
    type: 'block_actions',
    user: { id: 'U1', name: 'alice' },
    channel: { id: 'C1' },
    message: { ts: '1794567700.000100', thread_ts: '1794567600.000100' },
    actions: [{ action_id: 'kobo_button_1', value: '1', action_ts: '1794567708.357419', type: 'button' }],
    ...over,
  })

  async function connectWithClicks(onClick: (c: unknown) => unknown) {
    web.auth.test.mockResolvedValue({ user_id: 'UBOT', user: 'kobo', team: 'Acme' })
    await createSlackApi(creds).connect(
      () => undefined,
      () => undefined,
      onClick as never,
    )
  }

  it('acks a block_actions envelope before the click callback and maps the typed click', async () => {
    const order: unknown[] = []
    await connectWithClicks((c) => order.push(c))
    const env = interactive(clickBody())
    env.ack.mockImplementation(async () => {
      order.push('ack')
    })
    await listener()(env)
    expect(order).toEqual([
      'ack',
      { channel: 'C1', messageTs: '1794567700.000100', user: 'U1', actionTs: '1794567708.357419', index: 1 },
    ])
  })

  it.each([
    ['a non block_actions interactive envelope', { type: 'view_submission' }],
    ['a click without a user', clickBody({ user: undefined })],
    ['a click without actions', clickBody({ actions: [] })],
    ['a click with a foreign value', clickBody({ actions: [{ value: 'approve', action_ts: '1.1' }] })],
    ['a click with a malformed action_ts', clickBody({ actions: [{ value: '0', action_ts: 'x-1' }] })],
  ])('acks and drops %s', async (_label, body) => {
    const clicks: unknown[] = []
    await connectWithClicks((c) => clicks.push(c))
    const env = interactive(body)
    await listener()(env)
    expect(env.ack).toHaveBeenCalledOnce()
    expect(clicks).toEqual([])
  })

  it('swallows a throwing or rejecting click callback', async () => {
    let n = 0
    await connectWithClicks(() => {
      n++
      if (n === 1) throw new Error('sync')
      return Promise.reject(new Error('async'))
    })
    await expect(listener()(interactive(clickBody()))).resolves.toBeUndefined()
    await expect(listener()(interactive(clickBody()))).resolves.toBeUndefined()
    expect(n).toBe(2)
  })

  it('postMessage with buttons sends text sections, one actions block and the reply hint', async () => {
    web.chat.postMessage.mockResolvedValue({ ts: '9.9' })
    const text = 'x'.repeat(7000)
    await createSlackApi(creds).postMessage('C1', text, '1.0', [{ label: 'Yes', style: 'primary' }, { label: 'No' }])
    const args = web.chat.postMessage.mock.calls[0]![0]
    expect(args).toMatchObject({ channel: 'C1', text, thread_ts: '1.0' })
    const blocks = args.blocks as { type: string; text?: { type: string; text: string } }[]
    expect(blocks.map((b) => b.type)).toEqual(['section', 'section', 'section', 'actions', 'context'])
    expect(blocks.slice(0, 3).map((b) => [b.text?.type, b.text?.text.length])).toEqual([
      ['mrkdwn', 3000],
      ['mrkdwn', 3000],
      ['mrkdwn', 1000],
    ])
    expect(blocks[3]).toEqual({
      type: 'actions',
      block_id: 'kobo_buttons',
      elements: [
        {
          type: 'button',
          action_id: 'kobo_button_0',
          value: '0',
          text: { type: 'plain_text', text: 'Yes' },
          style: 'primary',
        },
        { type: 'button', action_id: 'kobo_button_1', value: '1', text: { type: 'plain_text', text: 'No' } },
      ],
    })
    expect(blocks[4]).toEqual({
      type: 'context',
      elements: [{ type: 'plain_text', text: 'You can also reply in this thread.' }],
    })
  })

  it('splits sections on line boundaries when possible', async () => {
    web.chat.postMessage.mockResolvedValue({ ts: '9.9' })
    const text = `${'a'.repeat(2000)}\n${'b'.repeat(2000)}`
    await createSlackApi(creds).postMessage('C1', text, undefined, [{ label: 'A' }])
    const blocks = web.chat.postMessage.mock.calls[0]![0].blocks as { type: string; text?: { text: string } }[]
    expect(blocks.filter((b) => b.type === 'section').map((b) => b.text?.text)).toEqual([
      'a'.repeat(2000),
      'b'.repeat(2000),
    ])
  })

  it('postMessage without buttons is unchanged', async () => {
    web.chat.postMessage.mockResolvedValue({ ts: '9.9' })
    await createSlackApi(creds).postMessage('C1', 'hello')
    expect(web.chat.postMessage).toHaveBeenCalledWith({ channel: 'C1', text: 'hello', thread_ts: undefined })
  })

  it('the answered line replaces the buttons through chat.update, with no actions block', async () => {
    web.chat.update.mockResolvedValue({ ok: true })
    await createSlackApi(creds).replaceButtons('C1', '9.9', 'Pick one', 'Answered: Yes - alice')
    expect(web.chat.update).toHaveBeenCalledWith({
      channel: 'C1',
      ts: '9.9',
      text: 'Pick one',
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: 'Pick one' } },
        { type: 'context', elements: [{ type: 'plain_text', text: 'Answered: Yes - alice' }] },
      ],
    })
    web.chat.update.mockRejectedValue(platformError('message_not_found'))
    await expect(createSlackApi(creds).replaceButtons('C1', '9.9', 'x', 'y')).rejects.toMatchObject({ code: 'unknown' })
  })
})

describe('polish', () => {
  const textBlocks = async (text: string) => {
    web.chat.postMessage.mockResolvedValue({ ts: '9.9' })
    await createSlackApi(creds).postMessage('C1', text, undefined, [{ label: 'A' }])
    const blocks = web.chat.postMessage.mock.calls.at(-1)![0].blocks as { type: string; text?: { text: string } }[]
    return blocks.filter((b) => b.type === 'section').map((b) => b.text?.text as string)
  }

  it('P3: a long line is never cut inside a surrogate pair', async () => {
    const text = `${'a'.repeat(2999)}😀${'b'.repeat(10)}`
    const sections = await textBlocks(text)
    expect(sections.join('')).toBe(text)
    for (const s of sections) {
      expect(s.length).toBeLessThanOrEqual(3000)
      expect(s).not.toMatch(/[\ud800-\udbff]$/)
      expect(s).not.toMatch(/^[\udc00-\udfff]/)
    }
  })

  it('P3: blank runs never produce a whitespace-only section', async () => {
    const sections = await textBlocks(`${'a'.repeat(100)}${'\n'.repeat(6000)}${'b'.repeat(100)}`)
    expect(sections.length).toBeGreaterThan(0)
    for (const s of sections) expect(s.trim()).not.toBe('')
  })

  it('P3: a mrkdwn entity straddling the boundary stays whole', async () => {
    const entity = '<https://example.com|label>'
    const text = `${'a'.repeat(2990)}${entity}${'b'.repeat(50)}`
    const sections = await textBlocks(text)
    expect(sections.some((s) => s.includes(entity))).toBe(true)
    expect(sections.join('')).toBe(text)
  })

  it('P6: a socket error followed by the fast reconnect leaves one live client', async () => {
    web.auth.test.mockResolvedValue({ user_id: 'UBOT', user: 'kobo', team: 'Acme' })
    const api = createSlackApi(creds)
    const conn: boolean[] = []
    await api.connect(
      () => undefined,
      (c) => conn.push(c),
    )
    const first = socketState.client
    first?.emit('error', new Error('boom'))
    expect(conn).toEqual([false])
    await api.connect(
      () => undefined,
      (c) => conn.push(c),
    )
    const second = socketState.client
    expect(second).not.toBe(first)
    expect(first?.disconnect).toHaveBeenCalledOnce()
    expect(second?.disconnect).not.toHaveBeenCalled()
  })
})

describe('question controls', () => {
  const interactive = (body: unknown) => ({ ack: vi.fn(async () => undefined), type: 'interactive', body })
  const base = {
    type: 'block_actions',
    user: { id: 'U1' },
    channel: { id: 'C1' },
    message: { ts: '1794567700.000100' },
  }

  async function connectAll() {
    web.auth.test.mockResolvedValue({ user_id: 'UBOT', user: 'kobo', team: 'Acme' })
    const clicks: unknown[] = []
    const questions: unknown[] = []
    await createSlackApi(creds).connect(
      () => undefined,
      () => undefined,
      (c) => clicks.push(c),
      (q) => questions.push(q),
    )
    return { clicks, questions }
  }

  it('posts buttons with kobo_question_ ids, values as positions and the hint', async () => {
    web.chat.postMessage.mockResolvedValue({ ts: '9.9' })
    const ts = await createSlackApi(creds).postQuestion('C1', '*H*\nPick', '1.0', {
      question: 1,
      kind: 'buttons',
      labels: ['A', 'B'],
      hint: 'Or reply in this thread with your own answer.',
    })
    expect(ts).toBe('9.9')
    const args = web.chat.postMessage.mock.calls[0]![0]
    expect(args).toMatchObject({ channel: 'C1', text: '*H*\nPick', thread_ts: '1.0' })
    expect(args.blocks).toEqual([
      { type: 'section', text: { type: 'mrkdwn', text: '*H*\nPick' } },
      {
        type: 'actions',
        block_id: 'kobo_question_1',
        elements: [
          { type: 'button', action_id: 'kobo_question_1_0', value: '0', text: { type: 'plain_text', text: 'A' } },
          { type: 'button', action_id: 'kobo_question_1_1', value: '1', text: { type: 'plain_text', text: 'B' } },
        ],
      },
      { type: 'context', elements: [{ type: 'plain_text', text: 'Or reply in this thread with your own answer.' }] },
    ])
    expect(JSON.stringify(args.blocks)).not.toContain('kobo_button_')
  })

  it('posts one checkbox group and a primary Submit button, and no controls without labels', async () => {
    web.chat.postMessage.mockResolvedValue({ ts: '9.9' })
    await createSlackApi(creds).postQuestion('C1', 'Pick', undefined, {
      question: 0,
      kind: 'checkboxes',
      labels: ['A', 'B'],
    })
    expect(web.chat.postMessage.mock.calls[0]![0].blocks).toEqual([
      { type: 'section', text: { type: 'mrkdwn', text: 'Pick' } },
      {
        type: 'actions',
        block_id: 'kobo_question_0',
        elements: [
          {
            type: 'checkboxes',
            action_id: 'kobo_question_0_checks',
            options: [
              { text: { type: 'plain_text', text: 'A' }, value: '0' },
              { text: { type: 'plain_text', text: 'B' }, value: '1' },
            ],
          },
          {
            type: 'button',
            action_id: 'kobo_question_0_submit',
            value: 'submit',
            style: 'primary',
            text: { type: 'plain_text', text: 'Submit' },
          },
        ],
      },
    ])
    await createSlackApi(creds).postQuestion('C1', 'Tell me', undefined, {
      question: 0,
      kind: 'none',
      labels: [],
      hint: 'Reply in this thread with your answer.',
    })
    expect(web.chat.postMessage.mock.calls[1]![0].blocks.map((b: { type: string }) => b.type)).toEqual([
      'section',
      'context',
    ])
  })

  it('maps a question button and a Submit carrying the checked options from state, after the ack', async () => {
    const { clicks, questions } = await connectAll()
    const button = interactive({
      ...base,
      actions: [{ action_id: 'kobo_question_2_3', block_id: 'kobo_question_2', value: '3', action_ts: '1.5' }],
    })
    await listener()(button)
    const submit = interactive({
      ...base,
      actions: [
        { action_id: 'kobo_question_0_submit', block_id: 'kobo_question_0', value: 'submit', action_ts: '1.6' },
      ],
      state: {
        values: {
          kobo_question_0: {
            kobo_question_0_checks: {
              type: 'checkboxes',
              selected_options: [{ value: '2' }, { value: '0' }, { value: 'x' }, { value: '0' }],
            },
          },
        },
      },
    })
    await listener()(submit)
    expect(button.ack).toHaveBeenCalledOnce()
    expect(submit.ack).toHaveBeenCalledOnce()
    expect(clicks).toEqual([])
    expect(questions).toEqual([
      { channel: 'C1', messageTs: '1794567700.000100', user: 'U1', actionTs: '1.5', question: 2, choices: [3] },
      { channel: 'C1', messageTs: '1794567700.000100', user: 'U1', actionTs: '1.6', question: 0, choices: [0, 2] },
    ])
  })

  it('acks and ignores a checkbox toggle and malformed question actions', async () => {
    const { clicks, questions } = await connectAll()
    for (const action of [
      { action_id: 'kobo_question_0_checks', type: 'checkboxes', action_ts: '1.1', selected_options: [] },
      { action_id: 'kobo_question_0_12', value: '12', action_ts: '1.1' },
      { action_id: 'kobo_question_x_1', value: '1', action_ts: '1.1' },
      { action_id: 'kobo_question_0_1', value: '1', action_ts: 'bad' },
    ]) {
      const env = interactive({ ...base, actions: [action] })
      await listener()(env)
      expect(env.ack).toHaveBeenCalledOnce()
    }
    expect(clicks).toEqual([])
    expect(questions).toEqual([])
  })
})
