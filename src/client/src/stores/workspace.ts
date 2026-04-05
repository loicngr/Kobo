import { defineStore } from 'pinia'

export interface Workspace {
  id: string
  name: string
  projectPath: string
  sourceBranch: string
  workingBranch: string
  status: string
  notionUrl: string | null
  notionPageId: string | null
  model: string
  devServerStatus: string
  archivedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface Task {
  id: string
  workspaceId: string
  title: string
  status: string
  isAcceptanceCriterion: boolean
  sortOrder: number
  createdAt: string
  updatedAt: string
}

export interface AgentSession {
  id: string
  workspaceId: string
  pid: number | null
  claudeSessionId: string | null
  status: string
  startedAt: string
  endedAt: string | null
}

export interface ActivityItem {
  id: string
  type: 'tool_use' | 'text' | 'system' | 'error' | 'raw'
  content: string
  timestamp: string
  sessionId?: string
  meta?: Record<string, unknown>
}

export interface CreateWorkspaceInput {
  name: string
  projectPath: string
  sourceBranch: string
  workingBranch: string
  notionUrl?: string
  model?: string
  tasks?: string[]
  acceptanceCriteria?: string[]
}

export class WorkspaceActionError extends Error {
  code?: string
  constructor(message: string, code?: string) {
    super(message)
    this.name = 'WorkspaceActionError'
    this.code = code
  }
}

export interface OpenPrResult {
  prNumber: number
  prUrl: string
  messageSent: boolean
  warning?: string
}

export interface GitStats {
  commitCount: number
  filesChanged: number
  insertions: number
  deletions: number
  prUrl: string | null
}

export const useWorkspaceStore = defineStore('workspace', {
  state: () => ({
    workspaces: [] as Workspace[],
    selectedWorkspaceId: null as string | null,
    tasks: [] as Task[],
    activityFeeds: {} as Record<string, ActivityItem[]>,
    sessions: [] as AgentSession[],
    selectedSessionId: null as string | null,
    archivedWorkspaces: [] as Workspace[],
    archivedLoaded: false,
    loading: false,
  }),

  getters: {
    selectedWorkspace: (state) => state.workspaces.find((w) => w.id === state.selectedWorkspaceId) ?? null,

    needsAttention: (state) => state.workspaces.filter((w) => ['error', 'quota'].includes(w.status)),

    running: (state) => state.workspaces.filter((w) => ['extracting', 'brainstorming', 'executing'].includes(w.status)),

    idle: (state) => state.workspaces.filter((w) => ['completed', 'idle', 'created'].includes(w.status)),

    activityFeed: (state) => {
      if (!state.selectedWorkspaceId) return []
      const items = state.activityFeeds[state.selectedWorkspaceId] ?? []
      if (!state.selectedSessionId) return items
      return items.filter((i) => !i.sessionId || i.sessionId === state.selectedSessionId)
    },

    acceptanceCriteria: (state) => state.tasks.filter((t) => t.isAcceptanceCriterion),

    archived: (state) => state.archivedWorkspaces,
  },

  actions: {
    async fetchWorkspaces() {
      this.loading = true
      try {
        const res = await fetch('/api/workspaces')
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = await res.json()
        this.workspaces = data.workspaces ?? data
      } catch (err) {
        console.error('[workspace store] fetchWorkspaces failed:', err)
      } finally {
        this.loading = false
      }
    },

    async fetchArchivedWorkspaces() {
      try {
        const res = await fetch('/api/workspaces/archived')
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        this.archivedWorkspaces = await res.json()
        this.archivedLoaded = true
      } catch (err) {
        console.error('[workspace store] fetchArchivedWorkspaces failed:', err)
      }
    },

    async fetchWorkspaceDetails(id: string) {
      try {
        const res = await fetch(`/api/workspaces/${id}`)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = await res.json()

        // Update workspace in list
        const idx = this.workspaces.findIndex((w) => w.id === id)
        if (idx >= 0) {
          this.workspaces[idx] = { ...this.workspaces[idx], ...(data.workspace ?? data) }
        }

        // Update tasks
        if (data.tasks) {
          this.tasks = data.tasks
        }
      } catch (err) {
        console.error('[workspace store] fetchWorkspaceDetails failed:', err)
      }
    },

    async createWorkspace(input: CreateWorkspaceInput) {
      try {
        const res = await fetch('/api/workspaces', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = await res.json()
        const workspace = data.workspace ?? data
        this.workspaces.push(workspace)
        return workspace as Workspace
      } catch (err) {
        console.error('[workspace store] createWorkspace failed:', err)
        throw err
      }
    },

    async startWorkspace(id: string, prompt?: string) {
      try {
        const res = await fetch(`/api/workspaces/${id}/start`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt }),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        await this.fetchWorkspaces()
      } catch (err) {
        console.error('[workspace store] startWorkspace failed:', err)
        throw err
      }
    },

    async stopWorkspace(id: string) {
      try {
        const res = await fetch(`/api/workspaces/${id}/stop`, {
          method: 'POST',
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        await this.fetchWorkspaces()
      } catch (err) {
        console.error('[workspace store] stopWorkspace failed:', err)
        throw err
      }
    },

    async deleteWorkspace(id: string, options?: { deleteLocalBranch?: boolean; deleteRemoteBranch?: boolean }) {
      try {
        const res = await fetch(`/api/workspaces/${id}`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(options ?? {}),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        this.workspaces = this.workspaces.filter((w) => w.id !== id)
        delete this.activityFeeds[id]
        if (this.selectedWorkspaceId === id) {
          this.selectedWorkspaceId = null
          this.tasks = []
        }
      } catch (err) {
        console.error('[workspace store] deleteWorkspace failed:', err)
        throw err
      }
    },

    async updateModel(id: string, model: string) {
      const res = await fetch(`/api/workspaces/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const updated = (await res.json()) as Workspace
      const idx = this.workspaces.findIndex((w) => w.id === id)
      if (idx >= 0) this.workspaces[idx] = updated
    },

    async pushBranch(id: string): Promise<void> {
      const res = await fetch(`/api/workspaces/${id}/push`, { method: 'POST' })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Push failed' }))
        throw new WorkspaceActionError(err.error ?? 'Push failed', err.code)
      }
    },

    async fetchGitStats(id: string): Promise<GitStats> {
      const res = await fetch(`/api/workspaces/${id}/git-stats`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return (await res.json()) as GitStats
    },

    async openPullRequest(id: string): Promise<OpenPrResult> {
      const res = await fetch(`/api/workspaces/${id}/open-pr`, { method: 'POST' })
      const data = await res.json().catch(() => null)
      if (!res.ok) {
        throw new WorkspaceActionError(data?.error ?? 'Open PR failed', data?.code)
      }
      return data as OpenPrResult
    },

    async archiveWorkspace(id: string) {
      try {
        const res = await fetch(`/api/workspaces/${id}/archive`, { method: 'POST' })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const updated = (await res.json()) as Workspace
        // Optimistic: move from active → archived locally.
        // activityFeeds[id] is intentionally preserved (archive is reversible).
        this.workspaces = this.workspaces.filter((w) => w.id !== id)
        if (this.archivedLoaded) {
          this.archivedWorkspaces.unshift(updated)
        }
        if (this.selectedWorkspaceId === id) {
          this.selectedWorkspaceId = null
          this.tasks = []
        }
        return updated
      } catch (err) {
        console.error('[workspace store] archiveWorkspace failed:', err)
        throw err
      }
    },

    async unarchiveWorkspace(id: string) {
      try {
        const res = await fetch(`/api/workspaces/${id}/unarchive`, { method: 'POST' })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const updated = (await res.json()) as Workspace
        this.archivedWorkspaces = this.archivedWorkspaces.filter((w) => w.id !== id)
        // unshift because updatedAt is fresh and list is sorted DESC
        this.workspaces.unshift(updated)
        return updated
      } catch (err) {
        console.error('[workspace store] unarchiveWorkspace failed:', err)
        throw err
      }
    },

    async createTask(workspaceId: string, title: string, isAcceptanceCriterion: boolean) {
      try {
        const res = await fetch(`/api/workspaces/${workspaceId}/tasks`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title, isAcceptanceCriterion }),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        await this.fetchWorkspaceDetails(workspaceId)
      } catch (err) {
        console.error('[workspace store] createTask failed:', err)
        throw err
      }
    },

    async updateTaskTitle(workspaceId: string, taskId: string, title: string) {
      try {
        const res = await fetch(`/api/workspaces/${workspaceId}/tasks/${taskId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title }),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        await this.fetchWorkspaceDetails(workspaceId)
      } catch (err) {
        console.error('[workspace store] updateTaskTitle failed:', err)
        throw err
      }
    },

    async deleteTask(workspaceId: string, taskId: string) {
      try {
        const res = await fetch(`/api/workspaces/${workspaceId}/tasks/${taskId}`, {
          method: 'DELETE',
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        await this.fetchWorkspaceDetails(workspaceId)
      } catch (err) {
        console.error('[workspace store] deleteTask failed:', err)
        throw err
      }
    },

    selectWorkspace(id: string) {
      this.selectedWorkspaceId = id
      this.selectedSessionId = null
      this.tasks = []
      this.fetchWorkspaceDetails(id)
      this.fetchSessions(id)
    },

    async fetchSessions(workspaceId: string) {
      try {
        const res = await fetch(`/api/workspaces/${workspaceId}/sessions`)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        this.sessions = await res.json()
      } catch (err) {
        console.error('[workspace store] fetchSessions failed:', err)
      }
    },

    selectSession(claudeSessionId: string | null) {
      this.selectedSessionId = claudeSessionId
    },

    addActivityItem(workspaceId: string, item: ActivityItem) {
      if (!this.activityFeeds[workspaceId]) {
        this.activityFeeds[workspaceId] = []
      }
      // When agent responds, resolve pending user messages
      if (item.meta?.sender !== 'user' && item.meta?.sender !== 'system-prompt') {
        for (const existing of this.activityFeeds[workspaceId]) {
          if (existing.meta?.pending) {
            existing.meta.pending = false
          }
        }
      }
      // Avoid duplicates (sync replay)
      if (!this.activityFeeds[workspaceId].some((i) => i.id === item.id)) {
        this.activityFeeds[workspaceId].push(item)
      }
    },

    clearActivityFeed(workspaceId?: string) {
      if (workspaceId) {
        delete this.activityFeeds[workspaceId]
      } else {
        this.activityFeeds = {}
      }
    },

    updateWorkspaceFromEvent(workspaceId: string, data: Partial<Workspace>) {
      const idx = this.workspaces.findIndex((w) => w.id === workspaceId)
      if (idx >= 0) {
        this.workspaces[idx] = { ...this.workspaces[idx], ...data }
      }
    },
  },
})
