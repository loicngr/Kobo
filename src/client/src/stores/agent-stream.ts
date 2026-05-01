import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { AgentEvent } from '../types/agent-event'

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
  const version = ref(0)

  function eventsFor(workspaceId: string): AgentEvent[] {
    version.value
    return events.value.get(workspaceId) ?? []
  }

  function timestampsFor(workspaceId: string): string[] {
    version.value
    return timestamps.value.get(workspaceId) ?? []
  }

  function sessionIdsFor(workspaceId: string): Array<string | null> {
    version.value
    return sessionIds.value.get(workspaceId) ?? []
  }

  function eventIdsFor(workspaceId: string): Array<string | null> {
    version.value
    return eventIds.value.get(workspaceId) ?? []
  }

  function oldestIdFor(workspaceId: string): string | undefined {
    version.value
    return oldestIds.value.get(workspaceId)
  }

  function hasMoreOlderFor(workspaceId: string): boolean {
    version.value
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
    const isFirst = list.length === 0
    list.push(event)
    tsList.push(ts ?? new Date().toISOString())
    sList.push(sessionId ?? null)
    idList.push(eventId ?? null)
    events.value.set(workspaceId, list)
    timestamps.value.set(workspaceId, tsList)
    sessionIds.value.set(workspaceId, sList)
    eventIds.value.set(workspaceId, idList)
    if (isFirst && eventId) {
      oldestIds.value.set(workspaceId, eventId)
    }
    version.value++
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
    eventIds.value.set(workspaceId, meta?.eventIds ? [...meta.eventIds] : list.map(() => null))
    if (meta?.oldestId) oldestIds.value.set(workspaceId, meta.oldestId)
    else oldestIds.value.delete(workspaceId)
    if (meta && typeof meta.hasMoreOlder === 'boolean') hasMoreOlder.value.set(workspaceId, meta.hasMoreOlder)
    else hasMoreOlder.value.delete(workspaceId)
    version.value++
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
      version.value++
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
    if (meta.oldestId) oldestIds.value.set(workspaceId, meta.oldestId)
    hasMoreOlder.value.set(workspaceId, meta.hasMoreOlder)
    version.value++
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
    version.value++
  }

  function clear(workspaceId: string): void {
    events.value.delete(workspaceId)
    timestamps.value.delete(workspaceId)
    sessionIds.value.delete(workspaceId)
    eventIds.value.delete(workspaceId)
    oldestIds.value.delete(workspaceId)
    hasMoreOlder.value.delete(workspaceId)
    version.value++
  }

  return {
    events,
    timestamps,
    sessionIds,
    eventIds,
    version,
    eventsFor,
    timestampsFor,
    sessionIdsFor,
    eventIdsFor,
    oldestIdFor,
    hasMoreOlderFor,
    append,
    reset,
    prepend,
    removeByEventId,
    clear,
  }
})
