import { defineStore } from 'pinia'

export interface DevServerStatus {
  status: 'unknown' | 'stopped' | 'starting' | 'running' | 'stopping' | 'error'
  instanceName: string
  projectName: string
  httpPort: string
  url: string
  containers: string[]
  error?: string
}

export const useDevServerStore = defineStore('devServer', {
  state: () => ({
    statuses: {} as Record<string, DevServerStatus>,
    logs: {} as Record<string, string>,
  }),

  getters: {
    getStatus:
      (state) =>
      (workspaceId: string): DevServerStatus | null =>
        state.statuses[workspaceId] ?? null,
  },

  actions: {
    async fetchStatus(workspaceId: string) {
      try {
        const res = await fetch(`/api/dev-server/${workspaceId}/status`)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = await res.json()
        this.statuses[workspaceId] = data
      } catch (err) {
        console.error('[dev-server store] fetchStatus failed:', err)
      }
    },

    async startDevServer(workspaceId: string) {
      try {
        const res = await fetch(`/api/dev-server/${workspaceId}/start`, { method: 'POST' })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = await res.json()
        this.statuses[workspaceId] = data
      } catch (err) {
        console.error('[dev-server store] startDevServer failed:', err)
        throw err
      }
    },

    async stopDevServer(workspaceId: string) {
      try {
        const res = await fetch(`/api/dev-server/${workspaceId}/stop`, { method: 'POST' })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = await res.json()
        this.statuses[workspaceId] = data
      } catch (err) {
        console.error('[dev-server store] stopDevServer failed:', err)
        throw err
      }
    },

    async fetchLogs(workspaceId: string, tail = 200) {
      try {
        const res = await fetch(`/api/dev-server/${workspaceId}/logs?tail=${tail}`)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = await res.json()
        this.logs[workspaceId] = data.logs
        return data.logs as string
      } catch (err) {
        console.error('[dev-server store] fetchLogs failed:', err)
        return ''
      }
    },

    updateFromWsEvent(workspaceId: string, status: DevServerStatus) {
      this.statuses[workspaceId] = status
    },
  },
})
