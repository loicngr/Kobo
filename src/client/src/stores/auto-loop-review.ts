import { defineStore } from 'pinia'
import { apiFetch } from 'src/utils/api'
import type { AutoLoopFinalReviewStatus, AutoLoopReviewConfiguration } from '../../../shared/auto-loop-review'
import type { ReviewReturnStatus } from '../../../shared/review-return'

export const useAutoLoopReviewStore = defineStore('auto-loop-review', {
  state: () => ({
    finalReviews: {} as Record<string, AutoLoopFinalReviewStatus>,
    returns: {} as Record<string, ReviewReturnStatus | null>,
    finalVersions: {} as Record<string, number>,
    returnVersions: {} as Record<string, number>,
  }),
  actions: {
    setFinalReview(id: string, status: AutoLoopFinalReviewStatus) {
      this.finalVersions[id] = (this.finalVersions[id] ?? 0) + 1
      this.finalReviews[id] = status
    },
    async fetchFinalReview(id: string) {
      const version = (this.finalVersions[id] ?? 0) + 1
      this.finalVersions[id] = version
      const status = await apiFetch<AutoLoopFinalReviewStatus>(`/api/workspaces/${id}/auto-loop/final-review`, {
        cache: 'no-store',
      })
      if (this.finalVersions[id] === version) this.finalReviews[id] = status
    },
    async saveFinalReview(id: string, configuration: AutoLoopReviewConfiguration | null) {
      const version = (this.finalVersions[id] ?? 0) + 1
      this.finalVersions[id] = version
      const status = await apiFetch<AutoLoopFinalReviewStatus>(`/api/workspaces/${id}/auto-loop/final-review`, {
        method: 'PATCH',
        body: { configuration },
      })
      if (this.finalVersions[id] === version) this.finalReviews[id] = status
    },
    setReturn(id: string, status: ReviewReturnStatus | null) {
      this.returnVersions[id] = (this.returnVersions[id] ?? 0) + 1
      this.returns[id] = status
    },
    async fetchReturn(id: string) {
      if (!(id in this.returns)) this.returns[id] = null
      const version = (this.returnVersions[id] ?? 0) + 1
      this.returnVersions[id] = version
      const status = await apiFetch<ReviewReturnStatus | null>(`/api/workspaces/${id}/review-return`, {
        cache: 'no-store',
      })
      if (this.returnVersions[id] === version) this.returns[id] = status
    },
    async resolveReturn(id: string, action: 'retry' | 'cancel') {
      await apiFetch(`/api/workspaces/${id}/review-return/${action}`, { method: 'POST' })
      await this.fetchReturn(id)
    },
    async refreshKnown() {
      await Promise.allSettled([
        ...Object.keys(this.finalReviews).map((id) => this.fetchFinalReview(id)),
        ...Object.keys(this.returns).map((id) => this.fetchReturn(id)),
      ])
    },
    forget(id: string) {
      this.finalVersions[id] = (this.finalVersions[id] ?? 0) + 1
      this.returnVersions[id] = (this.returnVersions[id] ?? 0) + 1
      delete this.finalReviews[id]
      delete this.returns[id]
    },
  },
})
