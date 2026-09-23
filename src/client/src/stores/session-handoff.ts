import { defineStore } from 'pinia'
import { apiFetch } from 'src/utils/api'
import { isHandoffPending, type SessionHandoff, type SessionHandoffRequest } from '../../../shared/session-handoff'
import { useWorkspaceStore } from './workspace'

export const useSessionHandoffStore = defineStore('session-handoff', {
  state: () => ({
    current: {} as Record<string, SessionHandoff | null>,
    versions: {} as Record<string, number>,
    selectedTargets: {} as Record<string, string>,
    selectedSources: {} as Record<string, string>,
    followedHandoffs: {} as Record<string, string>,
    loadErrors: {} as Record<string, string | null>,
  }),
  getters: {
    isActive: (state) => (workspaceId: string) =>
      ['stopping', 'generating', 'starting'].includes(state.current[workspaceId]?.state ?? ''),
    isBlocking: (state) => (workspaceId: string) => isHandoffPending(state.current[workspaceId]),
  },
  actions: {
    apply(handoff: SessionHandoff, initiated = false) {
      const previous = this.current[handoff.workspaceId]
      if (previous && Date.parse(previous.updatedAt) > Date.parse(handoff.updatedAt)) return
      this.versions[handoff.workspaceId] = (this.versions[handoff.workspaceId] ?? 0) + 1
      this.current[handoff.workspaceId] = handoff
      this.loadErrors[handoff.workspaceId] = null
      if (initiated || this.isActive(handoff.workspaceId)) this.followedHandoffs[handoff.workspaceId] = handoff.id
      const shouldFollow = this.followedHandoffs[handoff.workspaceId] === handoff.id
      // A completed snapshot is history after reload. Only a transfer followed
      // by this pane (or explicitly initiated here) may change its selection.
      if (!isHandoffPending(handoff)) delete this.followedHandoffs[handoff.workspaceId]
      const workspace = useWorkspaceStore()
      const sourceSelection = `${handoff.id}:${handoff.targetSessionId}:${handoff.state === 'cancelled' ? 'cancelled' : 'restored'}`
      if (
        shouldFollow &&
        ['failed', 'interrupted', 'cancelled'].includes(handoff.state) &&
        workspace.selectedWorkspaceId === handoff.workspaceId &&
        this.selectedSources[handoff.workspaceId] !== sourceSelection
      ) {
        this.selectedSources[handoff.workspaceId] = sourceSelection
        void workspace.fetchSessions(handoff.workspaceId, handoff.sourceSessionId)
      }
      if (
        shouldFollow &&
        handoff.state === 'completed' &&
        handoff.targetSessionId &&
        workspace.selectedWorkspaceId === handoff.workspaceId &&
        this.selectedTargets[handoff.workspaceId] !== handoff.id
      ) {
        this.selectedTargets[handoff.workspaceId] = handoff.id
        void workspace.fetchSessions(handoff.workspaceId, handoff.targetSessionId)
      }
    },
    async refresh(workspaceId: string) {
      const version = this.versions[workspaceId] ?? 0
      try {
        const { handoff } = await apiFetch<{ handoff: SessionHandoff | null }>(
          `/api/workspaces/${workspaceId}/session-handoffs/current`,
        )
        if ((this.versions[workspaceId] ?? 0) !== version) return
        this.loadErrors[workspaceId] = null
        if (handoff) this.apply(handoff)
        else this.current[workspaceId] = null
      } catch (error) {
        this.loadErrors[workspaceId] = error instanceof Error ? error.message : String(error)
        throw error
      }
    },
    async start(workspaceId: string, input: SessionHandoffRequest): Promise<SessionHandoff> {
      const version = this.versions[workspaceId] ?? 0
      const { handoff } = await apiFetch<{ handoff: SessionHandoff }>(
        `/api/workspaces/${workspaceId}/session-handoffs`,
        { method: 'POST', body: input },
      )
      const current = this.current[workspaceId]
      this.apply((this.versions[workspaceId] ?? 0) !== version && current?.id === handoff.id ? current : handoff, true)
      return handoff
    },
    async decide(workspaceId: string, handoffId: string, action: 'retry' | 'skip' | 'cancel'): Promise<SessionHandoff> {
      const version = this.versions[workspaceId] ?? 0
      const { handoff } = await apiFetch<{ handoff: SessionHandoff }>(
        `/api/workspaces/${workspaceId}/session-handoffs/${handoffId}/decision`,
        { method: 'POST', body: { action } },
      )
      const current = this.current[workspaceId]
      this.apply((this.versions[workspaceId] ?? 0) !== version && current?.id === handoff.id ? current : handoff, true)
      return handoff
    },
  },
})
