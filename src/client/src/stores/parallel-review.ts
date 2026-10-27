import { defineStore } from 'pinia'
import { apiFetch } from 'src/utils/api'
import type { ParallelReviewStatus } from '../../../shared/review'

export const useParallelReviewStore = defineStore('parallel-review', {
  state: () => ({
    statuses: {} as Record<string, ParallelReviewStatus | null>,
    versions: {} as Record<string, number>,
    sessions: {} as Record<string, string>,
    settled: {} as Record<string, boolean>,
  }),
  actions: {
    remember(workspaceId: string, sessionId: string) {
      this.sessions[sessionId] = workspaceId
    },
    isReviewer(workspaceId: string, sessionId?: string | null): boolean {
      return (
        !!sessionId &&
        (this.sessions[sessionId] === workspaceId || this.statuses[workspaceId]?.reviewSessionId === sessionId)
      )
    },
    setStatus(id: string, status: ParallelReviewStatus | null) {
      this.versions[id] = (this.versions[id] ?? 0) + 1
      this.statuses[id] = status
      if (status) this.remember(id, status.reviewSessionId)
    },
    async fetchStatus(id: string) {
      if (!(id in this.statuses)) this.statuses[id] = null
      const version = (this.versions[id] ?? 0) + 1
      this.versions[id] = version
      const status = await apiFetch<ParallelReviewStatus | null>(`/api/workspaces/${id}/parallel-review`, {
        cache: 'no-store',
      })
      if (this.versions[id] === version) this.setStatus(id, status)
    },
    async act(id: string, sessionId: string, action: 'stop' | 'retry-return' | 'cancel-return') {
      await apiFetch(`/api/workspaces/${id}/parallel-review/${action}`, { method: 'POST', body: { sessionId } })
      await this.fetchStatus(id)
    },
    async refreshKnown() {
      await Promise.allSettled(Object.keys(this.statuses).map((id) => this.fetchStatus(id)))
    },
    forget(id: string) {
      this.versions[id] = (this.versions[id] ?? 0) + 1
      delete this.statuses[id]
      for (const [sessionId, workspaceId] of Object.entries(this.sessions)) {
        if (workspaceId === id) {
          delete this.sessions[sessionId]
          delete this.settled[sessionId]
        }
      }
    },
  },
})
