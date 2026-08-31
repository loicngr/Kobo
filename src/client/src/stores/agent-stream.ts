import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { AgentEvent } from '../types/agent-event'

export const MAX_LIVE_EVENTS_PER_WORKSPACE = 5000

/**
 * Per-workspace AgentEvent stream. Keeps the Map stable and uses a monotonic
 * `version` counter as the reactive dependency (reads establish the
 * dependency, writes bump the counter). This is O(1) per append.
 *
 * Parallel arrays carry the creation time AND the session id of each event
 * so consumers (ActivityFeed) can display timestamps and filter per session
 * without re-importing the raw ws_events row shape.
 *
 * A parallel `oldestIds` + `hasMoreOlder` track the pagination cursor used
 * by ActivityFeed to load older history on-demand when the user scrolls up.
 */
export const useAgentStreamStore = defineStore('agent-stream', () => {
  const events = ref<Map<string, AgentEvent[]>>(new Map())
  const timestamps = ref<Map<string, string[]>>(new Map())
  const sessionIds = ref<Map<string, Array<string | null>>>(new Map())
  const eventIds = ref<Map<string, Array<string | null>>>(new Map())
  const oldestIds = ref<Map<string, string>>(new Map())
  const hasMoreOlder = ref<Map<string, boolean>>(new Map())
  // Transient "engine is compacting context right now" flag per workspace. Not
  // part of the persisted event stream — driven by ephemeral session:compacting
  // events and cleared when compaction ends. Reactive via `version`.
  const compacting = ref<Map<string, boolean>>(new Map())
  // Per-workspace index of persisted ws_events ids. `append` used to scan the
  // whole id array (`idList.includes`) on EVERY event: with Codex emitting 50
  // to 200 deltas per message on a 5 000-entry buffer, that is up to a million
  // comparisons per message. A Set makes it O(1). `merge` already built one —
  // it just threw it away on every call.
  const eventIdIndex = ref<Map<string, Set<string>>>(new Map())

  // Per-workspace reactive counter. A single global counter meant a burst on a
  // background workspace invalidated every computed value of the workspace on
  // screen — and WorkspaceList subscribes to ALL workspaces, so that happened
  // constantly. Vue tracks `Map.get(key)` per key, so reading this counter
  // establishes a dependency scoped to exactly one workspace.
  const versions = ref<Map<string, number>>(new Map())

  /** Register a reactive dependency on THIS workspace's stream. */
  function track(workspaceId: string): void {
    versions.value.get(workspaceId)
  }

  /** Invalidate every consumer of THIS workspace's stream. */
  function touch(workspaceId: string): void {
    versions.value.set(workspaceId, (versions.value.get(workspaceId) ?? 0) + 1)
  }

  /** Current counter of a workspace. Exposed so tests can assert isolation. */
  function versionFor(workspaceId: string): number {
    return versions.value.get(workspaceId) ?? 0
  }

  function idIndexFor(workspaceId: string): Set<string> {
    let set = eventIdIndex.value.get(workspaceId)
    if (!set) {
      set = new Set<string>()
      eventIdIndex.value.set(workspaceId, set)
    }
    return set
  }

  function isCompacting(workspaceId: string): boolean {
    track(workspaceId)
    return compacting.value.get(workspaceId) ?? false
  }

  function setCompacting(workspaceId: string, value: boolean): void {
    if ((compacting.value.get(workspaceId) ?? false) === value) return
    compacting.value.set(workspaceId, value)
    touch(workspaceId)
  }

  function eventsFor(workspaceId: string): AgentEvent[] {
    track(workspaceId)
    return events.value.get(workspaceId) ?? []
  }

  function timestampsFor(workspaceId: string): string[] {
    track(workspaceId)
    return timestamps.value.get(workspaceId) ?? []
  }

  function sessionIdsFor(workspaceId: string): Array<string | null> {
    track(workspaceId)
    return sessionIds.value.get(workspaceId) ?? []
  }

  function eventIdsFor(workspaceId: string): Array<string | null> {
    track(workspaceId)
    return eventIds.value.get(workspaceId) ?? []
  }

  function oldestIdFor(workspaceId: string): string | undefined {
    track(workspaceId)
    return oldestIds.value.get(workspaceId)
  }

  function hasMoreOlderFor(workspaceId: string): boolean {
    track(workspaceId)
    return hasMoreOlder.value.get(workspaceId) ?? true
  }

  function append(
    workspaceId: string,
    event: AgentEvent,
    ts?: string,
    eventId?: string,
    sessionId?: string | null,
  ): void {
    const list = events.value.get(workspaceId) ?? []
    const tsList = timestamps.value.get(workspaceId) ?? []
    const sList = sessionIds.value.get(workspaceId) ?? []
    const idList = eventIds.value.get(workspaceId) ?? []
    const known = idIndexFor(workspaceId)
    if (eventId && known.has(eventId)) return
    const isFirst = list.length === 0
    list.push(event)
    tsList.push(ts ?? new Date().toISOString())
    sList.push(sessionId ?? null)
    idList.push(eventId ?? null)
    if (eventId) known.add(eventId)
    events.value.set(workspaceId, list)
    timestamps.value.set(workspaceId, tsList)
    sessionIds.value.set(workspaceId, sList)
    eventIds.value.set(workspaceId, idList)
    if (isFirst && eventId) {
      oldestIds.value.set(workspaceId, eventId)
    }
    trimOldestLiveEvents(workspaceId, list, tsList, sList, idList)
    touch(workspaceId)
  }

  function trimOldestLiveEvents(
    workspaceId: string,
    list: AgentEvent[],
    tsList: string[],
    sList: Array<string | null>,
    idList: Array<string | null>,
  ): void {
    const overflow = list.length - MAX_LIVE_EVENTS_PER_WORKSPACE
    if (overflow <= 0) return
    // Capture the ids BEFORE splicing: they have to leave the index too, or a
    // re-delivered old event could never be appended again after a reconnect.
    const removedIds = idList.slice(0, overflow)
    const known = idIndexFor(workspaceId)
    for (const id of removedIds) if (id) known.delete(id)
    list.splice(0, overflow)
    tsList.splice(0, overflow)
    sList.splice(0, overflow)
    idList.splice(0, overflow)
    const firstPersistedId = idList.find((id): id is string => typeof id === 'string')
    if (firstPersistedId) oldestIds.value.set(workspaceId, firstPersistedId)
    else oldestIds.value.delete(workspaceId)
    hasMoreOlder.value.set(workspaceId, true)
  }

  /** Merge a reconnect delta, preserving existing history and ignoring duplicates. */
  function merge(
    workspaceId: string,
    incomingEvents: AgentEvent[],
    incomingTimestamps: string[],
    meta: { sessionIds: Array<string | null>; eventIds: Array<string | null> },
  ): number[] {
    const list = events.value.get(workspaceId) ?? []
    const tsList = timestamps.value.get(workspaceId) ?? []
    const sList = sessionIds.value.get(workspaceId) ?? []
    const idList = eventIds.value.get(workspaceId) ?? []
    const known = idIndexFor(workspaceId)
    const addedIndexes: number[] = []
    for (let i = 0; i < incomingEvents.length; i++) {
      const event = incomingEvents[i]
      if (!event) continue
      const eventId = meta.eventIds[i] ?? null
      if (eventId && known.has(eventId)) continue
      list.push(event)
      tsList.push(incomingTimestamps[i] ?? new Date().toISOString())
      sList.push(meta.sessionIds[i] ?? null)
      idList.push(eventId)
      if (eventId) known.add(eventId)
      addedIndexes.push(i)
    }
    if (addedIndexes.length === 0) return addedIndexes
    events.value.set(workspaceId, list)
    timestamps.value.set(workspaceId, tsList)
    sessionIds.value.set(workspaceId, sList)
    eventIds.value.set(workspaceId, idList)
    if (!oldestIds.value.has(workspaceId)) {
      const firstPersistedId = idList.find((id): id is string => typeof id === 'string')
      if (firstPersistedId) oldestIds.value.set(workspaceId, firstPersistedId)
    }
    trimOldestLiveEvents(workspaceId, list, tsList, sList, idList)
    touch(workspaceId)
    return addedIndexes
  }

  function reset(
    workspaceId: string,
    list: AgentEvent[],
    tsList?: string[],
    meta?: {
      oldestId?: string
      hasMoreOlder?: boolean
      sessionIds?: Array<string | null>
      eventIds?: Array<string | null>
    },
  ): void {
    events.value.set(workspaceId, [...list])
    timestamps.value.set(workspaceId, tsList ? [...tsList] : list.map(() => new Date().toISOString()))
    sessionIds.value.set(workspaceId, meta?.sessionIds ? [...meta.sessionIds] : list.map(() => null))
    const resetIds = meta?.eventIds ? [...meta.eventIds] : list.map(() => null)
    eventIds.value.set(workspaceId, resetIds)
    // Rebuild the index from scratch: a reset replaces the whole window, so a
    // stale id left behind would silently block a legitimate new event.
    const known = idIndexFor(workspaceId)
    known.clear()
    for (const id of resetIds) if (id) known.add(id)
    if (meta?.oldestId) oldestIds.value.set(workspaceId, meta.oldestId)
    else oldestIds.value.delete(workspaceId)
    if (meta && typeof meta.hasMoreOlder === 'boolean') hasMoreOlder.value.set(workspaceId, meta.hasMoreOlder)
    else hasMoreOlder.value.delete(workspaceId)
    touch(workspaceId)
  }

  function prepend(
    workspaceId: string,
    olderEvents: AgentEvent[],
    olderTimestamps: string[],
    meta: {
      oldestId: string | undefined
      hasMoreOlder: boolean
      sessionIds?: Array<string | null>
      eventIds?: Array<string | null>
    },
  ): void {
    if (olderEvents.length === 0) {
      hasMoreOlder.value.set(workspaceId, meta.hasMoreOlder)
      touch(workspaceId)
      return
    }
    const list = events.value.get(workspaceId) ?? []
    const tsList = timestamps.value.get(workspaceId) ?? []
    const sList = sessionIds.value.get(workspaceId) ?? []
    const idList = eventIds.value.get(workspaceId) ?? []
    const olderSids = meta.sessionIds ?? olderEvents.map(() => null)
    const olderIds = meta.eventIds ?? olderEvents.map(() => null)
    events.value.set(workspaceId, [...olderEvents, ...list])
    timestamps.value.set(workspaceId, [...olderTimestamps, ...tsList])
    sessionIds.value.set(workspaceId, [...olderSids, ...sList])
    eventIds.value.set(workspaceId, [...olderIds, ...idList])
    const known = idIndexFor(workspaceId)
    for (const id of olderIds) if (id) known.add(id)
    if (meta.oldestId) oldestIds.value.set(workspaceId, meta.oldestId)
    hasMoreOlder.value.set(workspaceId, meta.hasMoreOlder)
    touch(workspaceId)
  }

  /**
   * Remove a single event from the stream by its persisted ws_events row id.
   * No-op if the id is null/undefined or not found. Used by features that
   * server-side delete an event (e.g. dismissing the agent error banner)
   * to keep the local view in sync without waiting for a refresh.
   */
  function removeByEventId(workspaceId: string, eventId: string): void {
    const list = events.value.get(workspaceId)
    const idList = eventIds.value.get(workspaceId)
    if (!list || !idList) return
    const idx = idList.indexOf(eventId)
    if (idx === -1) return
    const tsList = timestamps.value.get(workspaceId)
    const sList = sessionIds.value.get(workspaceId)
    list.splice(idx, 1)
    idList.splice(idx, 1)
    if (tsList) tsList.splice(idx, 1)
    if (sList) sList.splice(idx, 1)
    idIndexFor(workspaceId).delete(eventId)
    touch(workspaceId)
  }

  function clear(workspaceId: string): void {
    events.value.delete(workspaceId)
    timestamps.value.delete(workspaceId)
    sessionIds.value.delete(workspaceId)
    eventIds.value.delete(workspaceId)
    oldestIds.value.delete(workspaceId)
    hasMoreOlder.value.delete(workspaceId)
    compacting.value.delete(workspaceId)
    eventIdIndex.value.delete(workspaceId)
    // Bump rather than delete: consumers still tracking this workspace need a
    // trigger to re-read an empty stream.
    touch(workspaceId)
  }

  return {
    events,
    timestamps,
    sessionIds,
    eventIds,
    versions,
    versionFor,
    eventsFor,
    timestampsFor,
    sessionIdsFor,
    eventIdsFor,
    oldestIdFor,
    hasMoreOlderFor,
    isCompacting,
    setCompacting,
    append,
    merge,
    reset,
    prepend,
    removeByEventId,
    clear,
  }
})
