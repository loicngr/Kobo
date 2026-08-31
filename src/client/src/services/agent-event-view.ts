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

type TextItem = Extract<ConversationItem, { type: 'text' }>
type ToolItem = Extract<ConversationItem, { type: 'tool' }>

/**
 * A cached item plus the index it occupies in `items`. The index is what makes
 * copy-on-write possible: updating an item means publishing a NEW object at the
 * same slot, and the slot has to be known without scanning the list.
 */
interface Slot<T extends ConversationItem> {
  item: T
  index: number
}

/**
 * Resumable state of a fold. `count` is how many events have been consumed and
 * `lastEvent` is the object that sat at `count - 1`: together they detect a
 * pure append by reference, which is the only case worth optimising and the
 * only one that is safe to resume.
 */
export interface FoldCache {
  count: number
  lastEvent: AgentEvent | null
  items: ConversationItem[]
  textItems: Map<string, Slot<TextItem>>
  toolItems: Map<string, Slot<ToolItem>>
}

export function createFoldCache(): FoldCache {
  return { count: 0, lastEvent: null, items: [], textItems: new Map(), toolItems: new Map() }
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
  return foldEventsCached(createFoldCache(), events, timestamps, sessionActive, eventIds)
}

/**
 * Fold an AgentEvent stream into ConversationItems, resuming from `cache`.
 *
 * The feed used to re-fold the entire history on every token: forty messages
 * reallocated a hundred and fifty times for one agent reply. Because a pure
 * append leaves every already-folded event at the same index, the cache can
 * consume only the tail — and, just as importantly, it REUSES the item objects,
 * so a frozen message keeps its identity and the markdown memo keeps hitting.
 *
 * Reuse is strictly *copy-on-write*: an UNCHANGED item keeps its reference, a
 * CHANGED one is replaced by a fresh object. Mutating in place would have kept
 * the reference stable across a real content change, and the feed passes these
 * items straight to child components under a stable key — Vue skips the patch
 * when a prop is reference-equal, so an in-place mutation froze the card for
 * good (invisible deltas, spinner that never stops, missing tool result).
 */
export function foldEventsCached(
  cache: FoldCache,
  events: AgentEvent[],
  timestamps?: string[],
  sessionActive = true,
  eventIds?: Array<string | null>,
): ConversationItem[] {
  const isAppend = cache.count > 0 && events.length >= cache.count && events[cache.count - 1] === cache.lastEvent
  if (!isAppend) {
    // Prepended history, a session switch, a sync:response reset — anything
    // that is not a pure append invalidates the resumable state.
    cache.count = 0
    cache.lastEvent = null
    cache.items = []
    cache.textItems = new Map()
    cache.toolItems = new Map()
  }

  foldRange(cache, events, timestamps, eventIds, cache.count, events.length)
  cache.count = events.length
  cache.lastEvent = events.length > 0 ? events[events.length - 1] : null
  closeStaleStreamingText(cache, sessionActive)
  return cache.items
}

/**
 * Publish `next` at the slot's index and re-point the slot at it. Never mutate
 * the previous object: a component already rendering it must see a brand-new
 * reference to notice the change.
 */
function replaceSlot<T extends ConversationItem>(items: ConversationItem[], slot: Slot<T>, next: T): void {
  items[slot.index] = next
  slot.item = next
}

/** Append an event id without mutating the previous array (it is shared). */
function appendEventId(current: string[] | undefined, eventId: string | undefined): string[] | undefined {
  if (!eventId || !current) return current
  return [...current, eventId]
}

/** Consume `events[from … to)` into the cache. */
function foldRange(
  cache: FoldCache,
  events: AgentEvent[],
  timestamps: string[] | undefined,
  eventIds: Array<string | null> | undefined,
  from: number,
  to: number,
): void {
  const { items, textItems, toolItems } = cache
  for (let i = from; i < to; i++) {
    const ev = events[i]
    const ts = timestamps?.[i]
    const eventId = eventIds?.[i] ?? undefined
    switch (ev.kind) {
      case 'message:text': {
        const existing = textItems.get(ev.messageId)
        if (existing) {
          replaceSlot(items, existing, {
            ...existing.item,
            text: existing.item.text + ev.text,
            streaming: ev.streaming,
            eventIds: appendEventId(existing.item.eventIds, eventId),
          })
        } else {
          const item: TextItem = {
            type: 'text',
            messageId: ev.messageId,
            text: ev.text,
            streaming: ev.streaming,
            ts,
            eventIds: eventId ? [eventId] : undefined,
          }
          textItems.set(ev.messageId, { item, index: items.length })
          items.push(item)
        }
        break
      }
      case 'message:end': {
        const existing = textItems.get(ev.messageId)
        if (existing?.item.streaming) {
          replaceSlot(items, existing, { ...existing.item, streaming: false })
        }
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
        const item: ToolItem = {
          type: 'tool',
          toolCallId: ev.toolCallId,
          name: ev.name,
          input: ev.input,
          ts,
          eventIds: eventId ? [eventId] : undefined,
        }
        toolItems.set(ev.toolCallId, { item, index: items.length })
        items.push(item)
        break
      }
      case 'tool:result': {
        const existing = toolItems.get(ev.toolCallId)
        if (existing) {
          replaceSlot(items, existing, {
            ...existing.item,
            result: { output: ev.output, isError: ev.isError },
            eventIds: appendEventId(existing.item.eventIds, eventId),
          })
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
}

/**
 * Historical streams sometimes lack a proper `message:end` for messages that
 * finished before this code existed. If a text item isn't the last text item in
 * the sequence, its stream has effectively ended — close it so the UI doesn't
 * render a perpetual spinner. The very last text item stays `streaming` only
 * when the session is actually active. It only allocates for the items it
 * actually closes, and is idempotent (an already-closed item is left strictly
 * alone, reference included), so it can safely run after every incremental fold.
 */
function closeStaleStreamingText(cache: FoldCache, sessionActive: boolean): void {
  const { items } = cache
  let lastStreamingIndex = -1
  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    if (it.type !== 'text' || !it.streaming) continue
    if (lastStreamingIndex >= 0) closeTextItemAt(cache, lastStreamingIndex)
    lastStreamingIndex = i
  }
  if (lastStreamingIndex >= 0 && !sessionActive) closeTextItemAt(cache, lastStreamingIndex)
}

/** Copy-on-write close of the text item sitting at `index`. */
function closeTextItemAt(cache: FoldCache, index: number): void {
  const it = cache.items[index]
  if (it.type !== 'text' || !it.streaming) return
  const next: TextItem = { ...it, streaming: false }
  cache.items[index] = next
  const slot = cache.textItems.get(it.messageId)
  if (slot && slot.index === index) slot.item = next
}

export interface UserMessage {
  content: string
  sender: string
  ts: string
  eventIds?: string[]
}

/** Sort key: a missing timestamp sinks to the end, as the old comparator did. */
function tsRank(item: ConversationItem): string {
  return item.ts ?? '￿'
}

function isSortedByTs(items: readonly ConversationItem[]): boolean {
  for (let i = 1; i < items.length; i++) {
    if (tsRank(items[i - 1]) > tsRank(items[i])) return false
  }
  return true
}

/**
 * Merge two item lists in chronological order. Both inputs are almost always
 * already sorted (events arrive in order, user messages too), so the common
 * case is a linear two-pointer merge instead of a concat plus a full sort of
 * the entire history on every token. Anything out of order falls back to the
 * original comparator, so the result is identical either way.
 */
function mergeSortedByTs(a: ConversationItem[], b: ConversationItem[]): ConversationItem[] {
  if (!isSortedByTs(a) || !isSortedByTs(b)) {
    const merged = [...a, ...b]
    merged.sort((x, y) => {
      const tx = tsRank(x)
      const ty = tsRank(y)
      if (tx === ty) return 0
      return tx < ty ? -1 : 1
    })
    return merged
  }

  const merged: ConversationItem[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    // `<=` keeps agent items before user items on an exact timestamp tie,
    // matching the stable sort this replaces.
    merged.push(tsRank(a[i]) <= tsRank(b[j]) ? a[i++] : b[j++])
  }
  while (i < a.length) merged.push(a[i++])
  while (j < b.length) merged.push(b[j++])
  return merged
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
  const merged = mergeSortedByTs(agentItems, userItems)

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
  // Copy-on-write, like the fold cache: publishing a new object is what makes
  // the already-rendered card notice that the spinner has to stop. The source
  // list (the fold cache's own `items`) is realigned on the same object so the
  // next merge is a no-op and the reference stays stable from then on.
  if (latestUserTs) {
    for (let i = 0; i < merged.length; i++) {
      const it = merged[i]
      if (it.type !== 'text' || !it.streaming) continue
      if (it.ts && it.ts >= latestUserTs) continue
      const closed: ConversationItem = { ...it, streaming: false }
      merged[i] = closed
      const sourceIndex = agentItems.indexOf(it)
      if (sourceIndex !== -1) agentItems[sourceIndex] = closed
    }
  }

  return merged
}
