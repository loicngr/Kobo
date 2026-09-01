<template>
  <!-- Workspace-switch spinner: shown at least WORKSPACE_SWITCH_SPINNER_MS
       every time the user clicks a workspace, hiding the mid-swap flicker
       and the empty transition while sync:response arrives. -->
  <div v-if="switching" class="activity-feed-switching">
    <q-spinner-dots size="40px" color="primary" />
  </div>
  <div v-else class="activity-feed-wrap">
    <!-- Off-screen live region. Deliberately NOT wrapped around the feed:
         announcing the container would read out every streaming fragment. -->
    <div
      data-testid="activity-live-region"
      class="sr-only"
      role="log"
      aria-live="polite"
      aria-atomic="true"
      :aria-label="$t('activity.a11y.region')"
    >
      {{ liveAnnouncement }}
    </div>
    <!-- Live, transient indicator while the engine compacts context — the feed
         looks frozen for a minute or two otherwise. Cleared automatically when
         compaction ends (boundary / session end). -->
    <transition name="fade">
      <div v-if="isCompacting" class="activity-feed-compacting">
        <q-spinner-dots size="18px" color="primary" />
        <span class="text-caption text-kobo-2">{{ $t('activity.compacting') }}</span>
      </div>
    </transition>
    <q-scroll-area ref="scrollRef" class="activity-feed-scroll" @scroll="onScroll">
      <div v-if="loadingOlder" class="text-center q-py-sm text-caption text-kobo-3">
        <q-spinner size="sm" /> {{ $t('activity.loading_older') }}
      </div>
      <q-virtual-scroll
        ref="virtualScrollRef"
        class="q-pa-md"
        :items="turns"
        :scroll-target="scrollTargetEl ?? undefined"
        :virtual-scroll-item-size="160"
        :virtual-scroll-slice-size="20"
        @virtual-scroll="onVirtualScroll"
      >
        <template #default="{ item: turn, index }: { item: Turn; index: number }">
          <TurnCard
            :key="turnKey(turn)"
            :turn="turn"
            :data-turn-index="index"
            :highlighted="turn.items.some((i) => i.eventIds?.includes(highlightedEventId ?? '') ?? false)"
            @scroll-to="onTurnScrollTo"
          />
        </template>
      </q-virtual-scroll>
      <!-- Un workspace neuf n'a rien à montrer : le dire, plutôt que de
           laisser une zone vide qui ressemble à une panne. -->
      <div v-if="turns.length === 0 && rawLines.length === 0 && !loadingOlder" class="activity-feed-empty q-pa-md">
        <q-icon name="forum" size="28px" />
        <div class="activity-feed-empty__title">{{ $t('activity.empty') }}</div>
        <div class="activity-feed-empty__hint">{{ $t('activity.emptyHint') }}</div>
      </div>
      <div v-if="rawLines.length" class="q-px-md q-pb-md">
        <q-expansion-item :label="$t('activity.raw_lines', { n: rawLines.length })" dense>
          <div v-for="(line, i) in rawLines" :key="i" class="text-caption text-kobo-3 q-pa-xs">
            {{ line }}
          </div>
        </q-expansion-item>
      </div>
    </q-scroll-area>
    <div class="activity-feed-nav-cluster">
      <q-btn
        v-if="!stickToBottom"
        round
        dense
        unelevated
        color="kobo-surface-2"
        text-color="kobo-1"
        icon="arrow_downward"
        size="sm"
        class="activity-feed-nav-btn"
        :title="$t('activity.scroll_to_bottom')"
        :aria-label="$t('activity.scroll_to_bottom')"
        @click="handleScrollToBottomClick"
      />
      <q-btn
        round
        dense
        unelevated
        color="kobo-surface-2"
        text-color="kobo-1"
        icon="arrow_upward"
        size="sm"
        class="activity-feed-nav-btn"
        :title="$t('activity.prev_user_message')"
        :aria-label="$t('activity.prev_user_message')"
        :loading="navigatingUp"
        :disable="navigatingUp"
        @click="goToPreviousUserMessage"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import type { QScrollArea } from 'quasar'
import {
  createFoldCache,
  foldEventsCached,
  isNormalSessionEnd,
  mergeWithUserMessages,
  type UserMessage,
} from 'src/services/agent-event-view'
import { findPreviousUserTurnIndex, groupIntoTurns, type Turn, turnKey } from 'src/services/conversation-turns'
import { useAgentStreamStore } from 'src/stores/agent-stream'
import { useSettingsStore } from 'src/stores/settings'
import { useWorkspaceStore } from 'src/stores/workspace'
import type { AgentEvent } from 'src/types/agent-event'
import { waitForCondition } from 'src/utils/wait-for'
import { isBusyStatus } from 'src/utils/workspace-status'
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import TurnCard from './TurnCard.vue'

const { t } = useI18n()

const props = defineProps<{ workspaceId: string }>()
const stream = useAgentStreamStore()
const settings = useSettingsStore()
const workspaceStore = useWorkspaceStore()

// Live "engine is compacting context" banner state (transient, ephemeral).
const isCompacting = computed(() => stream.isCompacting(props.workspaceId))

// Resolve the engine_session_id of the selected session to also accept legacy
// events tagged with the engine UUID (before the v6 backfill migration).
const selectedSessionId = computed(() => workspaceStore.selectedSessionId)
const selectedSessionLegacyTag = computed(() => {
  const s = workspaceStore.sessions.find((x) => x.id === selectedSessionId.value)
  return s?.engineSessionId ?? null
})
// Workspace-level events (setup script output, etc.) are persisted with
// session_id=NULL because they fire before any agent session exists. Only
// surface them on the very first session — sessions arrive sorted
// started_at DESC so the oldest one is the last element.
const isFirstSelectedSession = computed(() => {
  const sessions = workspaceStore.sessions
  if (sessions.length === 0) return false
  return selectedSessionId.value === sessions[sessions.length - 1].id
})

// An event (or user message) matches the currently selected session when:
// - no session is selected (fallback to showing everything — typically during
//   the brief window between workspace select and fetchSessions resolving), or
// - the item has no sessionId (workspace-level event) AND the selected session
//   is the first session of the workspace (otherwise these events would replay
//   on every new session), or
// - its sessionId matches the selected session id, or
// - its sessionId matches the engine_session_id of the selected session.
function sessionMatches(sid: string | null | undefined): boolean {
  if (!selectedSessionId.value) return true
  if (!sid) return isFirstSelectedSession.value
  return sid === selectedSessionId.value || sid === selectedSessionLegacyTag.value
}

const userMessages = computed<(UserMessage & { sessionId?: string })[]>(() => {
  const feed = workspaceStore.activityFeeds[props.workspaceId] ?? []
  return feed
    .filter((i) => i.type === 'text' && typeof i.content === 'string' && sessionMatches(i.sessionId))
    .map((i) => ({
      content: i.content,
      sender: (i.meta?.sender as string) ?? 'user',
      ts: i.timestamp,
      sessionId: i.sessionId,
      eventIds: [i.id],
    }))
})

const sessionActive = computed(() => {
  const ws = workspaceStore.workspaces.find((w) => w.id === props.workspaceId)
  return isBusyStatus(ws?.status)
})

// One resumable fold state per (workspace, session) view. Re-created whenever
// the view changes; foldEventsCached also invalidates it on its own whenever
// the stream is not a pure append.
let foldCache = createFoldCache()
let foldCacheKey = ''

const turns = computed(() => {
  // Filter the stream's parallel arrays (events / timestamps / sessionIds) by
  // the currently selected session BEFORE folding. Without this, session #1's
  // tool calls bleed into session #2's view and vice-versa.
  const allEvents = stream.eventsFor(props.workspaceId)
  const allTs = stream.timestampsFor(props.workspaceId)
  const allSids = stream.sessionIdsFor(props.workspaceId)
  const allIds = stream.eventIdsFor(props.workspaceId)
  const filteredEvents: AgentEvent[] = []
  const filteredTs: string[] = []
  const filteredIds: Array<string | null> = []
  for (let i = 0; i < allEvents.length; i++) {
    if (sessionMatches(allSids[i])) {
      filteredEvents.push(allEvents[i])
      filteredTs.push(allTs[i])
      filteredIds.push(allIds[i] ?? null)
    }
  }
  const viewKey = `${props.workspaceId}::${selectedSessionId.value ?? '*'}`
  if (viewKey !== foldCacheKey) {
    foldCache = createFoldCache()
    foldCacheKey = viewKey
  }
  const agentItems = foldEventsCached(foldCache, filteredEvents, filteredTs, sessionActive.value, filteredIds)
  const merged = mergeWithUserMessages(agentItems, userMessages.value)
  const filtered = merged.filter((item) => {
    if (item.type === 'thinking') return false
    if (item.type !== 'session') return true
    // `started` / `compacted` stay verbose-only. A session ending abnormally
    // (killed / error / watchdog) — or for an absent/unknown reason — is never
    // noise: hiding it behind the verbose toggle is exactly why a crash could
    // look indistinguishable from a normal turn. A *normal* completion, though,
    // happens after every turn and no longer needs to interrupt the feed: the
    // failure case now has its own dedicated `error` item, and the
    // `AgentLivenessChip` shows whether the agent is still running.
    if (item.kind !== 'ended') return settings.showVerboseSystemMessages
    return settings.showVerboseSystemMessages || !isNormalSessionEnd(item.detail)
  })
  return groupIntoTurns(filtered)
})

const rawLines = computed(() => {
  if (!settings.showVerboseSystemMessages) return []
  return stream
    .eventsFor(props.workspaceId)
    .filter((e: AgentEvent): e is Extract<AgentEvent, { kind: 'message:raw' }> => e.kind === 'message:raw')
    .map((e) => e.content)
})

// ── Screen-reader announcements ────────────────────────────────────────────
// The feed itself is NOT a live region: Codex emits one message:text event per
// token delta (50-200 per message), so announcing the container would read out
// every fragment. We therefore announce only two things — a message that has
// stopped streaming, and a tool call entering or leaving its running state.
const MAX_ANNOUNCED_CHARS = 300

const lastAnnounceable = computed(() => {
  for (let i = turns.value.length - 1; i >= 0; i--) {
    const items = turns.value[i]?.items ?? []
    for (let j = items.length - 1; j >= 0; j--) {
      const item = items[j]
      if (!item) continue
      if (item.type === 'text' && !item.streaming) {
        return { key: `text:${item.messageId}`, text: item.text }
      }
      if (item.type === 'tool') {
        if (!item.result) {
          return { key: `tool:${item.toolCallId}:start`, text: t('activity.a11y.toolStarted', { name: item.name }) }
        }
        const key = `tool:${item.toolCallId}:end`
        return {
          key,
          text: item.result.isError
            ? t('activity.a11y.toolFailed', { name: item.name })
            : t('activity.a11y.toolFinished', { name: item.name }),
        }
      }
    }
  }
  return null
})

const liveAnnouncement = ref('')

watch(lastAnnounceable, (next, previous) => {
  if (!next || next.key === previous?.key) return
  const body = next.key.startsWith('text:')
    ? t('activity.a11y.agentSaid', { text: next.text.slice(0, MAX_ANNOUNCED_CHARS) })
    : next.text
  liveAnnouncement.value = body
})

// ── Auto-scroll + infinite-scroll-up ─────────────────────────────────────
const scrollRef = ref<QScrollArea | null>(null)
const STICKY_THRESHOLD_PX = 60
const FETCH_MORE_THRESHOLD_PX = 200
// Reactive so the conditional "scroll to bottom" button can watch it — the
// button is hidden as long as the user is pinned to the bottom, and pops up
// as soon as they scroll up past STICKY_THRESHOLD_PX.
const stickToBottom = ref(true)
const loadingOlder = ref(false)
const highlightedEventId = ref<string | null>(null)
let initialScrollDone = false

// Workspace-switch spinner: true on mount and whenever the workspace id
// changes, flipped back to false once BOTH (a) the minimum display time
// has elapsed AND (b) the first event batch has arrived. Guarantees a
// visible loader even on instant switches and hides the mid-swap flicker.
const switching = ref(true)
const sessionHasMoreOlder = ref<Map<string, boolean>>(new Map())

interface ScrollInfo {
  verticalPosition: number
  verticalSize: number
  verticalContainerSize: number
}

function onScroll(info: ScrollInfo) {
  const distanceFromBottom = info.verticalSize - info.verticalPosition - info.verticalContainerSize
  stickToBottom.value = distanceFromBottom <= STICKY_THRESHOLD_PX

  if (!initialScrollDone) return

  if (info.verticalPosition <= FETCH_MORE_THRESHOLD_PX && !loadingOlder.value && currentHasMoreOlder()) {
    void loadOlderOnce()
  }
}

interface FetchedEvent {
  id: string
  workspaceId: string
  type: string
  payload: Record<string, unknown>
  sessionId: string | null
  createdAt: string
}

function sessionCacheKey(workspaceId: string, sessionId: string): string {
  return `${workspaceId}:${sessionId}`
}

function currentHasMoreOlder(): boolean {
  const sid = selectedSessionId.value
  if (!sid) return stream.hasMoreOlderFor(props.workspaceId)
  return sessionHasMoreOlder.value.get(sessionCacheKey(props.workspaceId, sid)) ?? true
}

function setSessionHasMoreOlder(workspaceId: string, sessionId: string, hasMore: boolean): void {
  sessionHasMoreOlder.value.set(sessionCacheKey(workspaceId, sessionId), hasMore)
}

function oldestVisibleEventId(workspaceId: string): string | undefined {
  if (!selectedSessionId.value) return stream.oldestIdFor(workspaceId)
  const allIds = stream.eventIdsFor(workspaceId)
  const allSids = stream.sessionIdsFor(workspaceId)
  for (let i = 0; i < allIds.length; i++) {
    if (!sessionMatches(allSids[i])) continue
    const eventId = allIds[i]
    if (eventId) return eventId
  }
  return undefined
}

const MIN_LOADER_MS = 200
const COOLDOWN_AFTER_PREPEND_MS = 400
const WORKSPACE_SWITCH_SPINNER_MS = 200

// One load at a time, and the in-flight promise is shareable: callers that
// need to wait for it can `await` instead of polling `loadingOlder` every
// fifty milliseconds.
let inFlightLoadOlder: Promise<void> | null = null

function loadOlderOnce(): Promise<void> {
  if (inFlightLoadOlder) return inFlightLoadOlder
  inFlightLoadOlder = loadOlder().finally(() => {
    inFlightLoadOlder = null
  })
  return inFlightLoadOlder
}

async function loadOlder(): Promise<void> {
  const workspaceId = props.workspaceId
  const sessionId = selectedSessionId.value
  const before = oldestVisibleEventId(workspaceId)
  if (!before) return
  loadingOlder.value = true
  const startedAt = Date.now()
  try {
    const area = scrollRef.value
    // Wait for Vue to render the "loading older messages…" DOM block so its
    // height is included in `prevSize`. Without this, an empty fetch (new
    // session, no history) would still produce a positive delta from the
    // loader itself and the position-preserve branch below would push the
    // user past the FETCH_MORE_THRESHOLD even though no content was actually
    // prepended — making the top of the feed unreachable.
    await nextTick()
    const prevSize = area?.getScroll().verticalSize ?? 0
    const prevPos = area?.getScroll().verticalPosition ?? 0

    // Fetch and (in parallel) a minimum-display delay so the loader stays
    // visible long enough for the user to see what's happening — avoids a
    // flashing spinner on fast networks.
    const params = new URLSearchParams({
      before,
      limit: '200',
    })
    if (sessionId) params.set('session', sessionId)
    const fetchPromise = fetch(`/api/workspaces/${workspaceId}/events?${params.toString()}`)
    const minDelay = new Promise((r) => setTimeout(r, MIN_LOADER_MS))
    const [res] = await Promise.all([fetchPromise, minDelay])

    if (!res.ok) {
      if (sessionId) setSessionHasMoreOlder(workspaceId, sessionId, false)
      else stream.prepend(workspaceId, [], [], { oldestId: before, hasMoreOlder: false })
      return
    }
    const body = (await res.json()) as { events: FetchedEvent[]; hasMore: boolean }
    const fetched = body.events ?? []

    const agentEvents = fetched.filter((e) => e.type === 'agent:event' && e.workspaceId === workspaceId)
    const userMsgs = fetched.filter((e) => e.type === 'user:message' && e.workspaceId === workspaceId)

    const olderEvents = agentEvents.map((e) => e.payload as unknown as AgentEvent)
    const olderTs = agentEvents.map((e) => e.createdAt)
    const olderSids = agentEvents.map((e) => e.sessionId ?? null)
    const olderIds = agentEvents.map((e) => e.id)
    const newOldestId = fetched.length > 0 ? fetched[0].id : before

    if (sessionId) setSessionHasMoreOlder(workspaceId, sessionId, body.hasMore)
    stream.prepend(workspaceId, olderEvents, olderTs, {
      oldestId: newOldestId,
      hasMoreOlder: sessionId ? stream.hasMoreOlderFor(workspaceId) : body.hasMore,
      sessionIds: olderSids,
      eventIds: olderIds,
    })

    for (const m of userMsgs) {
      const p = m.payload
      if (typeof p.content === 'string') {
        workspaceStore.addActivityItem(workspaceId, {
          id: m.id,
          type: 'text',
          content: p.content,
          timestamp: m.createdAt,
          sessionId: m.sessionId ?? undefined,
          meta: { sender: (p.sender as string) ?? 'user' },
        })
      }
    }

    // Preserve the user's visual position AND push them below the
    // fetch-more threshold so the next scroll event doesn't immediately
    // re-trigger loadOlder. This matters on small-batch fetches where the
    // newly-inserted content is shorter than the threshold.
    //
    // When NOTHING was actually prepended (server returned 0 events because
    // `hasMore` was already false on this session), do NOT touch the scroll.
    // The min-clamp `Math.max(prevPos, FETCH_MORE_THRESHOLD_PX + 50)` would
    // otherwise hijack the scroll: on a short feed, `setScrollPosition(250)`
    // gets clamped by q-scroll-area to `verticalSize - verticalContainerSize`,
    // which can equal max-scroll (= bottom) — so the user trying to read the
    // top of the feed gets yanked to the bottom on every loadOlder cycle.
    // Skipping is safe: `currentHasMoreOlder()` returns false after this
    // empty response, so onScroll won't re-trigger loadOlder on its own.
    await nextTick()
    if (area) {
      const newSize = area.getScroll().verticalSize
      const delta = newSize - prevSize
      if (delta > 0) {
        const desired = Math.max(prevPos + delta, FETCH_MORE_THRESHOLD_PX + 50)
        area.setScrollPosition('vertical', desired, 0)
      }
    }
  } catch (err) {
    console.error('[ActivityFeed] failed to load older events:', err)
    // Best-effort: stop trying if a transient network error hit — user
    // can refresh to retry. We still allow subsequent loads since we
    // don't mark hasMoreOlder=false here.
  } finally {
    // Keep the loader flag on for a short cooldown after all the DOM has
    // settled. Guarantees that an onScroll firing immediately after the
    // position-preserve won't re-trigger loadOlder before the dust settles.
    const elapsed = Date.now() - startedAt
    const remainingMin = Math.max(0, MIN_LOADER_MS - elapsed)
    await new Promise((r) => setTimeout(r, remainingMin + COOLDOWN_AFTER_PREPEND_MS))
    loadingOlder.value = false
  }
}

async function scrollToBottom(duration = 0) {
  await nextTick()
  const area = scrollRef.value
  if (!area) return
  const scroll = area.getScroll()
  area.setScrollPosition('vertical', scroll.verticalSize, duration)
}

// Coalesce streaming scrolls: animate the first one after a quiet period,
// snap the rest within a burst. Avoids stacked animations on per-delta events.
let pendingScrollFrame: number | null = null
let lastScrollAt = 0
const SCROLL_BURST_WINDOW_MS = 180

function requestStreamScrollToBottom() {
  if (pendingScrollFrame != null) return
  const now = performance.now()
  const inBurst = now - lastScrollAt < SCROLL_BURST_WINDOW_MS
  pendingScrollFrame = requestAnimationFrame(() => {
    pendingScrollFrame = null
    lastScrollAt = performance.now()
    void scrollToBottom(inBurst ? 0 : 180)
  })
}

// Handler for the `scrollTo` event emitted by TurnCard's "scroll to top of
// this message" button. The payload is the absolute Y in the scroll content
// — TurnCard computes it locally via getBoundingClientRect so it doesn't
// need access to the QScrollArea instance.
function onTurnScrollTo(y: number) {
  const area = scrollRef.value
  if (!area) return
  area.setScrollPosition('vertical', Math.max(0, y), 250)
}

/** Consume a one-shot search deep link without changing the current view. */
function clearHistoryFocusUrl(): void {
  const hash = window.location.hash
  const queryIndex = hash.indexOf('?')
  if (queryIndex === -1) return
  const params = new URLSearchParams(hash.slice(queryIndex + 1))
  if (!params.has('eventId')) return
  const cleanHash = hash.slice(0, queryIndex)
  window.history.replaceState(
    window.history.state,
    '',
    `${window.location.pathname}${window.location.search}${cleanHash}`,
  )
}

interface HistoryFocusDetail {
  workspaceId?: string
  sessionId?: string | null
  eventId?: string
}

/** Load a compact event window centered on a search hit, then land on its turn. */
async function focusHistoryEvent(event: Event): Promise<void> {
  const detail = (event as CustomEvent<HistoryFocusDetail>).detail
  if (detail?.workspaceId !== props.workspaceId || !detail.eventId) return

  try {
    const params = new URLSearchParams({ around: detail.eventId, limit: '200' })
    if (detail.sessionId) params.set('session', detail.sessionId)
    const response = await fetch(`/api/workspaces/${props.workspaceId}/events?${params}`)
    if (!response.ok) return
    const body = (await response.json()) as { events: FetchedEvent[]; hasMore?: boolean }
    const fetched = body.events ?? []
    const agentEvents = fetched.filter((item) => item.type === 'agent:event' && item.workspaceId === props.workspaceId)
    const userEvents = fetched.filter((item) => item.type === 'user:message' && item.workspaceId === props.workspaceId)

    stream.reset(
      props.workspaceId,
      agentEvents.map((item) => item.payload as unknown as AgentEvent),
      agentEvents.map((item) => item.createdAt),
      {
        oldestId: fetched[0]?.id,
        // Use the backend's real answer instead of hardcoding false — a
        // search deep-link into a long history otherwise permanently blocks
        // further scroll-up with no indication why.
        hasMoreOlder: body.hasMore ?? false,
        sessionIds: agentEvents.map((item) => item.sessionId),
        eventIds: agentEvents.map((item) => item.id),
      },
    )
    for (const item of userEvents) {
      const payload = item.payload
      if (typeof payload.content !== 'string') continue
      workspaceStore.addActivityItem(props.workspaceId, {
        id: item.id,
        type: 'text',
        content: payload.content,
        timestamp: item.createdAt,
        sessionId: item.sessionId ?? undefined,
        meta: { sender: (payload.sender as string) ?? 'user' },
      })
    }

    // On a route navigation the feed may still be showing its workspace
    // switch spinner. Wait until the scroll area is mounted, then let the
    // session/filter watchers render the focused window before resolving the
    // corresponding TurnCard template ref.
    // Wake on the actual state change, not fifty times a second for 5 s.
    await waitForCondition(switching, (isSwitching) => !isSwitching, 5000)
    await nextTick()
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    const turnIndex = turns.value.findIndex((turn) =>
      turn.items.some((item) => item.eventIds?.includes(detail.eventId!) ?? false),
    )
    if (turnIndex < 0) return
    highlightedEventId.value = detail.eventId
    // Index-based: the target card may not be in the DOM at all until the
    // virtual list scrolls to it.
    virtualScrollRef.value?.scrollTo(turnIndex, 'center')
    firstVisibleTurnIndex.value = turnIndex
    window.setTimeout(() => {
      if (highlightedEventId.value === detail.eventId) highlightedEventId.value = null
    }, 1800)
  } catch (err) {
    console.error('[ActivityFeed] failed to focus history event:', err)
  }
}

// Handle on the virtual list, used to scroll by index instead of by pixel.
const virtualScrollRef = ref<{ scrollTo(index: number, edge?: 'start' | 'center' | 'end'): void } | null>(null)
// The QScrollArea's inner scrollable element — QVirtualScroll needs an
// explicit scroll target when it does not own its own scroller.
const scrollTargetEl = ref<Element | null>(null)
// First turn index currently in view, fed by QVirtualScroll's own event.
const firstVisibleTurnIndex = ref(0)

function onVirtualScroll(details: { index: number }): void {
  firstVisibleTurnIndex.value = details.index
}

// True while a "jump to previous user message" is walking back through the
// history. Drives the button's disabled + loading state, and blocks reentrant
// clicks: three impatient clicks used to start three concurrent walks fighting
// over the same `loadingOlder` flag.
const navigatingUp = ref(false)

async function goToPreviousUserMessage(): Promise<void> {
  if (navigatingUp.value) return
  navigatingUp.value = true
  // The walk spans several awaits (history fetches). `props.workspaceId` is
  // reactive: if the user switches workspace mid-walk, every step after the
  // switch would keep walking — on the NEW workspace — fetching its history
  // and yanking its scroll position. Pin the workspace the walk started on and
  // bail out as soon as it no longer matches, exactly as if the component had
  // been torn down.
  const walkWorkspaceId = props.workspaceId
  try {
    let target = findPreviousUserTurnIndex(turns.value, firstVisibleTurnIndex.value)
    // Long workspaces may open with 300 recent agent events and *zero* user
    // turns loaded. Keep fetching older batches until a user turn appears, we
    // run out of history, or we hit a safety cap (≈15 * 200 = 3000 events).
    if (target < 0) {
      const MAX_ATTEMPTS = 15
      for (let i = 0; i < MAX_ATTEMPTS; i++) {
        if (walkWorkspaceId !== props.workspaceId) return
        if (!currentHasMoreOlder()) break
        const before = turns.value.length
        await loadOlderOnce()
        await nextTick()
        if (walkWorkspaceId !== props.workspaceId) return
        // Older turns are prepended, so the current position shifts down by
        // however many turns were added.
        firstVisibleTurnIndex.value += turns.value.length - before
        target = findPreviousUserTurnIndex(turns.value, firstVisibleTurnIndex.value)
        if (target >= 0) break
      }
    }
    if (target >= 0 && walkWorkspaceId === props.workspaceId) {
      virtualScrollRef.value?.scrollTo(target, 'start')
      firstVisibleTurnIndex.value = target
    }
  } finally {
    navigatingUp.value = false
  }
}

async function armInitialScroll() {
  initialScrollDone = false
  // Run through a few paint cycles so the feed's items are laid out before
  // we try to measure/scroll. sync:response may arrive AFTER onMounted, so
  // we rely on the watcher below to re-arm whenever turns populate.
  await nextTick()
  await scrollToBottom(0)
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  await scrollToBottom(0)
  initialScrollDone = true
}

// Count of events *in the currently selected session*. Used by the auto-scroll
// watcher so a burst of activity in a background session (e.g. auto-loop
// iteration #2 running while the user reads session #1) does NOT snap the
// visible feed to the bottom. Live typing (streaming chunks) still bumps this
// counter as long as the active session owns them.
const eventCount = computed(() => {
  const sids = stream.sessionIdsFor(props.workspaceId)
  if (!selectedSessionId.value) return sids.length
  let n = 0
  for (const sid of sids) {
    if (sessionMatches(sid)) n++
  }
  return n
})

// Unfiltered count — used by the switching spinner to know whether the
// workspace stream has been populated at all. We must NOT use `eventCount`
// (session-filtered) here: an old session with zero events in the current
// sync:response window would loop the spinner to its grace-period timeout
// before the session-scoped fetch even gets a chance to run.
const rawEventCount = computed(() => stream.eventsFor(props.workspaceId).length)

/** Un workspace neuf n'émettra JAMAIS d'événement : attendre cinq secondes
 *  pour finir par n'afficher rien du tout est une punition, pas un chargement.
 *  Une grâce courte suffit à masquer le battement de `sync:response`. */
const EMPTY_FEED_GRACE_MS = 1200

/**
 * Shows the switching spinner for at least `WORKSPACE_SWITCH_SPINNER_MS`
 * AND until the workspace stream has at least one event. Flip to false
 * once both conditions meet.
 */
async function showSwitchingSpinner() {
  switching.value = true
  const startedAt = Date.now()
  await new Promise((r) => setTimeout(r, WORKSPACE_SWITCH_SPINNER_MS))
  // Wait for the sync:response to land, capped — the remaining budget after
  // the minimum spinner display.
  const remaining = Math.max(0, startedAt + EMPTY_FEED_GRACE_MS - Date.now())
  await waitForCondition(rawEventCount, (count) => count > 0, remaining)
  switching.value = false
}

// When the spinner disappears and the scroll-area is (re-)mounted, we need
// to anchor at the bottom. armInitialScroll waits for a nextTick so it
// works even if the scroll-area just transitioned from v-if=false.
watch(switching, async (isSwitching) => {
  if (!isSwitching && eventCount.value > 0) {
    await armInitialScroll()
  }
  // First mount with a session already selected (e.g. refresh on ?session=X)
  // but no events landed yet for that session → targeted session-scoped fetch.
  if (!isSwitching && eventCount.value === 0 && selectedSessionId.value) {
    void fetchSessionIfMissing()
  }
  // QVirtualScroll needs the QScrollArea's inner scroller; the q-scroll-area
  // is remounted every time the spinner reappears/disappears (v-if), so its
  // scroll target must be re-resolved on the same transition.
  if (!isSwitching) {
    void nextTick(() => {
      scrollTargetEl.value = scrollRef.value?.getScrollTarget() ?? null
    })
  }
})

onMounted(() => {
  window.addEventListener('kobo:focus-history-event', focusHistoryEvent)
  // QVirtualScroll needs the QScrollArea's inner scroller; it only exists once
  // the scroll area is mounted.
  void nextTick(() => {
    scrollTargetEl.value = scrollRef.value?.getScrollTarget() ?? null
  })
  void showSwitchingSpinner()
  if (eventCount.value > 0) void armInitialScroll()
  // Fire the session-scoped fetch in parallel with sync:response, not after
  // the spinner ends. For refreshes on ?session=X where that session is
  // outside the sync:response window, this shaves off the RTT latency so
  // the feed paints at roughly the same speed as in-window sessions.
  if (selectedSessionId.value) void fetchSessionIfMissing()
  // Read the optional deep-link target without depending on vue-router's
  // injection: ActivityFeed is also mounted in isolated component tests.
  const eventId = new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('eventId')
  if (eventId) {
    void focusHistoryEvent(
      new CustomEvent<HistoryFocusDetail>('kobo:focus-history-event', {
        detail: { workspaceId: props.workspaceId, sessionId: selectedSessionId.value, eventId },
      }),
    )
    clearHistoryFocusUrl()
  }
})

// First-populate + live-follow watcher. Fires on any new event (including
// streaming chunks). Skips auto-scroll while `loadOlder` is prepending —
// that path preserves the user's visual position on its own.
let firstPopulateDone = eventCount.value > 0
watch(eventCount, async (newLen, oldLen) => {
  if (loadingOlder.value) return
  if (!firstPopulateDone && newLen > 0) {
    firstPopulateDone = true
    await armInitialScroll()
    return
  }
  if (newLen > oldLen && stickToBottom.value && !loadingOlder.value) {
    requestStreamScrollToBottom()
  }
})

onUnmounted(() => {
  window.removeEventListener('kobo:focus-history-event', focusHistoryEvent)
  if (pendingScrollFrame != null) {
    cancelAnimationFrame(pendingScrollFrame)
    pendingScrollFrame = null
  }
})

watch(
  () => props.workspaceId,
  () => {
    stickToBottom.value = true
    firstPopulateDone = eventCount.value > 0
    initialScrollDone = false
    void showSwitchingSpinner()
    if (eventCount.value > 0) void armInitialScroll()
  },
)

// When the user flips between sessions ("All" / session-1 / session-2…),
// re-anchor the feed at the bottom on the newly-filtered view.
watch(
  () => workspaceStore.selectedSessionId,
  async () => {
    stickToBottom.value = true
    initialScrollDone = false
    await armInitialScroll()
    void fetchSessionIfMissing()
  },
)

// sync:response only replays the 300 most recent events of the workspace
// (INITIAL_WINDOW backend-side). For workspaces with many sessions, older
// sessions (e.g. session #1 after hours of auto-loop) have zero events in
// the stream. When the user switches to such a session we do a targeted
// fetch filtered by session_id — cheap (one request, server-side SQL filter)
// and avoids walking unrelated events via infinite scroll.
const sessionsFetched = new Set<string>()

async function fetchSessionIfMissing(): Promise<void> {
  const sid = selectedSessionId.value
  if (!sid) return
  if (eventCount.value > 0) return
  const cacheKey = sessionCacheKey(props.workspaceId, sid)
  if (sessionsFetched.has(cacheKey)) return
  sessionsFetched.add(cacheKey)

  try {
    const res = await fetch(`/api/workspaces/${props.workspaceId}/events?session=${encodeURIComponent(sid)}&limit=500`)
    if (!res.ok) return
    const body = (await res.json()) as { events: FetchedEvent[]; hasMore: boolean }
    const fetched = body.events ?? []
    if (fetched.length === 0) return

    const agentEvents = fetched.filter((e) => e.type === 'agent:event' && e.workspaceId === props.workspaceId)
    const userMsgs = fetched.filter((e) => e.type === 'user:message' && e.workspaceId === props.workspaceId)

    // Prepend into the stream — these events are older than whatever is
    // currently loaded (the stream holds the most recent 300). Order is
    // preserved inside the prepended batch.
    const olderEvents = agentEvents.map((e) => e.payload as unknown as AgentEvent)
    const olderTs = agentEvents.map((e) => e.createdAt)
    const olderSids = agentEvents.map((e) => e.sessionId ?? null)
    const olderIds = agentEvents.map((e) => e.id)
    setSessionHasMoreOlder(props.workspaceId, sid, body.hasMore)
    if (olderEvents.length > 0) {
      stream.prepend(props.workspaceId, olderEvents, olderTs, {
        oldestId: fetched[0].id,
        hasMoreOlder: stream.hasMoreOlderFor(props.workspaceId),
        sessionIds: olderSids,
        eventIds: olderIds,
      })
    }

    for (const m of userMsgs) {
      const p = m.payload
      if (typeof p.content === 'string') {
        workspaceStore.addActivityItem(props.workspaceId, {
          id: m.id,
          type: 'text',
          content: p.content,
          timestamp: m.createdAt,
          sessionId: m.sessionId ?? undefined,
          meta: { sender: (p.sender as string) ?? 'user' },
        })
      }
    }

    await nextTick()
    await scrollToBottom(0)
  } catch (err) {
    console.error('[ActivityFeed] fetchSessionIfMissing failed:', err)
    sessionsFetched.delete(cacheKey) // allow retry
  }
}

// When the user sends a message, force the feed to the bottom even if
// they were reading earlier history. Detect by counting non-system-prompt
// user messages — increments exactly once per user send.
const userSendCount = computed(() => userMessages.value.filter((m) => m.sender !== 'system-prompt').length)
watch(userSendCount, async (newLen, oldLen) => {
  if (newLen > oldLen) {
    stickToBottom.value = true
    await scrollToBottom(180)
  }
})

// Click handler for the scroll-to-bottom button. Uses the existing helper
// (smooth 250ms). The button is rendered only when `!stickToBottom`.
async function handleScrollToBottomClick() {
  stickToBottom.value = true
  await scrollToBottom(250)
}
</script>

<style scoped>
.activity-feed-wrap {
  position: relative;
  height: 100%;
  width: 100%;
}
.activity-feed-scroll {
  height: 100%;
  width: 100%;
}
.activity-feed-nav-cluster {
  position: absolute;
  right: 14px;
  bottom: 14px;
  z-index: 2;
  display: flex;
  gap: 8px;
  align-items: center;
}
.activity-feed-compacting {
  position: absolute;
  top: 12px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 3;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 14px;
  background: var(--kobo-surface);
  border: 1px solid var(--kobo-border);
  border-radius: 6px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
}
.fade-enter-active,
.fade-leave-active {
  transition: opacity 160ms ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
.activity-feed-nav-btn {
  opacity: 0.8;
  transition: opacity 120ms ease;
}
.activity-feed-nav-btn:hover {
  opacity: 1;
}
/* Kill any horizontal overflow from long file paths, long words in code
   blocks, or oversized bash commands. We only want vertical scrolling. */
.activity-feed-scroll :deep(.q-scrollarea__content) {
  max-width: 100%;
  overflow-x: hidden;
}
.activity-feed-switching {
  height: 100%;
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
}
.activity-feed-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--kobo-space-sm);
  padding: var(--kobo-space-4xl) var(--kobo-space-xl);
  color: var(--kobo-text-3);
  text-align: center;
}
.activity-feed-empty__title {
  font-family: var(--kobo-font-sans);
  font-size: 14px;
  font-weight: 500;
  color: var(--kobo-text-2);
}
.activity-feed-empty__hint {
  font-family: var(--kobo-font-sans);
  font-size: 13px;
  color: var(--kobo-text-3);
  max-width: 380px;
}
</style>
