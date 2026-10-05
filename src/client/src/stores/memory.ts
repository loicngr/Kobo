import { defineStore } from 'pinia'
import { apiFetchResponse, apiResponseError } from 'src/utils/api'
import { createLatestRequest, isAbortError } from 'src/utils/latest-request'
import { ref } from 'vue'
import type { MemoryContextViewRecord, MemoryEntry, MemoryOperation, MemoryProposal } from '../../../shared/memory'

export interface MemoryScopeRecord {
  id: string
  level: 'global' | 'project' | 'workspace'
  projectPath?: string
  workspaceId?: string
  generation: number
  revision: number
}

export interface MemoryWorkspaceView {
  scopes: MemoryScopeRecord[]
  entries: MemoryEntry[]
  entriesNextCursor?: string
  entriesTotalCount?: number
  proposals: MemoryProposal[]
  contexts: MemoryContextViewRecord[]
  sessionId?: string
}

interface MemoryPage<T> {
  items: T[]
  nextCursor?: string
  totalCount?: number
}

interface MemoryInvalidation {
  scopeId: string
  level: 'global' | 'project' | 'workspace'
  revision: number
  generation: number
  operationId: number
  journalOnly?: boolean
}

function workspaceKey(workspaceId: string, sessionId?: string): string {
  return JSON.stringify([workspaceId, sessionId ?? ''])
}

async function jsonRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await apiFetchResponse(path, init)
  if (!response.ok) throw await apiResponseError(response)
  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

export const useMemoryStore = defineStore('memory', () => {
  const activeWorkspaceKey = ref<string | null>(null)
  const workspaceViews = ref<Record<string, MemoryWorkspaceView>>({})
  const loadingWorkspaceKeys = ref<Record<string, boolean>>({})
  const invalidatedWorkspaceKeys = ref<string[]>([])
  const scopesByKey = ref<Record<string, MemoryPage<MemoryScopeRecord>>>({})
  const entriesByKey = ref<Record<string, MemoryPage<MemoryEntry>>>({})
  const proposalsByScope = ref<Record<string, MemoryProposal[]>>({})
  const operationsByScope = ref<Record<string, MemoryOperation[]>>({})
  const operationsCursors = ref<Record<string, string | undefined>>({})
  const loadingScopes = ref<Record<string, boolean>>({})
  const loadingEntries = ref<Record<string, boolean>>({})
  const loadingOperations = ref<Record<string, boolean>>({})
  const workspaceOperationsById = ref<Record<string, MemoryOperation[]>>({})
  const workspaceOperationsCursors = ref<Record<string, string | undefined>>({})
  const loadingWorkspaceOperations = ref<Record<string, boolean>>({})
  const latestWorkspaceView = createLatestRequest()
  const latestRequests = new Map<string, ReturnType<typeof createLatestRequest>>()
  const visibleScopes = new Set<string>()

  function viewKey(workspaceId: string, sessionId?: string): string {
    return workspaceKey(workspaceId, sessionId)
  }

  function workspaceView(workspaceId: string, sessionId?: string): MemoryWorkspaceView | undefined {
    return workspaceViews.value[viewKey(workspaceId, sessionId)]
  }

  function isWorkspaceInvalidated(workspaceId: string, sessionId?: string): boolean {
    return invalidatedWorkspaceKeys.value.includes(viewKey(workspaceId, sessionId))
  }

  async function loadWorkspace(workspaceId: string, sessionId?: string, background = false): Promise<void> {
    const key = viewKey(workspaceId, sessionId)
    activeWorkspaceKey.value = key
    const signal = latestWorkspaceView.begin()
    if (!background || !workspaceViews.value[key]) loadingWorkspaceKeys.value[key] = true
    const query = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''
    try {
      const result = await jsonRequest<MemoryWorkspaceView>(
        `/api/memory/workspaces/${encodeURIComponent(workspaceId)}/view${query}`,
        {
          signal,
        },
      )
      if (!latestWorkspaceView.isCurrent(signal)) return
      workspaceViews.value[key] = result
      invalidatedWorkspaceKeys.value = invalidatedWorkspaceKeys.value.filter((item) => item !== key)
      for (const scope of result.scopes) visibleScopes.add(scope.id)
    } catch (error) {
      if (isAbortError(error) || !latestWorkspaceView.isCurrent(signal)) return
      throw error
    } finally {
      if (latestWorkspaceView.isCurrent(signal)) delete loadingWorkspaceKeys.value[key]
    }
  }

  function requestFor(key: string): ReturnType<typeof createLatestRequest> {
    let request = latestRequests.get(key)
    if (!request) {
      request = createLatestRequest()
      latestRequests.set(key, request)
    }
    return request
  }

  async function loadMoreWorkspaceEntries(workspaceId: string, sessionId?: string): Promise<void> {
    const key = viewKey(workspaceId, sessionId)
    const current = workspaceViews.value[key]
    if (activeWorkspaceKey.value !== key || !current?.entriesNextCursor || loadingWorkspaceKeys.value[key]) return
    const signal = latestWorkspaceView.begin()
    loadingWorkspaceKeys.value[key] = true
    try {
      const query = new URLSearchParams({ workspaceId, cursor: current.entriesNextCursor })
      const page = await jsonRequest<MemoryPage<MemoryEntry>>(`/api/memory/entries?${query}`, { signal })
      if (!latestWorkspaceView.isCurrent(signal) || activeWorkspaceKey.value !== key) return
      current.entries = [...new Map([...current.entries, ...page.items].map((entry) => [entry.id, entry])).values()]
      current.entriesNextCursor = page.nextCursor
    } catch (error) {
      if (isAbortError(error) || !latestWorkspaceView.isCurrent(signal)) return
      throw error
    } finally {
      delete loadingWorkspaceKeys.value[key]
    }
  }

  async function loadScopes(workspaceId?: string, background = false, append = false): Promise<void> {
    const key = workspaceId ? `workspace:${workspaceId}` : 'all'
    const signal = requestFor(`scopes:${key}`).begin()
    if (!background || !scopesByKey.value[key]) loadingScopes.value[key] = true
    const current = scopesByKey.value[key]
    const query = new URLSearchParams()
    if (workspaceId) query.set('workspaceId', workspaceId)
    if (append && current?.nextCursor) query.set('cursor', current.nextCursor)
    const queryString = query.size ? `?${query}` : ''
    try {
      const result = await jsonRequest<MemoryPage<MemoryScopeRecord>>(`/api/memory/scopes${queryString}`, { signal })
      if (!requestFor(`scopes:${key}`).isCurrent(signal)) return
      const items = append && current ? [...current.items, ...result.items] : result.items
      const uniqueItems = [...new Map(items.map((scope) => [scope.id, scope])).values()]
      scopesByKey.value[key] = { ...result, items: uniqueItems }
      for (const scope of result.items) visibleScopes.add(scope.id)
    } catch (error) {
      if (isAbortError(error) || !requestFor(`scopes:${key}`).isCurrent(signal)) return
      throw error
    } finally {
      if (requestFor(`scopes:${key}`).isCurrent(signal)) delete loadingScopes.value[key]
    }
  }

  function loadMoreScopes(workspaceId?: string): Promise<void> {
    return loadScopes(workspaceId, true, true)
  }

  function hasMoreScopes(workspaceId?: string): boolean {
    return Boolean(scopesByKey.value[workspaceId ? `workspace:${workspaceId}` : 'all']?.nextCursor)
  }

  function scopesFor(workspaceId?: string): MemoryScopeRecord[] {
    return scopesByKey.value[workspaceId ? `workspace:${workspaceId}` : 'all']?.items ?? []
  }

  async function loadEntries(scopeId: string, query = '', append = false): Promise<void> {
    const key = `${scopeId}\u0000${query}`
    const signal = requestFor(`entries:${key}`).begin()
    const current = entriesByKey.value[key]
    loadingEntries.value[key] = true
    const cursor = append ? current?.nextCursor : undefined
    const search = new URLSearchParams({ scopeId })
    if (query) search.set('query', query)
    if (cursor) search.set('cursor', cursor)
    try {
      const page = await jsonRequest<MemoryPage<MemoryEntry>>(`/api/memory/entries?${search}`, { signal })
      if (!requestFor(`entries:${key}`).isCurrent(signal)) return
      entriesByKey.value[key] = append && current ? { ...page, items: [...current.items, ...page.items] } : page
      visibleScopes.add(scopeId)
    } catch (error) {
      if (isAbortError(error) || !requestFor(`entries:${key}`).isCurrent(signal)) return
      throw error
    } finally {
      if (requestFor(`entries:${key}`).isCurrent(signal)) delete loadingEntries.value[key]
    }
  }

  function entriesFor(scopeId: string, query = ''): MemoryEntry[] {
    return entriesByKey.value[`${scopeId}\u0000${query}`]?.items ?? []
  }

  function hasMoreEntries(scopeId: string, query = ''): boolean {
    return Boolean(entriesByKey.value[`${scopeId}\u0000${query}`]?.nextCursor)
  }

  async function loadProposals(scopeId: string, background = false): Promise<void> {
    const signal = requestFor(`proposals:${scopeId}`).begin()
    try {
      const result = await jsonRequest<{ items: MemoryProposal[] }>(
        `/api/memory/proposals?scopeId=${encodeURIComponent(scopeId)}`,
        {
          signal,
        },
      )
      if (requestFor(`proposals:${scopeId}`).isCurrent(signal)) proposalsByScope.value[scopeId] = result.items
    } catch (error) {
      if (isAbortError(error) || !requestFor(`proposals:${scopeId}`).isCurrent(signal) || background) return
      throw error
    }
  }

  function proposalsFor(scopeId: string): MemoryProposal[] {
    return proposalsByScope.value[scopeId] ?? []
  }

  function pendingProposalCount(scopeIds?: string[]): number {
    const selected = scopeIds ?? Object.keys(proposalsByScope.value)
    return selected.reduce((count, scopeId) => count + (proposalsByScope.value[scopeId]?.length ?? 0), 0)
  }

  async function loadOperations(scopeId: string, append = false): Promise<void> {
    const signal = requestFor(`operations:${scopeId}`).begin()
    const cursor = append ? operationsCursors.value[scopeId] : undefined
    const query = new URLSearchParams({ scopeId, limit: '50' })
    if (cursor) query.set('afterCursor', cursor)
    loadingOperations.value[scopeId] = true
    try {
      const page = await jsonRequest<MemoryPage<MemoryOperation>>(`/api/memory/operations?${query}`, { signal })
      if (!requestFor(`operations:${scopeId}`).isCurrent(signal)) return
      operationsByScope.value[scopeId] = append
        ? [...(operationsByScope.value[scopeId] ?? []), ...page.items]
        : page.items
      operationsCursors.value[scopeId] = page.nextCursor
      visibleScopes.add(scopeId)
    } catch (error) {
      if (isAbortError(error) || !requestFor(`operations:${scopeId}`).isCurrent(signal)) return
      throw error
    } finally {
      if (requestFor(`operations:${scopeId}`).isCurrent(signal)) delete loadingOperations.value[scopeId]
    }
  }

  function operationsFor(scopeId: string): MemoryOperation[] {
    return operationsByScope.value[scopeId] ?? []
  }

  function operationsCursor(scopeId: string): string | undefined {
    return operationsCursors.value[scopeId]
  }

  async function loadWorkspaceOperations(workspaceId: string, append = false): Promise<void> {
    const requestKey = `workspace-operations:${workspaceId}`
    const signal = requestFor(requestKey).begin()
    const cursor = append ? workspaceOperationsCursors.value[workspaceId] : undefined
    const query = new URLSearchParams({ workspaceId, limit: '50' })
    if (cursor) query.set('afterCursor', cursor)
    loadingWorkspaceOperations.value[workspaceId] = true
    try {
      const page = await jsonRequest<MemoryPage<MemoryOperation>>(`/api/memory/operations?${query}`, { signal })
      if (!requestFor(requestKey).isCurrent(signal)) return
      const prior = append ? (workspaceOperationsById.value[workspaceId] ?? []) : []
      const items = [...prior, ...page.items]
      // The cursor is global across scopes, but de-duplicate defensively in
      // case a server retries a boundary row after concurrent inserts.
      workspaceOperationsById.value[workspaceId] = [...new Map(items.map((item) => [item.id, item])).values()]
      workspaceOperationsCursors.value[workspaceId] = page.nextCursor
    } catch (error) {
      if (isAbortError(error) || !requestFor(requestKey).isCurrent(signal)) return
      throw error
    } finally {
      if (requestFor(requestKey).isCurrent(signal)) delete loadingWorkspaceOperations.value[workspaceId]
    }
  }

  function workspaceOperationsFor(workspaceId: string): MemoryOperation[] {
    return workspaceOperationsById.value[workspaceId] ?? []
  }

  function workspaceOperationsCursor(workspaceId: string): string | undefined {
    return workspaceOperationsCursors.value[workspaceId]
  }

  function invalidate(change: MemoryInvalidation): void {
    if (change.journalOnly) {
      for (const scopeId of visibleScopes) {
        if (scopeId === change.scopeId) void loadOperations(scopeId)
      }
      for (const workspaceId of Object.keys(workspaceOperationsById.value)) {
        const appliesToWorkspace = Object.entries(workspaceViews.value).some(([key, view]) => {
          const [viewWorkspaceId] = JSON.parse(key) as [string, string]
          return viewWorkspaceId === workspaceId && view.scopes.some((scope) => scope.id === change.scopeId)
        })
        if (change.level === 'global' || appliesToWorkspace) void loadWorkspaceOperations(workspaceId)
      }
      return
    }
    const refreshScope = (scope: MemoryScopeRecord): MemoryScopeRecord =>
      scope.id === change.scopeId ? { ...scope, revision: change.revision, generation: change.generation } : scope
    for (const page of Object.values(scopesByKey.value)) page.items = page.items.map(refreshScope)
    for (const [key, view] of Object.entries(workspaceViews.value)) {
      view.scopes = view.scopes.map(refreshScope)
      if (change.level === 'global' || view.scopes.some((scope) => scope.id === change.scopeId)) {
        if (!invalidatedWorkspaceKeys.value.includes(key)) invalidatedWorkspaceKeys.value.push(key)
        const parsed = JSON.parse(key) as [string, string]
        if (key === activeWorkspaceKey.value) void loadWorkspace(parsed[0], parsed[1] || undefined, true)
      }
    }
    for (const workspaceId of Object.keys(workspaceOperationsById.value)) {
      const appliesToWorkspace = Object.entries(workspaceViews.value).some(([key, view]) => {
        const [viewWorkspaceId] = JSON.parse(key) as [string, string]
        return viewWorkspaceId === workspaceId && view.scopes.some((scope) => scope.id === change.scopeId)
      })
      if (change.level === 'global' || appliesToWorkspace) {
        void loadWorkspaceOperations(workspaceId)
      }
    }
    for (const scopeId of visibleScopes) {
      if (scopeId !== change.scopeId) continue
      for (const key of Object.keys(entriesByKey.value))
        if (key.startsWith(`${scopeId}\u0000`)) delete entriesByKey.value[key]
      delete proposalsByScope.value[scopeId]
      delete operationsByScope.value[scopeId]
      delete operationsCursors.value[scopeId]
      void loadEntries(scopeId, '')
      void loadProposals(scopeId, true)
      void loadOperations(scopeId)
    }
  }

  async function refreshVisibleData(): Promise<void> {
    const key = activeWorkspaceKey.value
    if (key) {
      const [workspaceId, sessionId] = JSON.parse(key) as [string, string]
      await loadWorkspace(workspaceId, sessionId || undefined, true)
      if (workspaceOperationsById.value[workspaceId]) await loadWorkspaceOperations(workspaceId)
    }
    for (const scopeId of visibleScopes) {
      await Promise.all([loadEntries(scopeId, ''), loadProposals(scopeId, true), loadOperations(scopeId)])
    }
  }

  function invalidateScopeCache(scopeId: string): void {
    const scope = [
      ...Object.values(scopesByKey.value).flatMap((page) => page.items),
      ...Object.values(workspaceViews.value).flatMap((view) => view.scopes),
    ].find((candidate) => candidate.id === scopeId)
    if (scope) {
      invalidate({
        scopeId,
        level: scope.level,
        revision: scope.revision + 1,
        generation: scope.generation,
        operationId: 0,
      })
      return
    }
    for (const key of Object.keys(entriesByKey.value))
      if (key.startsWith(`${scopeId}\u0000`)) delete entriesByKey.value[key]
    delete proposalsByScope.value[scopeId]
    delete operationsByScope.value[scopeId]
    delete operationsCursors.value[scopeId]
  }

  async function mutate<T>(path: string, method: string, body?: unknown): Promise<T> {
    const result = await jsonRequest<T>(path, {
      method,
      ...(body !== undefined ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } } : {}),
    })
    const values = body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
    const scopeIds = [values.scopeId, values.sourceScopeId, values.targetScopeId].filter(
      (value): value is string => typeof value === 'string',
    )
    const proposalId = /\/proposals\/([^/]+)\//.exec(path)?.[1]
    if (proposalId) {
      for (const [scopeId, proposals] of Object.entries(proposalsByScope.value)) {
        if (proposals.some((proposal) => proposal.id === decodeURIComponent(proposalId))) scopeIds.push(scopeId)
      }
    }
    for (const scopeId of new Set(scopeIds)) invalidateScopeCache(scopeId)
    return result
  }

  function createEntry(input: { scopeId: string; key: string; title: string; body: string }): Promise<MemoryEntry> {
    return mutate('/api/memory/entries', 'POST', input)
  }

  function updateEntry(
    entry: MemoryEntry,
    patch: { key?: string; title?: string; body?: string },
  ): Promise<MemoryEntry> {
    return mutate(`/api/memory/entries/${encodeURIComponent(entry.id)}`, 'PATCH', {
      scopeId: entry.scopeId,
      expectedRevision: entry.revision,
      ...patch,
    })
  }

  function deleteEntry(entry: MemoryEntry): Promise<void> {
    return mutate(`/api/memory/entries/${encodeURIComponent(entry.id)}`, 'DELETE', {
      scopeId: entry.scopeId,
      expectedRevision: entry.revision,
    })
  }

  function decideProposal(proposalId: string, decision: 'approve' | 'reject'): Promise<unknown> {
    return mutate(`/api/memory/proposals/${encodeURIComponent(proposalId)}/${decision}`, 'POST')
  }

  function promoteEntry(entry: MemoryEntry, targetScopeId: string): Promise<MemoryEntry> {
    return mutate(`/api/memory/entries/${encodeURIComponent(entry.id)}/promote`, 'POST', {
      sourceScopeId: entry.scopeId,
      targetScopeId,
    })
  }

  async function previewClear(scopeId: string): Promise<{ revision: number; entries: number; proposals: number }> {
    return jsonRequest(`/api/memory/scopes/${encodeURIComponent(scopeId)}/clear-preview`)
  }

  function clearScope(scopeId: string, expectedRevision: number): Promise<{ entries: number; proposals: number }> {
    return mutate(`/api/memory/scopes/${encodeURIComponent(scopeId)}/clear`, 'POST', { expectedRevision, scopeId })
  }

  return {
    activeWorkspaceKey,
    workspaceViews,
    loadingWorkspaceKeys,
    invalidatedWorkspaceKeys,
    scopesByKey,
    entriesByKey,
    proposalsByScope,
    operationsByScope,
    operationsCursors,
    loadingScopes,
    loadingEntries,
    loadingOperations,
    workspaceOperationsById,
    workspaceOperationsCursors,
    loadingWorkspaceOperations,
    workspaceView,
    isWorkspaceInvalidated,
    loadWorkspace,
    loadMoreWorkspaceEntries,
    loadScopes,
    loadMoreScopes,
    hasMoreScopes,
    scopesFor,
    loadEntries,
    entriesFor,
    hasMoreEntries,
    loadProposals,
    proposalsFor,
    pendingProposalCount,
    loadOperations,
    operationsFor,
    operationsCursor,
    loadWorkspaceOperations,
    workspaceOperationsFor,
    workspaceOperationsCursor,
    invalidate,
    refreshVisibleData,
    createEntry,
    updateEntry,
    deleteEntry,
    decideProposal,
    promoteEntry,
    previewClear,
    clearScope,
  }
})
