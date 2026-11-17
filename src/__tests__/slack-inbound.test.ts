import { describe, expect, it } from 'vitest'
import { classifyInbound, type InboundContext, type InboundEvent } from '../server/services/slack/slack-inbound.js'

const BOT = 'UBOT'
const mention = `<@${BOT}>`
const UNSUPPORTED = { action: 'ignore', reason: 'unsupported-message' }
const SILENT = { action: 'ignore' }

function ctx(over: Partial<InboundContext> = {}): InboundContext {
  return { botUserId: BOT, allowedUserIds: ['U1'], workspaceId: 'ws1', isTrackedThread: () => false, ...over }
}
function ev(over: Partial<InboundEvent> = {}): InboundEvent {
  return { type: 'message', channel: 'C1', ts: '10.1', user: 'U1', text: `${mention} hello`, ...over }
}

describe('classifyInbound', () => {
  it('ignores own, bot and filtered subtypes', () => {
    expect(classifyInbound(ev({ user: BOT }), ctx())).toEqual(SILENT)
    expect(classifyInbound(ev({ bot_id: 'B1' }), ctx())).toEqual(SILENT)
    expect(classifyInbound(ev({ user: undefined }), ctx())).toEqual(SILENT)
    for (const subtype of ['message_changed', 'message_deleted', 'channel_join']) {
      expect(classifyInbound(ev({ subtype }), ctx())).toEqual(SILENT)
    }
  })

  it('ignores any subtype outside the allow-list', () => {
    for (const subtype of ['me_message', 'channel_topic', 'pinned_item']) {
      expect(classifyInbound(ev({ subtype }), ctx())).toEqual(SILENT)
    }
  })

  it('detects and strips the labelled mention form', () => {
    expect(classifyInbound(ev({ text: `<@${BOT}|kobo> hello` }), ctx())).toEqual({
      action: 'deliver',
      threadTs: '10.1',
      text: 'hello',
      fetchContext: false,
    })
  })

  it('processes file_share and thread_broadcast', () => {
    for (const subtype of ['file_share', 'thread_broadcast']) {
      expect(classifyInbound(ev({ subtype }), ctx()).action).toBe('deliver')
    }
  })

  it('ignores authors outside the allow-list, even with a mention', () => {
    expect(classifyInbound(ev({ user: 'U9' }), ctx())).toEqual({ action: 'ignore', reason: 'not-allowed' })
    expect(classifyInbound(ev(), ctx({ allowedUserIds: [] }))).toEqual({ action: 'ignore', reason: 'not-allowed' })
  })

  it('ignores no mention in an untracked thread', () => {
    expect(classifyInbound(ev({ text: 'hello' }), ctx())).toEqual(SILENT)
    // Unaddressed chatter from outside the allow-list carries no reason either.
    expect(classifyInbound(ev({ user: 'U9', text: 'hello' }), ctx())).toEqual(SILENT)
    expect(
      classifyInbound(ev({ user: 'U9', text: 'hi', thread_ts: '5.0' }), ctx({ isTrackedThread: () => true })),
    ).toEqual({ action: 'ignore', reason: 'not-allowed' })
  })

  it('notifies when mentioned and unlinked', () => {
    expect(classifyInbound(ev(), ctx({ workspaceId: undefined }))).toEqual({
      action: 'notify-unlinked',
      threadTs: '10.1',
    })
  })

  it('ignores tracked thread without mention when unlinked', () => {
    const d = classifyInbound(
      ev({ text: 'hi', thread_ts: '5.0' }),
      ctx({ workspaceId: undefined, isTrackedThread: () => true }),
    )
    expect(d).toEqual({ action: 'ignore', reason: 'channel-not-linked' })
  })

  it('delivers a channel-level mention with the mention stripped', () => {
    expect(classifyInbound(ev(), ctx())).toEqual({
      action: 'deliver',
      threadTs: '10.1',
      text: 'hello',
      fetchContext: false,
    })
  })

  it('fetches context for a mention inside an untracked thread', () => {
    expect(classifyInbound(ev({ thread_ts: '5.0' }), ctx())).toEqual({
      action: 'deliver',
      threadTs: '5.0',
      text: 'hello',
      fetchContext: true,
    })
  })

  it('delivers an unmentioned message in a tracked thread', () => {
    expect(classifyInbound(ev({ text: 'more', thread_ts: '5.0' }), ctx({ isTrackedThread: () => true }))).toEqual({
      action: 'deliver',
      threadTs: '5.0',
      text: 'more',
      fetchContext: false,
    })
  })

  it('ignores a bare mention, delivers it with a file', () => {
    expect(classifyInbound(ev({ text: mention }), ctx())).toEqual(UNSUPPORTED)
    const file = { id: 'F1', name: 'a.txt', mimetype: 'text/plain', size: 1, url: 'u' }
    expect(classifyInbound(ev({ text: mention, files: [file] }), ctx())).toEqual({
      action: 'deliver',
      threadTs: '10.1',
      text: '',
      fetchContext: false,
    })
  })
})

describe('classifyInbound leading separators', () => {
  const text = (t: string, over: Partial<InboundContext> = {}, e: Partial<InboundEvent> = {}) =>
    (classifyInbound(ev({ text: t, ...e }), ctx(over)) as { text: string }).text

  it('P4: strips separators left behind by a leading mention', () => {
    expect(text(`${mention} : hello`)).toBe('hello')
    expect(text(`${mention}, hello`)).toBe('hello')
    expect(text(`${mention} ;: hello`)).toBe('hello')
  })

  it('P4: leaves interior and unmentioned text untouched', () => {
    expect(text(`hello ${mention} : there`)).toBe('hello  : there')
    expect(text(': hello', { isTrackedThread: () => true }, { thread_ts: '5.0' })).toBe(': hello')
  })
})
