import type { ConversationItem } from './agent-event-view'

/**
 * A conversation turn groups consecutive items from the same speaker so the
 * UI can render them as a single card (user turn, agent turn, or system
 * event). Tool calls and thinking blocks that belong to an agent turn are
 * nested inside it. System events (session:started, etc.) and the initial
 * system prompt become their own standalone turns.
 */
export type TurnSpeaker = 'user' | 'agent' | 'system-prompt' | 'session'

export interface Turn {
  speaker: TurnSpeaker
  ts?: string
  items: ConversationItem[]
}

function speakerOf(item: ConversationItem): TurnSpeaker {
  switch (item.type) {
    case 'user':
      return item.sender === 'system-prompt' ? 'system-prompt' : 'user'
    case 'session':
      return 'session'
    default:
      return 'agent'
  }
}

/**
 * Group a flat list of ConversationItems into Turns by consecutive speaker.
 * Each turn carries the timestamp of its first item. `session` and
 * `system-prompt` turns always contain exactly one item (they don't merge).
 */
export function groupIntoTurns(items: ConversationItem[]): Turn[] {
  const turns: Turn[] = []
  let current: Turn | null = null

  for (const item of items) {
    const speaker = speakerOf(item)
    // Session + system-prompt items are standalone: each gets its own turn.
    const standalone = speaker === 'session' || speaker === 'system-prompt'

    if (!current || current.speaker !== speaker || standalone) {
      current = { speaker, ts: item.ts, items: [item] }
      turns.push(current)
      if (standalone) current = null // force a fresh turn for the next item
    } else {
      current.items.push(item)
    }
  }

  return turns
}
