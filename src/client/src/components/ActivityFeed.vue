<script setup lang="ts">
import type { QScrollArea } from 'quasar'
import { foldEvents, mergeWithUserMessages, type UserMessage } from 'src/services/agent-event-view'
import { groupIntoTurns } from 'src/services/conversation-turns'
import { useAgentStreamStore } from 'src/stores/agent-stream'
import { useSettingsStore } from 'src/stores/settings'
import { useWorkspaceStore } from 'src/stores/workspace'
import type { AgentEvent } from 'src/types/agent-event'
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import TurnCard from './TurnCard.vue'

const props = defineProps<{ workspaceId: string }>()
const stream = useAgentStreamStore()
const settings = useSettingsStore()
const workspaceStore = useWorkspaceStore()

const userMessages = computed<(UserMessage & { sessionId?: string })[]>(() => {
  const feed = workspaceStore.activityFeeds[props.workspaceId] ?? []
  return feed
    .filter((i) => i.type === 'text' && typeof i.content === 'string')
    .map((i) => ({
      content: i.content,
      sender: (i.meta?.sender as string) ?? 'user',
      ts: i.timestamp,
      sessionId: i.sessionId,
    }))
})

const sessionActive = computed(() => {
  const ws = workspaceStore.workspaces.find((w) => w.id === props.workspaceId)
  if (!ws) return false
  return ws.status === 'extracting' || ws.status === 'brainstorming' || ws.status === 'executing'
})

const turns = computed(() => {
  const allEvents = stream.eventsFor(props.workspaceId)
  const allTs = stream.timestampsFor(props.workspaceId)
  const agentItems = foldEvents(allEvents, allTs, sessionActive.value)
  const merged = mergeWithUserMessages(agentItems, userMessages.value)
  const filtered = settings.showVerboseSystemMessages ? merged : merged.filter((it) => it.type !== 'session')
  return groupIntoTurns(filtered)
})

const rawLines = computed(() => {
  if (!settings.showVerboseSystemMessages) return []
  return stream
    .eventsFor(props.workspaceId)
    .filter((e: AgentEvent): e is Extract<AgentEvent, { kind: 'message:raw' }> => e.kind === 'message:raw')
    .map((e) => e.content)
})

// ── Auto-scroll + infinite-scroll-up ─────────────────────────────────────
const scrollRef = ref<QScrollArea | null>(null)
const STICKY_THRESHOLD_PX = 60
const FETCH_MORE_THRESHOLD_PX = 200
let stickToBottom = true
const loadingOlder = ref(false)
let initialScrollDone = false

// Workspace-switch spinner: true on mount and whenever the workspace id
// changes, flipped back to false once BOTH (a) the minimum display time
// has elapsed AND (b) the first event batch has arrived. Guarantees a
// visible loader even on instant switches and hides the mid-swap flicker.
const switching = ref(true)

interface ScrollInfo {
  verticalPosition: number
  verticalSize: number
  verticalContainerSize: number
}

function onScroll(info: ScrollInfo) {
  const distanceFromBottom = info.verticalSize - info.verticalPosition - info.verticalContainerSize
  stickToBottom = distanceFromBottom <= STICKY_THRESHOLD_PX

  if (!initialScrollDone) return

  if (
    info.verticalPosition <= FETCH_MORE_THRESHOLD_PX &&
    !loadingOlder.value &&
    stream.hasMoreOlderFor(props.workspaceId)
  ) {
    void loadOlder()
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

const MIN_LOADER_MS = 200
const COOLDOWN_AFTER_PREPEND_MS = 400
const WORKSPACE_SWITCH_SPINNER_MS = 200

async function loadOlder(): Promise<void> {
  const workspaceId = props.workspaceId
  const before = stream.oldestIdFor(workspaceId)
  if (!before) return
  loadingOlder.value = true
  const startedAt = Date.now()
  try {
    const area = scrollRef.value
    const prevSize = area?.getScroll().verticalSize ?? 0
    const prevPos = area?.getScroll().verticalPosition ?? 0

    // Fetch and (in parallel) a minimum-display delay so the loader stays
    // visible long enough for the user to see what's happening — avoids a
    // flashing spinner on fast networks.
    const fetchPromise = fetch(`/api/workspaces/${workspaceId}/events?before=${encodeURIComponent(before)}&limit=200`)
    const minDelay = new Promise((r) => setTimeout(r, MIN_LOADER_MS))
    const [res] = await Promise.all([fetchPromise, minDelay])

    if (!res.ok) {
      stream.prepend(workspaceId, [], [], { oldestId: before, hasMoreOlder: false })
      return
    }
    const body = (await res.json()) as { events: FetchedEvent[]; hasMore: boolean }
    const fetched = body.events ?? []

    const agentEvents = fetched.filter((e) => e.type === 'agent:event' && e.workspaceId === workspaceId)
    const userMsgs = fetched.filter((e) => e.type === 'user:message' && e.workspaceId === workspaceId)

    const olderEvents = agentEvents.map((e) => e.payload as unknown as AgentEvent)
    const olderTs = agentEvents.map((e) => e.createdAt)
    const olderSids = agentEvents.map((e) => e.sessionId ?? null)
    const newOldestId = fetched.length > 0 ? fetched[0].id : before

    stream.prepend(workspaceId, olderEvents, olderTs, {
      oldestId: newOldestId,
      hasMoreOlder: body.hasMore,
      sessionIds: olderSids,
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
    await nextTick()
    if (area) {
      const newSize = area.getScroll().verticalSize
      const delta = newSize - prevSize
      const desired = Math.max(prevPos + delta, FETCH_MORE_THRESHOLD_PX + 50)
      area.setScrollPosition('vertical', desired, 0)
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

// Collected via Vue template refs on <TurnCard v-for … ref="turnRefs">.
// Parallel to `turns.value` — same index, same length.
const turnRefs = ref<Array<{ $el: HTMLElement } | null>>([])

// Zero-height marker rendered at the very top of the scroll content.
// Its viewport Y gives us a stable "origin" for Y coords inside the
// content, independent of q-scroll-area's internal DOM structure and
// whatever transform strategy it uses.
const contentOriginRef = ref<HTMLElement | null>(null)

// Resolve the list of <user turn> DOM elements in DOM order. Prefers
// template refs (typed, in sync with `turns`); falls back to querying
// the `.turn-card--user` class if refs haven't populated yet.
function collectUserTurnElements(): HTMLElement[] {
  const turnList = turns.value
  const refList = turnRefs.value
  const result: HTMLElement[] = []
  if (refList.length === turnList.length) {
    for (let i = 0; i < turnList.length; i++) {
      if (turnList[i].speaker !== 'user') continue
      const instance = refList[i]
      const el = instance?.$el as HTMLElement | undefined
      if (el) result.push(el)
    }
    if (result.length > 0) return result
  }
  // Fallback path — direct DOM selector on the content origin's parent
  // (the scroll content). Covers the first-click-before-refs-populate case.
  const origin = contentOriginRef.value
  const host = origin?.parentElement
  if (host) {
    const cards = host.querySelectorAll<HTMLElement>('.turn-card--user')
    for (const c of cards) result.push(c)
  }
  return result
}

// Find the absolute Y (relative to the content origin marker) of the last
// user turn card whose top sits strictly *above* the current scroll
// position. Returns null if no such card exists in the currently-rendered
// DOM.
function findPreviousUserTurnY(): number | null {
  const area = scrollRef.value
  if (!area) return null
  const origin = contentOriginRef.value
  if (!origin) return null
  const currentPos = area.getScroll().verticalPosition
  const originTop = origin.getBoundingClientRect().top
  // Margin so a user card pinned at the top doesn't count as "previous".
  const margin = 40
  let bestY: number | null = null
  for (const el of collectUserTurnElements()) {
    // cardY = distance from the content-origin marker (at scroll-pos 0)
    //       = el.top - origin.top in viewport coords.
    // Since both move together with the scroll, their difference stays
    // equal to the card's position in the content.
    const cardY = el.getBoundingClientRect().top - originTop
    if (cardY < currentPos - margin) bestY = cardY
    else break
  }
  return bestY
}

async function goToPreviousUserMessage(): Promise<void> {
  const area = scrollRef.value
  if (!area) return
  let targetY = findPreviousUserTurnY()
  // Long workspaces may open with 300 recent agent events and *zero* user
  // turns in the current DOM (agent dominates the tail of the stream).
  // Keep fetching older batches until a user turn appears, we run out of
  // history, or we hit a safety cap (≈15 * 200 = 3000 events back).
  if (targetY === null) {
    const MAX_ATTEMPTS = 15
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      if (!stream.hasMoreOlderFor(props.workspaceId)) break
      while (loadingOlder.value) await new Promise((r) => setTimeout(r, 50))
      await loadOlder()
      await nextTick()
      targetY = findPreviousUserTurnY()
      if (targetY !== null) break
    }
  }
  if (targetY !== null) {
    area.setScrollPosition('vertical', Math.max(0, targetY - 12), 250)
  }
}

async function armInitialScroll() {
  initialScrollDone = false
  // Run through a few paint cycles so the feed's items are laid out before
  // we try to measure/scroll. sync:response may arrive AFTER onMounted, so
  // we rely on the watcher below to re-arm whenever turns populate.
  await nextTick()
  await scrollToBottom(0)
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      initialScrollDone = true
    })
  })
}

// Count of raw events in the stream — this bumps on every streaming chunk
// (each `message:text` delta is its own event), so watching it gives us a
// tick for live typing, not just for new turn creation.
const eventCount = computed(() => stream.eventsFor(props.workspaceId).length)

/**
 * Shows the switching spinner for at least `WORKSPACE_SWITCH_SPINNER_MS`
 * AND until events have landed. Flip to false once both conditions meet.
 */
async function showSwitchingSpinner() {
  switching.value = true
  const startedAt = Date.now()
  await new Promise((r) => setTimeout(r, WORKSPACE_SWITCH_SPINNER_MS))
  // Poll briefly if the sync:response hasn't landed yet (capped).
  const deadline = startedAt + 5000
  while (eventCount.value === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50))
  }
  switching.value = false
}

// When the spinner disappears and the scroll-area is (re-)mounted, we need
// to anchor at the bottom. armInitialScroll waits for a nextTick so it
// works even if the scroll-area just transitioned from v-if=false.
watch(switching, async (isSwitching) => {
  if (!isSwitching && eventCount.value > 0) {
    await armInitialScroll()
  }
})

onMounted(() => {
  void showSwitchingSpinner()
  if (eventCount.value > 0) void armInitialScroll()
})

// First-populate + live-follow watcher. Fires on any new event (including
// streaming chunks). Skips auto-scroll while `loadOlder` is prepending —
// that path preserves the user's visual position on its own.
let firstPopulateDone = false
watch(eventCount, async (newLen, oldLen) => {
  if (!firstPopulateDone && newLen > 0) {
    firstPopulateDone = true
    await armInitialScroll()
    return
  }
  if (newLen > oldLen && stickToBottom && !loadingOlder.value) {
    await scrollToBottom(180)
  }
})

watch(
  () => props.workspaceId,
  () => {
    stickToBottom = true
    firstPopulateDone = false
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
    stickToBottom = true
    initialScrollDone = false
    await armInitialScroll()
  },
)

// When the user sends a message, force the feed to the bottom even if
// they were reading earlier history. Detect by counting non-system-prompt
// user messages — increments exactly once per user send.
const userSendCount = computed(() => userMessages.value.filter((m) => m.sender !== 'system-prompt').length)
watch(userSendCount, async (newLen, oldLen) => {
  if (newLen > oldLen) {
    stickToBottom = true
    await scrollToBottom(180)
  }
})
</script>

<template>
  <!-- Workspace-switch spinner: shown at least WORKSPACE_SWITCH_SPINNER_MS
       every time the user clicks a workspace, hiding the mid-swap flicker
       and the empty transition while sync:response arrives. -->
  <div v-if="switching" class="activity-feed-switching">
    <q-spinner-dots size="40px" color="indigo-4" />
  </div>
  <div v-else class="activity-feed-wrap">
    <q-scroll-area ref="scrollRef" class="activity-feed-scroll" @scroll="onScroll">
      <!-- Zero-height origin marker — always at scroll position 0 within the
           scroll content. Used to compute accurate card Y coordinates
           without depending on Quasar's internal DOM. -->
      <div ref="contentOriginRef" class="content-origin-marker" />
      <div v-if="loadingOlder" class="text-center q-py-sm text-caption text-grey-6">
        <q-spinner size="sm" /> {{ $t('activity.loading_older') }}
      </div>
      <div class="q-pa-md">
        <TurnCard v-for="(turn, i) in turns" :key="i" ref="turnRefs" :turn="turn" />
      </div>
      <div v-if="rawLines.length" class="q-px-md q-pb-md">
        <q-expansion-item :label="$t('activity.raw_lines', { n: rawLines.length })" dense>
          <div v-for="(line, i) in rawLines" :key="i" class="text-caption text-grey q-pa-xs">
            {{ line }}
          </div>
        </q-expansion-item>
      </div>
    </q-scroll-area>
    <q-btn
      round
      dense
      unelevated
      color="grey-9"
      text-color="grey-3"
      icon="arrow_upward"
      size="sm"
      class="activity-feed-prev-btn"
      :title="$t('activity.prev_user_message')"
      @click="goToPreviousUserMessage"
    />
  </div>
</template>

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
.activity-feed-prev-btn {
  position: absolute;
  right: 14px;
  bottom: 14px;
  z-index: 2;
  opacity: 0.8;
  transition: opacity 120ms ease;
}
.activity-feed-prev-btn:hover {
  opacity: 1;
}
.content-origin-marker {
  height: 0;
  width: 0;
  margin: 0;
  padding: 0;
  pointer-events: none;
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
</style>
