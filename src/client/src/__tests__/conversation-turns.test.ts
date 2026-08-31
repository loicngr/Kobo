import { describe, expect, it } from 'vitest'
import type { ConversationItem } from '../services/agent-event-view'
import { groupIntoTurns } from '../services/conversation-turns'

function user(content: string, sender = 'user'): ConversationItem {
  return { type: 'user', content, sender }
}

function agentText(text: string): ConversationItem {
  return { type: 'text', messageId: text, text, streaming: false }
}

describe('groupIntoTurns', () => {
  it('groups consecutive same-speaker items into one turn', () => {
    const turns = groupIntoTurns([user('hi'), user('there'), agentText('hello')])
    expect(turns.map((t) => t.speaker)).toEqual(['user', 'agent'])
    expect(turns[0].items).toHaveLength(2)
  })

  it('preserves the source order of agent items', () => {
    const thinking: ConversationItem = { type: 'thinking', messageId: 'thought', text: 'analyse' }
    const tool: ConversationItem = { type: 'tool', toolCallId: 'write', name: 'Write', input: {} }
    const turn = groupIntoTurns([thinking, agentText('réponse'), tool])[0]

    expect(turn.items.map((item) => item.type)).toEqual(['thinking', 'text', 'tool'])
  })

  it('routes lifecycle-script items to a dedicated `script` turn', () => {
    expect(groupIntoTurns([user('log', 'cleanup')])[0].speaker).toBe('script')
    expect(groupIntoTurns([user('log', 'archive')])[0].speaker).toBe('script')
    expect(groupIntoTurns([user('log', 'setup')])[0].speaker).toBe('script')
  })

  it('never merges script items into the user turn (regression: flat-feed mixing)', () => {
    const turns = groupIntoTurns([
      user('tu es en quel mode ?'),
      user('Lance: commande introuvable', 'cleanup'),
      user('[cleanup] Error: exited 127', 'cleanup'),
      user("c'est bon"),
    ])

    expect(turns.map((t) => t.speaker)).toEqual(['user', 'script', 'user'])
    // The two cleanup lines stay together in the single script turn.
    expect(turns[1].items).toHaveLength(2)
  })

  it('does not merge different scripts into one turn (regression: cleanup + archive)', () => {
    const turns = groupIntoTurns([user('[cleanup] Complete', 'cleanup'), user('[archive] Complete', 'archive')])

    // Both are speaker 'script' but distinct senders → two separate cards.
    expect(turns).toHaveLength(2)
    expect(turns.every((t) => t.speaker === 'script')).toBe(true)
    expect((turns[0].items[0] as { sender: string }).sender).toBe('cleanup')
    expect((turns[1].items[0] as { sender: string }).sender).toBe('archive')
  })

  it('keeps merging consecutive items from the same script', () => {
    const turns = groupIntoTurns([user('line 1', 'cleanup'), user('[cleanup] Complete', 'cleanup')])
    expect(turns).toHaveLength(1)
    expect(turns[0].items).toHaveLength(2)
  })

  it('keeps the system-prompt sender on its own standalone turn', () => {
    const turns = groupIntoTurns([user('prompt', 'system-prompt'), user('hi')])
    expect(turns.map((t) => t.speaker)).toEqual(['system-prompt', 'user'])
  })
})

describe('itemKey / turnKey', () => {
  it('keys a text message by its message id, not by its position', async () => {
    const { itemKey } = await import('../services/conversation-turns')
    const item = { type: 'text' as const, messageId: 'm-42', text: 'hi', streaming: false }
    expect(itemKey(item)).toBe('text:m-42')
  })

  it('keys a tool call by its tool-call id', async () => {
    const { itemKey } = await import('../services/conversation-turns')
    const a = { type: 'tool' as const, toolCallId: 'tc-1', name: 'Bash', input: {} }
    const b = { type: 'tool' as const, toolCallId: 'tc-2', name: 'Bash', input: {} }
    expect(itemKey(a)).not.toBe(itemKey(b))
  })

  it('gives a turn the same key before and after older history is prepended', async () => {
    const { groupIntoTurns, turnKey } = await import('../services/conversation-turns')
    const recent = { type: 'text' as const, messageId: 'm-recent', text: 'now', streaming: false }
    // A different speaker than `recent` so groupIntoTurns doesn't merge them
    // into a single turn — the point here is a *turn* shifting position, not
    // an item merging with its neighbor.
    const older = { type: 'user' as const, content: 'before', sender: 'user', eventIds: ['u-older'] }

    const before = groupIntoTurns([recent])
    const after = groupIntoTurns([older, recent])

    // The recent turn moved from index 0 to index 1 — an index key would have
    // made Vue rebuild it (and hand its children's local state to the wrong
    // item). Its data identity, and therefore its key, is unchanged.
    expect(turnKey(before[0])).toBe(turnKey(after[1]))
    expect(turnKey(after[0])).not.toBe(turnKey(after[1]))
  })

  it('never collides between a user message and an agent message', async () => {
    const { itemKey } = await import('../services/conversation-turns')
    const user = { type: 'user' as const, content: 'x', sender: 'user', ts: '2026-01-01T00:00:00Z' }
    const agent = { type: 'text' as const, messageId: '2026-01-01T00:00:00Z', text: 'x', streaming: false }
    expect(itemKey(user)).not.toBe(itemKey(agent))
  })

  it('distinguishes two thinking blocks that share a message id', async () => {
    const { itemKey } = await import('../services/conversation-turns')
    const a = { type: 'thinking' as const, messageId: 'm-1', text: 'a', eventIds: ['evt-1'] }
    const b = { type: 'thinking' as const, messageId: 'm-1', text: 'b', eventIds: ['evt-2'] }
    expect(itemKey(a)).not.toBe(itemKey(b))
  })

  it('produces unique keys across a whole grouped conversation', async () => {
    const { groupIntoTurns, turnKey } = await import('../services/conversation-turns')
    const turns = groupIntoTurns([
      { type: 'user', content: 'go', sender: 'user', ts: '2026-01-01T00:00:00Z', eventIds: ['u-1'] },
      { type: 'text', messageId: 'm-1', text: 'ok', streaming: false, ts: '2026-01-01T00:00:01Z' },
      { type: 'tool', toolCallId: 'tc-1', name: 'Bash', input: {}, ts: '2026-01-01T00:00:02Z' },
      { type: 'user', content: 'again', sender: 'user', ts: '2026-01-01T00:00:03Z', eventIds: ['u-2'] },
      { type: 'text', messageId: 'm-2', text: 'done', streaming: false, ts: '2026-01-01T00:00:04Z' },
    ])
    const keys = turns.map(turnKey)
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe('findPreviousUserTurnIndex', () => {
  const turns = [
    { speaker: 'user' },
    { speaker: 'agent' },
    { speaker: 'agent' },
    { speaker: 'user' },
    { speaker: 'agent' },
  ]

  it('finds the last user turn strictly before the current position', async () => {
    const { findPreviousUserTurnIndex } = await import('../services/conversation-turns')
    expect(findPreviousUserTurnIndex(turns, 4)).toBe(3)
    expect(findPreviousUserTurnIndex(turns, 3)).toBe(0)
    expect(findPreviousUserTurnIndex(turns, 2)).toBe(0)
  })

  it('returns -1 when no user turn precedes the position', async () => {
    const { findPreviousUserTurnIndex } = await import('../services/conversation-turns')
    expect(findPreviousUserTurnIndex(turns, 0)).toBe(-1)
    expect(findPreviousUserTurnIndex([{ speaker: 'agent' }], 1)).toBe(-1)
  })

  it('handles an empty list and an out-of-range position', async () => {
    const { findPreviousUserTurnIndex } = await import('../services/conversation-turns')
    expect(findPreviousUserTurnIndex([], 0)).toBe(-1)
    expect(findPreviousUserTurnIndex(turns, 999)).toBe(3)
    expect(findPreviousUserTurnIndex(turns, -1)).toBe(-1)
  })

  it('ignores script and session turns', async () => {
    const { findPreviousUserTurnIndex } = await import('../services/conversation-turns')
    const mixed = [{ speaker: 'user' }, { speaker: 'script' }, { speaker: 'session' }, { speaker: 'agent' }]
    expect(findPreviousUserTurnIndex(mixed, 3)).toBe(0)
  })
})
