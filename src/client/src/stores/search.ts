import { defineStore } from 'pinia'

export interface SearchIndexStatus {
  state: 'building' | 'ready' | 'error'
  processed: number
  total: number
  error?: string
}

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
  indexStatus: SearchIndexStatus
  partial: boolean
  _abortController: AbortController | null
  _statusRequestToken: number
  _requestToken: number
}

export const useSearchStore = defineStore('search', {
  state: (): SearchState => ({
    query: '',
    includeArchived: false,
    results: [],
    loading: false,
    error: '',
    indexStatus: { state: 'building', processed: 0, total: 0 },
    partial: false,
    _abortController: null,
    _statusRequestToken: 0,
    _requestToken: 0,
  }),

  actions: {
    /**
     * Run a search against `/api/search` using the current `query` and
     * `includeArchived` flag. Empty queries short-circuit to a reset state
     * without hitting the network.
     */
    async refreshIndexStatus(signal?: AbortSignal): Promise<boolean> {
      const token = ++this._statusRequestToken
      try {
        const res = await fetch('/api/search/status', { signal })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const status = (await res.json()) as SearchIndexStatus
        if (signal?.aborted || token !== this._statusRequestToken) return false
        const changed = status.state !== this.indexStatus.state || status.processed !== this.indexStatus.processed
        this.indexStatus = status
        return changed
      } catch (err) {
        if (!signal?.aborted && token === this._statusRequestToken)
          this.indexStatus = {
            ...this.indexStatus,
            state: 'error',
            error: err instanceof Error ? err.message : String(err),
          }
        return false
      }
    },

    async search(background = false): Promise<void> {
      this._abortController?.abort()
      const q = this.query.trim()
      if (!q) {
        this._requestToken++
        this.results = []
        this.error = ''
        this.loading = false
        return
      }

      const requestToken = ++this._requestToken
      this.loading = !background
      this._abortController = new AbortController()
      this.error = ''
      try {
        const params = new URLSearchParams({ q })
        if (this.includeArchived) params.set('includeArchived', 'true')
        const res = await fetch(`/api/search?${params.toString()}`, { signal: this._abortController.signal })
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
        this.partial = res.headers.get('X-Kobo-Search-Partial') === 'true'
      } catch (err) {
        if (requestToken !== this._requestToken) return
        this.error = err instanceof Error ? err.message : String(err)
        this.results = []
      } finally {
        if (requestToken === this._requestToken) this.loading = false
      }
    },

    cancel(): void {
      this._requestToken++
      this._abortController?.abort()
      this._abortController = null
      this.loading = false
    },

    clear(): void {
      this._abortController?.abort()
      this.partial = false
      this._requestToken++
      this.query = ''
      this.results = []
      this.error = ''
      this.loading = false
    },
  },
})
