import type { AgentEvent } from '../types/agent-event'

export type ConversationItem =
  | { type: 'text'; messageId: string; text: string; streaming: boolean; ts?: string; eventIds?: string[] }
  | { type: 'thinking'; messageId: string; text: string; ts?: string; eventIds?: string[] }
  | {
      type: 'tool'
      toolCallId: string
      name: string
      input: unknown
      result?: { output: unknown; isError: boolean }
      ts?: string
      eventIds?: string[]
    }
  | { type: 'session'; kind: 'started' | 'ended' | 'compacted'; detail?: unknown; ts?: string; eventIds?: string[] }
  | { type: 'user'; content: string; sender: 'user' | 'system-prompt' | string; ts?: string; eventIds?: string[] }
  | { type: 'error'; category: string; message: string; ts?: string; eventIds?: string[] }

/**
 * Informational "Warning:" lines the Claude CLI writes to stderr; the legacy
 * pipeline persisted them as error events. Real engine failures never start
 * that way. Shared with AgentErrorBanner so the banner and the feed can never
 * disagree on what counts as an error.
 */
export function isBenignAgentWarning(message: string): boolean {
  // Strip ANSI escape sequences like "\u001b[33m" before matching "Warning:".
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes by design
  const cleaned = message.replace(/\u001b\[\d+m/g, '').trim()
  return /^warning:/i.test(cleaned)
}

/**
 * Pick the error the banner should show: the most recent one that isn't
 * `quota` (own surface), isn't a benign CLI warning, and hasn't been
 * acknowledged (dismissed) yet. `dismissedEventIds` is client-local and
 * intentionally never persisted — see AgentErrorBanner.vue's `dismiss()` for
 * why acknowledging must not delete the underlying event anymore: the feed
 * now anchors the same event in the conversation timeline (task 9), so a
 * destructive dismiss would erase that anchor too.
 */
export function selectLastAgentError(
  events: AgentEvent[],
  eventIds: Array<string | null | undefined>,
  dismissedEventIds: ReadonlySet<string>,
): { event: Extract<AgentEvent, { kind: 'error' }>; eventId: string | null } | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]
    if (ev.kind !== 'error' || ev.category === 'quota') continue
    if (ev.category === 'other' && isBenignAgentWarning(ev.message)) continue
    const eventId = eventIds[i] ?? null
    if (eventId && dismissedEventIds.has(eventId)) continue
    return { event: ev, eventId }
  }
  return null
}

/**
 * i18n key for a `session:ended` item. The reason has always been captured in
 * `detail` but was never read at render time, so a turn that finished normally
 * and a force-closed stream looked identical — the whole "it stops on its own"
 * symptom.
 */
export function sessionEndedI18nKey(detail: unknown): string {
  const reason = (detail as { reason?: unknown } | null | undefined)?.reason
  switch (reason) {
    case 'completed':
      return 'session.endedCompleted'
    case 'killed':
      return 'session.endedKilled'
    case 'error':
      return 'session.endedError'
    case 'watchdog':
      return 'session.endedWatchdog'
    default:
      return 'session.ended'
  }
}

/**
 * Whether a `session:ended` item's reason is a normal completion. Used to
 * gate the item behind the verbose-system-messages toggle: a normal
 * completion happens after every turn and is expected noise now that the
 * `AgentLivenessChip` shows whether the agent is still running and a failure
 * gets its own dedicated `error` feed item — but an abnormal reason (killed,
 * error, watchdog) or an absent/unknown one must stay visible unconditionally,
 * since not knowing why a session ended is not the same as knowing it ended
 * normally.
 */
export function isNormalSessionEnd(detail: unknown): boolean {
  return (detail as { reason?: unknown } | null | undefined)?.reason === 'completed'
}

/** Return the newest usable thinking item from a normalised conversation. */
export function getLatestThinkingItem(
  items: ConversationItem[],
): Extract<ConversationItem, { type: 'thinking' }> | null {
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index]
    if (item?.type === 'thinking' && item.text.trim().length > 0) return item
  }
  return null
}

/**
 * Fold a flat AgentEvent stream into ConversationItems.
 * `timestamps` is an optional parallel array (same length as `events`) that
 * carries the ISO creation time of each event; when supplied, each produced
 * item receives the timestamp of its first contributing event.
 * `sessionActive` (default true) tells the reducer whether the conversation
 * is still running — when false, the last text message is force-closed so
 * the UI never shows a lingering spinner on a finished turn.
 */
export function foldEvents(
  events: AgentEvent[],
  timestamps?: string[],
  sessionActive = true,
  eventIds?: Array<string | null>,
): ConversationItem[] {
  const items: ConversationItem[] = []
  const textItems = new Map<
    string,
    { type: 'text'; messageId: string; text: string; streaming: boolean; ts?: string; eventIds?: string[] }
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
      eventIds?: string[]
    }
  >()

  for (let i = 0; i < events.length; i++) {
    const ev = events[i]
    const ts = timestamps?.[i]
    const eventId = eventIds?.[i] ?? undefined
    switch (ev.kind) {
      case 'message:text': {
        const existing = textItems.get(ev.messageId)
        if (existing) {
          existing.text += ev.text
          existing.streaming = ev.streaming
          if (eventId) existing.eventIds?.push(eventId)
        } else {
          const item = {
            type: 'text' as const,
            messageId: ev.messageId,
            text: ev.text,
            streaming: ev.streaming,
            ts,
            eventIds: eventId ? [eventId] : undefined,
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
        items.push({
          type: 'thinking',
          messageId: ev.messageId,
          text: ev.text,
          ts,
          eventIds: eventId ? [eventId] : undefined,
        })
        break
      }
      case 'tool:call': {
        const item = {
          type: 'tool' as const,
          toolCallId: ev.toolCallId,
          name: ev.name,
          input: ev.input,
          ts,
          eventIds: eventId ? [eventId] : undefined,
        }
        toolItems.set(ev.toolCallId, item)
        items.push(item)
        break
      }
      case 'tool:result': {
        const existing = toolItems.get(ev.toolCallId)
        if (existing) {
          existing.result = { output: ev.output, isError: ev.isError }
          if (eventId) existing.eventIds?.push(eventId)
        }
        break
      }
      case 'session:started':
        items.push({
          type: 'session',
          kind: 'started',
          detail: { engineSessionId: ev.engineSessionId, model: ev.model },
          ts,
          eventIds: eventId ? [eventId] : undefined,
        })
        break
      case 'session:ended':
        items.push({
          type: 'session',
          kind: 'ended',
          detail: { reason: ev.reason, exitCode: ev.exitCode },
          ts,
          eventIds: eventId ? [eventId] : undefined,
        })
        break
      case 'session:compacted':
        items.push({ type: 'session', kind: 'compacted', ts, eventIds: eventId ? [eventId] : undefined })
        break
      // An agent error belongs in the timeline: the banner shows only the LAST
      // one, outside the feed, and it can be dismissed for good — so a failed
      // engine start left no trace of WHEN it happened. Quota keeps its own
      // surface (banner + workspace status) and informational CLI warnings
      // are not failures.
      case 'error': {
        if (ev.category === 'quota') break
        if (ev.category === 'other' && isBenignAgentWarning(ev.message)) break
        items.push({
          type: 'error',
          category: ev.category,
          message: ev.message,
          ts,
          eventIds: eventId ? [eventId] : undefined,
        })
        break
      }

      // Ignored categories — consumed by dedicated panels (session:compacting
      // is an ephemeral live indicator handled by the agent-stream store, never
      // a persisted feed item).
      case 'session:compacting':
      case 'turn:completed':
      case 'session:brainstorm-complete':
      case 'session:user-input-requested':
      case 'mcp:status':
      case 'message:raw':
      case 'skills:discovered':
      case 'usage':
      case 'rate_limit':
      case 'subagent:progress':
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
  eventIds?: string[]
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
    eventIds: m.eventIds,
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

  // Close any text item still marked `streaming` that predates the most
  // recent user message. The user taking another turn is a hard signal
  // that the previous assistant response is done — its `message:end` may
  // be missing from the stream (CLI hard-stop, resume boundary, old
  // sessions) but logically it cannot still be typing.
  let latestUserTs: string | undefined
  for (const it of merged) {
    if (it.type === 'user' && it.sender !== 'system-prompt' && it.ts) {
      if (!latestUserTs || it.ts > latestUserTs) latestUserTs = it.ts
    }
  }
  if (latestUserTs) {
    for (const it of merged) {
      if (it.type === 'text' && it.streaming && (!it.ts || it.ts < latestUserTs)) {
        it.streaming = false
      }
    }
  }

  return merged
}
