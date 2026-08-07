import { defineStore } from 'pinia'

export interface SearchResult {
  eventId: string
  sessionId: string | null
  workspaceId: string
  workspaceName: string
  archived: boolean
  /** `'user:message'` or `'agent:output'` — matches what the backend returns. */
  type: string
  timestamp: string
  snippet: string
}

interface SearchState {
  query: string
  includeArchived: boolean
  results: SearchResult[]
  loading: boolean
  error: string
  _requestToken: number
}

export const useSearchStore = defineStore('search', {
  state: (): SearchState => ({
    query: '',
    includeArchived: false,
    results: [],
    loading: false,
    error: '',
    _requestToken: 0,
  }),

  actions: {
    /**
     * Run a search against `/api/search` using the current `query` and
     * `includeArchived` flag. Empty queries short-circuit to a reset state
     * without hitting the network.
     */
    async search(): Promise<void> {
      const q = this.query.trim()
      if (!q) {
        this._requestToken++
        this.results = []
        this.error = ''
        this.loading = false
        return
      }

      const requestToken = ++this._requestToken
      this.loading = true
      this.error = ''
      try {
        const params = new URLSearchParams({ q })
        if (this.includeArchived) params.set('includeArchived', 'true')
        const res = await fetch(`/api/search?${params.toString()}`)
        if (!res.ok) {
          let message = `HTTP ${res.status}`
          try {
            const body = (await res.json()) as { error?: string }
            if (body?.error) message = body.error
          } catch {
            // Non-JSON error body — fall back to status message
          }
          throw new Error(message)
        }
        const results = (await res.json()) as SearchResult[]
        // A newer search may have started while this one was in flight —
        // only the most recently issued request is allowed to write.
        if (requestToken !== this._requestToken) return
        this.results = results
      } catch (err) {
        if (requestToken !== this._requestToken) return
        this.error = err instanceof Error ? err.message : String(err)
        this.results = []
      } finally {
        if (requestToken === this._requestToken) this.loading = false
      }
    },

    clear(): void {
      this._requestToken++
      this.query = ''
      this.results = []
      this.error = ''
      this.loading = false
    },
  },
})
