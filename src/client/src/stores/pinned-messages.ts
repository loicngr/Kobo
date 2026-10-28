import { defineStore } from 'pinia'
import { apiFetch } from 'src/utils/api'
import { ref } from 'vue'
import type { PinnedMessage, PinnedMessageDetail, PinnedMessagesPage } from '../../../shared/pinned-messages'

interface PinList {
  pins: PinnedMessage[]
  loading: boolean
  loaded: boolean
  error: string
  hasMore: boolean
}

export const usePinnedMessagesStore = defineStore('pinned-messages', () => {
  const lists = ref<Record<string, PinList>>({})
  const versions = new Map<string, number>()
  const mutations = new Map<string, number>()

  function list(workspaceId?: string): PinList {
    const key = workspaceId ?? '*'
    lists.value[key] ??= { pins: [], loading: false, loaded: false, error: '', hasMore: false }
    return lists.value[key]
  }

  async function load(workspaceId?: string, more = false) {
    const key = workspaceId ?? '*'
    const state = list(workspaceId)
    const version = (versions.get(key) ?? 0) + 1
    versions.set(key, version)
    const mutation = mutations.get(key) ?? 0
    const current = () => versions.get(key) === version && (mutations.get(key) ?? 0) === mutation
    state.loading = true
    state.error = ''
    let offset = more ? state.pins.length : 0
    const targetCount = more ? 0 : state.pins.length
    const pins = more ? [...state.pins] : []
    try {
      let hasMore: boolean
      do {
        const query = new URLSearchParams({ limit: '100', offset: String(offset) })
        if (workspaceId) query.set('workspaceId', workspaceId)
        const page = await apiFetch<PinnedMessagesPage>(`/api/pinned-messages?${query}`)
        if (!current()) return
        pins.push(...page.pins)
        offset += page.pins.length
        hasMore = page.hasMore && page.pins.length > 0
        // Workspace metadata drives every card's indicator, including older pins.
      } while (hasMore && (workspaceId || pins.length < targetCount))
      state.pins = [...new Map(pins.map((pin) => [pin.id, pin])).values()]
      state.hasMore = hasMore
      state.loaded = true
    } catch (error) {
      if (current()) state.error = error instanceof Error ? error.message : String(error)
    } finally {
      if (versions.get(key) === version) state.loading = false
    }
  }

  function find(workspaceId: string, sessionId: string | null, itemKeys: string[]) {
    return list(workspaceId).pins.find(
      (pin) => pin.sessionId === sessionId && pin.itemKeys.some((key) => itemKeys.includes(key)),
    )
  }

  function refresh(workspaceId?: string) {
    return Promise.all(
      Object.keys(lists.value)
        .filter((key) => !workspaceId || key === workspaceId || key === '*')
        .map((key) => load(key === '*' ? undefined : key)),
    )
  }

  function invalidateMutation(workspaceId: string) {
    for (const key of [workspaceId, '*']) mutations.set(key, (mutations.get(key) ?? 0) + 1)
  }

  async function pin(workspaceId: string, sessionId: string | null, eventIds: string[]) {
    invalidateMutation(workspaceId)
    try {
      const saved = await apiFetch<PinnedMessage>('/api/pinned-messages', {
        method: 'POST',
        body: { workspaceId, ...(sessionId ? { sessionId } : {}), eventIds },
      })
      for (const key of [workspaceId, '*']) {
        const state = lists.value[key]
        if (!state) continue
        state.pins = [saved, ...state.pins.filter((pin) => pin.id !== saved.id)].sort(
          (a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
        )
      }
      return saved
    } finally {
      invalidateMutation(workspaceId)
      void refresh(workspaceId)
    }
  }

  async function unpin(pin: PinnedMessage) {
    invalidateMutation(pin.workspaceId)
    try {
      await apiFetch(`/api/pinned-messages/${encodeURIComponent(pin.id)}`, { method: 'DELETE' })
      for (const state of Object.values(lists.value)) state.pins = state.pins.filter((item) => item.id !== pin.id)
    } finally {
      invalidateMutation(pin.workspaceId)
      void refresh(pin.workspaceId)
    }
  }

  function detail(id: string) {
    return apiFetch<PinnedMessageDetail>(`/api/pinned-messages/${encodeURIComponent(id)}`)
  }

  return { lists, list, load, find, refresh, pin, unpin, detail }
})
