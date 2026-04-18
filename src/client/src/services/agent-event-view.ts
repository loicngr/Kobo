import type { AgentEvent } from '../types/agent-event'

export type ConversationItem =
  | { type: 'text'; messageId: string; text: string; streaming: boolean; ts?: string }
  | { type: 'thinking'; messageId: string; text: string; ts?: string }
  | {
      type: 'tool'
      toolCallId: string
      name: string
      input: unknown
      result?: { output: unknown; isError: boolean }
      ts?: string
    }
  | { type: 'session'; kind: 'started' | 'ended' | 'compacted'; detail?: unknown; ts?: string }
  | { type: 'user'; content: string; sender: 'user' | 'system-prompt' | string; ts?: string }

/**
 * Fold a flat AgentEvent stream into ConversationItems.
 * `timestamps` is an optional parallel array (same length as `events`) that
 * carries the ISO creation time of each event; when supplied, each produced
 * item receives the timestamp of its first contributing event.
 * `sessionActive` (default true) tells the reducer whether the conversation
 * is still running — when false, the last text message is force-closed so
 * the UI never shows a lingering spinner on a finished turn.
 */
export function foldEvents(events: AgentEvent[], timestamps?: string[], sessionActive = true): ConversationItem[] {
  const items: ConversationItem[] = []
  const textItems = new Map<
    string,
    { type: 'text'; messageId: string; text: string; streaming: boolean; ts?: string }
  >()
  const toolItems = new Map<
    string,
    {
      type: 'tool'
      toolCallId: string
      name: string
      input: unknown
      result?: { output: unknown; isError: boolean }
      ts?: string
    }
  >()

  for (let i = 0; i < events.length; i++) {
    const ev = events[i]
    const ts = timestamps?.[i]
    switch (ev.kind) {
      case 'message:text': {
        const existing = textItems.get(ev.messageId)
        if (existing) {
          existing.text += ev.text
          existing.streaming = ev.streaming
        } else {
          const item = {
            type: 'text' as const,
            messageId: ev.messageId,
            text: ev.text,
            streaming: ev.streaming,
            ts,
          }
          textItems.set(ev.messageId, item)
          items.push(item)
        }
        break
      }
      case 'message:end': {
        const existing = textItems.get(ev.messageId)
        if (existing) existing.streaming = false
        break
      }
      case 'message:thinking': {
        items.push({ type: 'thinking', messageId: ev.messageId, text: ev.text, ts })
        break
      }
      case 'tool:call': {
        const item = {
          type: 'tool' as const,
          toolCallId: ev.toolCallId,
          name: ev.name,
          input: ev.input,
          ts,
        }
        toolItems.set(ev.toolCallId, item)
        items.push(item)
        break
      }
      case 'tool:result': {
        const existing = toolItems.get(ev.toolCallId)
        if (existing) {
          existing.result = { output: ev.output, isError: ev.isError }
        }
        break
      }
      case 'session:started':
        items.push({
          type: 'session',
          kind: 'started',
          detail: { engineSessionId: ev.engineSessionId, model: ev.model },
          ts,
        })
        break
      case 'session:ended':
        items.push({
          type: 'session',
          kind: 'ended',
          detail: { reason: ev.reason, exitCode: ev.exitCode },
          ts,
        })
        break
      case 'session:compacted':
        items.push({ type: 'session', kind: 'compacted', ts })
        break
      // Ignored categories — consumed by dedicated panels
      case 'session:brainstorm-complete':
      case 'message:raw':
      case 'skills:discovered':
      case 'usage':
      case 'rate_limit':
      case 'subagent:progress':
      case 'error':
        break
      default: {
        // Exhaustiveness check — a new AgentEvent kind added upstream must be
        // handled here or the type system will flag this line.
        const _exhaustive: never = ev
        void _exhaustive
      }
    }
  }

  // Historical streams sometimes lack a proper `message:end` for messages
  // that finished before this code existed. If a text item isn't the last
  // text item in the sequence, its stream has effectively ended — close
  // it so the UI doesn't render a perpetual spinner. The very last text
  // item stays `streaming` only when the session is actually active
  // (the agent is currently typing). Otherwise it's also closed.
  let lastStreamingText: { streaming: boolean } | null = null
  for (const it of items) {
    if (it.type === 'text' && it.streaming) {
      if (lastStreamingText) lastStreamingText.streaming = false
      lastStreamingText = it
    }
  }
  if (lastStreamingText && !sessionActive) {
    lastStreamingText.streaming = false
  }

  return items
}

export interface UserMessage {
  content: string
  sender: string
  ts: string
}

/**
 * Merge fold()'ed agent items with the user-side messages, keeping
 * chronological order by timestamp. User messages without a timestamp sink
 * to the end (should not happen in practice).
 */
export function mergeWithUserMessages(agentItems: ConversationItem[], userMessages: UserMessage[]): ConversationItem[] {
  if (userMessages.length === 0) return agentItems
  const userItems: ConversationItem[] = userMessages.map((m) => ({
    type: 'user' as const,
    content: m.content,
    sender: m.sender,
    ts: m.ts,
  }))
  const merged = [...agentItems, ...userItems]
  merged.sort((a, b) => {
    const ta = a.ts ?? ''
    const tb = b.ts ?? ''
    if (ta === tb) return 0
    if (!ta) return 1
    if (!tb) return -1
    return ta < tb ? -1 : 1
  })
  return merged
}
