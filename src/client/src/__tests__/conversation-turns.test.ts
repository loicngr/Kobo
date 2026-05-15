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
