import type { ConversationItem } from './agent-event-view'

/**
 * A conversation turn groups consecutive items from the same speaker so the
 * UI can render them as a single card (user turn, agent turn, or system
 * event). Tool calls and thinking blocks that belong to an agent turn are
 * nested inside it. System events (session:started, etc.) and the initial
 * system prompt become their own standalone turns.
 */
export type TurnSpeaker = 'user' | 'agent' | 'system-prompt' | 'session' | 'script'

export interface Turn {
  speaker: TurnSpeaker
  ts?: string
  items: ConversationItem[]
}

/**
 * Activity-feed `sender` values produced by lifecycle scripts (setup / cleanup
 * / archive). They render in their own `script` turn card — never merged into
 * the user's real messages.
 */
const SCRIPT_SENDERS = new Set(['setup', 'cleanup', 'archive'])

function speakerOf(item: ConversationItem): TurnSpeaker {
  switch (item.type) {
    case 'user':
      if (item.sender === 'system-prompt') return 'system-prompt'
      if (SCRIPT_SENDERS.has(item.sender)) return 'script'
      return 'user'
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
  let currentKey: string | null = null

  for (const item of items) {
    const speaker = speakerOf(item)
    // Session + system-prompt items are standalone: each gets its own turn.
    const standalone = speaker === 'session' || speaker === 'system-prompt'
    // Script turns are keyed by their sender so a cleanup run and an archive
    // run (both speaker 'script') never merge into a single mislabelled card.
    const key = speaker === 'script' && item.type === 'user' ? `script:${item.sender}` : speaker

    if (!current || currentKey !== key || standalone) {
      current = { speaker, ts: item.ts, items: [item] }
      currentKey = key
      turns.push(current)
      if (standalone) current = null // force a fresh turn for the next item
    } else {
      current.items.push(item)
    }
  }

  return turns
}

/**
 * Stable identity for a single conversation item, usable as a Vue list key.
 *
 * Index keys break as soon as older history is prepended on scroll-up: every
 * index shifts, so Vue rebuilds each card instead of moving it — and the local
 * state of the children (a tool card's `expanded` flag) follows the index, not
 * the data. Concretely, an expanded tool call ends up expanded on a different
 * tool. The prefix per type guarantees no cross-type collision.
 */
export function itemKey(item: ConversationItem): string {
  switch (item.type) {
    case 'text':
      return `text:${item.messageId}`
    case 'thinking':
      // A message id can carry several thinking blocks, so the event id (or,
      // failing that, the timestamp) disambiguates them.
      return `thinking:${item.messageId}:${item.eventIds?.[0] ?? item.ts ?? ''}`
    case 'tool':
      return `tool:${item.toolCallId}`
    case 'session':
      return `session:${item.kind}:${item.eventIds?.[0] ?? item.ts ?? ''}`
    case 'user':
      return `user:${item.eventIds?.[0] ?? `${item.sender}:${item.ts ?? ''}`}`
    case 'error':
      return `error:${item.eventIds?.[0] ?? `${item.category}:${item.ts ?? ''}`}`
  }
}

/**
 * Stable identity for a turn card. A turn always holds at least one item
 * (groupIntoTurns never creates an empty one), and the first item of a turn is
 * unique across the conversation, so it identifies the turn.
 */
export function turnKey(turn: Turn): string {
  const first = turn.items[0]
  return `${turn.speaker}:${first ? itemKey(first) : 'empty'}`
}

/**
 * Index of the last `user` turn strictly before `fromIndex`, or -1.
 *
 * Replaces the DOM walk that measured every rendered user card's bounding
 * rectangle: with a virtualised feed most cards are not in the DOM at all, and
 * an index is both cheaper and exact.
 */
export function findPreviousUserTurnIndex(turns: readonly { speaker: string }[], fromIndex: number): number {
  const start = Math.min(fromIndex, turns.length) - 1
  for (let i = start; i >= 0; i--) {
    if (turns[i]?.speaker === 'user') return i
  }
  return -1
}
