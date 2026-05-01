import { defineStore } from 'pinia'
import type { ProviderId, UsageSnapshot } from '../types/usage'
import { isBusyStatus } from '../utils/workspace-status'
import { useWebSocketStore } from './websocket'

export interface Workspace {
  id: string
  name: string
  projectPath: string
  sourceBranch: string
  workingBranch: string
  status: string
  notionUrl: string | null
  sentryUrl: string | null
  notionPageId: string | null
  model: string
  engine: string
  reasoningEffort: string
  /** Unified SDK-aligned permission mode (plan | bypass | strict | interactive). */
  agentPermissionMode: 'plan' | 'bypass' | 'strict' | 'interactive'
  devServerStatus: string
  hasUnread: boolean
  archivedAt: string | null
  favoritedAt: string | null
  tags: string[]
  autoLoop: boolean
  autoLoopReady: boolean
  noProgressStreak: number
  worktreePath: string
  worktreeOwned: boolean
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
  engineSessionId: string | null
  status: string
  startedAt: string
  endedAt: string | null
  name: string | null
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
  engine?: string
  notionUrl?: string
  model?: string
  reasoningEffort?: string
  agentPermissionMode?: 'plan' | 'bypass' | 'strict' | 'interactive'
  tasks?: string[]
  acceptanceCriteria?: string[]
  autoLoop?: boolean
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

export interface Subagent {
  toolUseId: string
  description: string
  taskType?: string
  status: 'running' | 'done'
  lastToolName?: string
  lastDescription?: string
  totalTokens?: number
  toolUses?: number
  durationMs?: number
  startedAt: string
  updatedAt: string
}

export interface AgentTodo {
  content: string
  status: string
  activeForm?: string
}

/**
 * Set of `task_notification` status values that mark a subagent as finished.
 * Any other value (present or future) keeps the subagent in `running` — we
 * never regress UI state on an unknown status.
 */
const TERMINAL_TASK_NOTIFICATION_STATUSES = new Set(['completed', 'stopped', 'failed', 'cancelled'])

/**
 * Returns `true` when a Claude Code system event signals the end of a subagent's work.
 *
 * In-flight updates (dernier outil utilisé, progression) arrive via `task_progress`
 * and never call this function. Terminal lifecycle events arrive via
 * `task_notification` with a status field indicating WHY the subagent ended —
 * currently observed values: `completed`, `stopped`, `failed`. We match against
 * a whitelist so that any unknown status (e.g. a future `progressing` variant)
 * is treated conservatively as non-terminal.
 */
export function isSubagentTerminalEvent(subtype: string | undefined, status?: string | undefined): boolean {
  if (subtype !== 'task_notification') return false
  if (!status) return false
  return TERMINAL_TASK_NOTIFICATION_STATUSES.has(status)
}

export interface GitStats {
  commitCount: number
  filesChanged: number
  insertions: number
  deletions: number
  prUrl: string | null
  prState: 'OPEN' | 'CLOSED' | 'MERGED' | null
  unpushedCount: number // -1 = no upstream
  workingTree: { staged: number; modified: number; untracked: number }
}

export interface PendingWakeup {
  targetAt: string
  reason?: string
}

export interface PendingDeferredToolUse {
  toolCallId: string
  toolName: string
  input: unknown
  /**
   * Kōbō agent_sessions row id of the session that emitted the deferred
   * tool call. Used to scope clear-on-session-end so a sibling session
   * finishing does not erase a still-valid pending entry.
   */
  agentSessionId: string | null
}

/**
 * Unified pending item: either an AskUserQuestion or an interactive
 * permission request. Items are queued FIFO per workspace; the head is
 * what the UI surfaces.
 */
export type PendingItem =
  | { kind: 'question'; agentSessionId: string | null; toolCallId: string; toolName: string; input: unknown }
  | { kind: 'permission'; agentSessionId: string | null; toolCallId: string; toolName: string; toolInput: unknown }

export interface AutoLoopStatus {
  auto_loop: boolean
  auto_loop_ready: boolean
  no_progress_streak: number
}

const MAX_FEED_ITEMS = 5000

// Debounce window for `fetchPrStates` called via `triggerGitRefresh`. The
// backend cache (pr-watcher) only updates on its own 30 s poll, so coalescing
// many git bumps into a single fetch costs nothing and keeps the network
// quiet during loops like repeated `git status`.
const PR_STATES_DEBOUNCE_MS = 500
let _prStatesDebounceTimer: ReturnType<typeof setTimeout> | null = null

function engineToProviderId(engine: string | undefined): ProviderId | null {
  if (engine === 'claude-code') return 'claude-code'
  return null
}

export const useWorkspaceStore = defineStore('workspace', {
  state: () => ({
    workspaces: [] as Workspace[],
    selectedWorkspaceId: null as string | null,
    tasks: [] as Task[],
    activityFeeds: {} as Record<string, ActivityItem[]>,
    activityFeedIds: {} as Record<string, Set<string>>,
    activityCounts: {} as Record<
      string,
      { toolUses: number; agentMessages: number; userMessages: number; errors: number }
    >,
    subagents: {} as Record<string, Record<string, Subagent>>,
    agentTodos: {} as Record<string, AgentTodo[]>,
    sessions: [] as AgentSession[],
    selectedSessionId: null as string | null,
    archivedWorkspaces: [] as Workspace[],
    archivedLoaded: false,
    loading: false,
    loadingOlderEvents: false,
    hasMoreEvents: {} as Record<string, boolean>,
    providerUsage: {} as Record<ProviderId, UsageSnapshot | undefined>,
    chatDraft: '',
    queuedMessages: {} as Record<string, { content: string; sessionId?: string }>,
    gitRefreshTrigger: 0,
    gitStatsCache: {} as Record<string, GitStats>,
    pendingWakeups: {} as Record<string, PendingWakeup>,
    pendingDeferred: {} as Record<string, PendingDeferredToolUse>,
    pendingQueue: {} as Record<string, PendingItem[]>,
    prStates: {} as Record<string, string>,
    autoLoopStates: {} as Record<string, AutoLoopStatus>,
  }),

  getters: {
    selectedWorkspace: (state) => state.workspaces.find((w) => w.id === state.selectedWorkspaceId) ?? null,

    needsAttention: (state) => state.workspaces.filter((w) => ['error', 'quota', 'awaiting-user'].includes(w.status)),

    running: (state) => state.workspaces.filter((w) => isBusyStatus(w.status)),

    idle: (state) => state.workspaces.filter((w) => ['completed', 'idle', 'created'].includes(w.status)),

    favorites(state): Workspace[] {
      return state.workspaces.filter((w) => w.favoritedAt !== null)
    },

    currentAgentTodos: (state): AgentTodo[] => {
      if (!state.selectedWorkspaceId) return []
      return state.agentTodos[state.selectedWorkspaceId] ?? []
    },

    currentSubagents: (state): Subagent[] => {
      if (!state.selectedWorkspaceId) return []
      const map = state.subagents[state.selectedWorkspaceId] ?? {}
      return Object.values(map).sort((a, b) => a.startedAt.localeCompare(b.startedAt))
    },

    activityFeed: (state) => {
      if (!state.selectedWorkspaceId) return []
      const items = state.activityFeeds[state.selectedWorkspaceId] ?? []
      // While fetchSessions hasn't loaded the list yet, fall back to showing
      // every item: this avoids a blank feed during the brief window between
      // workspace selection and session hydration, and also covers workspaces
      // that have no sessions at all (new workspace not yet started).
      if (!state.selectedSessionId) {
        return state.sessions.length === 0 ? items : []
      }
      // Resolve the engine_session_id of the selected session to also accept
      // legacy events that were tagged with the engine UUID before the
      // backfill migration (v6) had a chance to run.
      const selectedSession = state.sessions.find((s) => s.id === state.selectedSessionId)
      const legacyTag = selectedSession?.engineSessionId ?? null
      // Workspace-level events (setup script output, etc.) are persisted with
      // session_id=NULL because they fire before any agent session exists.
      // Only attach them to the very first session — otherwise every new
      // session re-replays the workspace creation logs.
      // sessions[] arrives sorted started_at DESC, so the oldest session is
      // the last element.
      const firstSessionId = state.sessions.length > 0 ? state.sessions[state.sessions.length - 1].id : null
      const isFirstSession = state.selectedSessionId === firstSessionId
      return items.filter((i) => {
        if (!i.sessionId) return isFirstSession
        return i.sessionId === state.selectedSessionId || (legacyTag !== null && i.sessionId === legacyTag)
      })
    },

    acceptanceCriteria: (state) => state.tasks.filter((t) => t.isAcceptanceCriterion),

    archived: (state) => state.archivedWorkspaces,

    currentProviderUsage(state): UsageSnapshot | null {
      const ws = state.workspaces.find((w) => w.id === state.selectedWorkspaceId)
      if (!ws) return null
      const providerId = engineToProviderId(ws.engine)
      if (!providerId) return null
      return state.providerUsage[providerId] ?? null
    },
  },

  actions: {
    async toggleFavorite(id: string) {
      // Resolve by id both before and after the network call — the workspace
      // array can be reordered (or the workspace removed) by a concurrent
      // WS event while the request is in flight. A captured index would write
      // the update to the wrong row.
      const before = this.workspaces.find((w) => w.id === id)
      if (!before) return
      const previous = before.favoritedAt
      const nextFavorited = previous === null
      const optimistic = nextFavorited ? new Date().toISOString() : null
      this.workspaces = this.workspaces.map((w) => (w.id === id ? { ...w, favoritedAt: optimistic } : w))
      try {
        const res = await fetch(`/api/workspaces/${id}/favorite`, {
          method: nextFavorited ? 'POST' : 'DELETE',
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const updated = (await res.json()) as Workspace
        this.workspaces = this.workspaces.map((w) => (w.id === id ? updated : w))
      } catch (err) {
        this.workspaces = this.workspaces.map((w) => (w.id === id ? { ...w, favoritedAt: previous } : w))
        throw err
      }
    },

    async setWorkspaceTags(id: string, tags: string[]) {
      const before = this.workspaces.find((w) => w.id === id)
      if (!before) return
      const previous = before.tags
      const optimistic = [...tags]
      this.workspaces = this.workspaces.map((w) => (w.id === id ? { ...w, tags: optimistic } : w))
      try {
        const res = await fetch(`/api/workspaces/${id}/tags`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tags }),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const updated = (await res.json()) as Workspace
        this.workspaces = this.workspaces.map((w) => (w.id === id ? updated : w))
      } catch (err) {
        this.workspaces = this.workspaces.map((w) => (w.id === id ? { ...w, tags: previous } : w))
        throw err
      }
    },

    async fetchOrphanWorktrees(
      projectPath: string,
    ): Promise<Array<{ path: string; branch: string; head: string; suggestedSourceBranch: string }>> {
      const url = `/api/git/orphan-worktrees?projectPath=${encodeURIComponent(projectPath)}`
      const res = await fetch(url, { cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json()
    },

    async fetchWorkspaces() {
      this.loading = true
      try {
        const res = await fetch('/api/workspaces')
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = await res.json()
        this.workspaces = data.workspaces ?? data
        // Finalize orphan sub-agents for workspaces that came back in a
        // terminal state. Covers the rare case where `session:ended` was
        // missed (WS reconnect, browser tab returning from sleep, etc.)
        // and sub-agents still marked `running` keep AgentBusyBanner visible.
        for (const ws of this.workspaces) {
          if (['completed', 'idle', 'error', 'quota'].includes(ws.status)) {
            this.finalizeRunningSubagents(ws.id)
          }
        }
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

        // Guard against stale response: user may have switched workspace while
        // this request was in flight.
        if (this.selectedWorkspaceId !== id) return

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
        // When created with autoLoop=true, the server flipped auto_loop=1 in DB
        // but the event broadcast lands before this client is subscribed.
        // Refresh states explicitly so the toggle reflects the new row.
        if (input.autoLoop) {
          void this.fetchAutoLoopStates()
        }
        return workspace as Workspace
      } catch (err) {
        console.error('[workspace store] createWorkspace failed:', err)
        throw err
      }
    },

    async startWorkspace(id: string, prompt?: string, agentSessionId?: string, resume?: boolean) {
      try {
        const res = await fetch(`/api/workspaces/${id}/start`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt, agentSessionId, resume }),
        })
        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          throw new Error(body.error ?? `HTTP ${res.status}`)
        }
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

    async interruptAgent(id: string) {
      try {
        const res = await fetch(`/api/workspaces/${id}/interrupt`, {
          method: 'POST',
        })
        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          throw new Error(body.error ?? `HTTP ${res.status}`)
        }
      } catch (err) {
        console.error('[workspace store] interruptAgent failed:', err)
        throw err
      }
    },

    async deleteWorkspace(
      id: string,
      options?: { deleteLocalBranch?: boolean; deleteRemoteBranch?: boolean },
    ): Promise<{ warnings: string[] }> {
      try {
        const res = await fetch(`/api/workspaces/${id}`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(options ?? {}),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)

        // Status 204 = clean. Status 200 = delete succeeded but with warnings
        // (e.g. worktree dir couldn't be removed due to Docker-owned files).
        let warnings: string[] = []
        if (res.status === 200) {
          const body = (await res.json().catch(() => ({}))) as { warnings?: string[] }
          warnings = Array.isArray(body.warnings) ? body.warnings : []
        }

        this.workspaces = this.workspaces.filter((w) => w.id !== id)
        // Deletion can target an archived workspace from the "Archivés" list,
        // so we must also drop it from that list — otherwise the entry lingers
        // after the backend row is gone.
        this.archivedWorkspaces = this.archivedWorkspaces.filter((w) => w.id !== id)
        delete this.activityFeeds[id]
        delete this.activityFeedIds[id]
        delete this.activityCounts[id]
        delete this.subagents[id]
        delete this.agentTodos[id]
        if (this.selectedWorkspaceId === id) {
          this.selectedWorkspaceId = null
          this.tasks = []
        }

        return { warnings }
      } catch (err) {
        console.error('[workspace store] deleteWorkspace failed:', err)
        throw err
      }
    },

    async updateModel(id: string, model: string) {
      try {
        const res = await fetch(`/api/workspaces/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model }),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const updated = (await res.json()) as Workspace
        const idx = this.workspaces.findIndex((w) => w.id === id)
        if (idx >= 0) this.workspaces[idx] = updated
      } catch (err) {
        console.error('[workspace store] updateModel failed:', err)
        throw err
      }
    },

    async updateReasoningEffort(id: string, reasoningEffort: string) {
      try {
        const res = await fetch(`/api/workspaces/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reasoningEffort }),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const updated = (await res.json()) as Workspace
        const idx = this.workspaces.findIndex((w) => w.id === id)
        if (idx >= 0) this.workspaces[idx] = updated
      } catch (err) {
        console.error('[workspace store] updateReasoningEffort failed:', err)
        throw err
      }
    },

    /**
     * Rename the working branch in git, move its worktree dir to match, and
     * persist the new name to the DB. Throws a WorkspaceActionError on
     * conflict so the UI can surface a friendly message (e.g. the target
     * name is already in use locally or on origin).
     */
    async renameWorkspaceBranch(id: string, newName: string): Promise<Workspace> {
      const res = await fetch(`/api/workspaces/${id}/rename-branch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newName }),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok) {
        throw new WorkspaceActionError(data?.error ?? 'Rename failed', data?.code)
      }
      const updated = data as Workspace
      const idx = this.workspaces.findIndex((w) => w.id === id)
      if (idx >= 0) this.workspaces[idx] = updated
      return updated
    },

    /**
     * Ask the backend to read the real HEAD of the worktree and update the
     * DB's `workingBranch` if it drifted. Used after the agent renames the
     * branch from within the chat (e.g. `git branch -m …`).
     */
    async resyncWorkspaceBranch(id: string): Promise<{ changed: boolean; workingBranch: string }> {
      const res = await fetch(`/api/workspaces/${id}/resync-branch`, { method: 'POST' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const body = (await res.json()) as { changed: boolean; workingBranch: string }
      if (body.changed) {
        const idx = this.workspaces.findIndex((w) => w.id === id)
        if (idx >= 0) this.workspaces[idx] = { ...this.workspaces[idx], workingBranch: body.workingBranch }
      }
      return body
    },

    async updateAgentPermissionMode(id: string, agentPermissionMode: 'plan' | 'bypass' | 'strict' | 'interactive') {
      try {
        const res = await fetch(`/api/workspaces/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agentPermissionMode }),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const updated = (await res.json()) as Workspace
        const idx = this.workspaces.findIndex((w) => w.id === id)
        if (idx >= 0) this.workspaces[idx] = updated
      } catch (err) {
        console.error('[workspace store] updateAgentPermissionMode failed:', err)
        throw err
      }
    },

    async pushBranch(id: string, options: { force?: boolean } = {}): Promise<void> {
      const res = await fetch(`/api/workspaces/${id}/push`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force: options.force === true }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Push failed' }))
        throw new WorkspaceActionError(err.error ?? 'Push failed', err.code)
      }
    },

    async pullBranch(id: string): Promise<void> {
      const res = await fetch(`/api/workspaces/${id}/pull`, { method: 'POST' })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Pull failed' }))
        throw new WorkspaceActionError(err.error ?? 'Pull failed', err.code)
      }
    },

    async fetchGitStats(id: string): Promise<GitStats> {
      const res = await fetch(`/api/workspaces/${id}/git-stats`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const stats = (await res.json()) as GitStats
      this.gitStatsCache[id] = stats
      return stats
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
      // Mark as read before fetching details so the API response already reflects the read state
      this.markRead(id)
      this.fetchWorkspaceDetails(id)
      this.fetchSessions(id)
      // Pre-fetch git stats so template expansion has them available immediately
      // when the user selects a template — without this, variables like
      // {commit_count}/{pr_url} would stay as literal placeholders until the
      // user opens the Git panel.
      this.fetchGitStats(id).catch(() => {
        // Silent: git stats are best-effort for templates. GitPanel.vue will
        // surface its own error if the user opens it later.
      })
      // Re-subscribe to replay events if the feed is empty (e.g. after unarchive)
      if (!this.activityFeeds[id]?.length) {
        useWebSocketStore().subscribe(id)
      }
    },

    async fetchSessions(workspaceId: string, forceSelectId?: string) {
      try {
        const res = await fetch(`/api/workspaces/${workspaceId}/sessions`)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)

        // Guard against stale response: user may have switched workspace while
        // this request was in flight.
        if (this.selectedWorkspaceId !== workspaceId) return

        this.sessions = await res.json()

        // When auto-loop starts a new session, force-switch to it.
        if (forceSelectId && this.sessions.some((s) => s.id === forceSelectId)) {
          this.selectSession(forceSelectId)
          return
        }

        // Auto-select only if no session is currently selected (or current selection is stale)
        const currentStillExists = this.selectedSessionId && this.sessions.some((s) => s.id === this.selectedSessionId)
        if (this.sessions.length > 0 && !currentStillExists) {
          const persisted = localStorage.getItem(`kobo:session:${workspaceId}`)
          const found = persisted ? this.sessions.find((s) => s.id === persisted) : null
          this.selectSession(found ? found.id : this.sessions[0].id)
        }
      } catch (err) {
        console.error('[workspace store] fetchSessions failed:', err)
      }
    },

    async fetchOlderEvents(workspaceId: string): Promise<boolean> {
      if (this.loadingOlderEvents) return false
      if (this.hasMoreEvents[workspaceId] === false) return false

      const feed = this.activityFeeds[workspaceId]
      if (!feed?.length) return false

      const oldestId = feed[0].id
      this.loadingOlderEvents = true
      try {
        const res = await fetch(
          `/api/workspaces/${workspaceId}/events?before=${encodeURIComponent(oldestId)}&limit=100`,
        )
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = (await res.json()) as {
          events: Array<{
            id: string
            workspaceId: string
            type: string
            payload: Record<string, unknown>
            createdAt: string
          }>
          hasMore: boolean
        }

        this.hasMoreEvents[workspaceId] = data.hasMore

        if (data.events.length > 0) {
          // Route each event through the websocket store to parse and add properly
          const wsStore = useWebSocketStore()
          for (const evt of data.events) {
            wsStore._routeMessage(evt)
          }
        }

        return data.events.length > 0
      } catch (err) {
        console.error('[workspace store] fetchOlderEvents failed:', err)
        return false
      } finally {
        this.loadingOlderEvents = false
      }
    },

    selectSession(id: string) {
      this.selectedSessionId = id
      if (this.selectedWorkspaceId) {
        localStorage.setItem(`kobo:session:${this.selectedWorkspaceId}`, id)
      }
    },

    async createSession(workspaceId: string) {
      try {
        const res = await fetch(`/api/workspaces/${workspaceId}/sessions`, { method: 'POST' })
        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          throw new Error(body.error ?? `HTTP ${res.status}`)
        }
        const session: AgentSession = await res.json()
        this.sessions.unshift(session)
        this.selectSession(session.id)
        return session
      } catch (err) {
        console.error('[workspace store] createSession failed:', err)
        throw err
      }
    },

    async renameWorkspace(workspaceId: string, name: string) {
      const res = await fetch(`/api/workspaces/${workspaceId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      const updated = (await res.json()) as Workspace
      const idx = this.workspaces.findIndex((w) => w.id === workspaceId)
      if (idx >= 0) {
        this.workspaces[idx] = { ...this.workspaces[idx], ...updated }
      }
      const aidx = this.archivedWorkspaces.findIndex((w) => w.id === workspaceId)
      if (aidx >= 0) {
        this.archivedWorkspaces[aidx] = { ...this.archivedWorkspaces[aidx], ...updated }
      }
    },

    async renameSession(workspaceId: string, sessionId: string, name: string) {
      const res = await fetch(`/api/workspaces/${workspaceId}/sessions/${sessionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      // The backend confirmed the rename (200). Update local state optimistically:
      // parse the response body, but fall back to the user-supplied name if the
      // body can't be parsed so the UI still reflects the committed change.
      const updated = (await res.json().catch(() => null)) as AgentSession | null
      const session = this.sessions.find((s) => s.id === sessionId)
      if (session) session.name = updated?.name ?? name
    },

    addActivityItem(workspaceId: string, item: ActivityItem) {
      if (!this.activityFeeds[workspaceId]) {
        this.activityFeeds[workspaceId] = []
      }
      if (!this.activityFeedIds[workspaceId]) {
        this.activityFeedIds[workspaceId] = new Set()
      }
      if (!this.activityCounts[workspaceId]) {
        this.activityCounts[workspaceId] = { toolUses: 0, agentMessages: 0, userMessages: 0, errors: 0 }
      }
      // When agent responds, resolve pending user messages
      if (item.meta?.sender !== 'user' && item.meta?.sender !== 'system-prompt') {
        for (const existing of this.activityFeeds[workspaceId]) {
          if (existing.meta?.pending) {
            existing.meta.pending = false
          }
        }
      }
      // Avoid duplicates (sync replay) — O(1) via Set
      if (!this.activityFeedIds[workspaceId].has(item.id)) {
        this.activityFeedIds[workspaceId].add(item.id)
        this.activityFeeds[workspaceId].push(item)
        // Increment activity counters
        const counts = this.activityCounts[workspaceId]
        if (item.type === 'tool_use') counts.toolUses++
        else if (item.type === 'error') counts.errors++
        if (item.meta?.sender === 'user') counts.userMessages++
        else if (item.type === 'text' && item.meta?.sender !== 'system-prompt') counts.agentMessages++
      }
      // Cap feed size to prevent unbounded memory growth
      const feed = this.activityFeeds[workspaceId]
      if (feed.length > MAX_FEED_ITEMS) {
        const removed = feed.splice(0, feed.length - MAX_FEED_ITEMS)
        const idSet = this.activityFeedIds[workspaceId]
        for (const r of removed) {
          idSet.delete(r.id)
        }
      }
    },

    removeActivityItem(workspaceId: string, itemId: string) {
      const feed = this.activityFeeds[workspaceId]
      const idSet = this.activityFeedIds[workspaceId]
      if (!feed || !idSet) return
      const idx = feed.findIndex((i) => i.id === itemId)
      if (idx < 0) return
      const [removed] = feed.splice(idx, 1)
      idSet.delete(itemId)
      // Revert activity counters
      const counts = this.activityCounts[workspaceId]
      if (counts && removed) {
        if (removed.type === 'tool_use') counts.toolUses = Math.max(0, counts.toolUses - 1)
        else if (removed.type === 'error') counts.errors = Math.max(0, counts.errors - 1)
        if (removed.meta?.sender === 'user') counts.userMessages = Math.max(0, counts.userMessages - 1)
        else if (removed.type === 'text' && removed.meta?.sender !== 'system-prompt')
          counts.agentMessages = Math.max(0, counts.agentMessages - 1)
      }
    },

    clearActivityFeed(workspaceId?: string) {
      if (workspaceId) {
        delete this.activityFeeds[workspaceId]
        delete this.activityFeedIds[workspaceId]
        delete this.activityCounts[workspaceId]
      } else {
        this.activityFeeds = {}
        this.activityFeedIds = {}
        this.activityCounts = {}
      }
    },

    applyUsageSnapshot(payload: { providerId: ProviderId; snapshot: UsageSnapshot }) {
      this.providerUsage[payload.providerId] = payload.snapshot
    },

    async requestUsageRefresh(providerId: ProviderId): Promise<void> {
      try {
        await fetch(`/api/usage/${providerId}/refresh`, { method: 'POST' })
        // Server broadcasts the result via WS — nothing else to do.
      } catch (err) {
        console.error('[workspace store] requestUsageRefresh failed:', err)
      }
    },

    triggerGitRefresh() {
      this.gitRefreshTrigger++
      this.schedulePrStatesRefresh()
    },

    /**
     * Trailing-edge debounce for `fetchPrStates`. `triggerGitRefresh` fires
     * on every git-matching Bash tool:call, which can be many per minute
     * (`git status` loops, etc.). A single pr-states refetch per burst is
     * enough — the backend snapshot is updated only every 30 s by the
     * pr-watcher poll anyway.
     */
    schedulePrStatesRefresh() {
      if (_prStatesDebounceTimer !== null) clearTimeout(_prStatesDebounceTimer)
      _prStatesDebounceTimer = setTimeout(() => {
        _prStatesDebounceTimer = null
        void this.fetchPrStates()
      }, PR_STATES_DEBOUNCE_MS)
    },

    async fetchPrStates(): Promise<void> {
      try {
        const res = await fetch('/api/workspaces/pr-states', { cache: 'no-store' })
        if (!res.ok) return
        const data = (await res.json()) as Record<string, string>
        this.prStates = data
      } catch (err) {
        console.error('[workspace-store] fetchPrStates failed:', err)
      }
    },

    async fetchAutoLoopStates(): Promise<void> {
      try {
        const res = await fetch('/api/workspaces/auto-loop-states', { cache: 'no-store' })
        if (!res.ok) return
        const data = (await res.json()) as Record<string, AutoLoopStatus>
        this.autoLoopStates = data
      } catch (err) {
        console.error('[workspace-store] fetchAutoLoopStates failed:', err)
      }
    },

    async enableAutoLoop(id: string): Promise<void> {
      // Plan mode would deadlock the loop (blocks MCP + edits) — promote to bypass.
      const ws = this.workspaces.find((w) => w.id === id)
      if (ws && ws.agentPermissionMode === 'plan') {
        try {
          await this.updateAgentPermissionMode(id, 'bypass')
        } catch {
          // best-effort — the loop forces a non-plan mode regardless
        }
      }

      const res = await fetch(`/api/workspaces/${id}/auto-loop`, { method: 'POST' })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`)
      }
      await this.fetchAutoLoopStates()
    },

    async disableAutoLoop(id: string): Promise<void> {
      const res = await fetch(`/api/workspaces/${id}/auto-loop`, { method: 'DELETE' })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`)
      }
      await this.fetchAutoLoopStates()
    },

    async forceAutoLoopReady(id: string): Promise<void> {
      const res = await fetch(`/api/workspaces/${id}/auto-loop-ready`, { method: 'POST' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      await this.fetchAutoLoopStates()
    },

    setAutoLoopState(id: string, state: AutoLoopStatus): void {
      this.autoLoopStates[id] = state
    },

    clearAutoLoopState(id: string): void {
      delete this.autoLoopStates[id]
    },

    async fetchPendingWakeup(workspaceId: string): Promise<void> {
      try {
        const res = await fetch(`/api/workspaces/${workspaceId}/pending-wakeup`, { cache: 'no-store' })
        if (!res.ok) return
        const data = (await res.json()) as PendingWakeup | null
        if (data) this.pendingWakeups[workspaceId] = data
        else delete this.pendingWakeups[workspaceId]
      } catch (err) {
        console.error('[workspace-store] fetchPendingWakeup failed:', err)
      }
    },

    setPendingWakeup(workspaceId: string, wakeup: PendingWakeup): void {
      this.pendingWakeups[workspaceId] = wakeup
    },

    clearPendingWakeup(workspaceId: string): void {
      delete this.pendingWakeups[workspaceId]
    },

    async cancelPendingWakeup(workspaceId: string): Promise<void> {
      // Optimistic local clear — the `wakeup:cancelled` WS event will do the
      // same a moment later, but clearing now gives instant feedback. If the
      // DELETE fails (network, 500, etc.), re-fetch to restore the truth so
      // the banner doesn't lie about what the backend will actually do.
      const hadPending = this.pendingWakeups[workspaceId] !== undefined
      delete this.pendingWakeups[workspaceId]
      try {
        const res = await fetch(`/api/workspaces/${workspaceId}/pending-wakeup`, { method: 'DELETE' })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
      } catch (err) {
        console.error('[workspace-store] cancelPendingWakeup failed:', err)
        if (hadPending) {
          // Reconcile with backend — may restore the banner if the server
          // still has the row, or confirm the clear if it was already gone.
          await this.fetchPendingWakeup(workspaceId)
        }
      }
    },

    /** Append an item to the pending queue for a workspace. */
    enqueuePending(workspaceId: string, item: PendingItem): void {
      const arr = this.pendingQueue[workspaceId] ?? []
      // Dedup by toolCallId — a `session:user-input-requested` event can land
      // twice (live arrival + replay before purge succeeded); without this
      // guard the panel would surface back-to-back for the same callback.
      if (arr.some((existing) => existing.toolCallId === item.toolCallId)) return
      arr.push(item)
      this.pendingQueue[workspaceId] = arr
      if (item.kind === 'question') {
        this.pendingDeferred[workspaceId] = {
          toolCallId: item.toolCallId,
          toolName: item.toolName,
          input: item.input,
          agentSessionId: item.agentSessionId,
        }
      }
    },

    /** Peek the head of the queue without removing it. */
    peekPending(workspaceId: string): PendingItem | undefined {
      return this.pendingQueue[workspaceId]?.[0]
    },

    /** Remove and return the head of the queue. */
    dequeuePending(workspaceId: string): PendingItem | undefined {
      const arr = this.pendingQueue[workspaceId]
      if (!arr || arr.length === 0) return undefined
      const head = arr.shift()
      if (arr.length === 0) delete this.pendingQueue[workspaceId]
      // Mirror the legacy single-entry map for any caller still reading it.
      const newHead = this.pendingQueue[workspaceId]?.[0]
      if (newHead && newHead.kind === 'question') {
        this.pendingDeferred[workspaceId] = {
          toolCallId: newHead.toolCallId,
          toolName: newHead.toolName,
          input: newHead.input,
          agentSessionId: newHead.agentSessionId,
        }
      } else {
        delete this.pendingDeferred[workspaceId]
      }
      return head
    },

    /**
     * Drop every pending item owned by `agentSessionId`. Pass `null` to
     * leave the queue untouched (mirrors the original safety behaviour
     * where unscoped clears were opt-in).
     */
    clearPendingForSession(workspaceId: string, agentSessionId: string | null): void {
      if (agentSessionId === null) return
      const arr = this.pendingQueue[workspaceId]
      if (!arr) return
      const filtered = arr.filter((it) => it.agentSessionId !== agentSessionId)
      if (filtered.length === 0) delete this.pendingQueue[workspaceId]
      else this.pendingQueue[workspaceId] = filtered
      // Sync legacy map.
      const cur = this.pendingDeferred[workspaceId]
      if (cur && cur.agentSessionId === agentSessionId) {
        delete this.pendingDeferred[workspaceId]
      }
    },

    /** Wipe the whole queue for a workspace (e.g. user explicit stop). */
    clearAllPending(workspaceId: string): void {
      delete this.pendingQueue[workspaceId]
      delete this.pendingDeferred[workspaceId]
    },

    /** @deprecated use `enqueuePending` with `kind: 'question'`. */
    setPendingDeferred(workspaceId: string, payload: PendingDeferredToolUse): void {
      this.enqueuePending(workspaceId, {
        kind: 'question',
        agentSessionId: payload.agentSessionId,
        toolCallId: payload.toolCallId,
        toolName: payload.toolName,
        input: payload.input,
      })
    },

    /** @deprecated use `clearPendingForSession` / `clearAllPending` instead. */
    clearPendingDeferred(workspaceId: string, onlyIfSession: string | null = null): void {
      if (onlyIfSession === null) {
        this.clearAllPending(workspaceId)
        return
      }
      this.clearPendingForSession(workspaceId, onlyIfSession)
    },

    /** @deprecated use `peekPending` instead — returns the head only if it is a question. */
    getPendingDeferred(workspaceId: string): PendingDeferredToolUse | undefined {
      const head = this.peekPending(workspaceId)
      if (!head || head.kind !== 'question') return undefined
      return {
        toolCallId: head.toolCallId,
        toolName: head.toolName,
        input: head.input,
        agentSessionId: head.agentSessionId,
      }
    },

    /** Submit answers for a deferred AskUserQuestion. Dequeues optimistically on success. */
    async submitDeferredAnswer(
      workspaceId: string,
      answers: Record<string, string>,
      toolCallId?: string,
    ): Promise<void> {
      const res = await fetch(`/api/workspaces/${workspaceId}/deferred-tool-use/answer`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ answers, toolCallId }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        const message = body.error ?? `HTTP ${res.status}`
        // Self-heal a zombie panel left by a stale ws_events replay.
        if (/no deferred tool use pending/i.test(message)) {
          console.warn('[workspace] submitDeferredAnswer: backend has no pending — clearing zombie panel locally')
          this.dequeuePending(workspaceId)
          void this.fetchWorkspaces()
          return
        }
        throw new Error(message)
      }
      // Optimistic dequeue + status refresh: the backend resolved the SDK
      // callback synchronously but `session:started` lags the SDK warm-up.
      this.dequeuePending(workspaceId)
      void this.fetchWorkspaces()
    },

    /**
     * Cancel a pending question without answering. The agent receives a
     * `behavior: 'deny'` tool_result and decides what to do — usually
     * proceeds with sensible defaults or skips the question altogether.
     * Does NOT stop the agent.
     */
    async cancelDeferredAnswer(workspaceId: string, reason?: string, toolCallId?: string): Promise<void> {
      const res = await fetch(`/api/workspaces/${workspaceId}/deferred-tool-use/cancel`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason, toolCallId }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        const message = body.error ?? `HTTP ${res.status}`
        if (/no deferred tool use pending/i.test(message)) {
          console.warn('[workspace] cancelDeferredAnswer: backend has no pending — clearing zombie panel locally')
          this.dequeuePending(workspaceId)
          void this.fetchWorkspaces()
          return
        }
        throw new Error(message)
      }
      this.dequeuePending(workspaceId)
      void this.fetchWorkspaces()
    },

    /** Submit allow/deny for a deferred permission request. Dequeues optimistically on success. */
    async submitDeferredPermission(
      workspaceId: string,
      toolCallId: string,
      decision: 'allow' | 'deny',
      reason?: string,
    ): Promise<void> {
      const res = await fetch(`/api/workspaces/${workspaceId}/deferred-permission/decision`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ toolCallId, decision, reason }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`)
      }
      this.dequeuePending(workspaceId)
      void this.fetchWorkspaces()
    },

    updateAgentTodos(workspaceId: string, todos: AgentTodo[]) {
      this.agentTodos[workspaceId] = todos
    },

    /**
     * Mark every subagent still in `running` state as `done`. Called on
     * `session:ended` — the session is the unit that hosts subagents, so when
     * it ends, any subagent still reported as running is orphaned and must
     * not keep AgentBusyBanner visible. Preserves all other fields; only
     * flips status. No-op if the workspace has no subagents.
     */
    finalizeRunningSubagents(workspaceId: string) {
      const map = this.subagents[workspaceId]
      if (!map) return
      const now = new Date().toISOString()
      for (const toolUseId of Object.keys(map)) {
        const sub = map[toolUseId]
        if (sub.status === 'running') {
          map[toolUseId] = { ...sub, status: 'done', updatedAt: now }
        }
      }
    },

    upsertSubagent(workspaceId: string, data: Partial<Subagent> & { toolUseId: string }) {
      if (!this.subagents[workspaceId]) this.subagents[workspaceId] = {}
      const existing = this.subagents[workspaceId][data.toolUseId]
      const now = new Date().toISOString()
      // Once a subagent is 'done', never regress to 'running' — guards against
      // out-of-order events (e.g. a late task_progress after task_notification).
      const nextStatus = existing?.status === 'done' ? 'done' : (data.status ?? existing?.status ?? 'running')
      this.subagents[workspaceId][data.toolUseId] = {
        toolUseId: data.toolUseId,
        description: data.description ?? existing?.description ?? '',
        taskType: data.taskType ?? existing?.taskType,
        status: nextStatus,
        lastToolName: data.lastToolName ?? existing?.lastToolName,
        lastDescription: data.lastDescription ?? existing?.lastDescription,
        totalTokens: data.totalTokens ?? existing?.totalTokens,
        toolUses: data.toolUses ?? existing?.toolUses,
        durationMs: data.durationMs ?? existing?.durationMs,
        startedAt: existing?.startedAt ?? now,
        updatedAt: now,
      }
    },

    /** Mark a workspace as read by calling the backend and updating local state. */
    async markRead(workspaceId: string) {
      try {
        const res = await fetch(`/api/workspaces/${workspaceId}/mark-read`, { method: 'POST' })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const idx = this.workspaces.findIndex((w) => w.id === workspaceId)
        if (idx >= 0) {
          this.workspaces[idx] = { ...this.workspaces[idx], hasUnread: false }
        }
      } catch (err) {
        console.error('[workspace store] markRead failed:', err)
      }
    },

    queueMessage(workspaceId: string, content: string, sessionId?: string) {
      this.queuedMessages[workspaceId] = { content, sessionId }
    },

    cancelQueuedMessage(workspaceId: string) {
      delete this.queuedMessages[workspaceId]
    },

    updateWorkspaceFromEvent(workspaceId: string, data: Partial<Workspace>) {
      const idx = this.workspaces.findIndex((w) => w.id === workspaceId)
      if (idx >= 0) {
        this.workspaces[idx] = { ...this.workspaces[idx], ...data }
      }
      // When agent stops, resolve pending messages and mark subagents as done
      if (data.status && ['completed', 'idle', 'error', 'quota'].includes(data.status)) {
        const feed = this.activityFeeds[workspaceId]
        if (feed) {
          for (const item of feed) {
            if (item.meta?.pending) {
              item.meta.pending = false
            }
          }
        }
        const subs = this.subagents[workspaceId]
        if (subs) {
          for (const [id, sub] of Object.entries(subs) as [string, Subagent][]) {
            if (sub.status === 'running') {
              subs[id] = { ...sub, status: 'done' }
            }
          }
        }
        // Auto-send queued message when agent finishes successfully
        const queued = this.queuedMessages[workspaceId]
        if ((data.status === 'completed' || data.status === 'idle') && queued) {
          delete this.queuedMessages[workspaceId]
          const wsStore = useWebSocketStore()
          wsStore.sendChatMessage(workspaceId, queued.content, queued.sessionId)
          this.addActivityItem(workspaceId, {
            id: `user-${Date.now()}`,
            type: 'text',
            content: queued.content,
            timestamp: new Date().toISOString(),
            sessionId: queued.sessionId,
            meta: { sender: 'user', pending: true },
          })
        }
      }
    },
  },
})
