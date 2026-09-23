import { defineStore } from 'pinia'
import { apiFetch } from 'src/utils/api'

export interface ActivityItem {
  id: number
  workspaceId: string
  workspaceName: string
  kind: string
  sessionId: string | null
  createdAt: string
}
interface ActivityPage {
  items: ActivityItem[]
  nextCursor: number
  cursor: number
  hasMore: boolean
}
const KEY = 'kobo:activityVisit'
function readVisit(): { cursor: number; seenAt: string } | null {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? 'null')
    return value && Number.isSafeInteger(value.cursor) && value.cursor >= 0 && typeof value.seenAt === 'string'
      ? value
      : null
  } catch {
    return null
  }
}
export const useActivityStore = defineStore('activity', {
  state: () => {
    const visit = readVisit()
    return {
      cursor: visit?.cursor ?? (null as number | null),
      since: visit?.seenAt ?? '',
      items: [] as ActivityItem[],
      nextCursor: visit?.cursor ?? 0,
      hasMore: false,
      error: false,
      loading: false,
      present: false,
      epoch: 0,
    }
  },
  actions: {
    checkpoint(cursor: number, reset = false) {
      // Another open tab may already have acknowledged a more recent event.
      const saved = readVisit()
      this.cursor = reset ? cursor : Math.max(cursor, saved?.cursor ?? 0)
      const seenAt = new Date().toISOString()
      this.since = seenAt
      try {
        localStorage.setItem(KEY, JSON.stringify({ cursor: this.cursor, seenAt }))
      } catch {
        /* memory-only fallback */
      }
    },
    leaveApp() {
      this.present = false
      this.loading = false
      this.epoch++
    },
    connectionLost() {
      this.epoch++
      this.loading = false
      this.error = true
    },
    async returnToApp() {
      this.present = true
      const epoch = ++this.epoch
      this.loading = true
      this.error = false
      try {
        if (this.cursor === null) {
          const head = await apiFetch<{ cursor: number }>('/api/activity?head=1')
          if (this.epoch === epoch && this.present) this.checkpoint(head.cursor)
        } else {
          await this.readPage(this.cursor, epoch)
        }
      } catch {
        if (this.epoch === epoch) this.error = true
      } finally {
        if (this.epoch === epoch) this.loading = false
      }
    },
    async readPage(after: number, epoch: number, append = false) {
      let page = await apiFetch<ActivityPage>(`/api/activity?after=${after}`)
      if (this.epoch !== epoch || !this.present) return
      if (page.cursor < after) {
        // A restored database may reuse older sequence numbers. Recover retained
        // activity instead of keeping a checkpoint ahead of the entire journal.
        this.checkpoint(0, true)
        this.items = []
        this.nextCursor = 0
        this.hasMore = false
        append = false
        page = await apiFetch<ActivityPage>('/api/activity?after=0')
        if (this.epoch !== epoch || !this.present) return
      }
      this.items = append ? [...this.items, ...page.items] : page.items
      this.nextCursor = page.nextCursor
      this.hasMore = page.hasMore
      this.error = false
      if (!this.items.length && !page.hasMore) this.checkpoint(page.cursor)
    },
    async loadMore() {
      if (this.loading || !this.hasMore) return
      this.loading = true
      const epoch = this.epoch
      try {
        await this.readPage(this.nextCursor, epoch, true)
      } catch {
        if (this.epoch === epoch) this.error = true
      } finally {
        if (this.epoch === epoch) this.loading = false
      }
    },
    async heartbeat() {
      if (!this.present || this.loading || this.items.length || this.hasMore) return
      // An unsuccessful observation is an absence, even while the tab is visible.
      // Fetch the missing events before any later head request can mark them read.
      if (this.error || this.cursor === null) {
        await this.returnToApp()
        return
      }
      const epoch = this.epoch
      this.loading = true
      try {
        const head = await apiFetch<{ cursor: number }>('/api/activity?head=1')
        if (!this.present || this.epoch !== epoch || this.items.length) return
        if (head.cursor < this.cursor) {
          this.checkpoint(0, true)
          this.nextCursor = 0
          await this.readPage(0, epoch)
        } else this.checkpoint(head.cursor)
      } catch {
        if (this.epoch === epoch) this.error = true
      } finally {
        if (this.epoch === epoch) this.loading = false
      }
    },
    markRead() {
      this.checkpoint(this.nextCursor)
      this.items = []
      this.since = new Date().toISOString()
      if (this.hasMore) void this.returnToApp()
    },
  },
})
