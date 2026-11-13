import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initSchema } from '../server/db/schema.js'
import type { SlackApi } from '../server/services/slack/slack-api.js'
import type { InboundEvent } from '../server/services/slack/slack-inbound.js'
import type { SlackFileRef } from '../server/services/slack/slack-message-store.js'
import { makeGlobalSettings } from './helpers/fixtures.js'

// Registered per test after vi.resetModules(): partial mocks must not keep a previous test's database module.
function registerMocks() {
  vi.doMock('../server/services/workspace-message-service.js', () => ({ deliverWorkspaceMessage: vi.fn() }))
  vi.doMock('../server/services/slack/slack-credentials.js', () => ({
    getSlackCredentials: vi.fn(() => ({ botToken: 'xoxb-t', appToken: 'xapp-t' })),
    saveSlackCredentials: vi.fn(),
  }))
  vi.doMock('../server/services/settings-service.js', async (orig) => ({
    ...(await orig<typeof import('../server/services/settings-service.js')>()),
    getGlobalSettings: vi.fn(),
  }))
  vi.doMock('../server/services/websocket-service.js', async (orig) => ({
    ...(await orig<typeof import('../server/services/websocket-service.js')>()),
    broadcastAll: vi.fn(),
  }))
}

const TEXT = {
  unlinkedQueued: 'This channel was unlinked from its Kōbō workspace before this message was delivered.',
  archived: 'This workspace is archived in Kōbō. Restore it to send messages.',
  autoLoop: 'Attachments cannot be delivered while the workspace runs in auto-loop.',
  full: 'Too many messages are waiting for this workspace. Try again later.',
  expired: 'This message waited more than 24 hours and was not delivered.',
  uncertain: 'Kōbō restarted while delivering this message. Delivery is uncertain and it was not retried.',
}

type Call = { fn: string; args: unknown[] }

function fakeApi(over: Partial<Record<keyof SlackApi, (...args: never[]) => unknown>> = {}) {
  const calls: Call[] = []
  const impl: Record<keyof SlackApi, (...args: never[]) => unknown> = {
    connect: async () => ({ botUserId: 'UBOT', botName: 'kobo', teamName: 'acme' }),
    disconnect: async () => undefined,
    postMessage: async () => '1731600000.000001',
    postQuestion: async () => '1731600000.000002',
    replaceButtons: async () => undefined,
    addReaction: async () => undefined,
    removeReaction: async () => undefined,
    listChannels: async () => [
      { id: 'C1', name: 'general' },
      { id: 'C2', name: 'other' },
    ],
    threadReplies: async () => [],
    userName: async (id: string) => (id === 'U1' ? 'alice' : id),
    downloadFile: async () => Buffer.from('png-bytes'),
    ...over,
  }
  const api = {} as Record<string, unknown>
  for (const [fn, f] of Object.entries(impl))
    api[fn] = async (...args: unknown[]) => {
      calls.push({ fn, args })
      return (f as (...a: unknown[]) => unknown)(...args)
    }
  return { api: api as unknown as SlackApi, calls }
}

let tmpDir: string
let svc: typeof import('../server/services/slack/slack-service.js')
let store: typeof import('../server/services/slack/slack-message-store.js')
let getDb: typeof import('../server/db/index.js').getDb
let deliver: ReturnType<typeof vi.fn>
let broadcastAll: ReturnType<typeof vi.fn>
let settings = makeGlobalSettings({ slackEnabled: true, slackAllowedUserIds: ['U1'] })

function wsRow(id: string, channel: string | null, extra = '') {
  getDb()
    .prepare(
      `INSERT INTO workspaces(id,name,project_path,source_branch,working_branch,worktree_path,slack_channel_id,created_at,updated_at)
       VALUES (?,?,'/tmp','main',?,'/tmp',?,'now','now')`,
    )
    .run(id, id, `b-${id}`, channel)
  if (extra) getDb().prepare(`UPDATE workspaces SET ${extra} WHERE id = ?`).run(id)
}

function rows(where = '1=1') {
  return getDb()
    .prepare(`SELECT channel_id, ts, thread_ts, state, text, direction FROM slack_messages WHERE ${where} ORDER BY ts`)
    .all() as {
    channel_id: string
    ts: string
    thread_ts: string
    state: string
    text: string
    direction: string
  }[]
}

const posts = (calls: Call[]) => calls.filter((c) => c.fn === 'postMessage').map((c) => c.args)
const reactions = (calls: Call[], fn: 'addReaction' | 'removeReaction') =>
  calls.filter((c) => c.fn === fn).map((c) => c.args)

function mention(over: Partial<InboundEvent> = {}): InboundEvent {
  return { type: 'message', channel: 'C1', ts: '1731500000.000100', user: 'U1', text: '<@UBOT> hello there', ...over }
}

const png: SlackFileRef = {
  id: 'F1',
  name: 'shot.png',
  mimetype: 'image/png',
  size: 9,
  url: 'https://files.slack.com/a',
}

async function start(api: SlackApi) {
  await svc.startSlack(() => api)
}

beforeEach(async () => {
  vi.resetModules()
  registerMocks()
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kobo-slack-svc-'))
  const dbPath = path.join(tmpDir, 'test.db')
  const db = new Database(dbPath)
  db.pragma('journal_mode=WAL')
  db.pragma('foreign_keys=ON')
  initSchema(db)
  db.close()
  ;({ getDb } = await import('../server/db/index.js'))
  getDb(dbPath)
  settings = makeGlobalSettings({ slackEnabled: true, slackAllowedUserIds: ['U1'] })
  const settingsModule = await import('../server/services/settings-service.js')
  vi.mocked(settingsModule.getGlobalSettings).mockImplementation(() => settings)
  deliver = vi.mocked((await import('../server/services/workspace-message-service.js')).deliverWorkspaceMessage)
  deliver.mockImplementation(async (_ws, msg, hooks) => {
    hooks?.beforeDispatch?.()
    hooks?.persist?.({ content: msg.content, sender: 'user', source: msg.source }, 's1')
    return { sessionId: 's1' }
  })
  broadcastAll = vi.mocked((await import('../server/services/websocket-service.js')).broadcastAll)
  store = await import('../server/services/slack/slack-message-store.js')
  svc = await import('../server/services/slack/slack-service.js')
  wsRow('wsA', 'C1')
  wsRow('wsB', null)
})

afterEach(async () => {
  await svc.stopSlack()
  const { closeDb } = await import('../server/db/index.js')
  closeDb()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('slack service inbound delivery', () => {
  it('delivers a mention from an allowed user with header, Slack source and eyes', async () => {
    const { api, calls } = fakeApi()
    await start(api)
    await svc.handleSlackEvent(mention())
    expect(deliver).toHaveBeenCalledTimes(1)
    const [wsId, msg] = deliver.mock.calls[0]!
    expect(wsId).toBe('wsA')
    expect(msg.content).toBe(
      '[Slack #general | from alice | thread 1731500000.000100 | reply with slack_post_message thread_ts="1731500000.000100"]\nhello there',
    )
    expect(msg.source).toEqual({
      kind: 'slack',
      userName: 'alice',
      userId: 'U1',
      channelId: 'C1',
      threadTs: '1731500000.000100',
    })
    expect(msg.delivery).toBe('immediate')
    expect(msg.clientMessageId).toBe('slack:C1:1731500000.000100')
    expect(rows()[0]!.state).toBe('delivered')
    expect(reactions(calls, 'addReaction')).toContainEqual(['C1', '1731500000.000100', 'eyes'])
    const event = getDb().prepare("SELECT payload FROM ws_events WHERE type = 'user:message'").get() as {
      payload: string
    }
    expect(JSON.parse(event.payload).source.kind).toBe('slack')
  })

  it('Review Focus 1: a message and its concurrent and later redeliveries produce exactly one delivery', async () => {
    const { api } = fakeApi()
    await start(api)
    await Promise.all([svc.handleSlackEvent(mention()), svc.handleSlackEvent(mention())])
    await svc.handleSlackEvent(mention())
    expect(deliver).toHaveBeenCalledTimes(1)
    expect(rows()).toHaveLength(1)
  })

  it('Review Focus 2: file_share with empty text and one PNG is delivered with one attachment', async () => {
    const { api } = fakeApi()
    await start(api)
    await svc.handleSlackEvent(mention({ subtype: 'file_share', text: '<@UBOT>', files: [png] }))
    expect(deliver).toHaveBeenCalledTimes(1)
    const msg = deliver.mock.calls[0]![1]
    expect(msg.attachments).toEqual([
      { name: 'shot.png', mime_type: 'image/png', data_base64: Buffer.from('png-bytes').toString('base64') },
    ])
    expect(rows()[0]!.state).toBe('delivered')
  })

  it('ignores authors outside the allow-list without any API call or row', async () => {
    const { api, calls } = fakeApi()
    await start(api)
    calls.length = 0
    await svc.handleSlackEvent(mention({ user: 'U9' }))
    expect(calls).toEqual([])
    expect(rows()).toEqual([])
    expect(deliver).not.toHaveBeenCalled()
  })

  it('keeps a refused message queued, preserves order and drains both later', async () => {
    const { api, calls } = fakeApi()
    await start(api)
    deliver.mockRejectedValue(new Error('busy'))
    await svc.handleSlackEvent(mention())
    expect(rows()[0]!.state).toBe('queued')
    expect(reactions(calls, 'addReaction')).toEqual([['C1', '1731500000.000100', 'hourglass_flowing_sand']])
    await svc.handleSlackEvent(mention({ ts: '1731500000.000200', text: '<@UBOT> second' }))
    expect(rows().map((r) => r.state)).toEqual(['queued', 'queued'])
    expect(deliver.mock.calls.every((c) => String(c[1].content).endsWith('hello there'))).toBe(true)
    // every queued row gets the hourglass, each once
    expect(reactions(calls, 'addReaction').filter((r) => r[2] === 'hourglass_flowing_sand')).toEqual([
      ['C1', '1731500000.000100', 'hourglass_flowing_sand'],
      ['C1', '1731500000.000200', 'hourglass_flowing_sand'],
    ])

    deliver.mockReset()
    deliver.mockImplementation(async (_ws, msg, hooks) => {
      hooks?.beforeDispatch?.()
      hooks?.persist?.({ content: msg.content }, 's1')
      return {}
    })
    await svc.drainSlackQueue('wsA')
    expect(deliver.mock.calls.map((c) => String(c[1].content).split('\n')[1])).toEqual(['hello there', 'second'])
    expect(rows().map((r) => r.state)).toEqual(['delivered', 'delivered'])
    expect(reactions(calls, 'removeReaction')).toContainEqual(['C1', '1731500000.000100', 'hourglass_flowing_sand'])
    expect(reactions(calls, 'addReaction')).toContainEqual(['C1', '1731500000.000100', 'eyes'])
    expect(reactions(calls, 'addReaction')).toContainEqual(['C1', '1731500000.000200', 'eyes'])
  })

  it('marks a dispatched failure unknown, posts the uncertain notice and never retries it', async () => {
    const { api, calls } = fakeApi()
    await start(api)
    deliver.mockImplementation(async (_ws, _msg, hooks) => {
      hooks?.beforeDispatch?.()
      throw new Error('engine died')
    })
    await svc.handleSlackEvent(mention())
    expect(rows()[0]!.state).toBe('unknown')
    expect(posts(calls)).toContainEqual(['C1', TEXT.uncertain, '1731500000.000100'])
    expect(reactions(calls, 'removeReaction')).toContainEqual(['C1', '1731500000.000100', 'hourglass_flowing_sand'])
    await svc.drainSlackQueue('wsA')
    expect(deliver).toHaveBeenCalledTimes(1)
  })

  it('rejects messages for an archived workspace', async () => {
    getDb().prepare("UPDATE workspaces SET archived_at = 'now' WHERE id = 'wsA'").run()
    const { api, calls } = fakeApi()
    await start(api)
    await svc.handleSlackEvent(mention())
    expect(rows()[0]!.state).toBe('rejected')
    expect(posts(calls)).toContainEqual(['C1', TEXT.archived, '1731500000.000100'])
    expect(deliver).not.toHaveBeenCalled()
    // a redelivery of the rejected message is silent
    calls.length = 0
    await svc.handleSlackEvent(mention())
    expect(calls.filter((c) => c.fn !== 'userName')).toEqual([])
  })

  it('uses next_iteration on auto-loop workspaces and rejects files there', async () => {
    getDb().prepare("UPDATE workspaces SET auto_loop = 1 WHERE id = 'wsA'").run()
    const { api, calls } = fakeApi()
    await start(api)
    await svc.handleSlackEvent(mention())
    expect(deliver.mock.calls[0]![1]).toMatchObject({
      delivery: 'next_iteration',
      clientMessageId: 'slack:C1:1731500000.000100',
    })
    await svc.handleSlackEvent(mention({ ts: '1731500000.000300', files: [png] }))
    expect(deliver).toHaveBeenCalledTimes(1)
    expect(rows("ts = '1731500000.000300'")[0]!.state).toBe('rejected')
    expect(posts(calls)).toContainEqual(['C1', TEXT.autoLoop, '1731500000.000300'])
  })

  it('rejects the 51st message when 50 are queued', async () => {
    for (let i = 0; i < 50; i++)
      store.insertSlackMessage({
        channelId: 'C1',
        ts: `1731400000.${String(i).padStart(6, '0')}`,
        threadTs: `1731400000.${String(i).padStart(6, '0')}`,
        workspaceId: 'wsA',
        userId: 'U1',
        userName: 'alice',
        text: 'x',
        direction: 'in',
        state: 'queued',
        files: [],
      })
    const { api, calls } = fakeApi()
    await start(api)
    await svc.handleSlackEvent(mention())
    expect(rows("ts = '1731500000.000100'")[0]!.state).toBe('rejected')
    expect(posts(calls)).toContainEqual(['C1', TEXT.full, '1731500000.000100'])
    expect(deliver).not.toHaveBeenCalled()
  })

  it('fetches context once for a mention inside an untracked thread', async () => {
    const replies: InboundEvent[] = [
      { type: 'message', channel: 'C1', ts: '1731500000.000100', user: 'U7', text: 'root text' },
      { type: 'message', channel: 'C1', ts: '1731500000.000200', user: 'U8', text: 'second text', files: [png] },
      { type: 'message', channel: 'C1', ts: '1731500000.000300', user: 'U1', text: '<@UBOT> do it' },
      { type: 'message', channel: 'C1', ts: '1731500000.000400', user: 'U8', text: 'later text' },
    ]
    const { api, calls } = fakeApi({ threadReplies: async () => replies })
    await start(api)
    await svc.handleSlackEvent(
      mention({ ts: '1731500000.000300', thread_ts: '1731500000.000100', text: '<@UBOT> do it' }),
    )
    expect(calls.filter((c) => c.fn === 'threadReplies').map((c) => c.args)).toEqual([['C1', '1731500000.000100', 100]])
    expect(rows().map((r) => [r.ts, r.state])).toEqual([
      ['1731500000.000100', 'context'],
      ['1731500000.000200', 'context'],
      ['1731500000.000300', 'delivered'],
    ])
    const content = String(deliver.mock.calls[0]![1].content)
    expect(content.split('\n')[0]).toContain('| 2 earlier stored messages |')
    expect(content).not.toContain('root text')
    expect(content).not.toContain('second text')
    // context files are stored as names only
    const ctx = store.listSlackThread('C1', '1731500000.000100', { limit: 10 })[1]!
    expect(ctx.files.map((f) => [f.name, f.url])).toEqual([['shot.png', '']])
  })

  it('skips an unsupported file, names it in the header and in one notice', async () => {
    const zip: SlackFileRef = {
      id: 'F2',
      name: 'dump.zip',
      mimetype: 'application/zip',
      size: 5,
      url: 'https://files.slack.com/b',
    }
    const { api, calls } = fakeApi()
    await start(api)
    await svc.handleSlackEvent(mention({ files: [png, zip] }))
    const msg = deliver.mock.calls[0]![1]
    expect(msg.attachments).toHaveLength(1)
    expect(String(msg.content).split('\n')[0]).toMatch(/ \| ignored files: dump\.zip\]$/)
    expect(calls.filter((c) => c.fn === 'downloadFile')).toHaveLength(1)
    const notices = posts(calls).filter((p) => String(p[1]).startsWith('Ignored files'))
    expect(notices).toEqual([['C1', 'Ignored files (unsupported type or too large): dump.zip', '1731500000.000100']])
  })

  it('Review Focus 3: failing reactions and notices never change delivery state', async () => {
    const { SlackApiError } = await import('../server/services/slack/slack-api.js')
    const fail = async () => {
      throw new SlackApiError('not_in_channel')
    }
    const { api } = fakeApi({ addReaction: fail, removeReaction: fail, postMessage: fail })
    await start(api)
    await expect(
      svc.handleSlackEvent(mention({ files: [png, { ...png, name: 'x.zip', mimetype: 'application/zip' }] })),
    ).resolves.toBeUndefined()
    expect(rows()[0]!.state).toBe('delivered')
    getDb().prepare("UPDATE workspaces SET archived_at = 'now' WHERE id = 'wsA'").run()
    await expect(svc.handleSlackEvent(mention({ ts: '1731500000.000900' }))).resolves.toBeUndefined()
    expect(rows("ts = '1731500000.000900'")[0]!.state).toBe('rejected')
  })

  it('Review Focus 4: unlinking rejects queued rows, deletes them and a new link delivers nothing', async () => {
    const { api, calls } = fakeApi()
    await start(api)
    deliver.mockRejectedValue(new Error('busy'))
    await svc.handleSlackEvent(mention())
    await svc.handleSlackEvent(mention({ ts: '1731500000.000200' }))
    expect(rows().map((r) => r.state)).toEqual(['queued', 'queued'])
    calls.length = 0
    await svc.linkSlackChannel('wsA', null)
    expect(posts(calls)).toEqual([
      ['C1', TEXT.unlinkedQueued, '1731500000.000100'],
      ['C1', TEXT.unlinkedQueued, '1731500000.000200'],
    ])
    expect(rows()).toEqual([])
    expect(broadcastAll).toHaveBeenCalledWith('workspace:slack-channel-updated', {
      workspaceId: 'wsA',
      slackChannelId: null,
    })
    deliver.mockClear()
    await svc.linkSlackChannel('wsB', 'C1')
    await svc.drainSlackQueue('wsB')
    expect(deliver).not.toHaveBeenCalled()
  })
})

describe('slack service lifecycle', () => {
  it('turns a dispatching row into unknown on boot and posts the uncertain notice', async () => {
    store.insertSlackMessage({
      channelId: 'C1',
      ts: '1731500000.000100',
      threadTs: '1731500000.000050',
      workspaceId: 'wsA',
      userId: 'U1',
      userName: 'alice',
      text: 'x',
      direction: 'in',
      state: 'dispatching',
      files: [],
    })
    const { api, calls } = fakeApi()
    await start(api)
    expect(rows()[0]!.state).toBe('unknown')
    expect(posts(calls)).toContainEqual(['C1', TEXT.uncertain, '1731500000.000050'])
  })

  it('startSlack resolves when disabled or when connect fails', async () => {
    settings = makeGlobalSettings({ slackEnabled: false, slackAllowedUserIds: ['U1'] })
    const first = fakeApi()
    await expect(svc.startSlack(() => first.api)).resolves.toBeUndefined()
    expect(first.calls).toEqual([])
    expect(svc.getSlackStatus()).toMatchObject({ configured: true, enabled: false, connected: false })

    settings = makeGlobalSettings({ slackEnabled: true, slackAllowedUserIds: ['U1'] })
    const { SlackApiError } = await import('../server/services/slack/slack-api.js')
    const second = fakeApi({
      connect: async () => {
        throw new SlackApiError('invalid_auth')
      },
    })
    await expect(svc.startSlack(() => second.api)).resolves.toBeUndefined()
    expect(svc.getSlackStatus()).toMatchObject({ enabled: true, connected: false, error: 'invalid_auth' })
  })

  it('stopSlack awaits an in-flight handler and ignores later events', async () => {
    const { api } = fakeApi()
    await start(api)
    let release!: () => void
    deliver.mockImplementation(async (_ws, msg, hooks) => {
      hooks?.beforeDispatch?.()
      await new Promise<void>((r) => {
        release = r
      })
      hooks?.persist?.({ content: msg.content }, 's1')
      return {}
    })
    const handled = svc.handleSlackEvent(mention())
    await vi.waitFor(() => expect(deliver).toHaveBeenCalled())
    let stopped = false
    const stopping = svc.stopSlack().then(() => {
      stopped = true
    })
    await new Promise((r) => setTimeout(r, 20))
    expect(stopped).toBe(false)
    release()
    await stopping
    await handled
    expect(rows()[0]!.state).toBe('delivered')
    await svc.handleSlackEvent(mention({ ts: '1731500000.000500' }))
    expect(rows()).toHaveLength(1)
    expect(deliver).toHaveBeenCalledTimes(1)
  })

  it('the tick expires messages queued for more than 24 hours with a notice', async () => {
    const { api, calls } = fakeApi()
    await start(api)
    deliver.mockRejectedValue(new Error('busy'))
    await svc.handleSlackEvent(mention())
    getDb().prepare("UPDATE slack_messages SET created_at = '2000-01-01T00:00:00.000Z'").run()
    await svc.runSlackTick()
    expect(rows()[0]!.state).toBe('rejected')
    expect(posts(calls)).toContainEqual(['C1', TEXT.expired, '1731500000.000100'])
    expect(reactions(calls, 'removeReaction')).toContainEqual(['C1', '1731500000.000100', 'hourglass_flowing_sand'])
  })
})

/** Delivery blocked before the dispatch boundary, like an agent that is still starting. */
function gatedDeliver() {
  let open!: () => void
  const gate = new Promise<void>((r) => {
    open = r
  })
  let reached = false
  deliver.mockImplementation(async (_ws, msg, hooks) => {
    await gate
    hooks?.beforeDispatch?.() // a throw here rejects before the engine receives anything
    reached = true
    hooks?.persist?.({ content: msg.content }, 's1')
    return {}
  })
  return { release: () => open(), reached: () => reached }
}
const userEvents = () =>
  (getDb().prepare("SELECT COUNT(*) AS n FROM ws_events WHERE type = 'user:message'").get() as { n: number }).n

describe('slack service fix round 1', () => {
  it('Critical 1: unlinking while delivery is in flight never reaches the agent', async () => {
    const { api, calls } = fakeApi()
    await start(api)
    const g = gatedDeliver()
    const handled = svc.handleSlackEvent(mention())
    await vi.waitFor(() => expect(deliver).toHaveBeenCalled())
    await svc.linkSlackChannel('wsA', null)
    await svc.linkSlackChannel('wsB', 'C1')
    g.release()
    await handled
    expect(g.reached()).toBe(false)
    expect(reactions(calls, 'addReaction').filter((r) => r[2] === 'eyes')).toEqual([])
    expect(userEvents()).toBe(0)
    expect(rows()).toEqual([])
    expect(posts(calls).filter((p) => p[1] === TEXT.unlinkedQueued)).toHaveLength(1)
  })

  it('Critical 1: expiry while delivery is in flight never reaches the agent', async () => {
    const { api, calls } = fakeApi()
    await start(api)
    const g = gatedDeliver()
    const handled = svc.handleSlackEvent(mention())
    await vi.waitFor(() => expect(deliver).toHaveBeenCalled())
    getDb().prepare("UPDATE slack_messages SET created_at = '2000-01-01T00:00:00.000Z'").run()
    const tick = svc.runSlackTick()
    await vi.waitFor(() => expect(posts(calls)).toContainEqual(['C1', TEXT.expired, '1731500000.000100']))
    g.release()
    await Promise.all([handled, tick])
    expect(g.reached()).toBe(false)
    expect(rows()[0]!.state).toBe('rejected')
    expect(reactions(calls, 'addReaction').filter((r) => r[2] === 'eyes')).toEqual([])
    expect(userEvents()).toBe(0)
  })

  it('Important 1: a reconnect pending at stop is awaited, then disconnected', async () => {
    const { SlackApiError } = await import('../server/services/slack/slack-api.js')
    const order: string[] = []
    let attempts = 0
    let finish!: () => void
    const { api } = fakeApi({
      connect: async () => {
        attempts++
        if (attempts === 1) throw new SlackApiError('network')
        await new Promise<void>((r) => {
          finish = r
        })
        order.push('connected')
        return { botUserId: 'UBOT', botName: 'kobo', teamName: 'acme' }
      },
      disconnect: async () => {
        order.push('disconnect')
      },
    })
    await start(api)
    const tick = svc.runSlackTick()
    await vi.waitFor(() => expect(attempts).toBe(2))
    const stopped = svc.stopSlack()
    finish()
    await Promise.all([stopped, tick])
    expect(order).toEqual(['connected', 'disconnect'])
    expect(svc.getSlackStatus().connected).toBe(false)
  })

  it('Important 2: a message first stored as context is promoted and delivered when its own event arrives', async () => {
    const replies: InboundEvent[] = [
      { type: 'message', channel: 'C1', ts: '1731500000.000050', user: 'U7', text: 'root' },
      { type: 'message', channel: 'C1', ts: '1731500000.000100', user: 'U1', text: '<@UBOT> first' },
    ]
    const { api } = fakeApi({ threadReplies: async () => replies })
    await start(api)
    const thread = { thread_ts: '1731500000.000050' }
    await svc.handleSlackEvent(mention({ ...thread, ts: '1731500000.000200', text: '<@UBOT> second' }))
    expect(rows("ts = '1731500000.000100'")[0]!.state).toBe('context')
    await svc.handleSlackEvent(mention({ ...thread, ts: '1731500000.000100', text: '<@UBOT> first' }))
    expect(deliver).toHaveBeenCalledTimes(2)
    expect(String(deliver.mock.calls[1]![1].content).split('\n')[1]).toBe('first')
    expect(rows("ts = '1731500000.000100'")[0]!.state).toBe('delivered')
    await svc.handleSlackEvent(mention({ ...thread, ts: '1731500000.000100', text: '<@UBOT> first' }))
    expect(deliver).toHaveBeenCalledTimes(2)
  })

  it('Important 3: one unlinked notice for a message and its redelivery', async () => {
    const { api, calls } = fakeApi()
    await start(api)
    await svc.handleSlackEvent(mention({ channel: 'C2' }))
    await svc.handleSlackEvent(mention({ channel: 'C2' }))
    expect(posts(calls)).toEqual([['C2', 'This channel is not linked to a Kōbō workspace.', '1731500000.000100']])
  })

  it('Ruling C: a file failing three downloads is skipped and the message delivered', async () => {
    const { SlackApiError } = await import('../server/services/slack/slack-api.js')
    const { api, calls } = fakeApi({
      downloadFile: async () => {
        throw new SlackApiError('network')
      },
    })
    await start(api)
    await svc.handleSlackEvent(mention({ files: [png] }))
    await svc.drainSlackQueue('wsA')
    expect(rows()[0]!.state).toBe('queued')
    expect(deliver).not.toHaveBeenCalled()
    await svc.drainSlackQueue('wsA')
    expect(calls.filter((c) => c.fn === 'downloadFile')).toHaveLength(3)
    expect(rows()[0]!.state).toBe('delivered')
    const msg = deliver.mock.calls[0]![1]
    expect(msg.attachments).toBeUndefined()
    expect(String(msg.content).split('\n')[0]).toMatch(/ \| ignored files: shot\.png\]$/)
    expect(posts(calls)).toContainEqual([
      'C1',
      'Ignored files (unsupported type or too large): shot.png',
      '1731500000.000100',
    ])
  })

  it('Ruling D: context is fetched before the row is queued, and a failed fetch still delivers', async () => {
    let queuedAtFetch = -1
    const { api } = fakeApi({
      threadReplies: async () => {
        queuedAtFetch = rows().length
        throw new Error('boom')
      },
    })
    await start(api)
    await svc.handleSlackEvent(
      mention({ ts: '1731500000.000300', thread_ts: '1731500000.000100', text: '<@UBOT> do it' }),
    )
    expect(queuedAtFetch).toBe(0)
    expect(deliver).toHaveBeenCalledTimes(1)
    expect(rows().map((r) => r.state)).toEqual(['delivered'])
  })

  it('Ruling B: readSlackThread reads local history while Slack is disabled', async () => {
    store.insertSlackMessage({
      channelId: 'C1',
      ts: '1731500000.000100',
      threadTs: '1731500000.000100',
      workspaceId: 'wsA',
      userId: 'U1',
      userName: 'alice',
      text: 'x',
      direction: 'in',
      state: 'delivered',
      files: [png],
    })
    settings = makeGlobalSettings({ slackEnabled: false, slackAllowedUserIds: ['U1'] })
    const thread = svc.readSlackThread('wsA', '1731500000.000100', { limit: 10 })
    expect(thread.map((r) => [r.text, r.files[0]?.url])).toEqual([['x', '']])
    expect(() => svc.readSlackThread('wsB', '1731500000.000100', { limit: 10 })).toThrow(
      'Slack is not available for this workspace',
    )
  })
})

describe('slack service final review fixes', () => {
  it('C1: a dropped socket reports disconnected and the tick reconnects', async () => {
    let report!: (up: boolean) => void
    const { api, calls } = fakeApi({
      connect: async (_onEvent: never, onConnection: (up: boolean) => void) => {
        report = onConnection
        return { botUserId: 'UBOT', botName: 'kobo', teamName: 'acme' }
      },
    })
    await start(api)
    expect(svc.getSlackStatus().connected).toBe(true)
    report(false)
    expect(svc.getSlackStatus()).toMatchObject({ connected: false })
    expect(svc.getSlackStatus().botName).toBeUndefined()
    await svc.runSlackTick()
    await vi.waitFor(() => expect(calls.filter((c) => c.fn === 'connect')).toHaveLength(2))
    await vi.waitFor(() => expect(svc.getSlackStatus().connected).toBe(true))
  })

  it.each(['awaiting-user', 'compacting'])('I1: a queued attachment is not downloaded while %s', async (status) => {
    getDb().prepare('UPDATE workspaces SET status = ? WHERE id = ?').run(status, 'wsA')
    const { api, calls } = fakeApi()
    await start(api)
    await svc.handleSlackEvent(mention({ files: [png] }))
    await svc.runSlackTick()
    await svc.runSlackTick()
    expect(calls.filter((c) => c.fn === 'downloadFile')).toEqual([])
    expect(deliver).not.toHaveBeenCalled()
    expect(rows()[0]!.state).toBe('queued')
    expect(reactions(calls, 'addReaction')).toEqual([['C1', '1731500000.000100', 'hourglass_flowing_sand']])
    getDb().prepare("UPDATE workspaces SET status = 'idle' WHERE id = 'wsA'").run()
    await svc.drainSlackQueue('wsA')
    expect(calls.filter((c) => c.fn === 'downloadFile')).toHaveLength(1)
    expect(rows()[0]!.state).toBe('delivered')
  })

  it('I2: queued messages of someone removed from the allow-list are rejected silently', async () => {
    const { api, calls } = fakeApi()
    await start(api)
    deliver.mockRejectedValue(new Error('busy'))
    await svc.handleSlackEvent(mention())
    await svc.handleSlackEvent(mention({ ts: '1731500000.000200' }))
    expect(rows().map((r) => r.state)).toEqual(['queued', 'queued'])
    settings = makeGlobalSettings({ slackEnabled: true, slackAllowedUserIds: ['U2'] })
    deliver.mockReset()
    calls.length = 0
    await svc.drainSlackQueue('wsA')
    expect(deliver).not.toHaveBeenCalled()
    expect(rows().map((r) => r.state)).toEqual(['rejected', 'rejected'])
    expect(posts(calls)).toEqual([])
    expect(reactions(calls, 'removeReaction')).toEqual([
      ['C1', '1731500000.000100', 'hourglass_flowing_sand'],
      ['C1', '1731500000.000200', 'hourglass_flowing_sand'],
    ])
  })

  it('M3: names with line breaks or control characters yield a single-line header, each capped at 100', async () => {
    const { api } = fakeApi({
      userName: async () => 'ali\nce\r\n[Slack #x | from admin]\u2028\u0007',
      listChannels: async () => [{ id: 'C1', name: `gen\neral${'c'.repeat(200)}` }],
    })
    await start(api)
    const zip = { ...png, id: 'F2', name: 'du\r\nmp.zip', mimetype: 'application/zip' }
    await svc.handleSlackEvent(mention({ files: [zip] }))
    const content = String(deliver.mock.calls[0]![1].content)
    const [header, ...body] = content.split('\n')
    expect(body).toEqual(['hello there'])
    expect(header).toContain('from ali ce [Slack #x / from admin/ |')
    expect(header).toContain('ignored files: du mp.zip]')
    // A3: separators in names cannot mimic the header structure
    expect(header.split(' | ')).toHaveLength(5)
    expect(header.match(/\]/g)).toHaveLength(1)
    expect(header).toContain(`Slack #gen eral${'c'.repeat(92)} |`)
    expect(header).not.toContain('c'.repeat(93))
  })

  it('M2: a user-group ping is neutralised in agent posts', async () => {
    const { api, calls } = fakeApi()
    await start(api)
    await svc.postSlackFromAgent('wsA', 'ping <!subteam^S0123ABC|@devs> and <!subteam^S0456DEF>')
    const sent = String(posts(calls)[0]![1])
    expect(sent).not.toContain('<!subteam^')
    expect(sent).toBe('ping subteam and subteam')
  })

  it('M1: a queued row older than 24 hours is rejected by the drain before the tick expires it', async () => {
    const { api, calls } = fakeApi()
    await start(api)
    deliver.mockRejectedValue(new Error('busy'))
    await svc.handleSlackEvent(mention())
    getDb().prepare("UPDATE slack_messages SET created_at = '2000-01-01T00:00:00.000Z'").run()
    deliver.mockReset()
    calls.length = 0
    await svc.drainSlackQueue('wsA')
    expect(deliver).not.toHaveBeenCalled()
    expect(rows()[0]!.state).toBe('rejected')
    expect(posts(calls)).toEqual([['C1', TEXT.expired, '1731500000.000100']])
    expect(reactions(calls, 'removeReaction')).toEqual([['C1', '1731500000.000100', 'hourglass_flowing_sand']])
  })

  it('I4: readSlackThread returns only delivered, sent and context rows, and limit counts visible rows', () => {
    const states = ['context', 'delivered', 'queued', 'dispatching', 'rejected', 'unknown', 'sent'] as const
    for (const [i, state] of states.entries())
      store.insertSlackMessage({
        channelId: 'C1',
        ts: `1731500000.00010${i}`,
        threadTs: '1731500000.000100',
        workspaceId: 'wsA',
        userId: 'U1',
        userName: 'alice',
        text: state,
        direction: state === 'sent' ? 'out' : 'in',
        state,
        files: [],
      })
    expect(svc.readSlackThread('wsA', '1731500000.000100', { limit: 50 }).map((r) => r.text)).toEqual([
      'context',
      'delivered',
      'sent',
    ])
    expect(svc.readSlackThread('wsA', '1731500000.000100', { limit: 2 }).map((r) => r.text)).toEqual([
      'delivered',
      'sent',
    ])
  })
})

describe('slack service outbound', () => {
  it('postSlackFromAgent checks availability and tracked threads, strips broadcasts and stores the row', async () => {
    const { api, calls } = fakeApi()
    await start(api)
    await expect(svc.postSlackFromAgent('wsB', 'hi')).rejects.toThrow('Slack is not available for this workspace')
    await expect(svc.postSlackFromAgent('wsA', 'hi', '1731500000.000777')).rejects.toThrow('Unknown Slack thread')
    await expect(svc.postSlackFromAgent('wsA', 'ping <!here> and <!channel>, <!everyone>')).resolves.toEqual({
      ts: '1731600000.000001',
    })
    expect(posts(calls)).toContainEqual(['C1', 'ping here and channel, everyone', undefined])
    expect(rows()).toEqual([
      {
        channel_id: 'C1',
        ts: '1731600000.000001',
        thread_ts: '1731600000.000001',
        state: 'sent',
        text: 'ping here and channel, everyone',
        direction: 'out',
      },
    ])
    expect(store.isTrackedThread('C1', '1731600000.000001')).toBe(true)
    expect(svc.readSlackThread('wsA', '1731600000.000001', { limit: 10 })).toHaveLength(1)
  })
})

describe('slack service buttons', () => {
  const BOT_TS = '1731600000.000001'
  const updates = (calls: Call[]) => calls.filter((c) => c.fn === 'replaceButtons').map((c) => c.args)
  const clickRows = () => rows("ts LIKE '%-%'")
  const clickReactions = (calls: Call[]) =>
    calls.filter((c) => (c.fn === 'addReaction' || c.fn === 'removeReaction') && String(c.args[1]).includes('-'))
  const click = (over: Partial<import('../server/services/slack/slack-api.js').SlackClick> = {}) => ({
    channel: 'C1',
    messageTs: BOT_TS,
    user: 'U1',
    actionTs: '1731600005.000001',
    index: 0,
    ...over,
  })
  async function postButtons(api: SlackApi, multiple = false, labels = ['Yes', 'No']) {
    await start(api)
    await svc.postSlackFromAgent('wsA', 'Pick one', undefined, {
      buttons: labels.map((label) => ({ label })),
      multiple,
    })
  }

  it('a click on a single-answer message is delivered once and answers the message', async () => {
    const { api, calls } = fakeApi()
    await postButtons(api)
    expect(posts(calls)[0]).toEqual(['C1', 'Pick one', undefined, [{ label: 'Yes' }, { label: 'No' }]])
    await svc.handleSlackClick(click({ index: 1 }))
    expect(deliver).toHaveBeenCalledTimes(1)
    const msg = deliver.mock.calls[0]![1]
    expect(msg.content).toBe(
      `[Slack #general | from alice | thread ${BOT_TS} | button | 1 earlier stored messages | reply with slack_post_message thread_ts="${BOT_TS}"]\nClicked: No`,
    )
    expect(msg.source).toEqual({ kind: 'slack', userName: 'alice', userId: 'U1', channelId: 'C1', threadTs: BOT_TS })
    expect(updates(calls)).toEqual([['C1', BOT_TS, 'Pick one', 'Answered: No - alice']])
    expect(clickRows().map((r) => [r.state, r.thread_ts, r.text])).toEqual([['delivered', BOT_TS, 'Clicked: No']])
    expect(calls.filter((c) => c.fn === 'addReaction' || c.fn === 'removeReaction')).toEqual([])
    const thread = svc.readSlackThread('wsA', BOT_TS, { limit: 10 })
    expect(thread.map((r) => [r.direction, r.state, r.text])).toEqual([
      ['out', 'sent', 'Pick one'],
      ['in', 'delivered', 'Clicked: No'],
    ])
  })

  it('two racing clicks on a single-answer message give one delivery and one update', async () => {
    const { api, calls } = fakeApi()
    await postButtons(api)
    await Promise.all([
      svc.handleSlackClick(click()),
      svc.handleSlackClick(click({ index: 1, actionTs: '1731600005.000002' })),
    ])
    expect(deliver).toHaveBeenCalledTimes(1)
    expect(updates(calls)).toHaveLength(1)
    expect(clickRows()).toHaveLength(1)
  })

  it('a redelivered click is delivered once', async () => {
    const { api } = fakeApi()
    await postButtons(api, true)
    await svc.handleSlackClick(click())
    await svc.handleSlackClick(click())
    await Promise.all([svc.handleSlackClick(click()), svc.handleSlackClick(click())])
    expect(deliver).toHaveBeenCalledTimes(1)
  })

  it('multiple: every click is delivered, buttons stay and eyes go on the bot message', async () => {
    const { api, calls } = fakeApi()
    await postButtons(api, true)
    await svc.handleSlackClick(click())
    await svc.handleSlackClick(click({ index: 1, actionTs: '1731600006.000001' }))
    expect(deliver.mock.calls.map((c) => String(c[1].content).split('\n')[1])).toEqual(['Clicked: Yes', 'Clicked: No'])
    // A2: the delivered first click is counted in the second header
    expect(String(deliver.mock.calls[1]![1].content)).toContain('| button | 2 earlier stored messages |')
    expect(updates(calls)).toEqual([])
    expect(reactions(calls, 'addReaction')).toEqual([
      ['C1', BOT_TS, 'eyes'],
      ['C1', BOT_TS, 'eyes'],
    ])
    expect(clickReactions(calls)).toEqual([])
  })

  it('a click by someone outside the allow-list makes no API call and stores nothing', async () => {
    const { api, calls } = fakeApi()
    await postButtons(api)
    calls.length = 0
    await svc.handleSlackClick(click({ user: 'U9' }))
    expect(calls).toEqual([])
    expect(clickRows()).toEqual([])
    expect(deliver).not.toHaveBeenCalled()
  })

  it('ignores a click on an unknown message, an unknown button or an unlinked channel', async () => {
    const { api, calls } = fakeApi()
    await postButtons(api)
    store.insertSlackMessage({
      channelId: 'C1',
      ts: '1731600001.000001',
      threadTs: '1731600001.000001',
      workspaceId: 'wsA',
      userId: 'UBOT',
      userName: 'kobo',
      text: 'plain',
      direction: 'out',
      state: 'sent',
      files: [],
    })
    calls.length = 0
    await svc.handleSlackClick(click({ messageTs: '1731699999.000001' }))
    await svc.handleSlackClick(click({ messageTs: '1731600001.000001' }))
    await svc.handleSlackClick(click({ index: 2 }))
    await svc.handleSlackClick(click({ channel: 'C2' }))
    await svc.linkSlackChannel('wsA', null)
    await svc.handleSlackClick(click())
    expect(deliver).not.toHaveBeenCalled()
    expect(calls.filter((c) => c.fn !== 'userName')).toEqual([])
    expect(clickRows()).toEqual([])
  })

  it('a click while the agent is busy is queued, answered at once, then delivered once by the next drain', async () => {
    const { api, calls } = fakeApi()
    await postButtons(api)
    deliver.mockRejectedValue(new Error('busy'))
    await svc.handleSlackClick(click())
    expect(clickRows().map((r) => r.state)).toEqual(['queued'])
    expect(updates(calls)).toEqual([['C1', BOT_TS, 'Pick one', 'Answered: Yes - alice']])
    deliver.mockReset()
    deliver.mockImplementation(async (_ws, msg, hooks) => {
      hooks?.beforeDispatch?.()
      hooks?.persist?.({ content: msg.content }, 's1')
      return {}
    })
    await svc.drainSlackQueue('wsA')
    await svc.drainSlackQueue('wsA')
    expect(deliver).toHaveBeenCalledTimes(1)
    expect(clickRows().map((r) => r.state)).toEqual(['delivered'])
    expect(updates(calls)).toHaveLength(1)
    expect(clickReactions(calls)).toEqual([])
  })

  it('queued clicks that expire, lose their author or are unlinked get no reaction', async () => {
    const { api, calls } = fakeApi()
    await postButtons(api, true)
    deliver.mockRejectedValue(new Error('busy'))
    await svc.handleSlackClick(click())
    await svc.handleSlackClick(click({ actionTs: '1731600006.000001' }))
    await svc.handleSlackClick(click({ actionTs: '1731600007.000001' }))
    expect(clickRows().map((r) => r.state)).toEqual(['queued', 'queued', 'queued'])
    getDb()
      .prepare("UPDATE slack_messages SET created_at = '2000-01-01T00:00:00.000Z' WHERE ts LIKE '1731600005%'")
      .run()
    await svc.runSlackTick()
    expect(posts(calls)).toContainEqual(['C1', TEXT.expired, BOT_TS])
    settings = makeGlobalSettings({ slackEnabled: true, slackAllowedUserIds: ['U2'] })
    await svc.drainSlackQueue('wsA')
    expect(clickRows().map((r) => r.state)).toEqual(['rejected', 'rejected', 'rejected'])
    expect(clickReactions(calls)).toEqual([])
    expect(reactions(calls, 'addReaction')).toEqual([])
  })

  it('an unlinked queued click gets the unlinked notice in its thread and no reaction', async () => {
    const { api, calls } = fakeApi()
    await postButtons(api)
    deliver.mockRejectedValue(new Error('busy'))
    await svc.handleSlackClick(click())
    await svc.linkSlackChannel('wsA', null)
    expect(posts(calls)).toContainEqual(['C1', TEXT.unlinkedQueued, BOT_TS])
    expect(clickReactions(calls)).toEqual([])
  })

  it('a click on an archived workspace is rejected with the archived notice and does not answer', async () => {
    const { api, calls } = fakeApi()
    await postButtons(api)
    getDb().prepare("UPDATE workspaces SET archived_at = 'now' WHERE id = 'wsA'").run()
    await svc.handleSlackClick(click())
    await svc.handleSlackClick(click())
    expect(clickRows().map((r) => r.state)).toEqual(['rejected'])
    expect(posts(calls).filter((p) => p[1] === TEXT.archived)).toEqual([['C1', TEXT.archived, BOT_TS]])
    expect(updates(calls)).toEqual([])
    expect(deliver).not.toHaveBeenCalled()
    expect(store.getSlackButtonMessage('C1', BOT_TS)?.answered).toBe(false)
  })

  it('a text reply after buttons still delivers and leaves the buttons', async () => {
    const { api, calls } = fakeApi()
    await postButtons(api)
    await svc.handleSlackEvent(mention({ ts: '1731600010.000001', thread_ts: BOT_TS, text: 'free text' }))
    expect(deliver).toHaveBeenCalledTimes(1)
    expect(String(deliver.mock.calls[0]![1].content)).not.toContain('| button |')
    expect(updates(calls)).toEqual([])
    await svc.handleSlackClick(click())
    expect(deliver).toHaveBeenCalledTimes(2)
  })

  it('neutralises channel pings in button labels', async () => {
    const { api, calls } = fakeApi()
    await postButtons(api, false, ['<!channel> go', '<!here|here>'])
    expect(posts(calls)[0]![3]).toEqual([{ label: 'channel go' }, { label: 'here' }])
    await svc.handleSlackClick(click())
    expect(String(deliver.mock.calls[0]![1].content).split('\n')[1]).toBe('Clicked: channel go')
  })
})

describe('slack service reconnect', () => {
  it('A1: a disconnect triggers one immediate reconnect, not a second within the tick, none after stop', async () => {
    let report!: (up: boolean) => void
    const { api, calls } = fakeApi({
      connect: async (_onEvent: never, onConnection: (up: boolean) => void) => {
        report = onConnection
        return { botUserId: 'UBOT', botName: 'kobo', teamName: 'acme' }
      },
    })
    const connects = () => calls.filter((c) => c.fn === 'connect').length
    await start(api)
    expect(connects()).toBe(1)
    report(false)
    await vi.waitFor(() => expect(svc.getSlackStatus().connected).toBe(true))
    expect(connects()).toBe(2)
    report(false)
    await new Promise((r) => setTimeout(r, 10))
    expect(connects()).toBe(2)
    expect(svc.getSlackStatus().connected).toBe(false)
    await svc.stopSlack()
    report(false)
    await new Promise((r) => setTimeout(r, 10))
    expect(connects()).toBe(2)
  })
})

describe('slack service polish', () => {
  const BOT_TS = '1731600000.000001'
  const click = { channel: 'C1', messageTs: BOT_TS, user: 'U1', actionTs: '1731600005.000001', index: 0 }

  it('P1: a slow answered-line update does not delay delivery, and stop still awaits it', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const { api } = fakeApi({ replaceButtons: () => gate })
    await start(api)
    await svc.postSlackFromAgent('wsA', 'Pick one', undefined, { buttons: [{ label: 'Yes' }], multiple: false })
    void svc.handleSlackClick(click)
    try {
      await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1))
    } catch (err) {
      release()
      throw err
    }
    let stopped = false
    const stopping = svc.stopSlack().then(() => {
      stopped = true
    })
    await new Promise((r) => setTimeout(r, 20))
    expect(stopped).toBe(false)
    release()
    await stopping
    expect(stopped).toBe(true)
  })
})
