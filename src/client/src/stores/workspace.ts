import { defineStore } from 'pinia'
import { apiFetch } from 'src/utils/api'
import type { ProviderId, UsageSnapshot } from '../types/usage'
import { hasPrAttention } from '../utils/pr-status'
import { isBusyStatus } from '../utils/workspace-status'
import { useAgentStreamStore } from './agent-stream'
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
  prWatchDisabledAt: string | null
  tags: string[]
  description: string | null
  agentDescription: string | null
  /**
   * Brainstorm prompt persisted at workspace-creation time so a setup-script
   * crash doesn't lose the user's input. Non-null until the agent successfully
   * ingests it via POST /:id/start (server clears it then).
   */
  initialPrompt: string | null
  /** pr.updatedAt at the time the user clicked "Marquer comme vu" on the
   *  changes-requested badge. Null = never dismissed. The badge is hidden
   *  until the watcher observes a fresher pr.updatedAt. */
  prChangesDismissedAt: string | null
  /** Same as `prChangesDismissedAt` but for the CI failure badge. */
  prCiFailureDismissedAt: string | null
  /** ISO timestamp when the worktree was purged from disk. Null = present. */
  worktreePurgedAt: string | null
  /** JSON blob (string) with restore metadata captured at purge time. */
  worktreePurgeRestoreData: string | null
  autoLoop: boolean
  autoLoopReady: boolean
  noProgressStreak: number
  worktreePath: string
  worktreeOwned: boolean
  createdAt: string
  updatedAt: string
}

/**
 * Server-side memory truth about an agent controller, never derived from the
 * `status` column. See `getAgentLiveness` / `getAllAgentLiveness` in
 * `orchestrator.ts` — this is the exact shape those serialize.
 */
export interface AgentLiveness {
  status: 'running' | 'stopping'
  agentSessionId: string
  startedAt: string
  lastEventAt: string
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
  engine?: string | null
  status: string
  model?: string | null
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
  brainstormModel?: string
  reasoningEffort?: string
  agentPermissionMode?: 'plan' | 'bypass' | 'strict' | 'interactive'
  tasks?: string[]
  acceptanceCriteria?: string[]
  autoLoop?: boolean
  autoLoopSessionMode?: 'per_task' | 'continuous'
  // Client-generated channel id the caller subscribed to (via
  // websocketStore.subscribeChannel) *before* this call, so it can receive
  // `workspace:create-progress` / `workspace:create-failed` beats for a
  // workspace that doesn't have an id yet.
  creationId?: string
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
  /** Originating TaskCreate tool-call id (Claude Code ≥ v0.3.142 Task tools). */
  id?: string
  /** Sequential `#N` parsed from the TaskCreate result, used to match TaskUpdate. */
  taskNumber?: number
}

/**
 * Normalize a Claude Code Task-tool status (`pending | running | completed |
 * failed | killed | paused`) to the vocabulary the AgentTodosPanel renders
 * (`pending | in_progress | completed`). Unknown values pass through.
 */
export function normalizeAgentTaskStatus(status: string): string {
  if (status === 'running') return 'in_progress'
  return status
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

export interface ForgeInfo {
  id: 'github' | 'gitlab' | 'bitbucket-community' | 'none'
  capabilities: {
    canCreatePr: boolean
    canChangePrBase: boolean
    canMergeRequest: boolean
    canDeleteRemoteBranch: boolean
    requestTermShort: 'PR' | 'MR'
  }
  availability: { available: boolean; reason?: 'cli_missing' | 'not_authenticated' }
}

export interface GitStats {
  commitCount: number
  behindCount: number
  filesChanged: number
  insertions: number
  deletions: number
  prUrl: string | null
  prState: 'OPEN' | 'CLOSED' | 'MERGED' | null
  unpushedCount: number // -1 = no upstream
  workingTree: { staged: number; modified: number; untracked: number }
  forge?: ForgeInfo
  /** Epoch ms (server clock) when these stats were computed. Used to merge the
   *  30s background poll monotonically — see `fetchWorkspacesInfo`. */
  computedAt?: number
}

export interface BranchCommit {
  sha: string
  shortSha: string
  subject: string
  author: string
  date: string
  isPushed: boolean
}

export interface Commit {
  sha: string
  shortSha: string
  subject: string
  author: string
  date: string
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
  tasks_done: number
  tasks_total: number
  crons_count: number
}

export interface PrReviewer {
  login: string
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING'
}

export interface PrCiCheck {
  name: string
  conclusion: string | null
  status: string
  detailsUrl: string | null
}

export interface PrSnapshot {
  number: number
  title: string
  url: string
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  base: string
  reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null
  author: { login: string }
  assignees: Array<{ login: string }>
  reviewers: PrReviewer[]
  labels: Array<{ name: string; color: string }>
  ci: { rollup: 'SUCCESS' | 'FAILURE' | 'PENDING' | 'CANCELLED' | 'NEUTRAL' | null; checks: PrCiCheck[] }
  updatedAt: string
  /**
   * Number of review threads still unresolved on the PR. GitHub keeps
   * `reviewDecision` at `CHANGES_REQUESTED` until the reviewer re-reviews or
   * dismisses, even after the author resolves every comment thread. The UI
   * combines this counter with `reviewDecision` to decide whether the PR is
   * truly blocking or merely flagged stale.
   */
  unresolvedReviewThreadsCount: number
  /** Computed in the backend: OPEN + CI all green + not blocked by changes-requested. */
  readyToMerge: boolean
}

export interface PendingCron {
  id: string
  workspaceId: string
  expression: string
  prompt: string
  label: string | null
  agentSessionId: string | null
  nextFireAt: string
  lastFiredAt: string | null
  oneShot: boolean
  createdAt: string
}

const MAX_FEED_ITEMS = 5000

// Debounce window for `fetchPrSnapshots` called via `triggerGitRefresh`. The
// backend cache (pr-watcher) only updates on its own 30 s poll, so coalescing
// many git bumps into a single fetch costs nothing and keeps the network
// quiet during loops like repeated `git status`.
const PR_SNAPSHOTS_DEBOUNCE_MS = 500
let _prSnapshotsDebounceTimer: ReturnType<typeof setTimeout> | null = null

// Monotonic request counter for `fetchWorkspacesInfo` out-of-order response
// guarding — internal bookkeeping unrelated to reactive store state, so it
// lives as a module-level variable rather than a Pinia state field (mirrors
// `_prSnapshotsDebounceTimer` above).
let _workspacesInfoRequestToken = 0
let _prSnapshotsRequestToken = 0
const _workspaceEventVersions = new Map<string, number>()
const _prSnapshotVersions = new Map<string, number>()
const _sessionsRequestVersions = new Map<string, number>()
const _workspaceDetailsRequestVersions = new Map<string, number>()

function markPrSnapshotChanged(workspaceId: string): void {
  _prSnapshotVersions.set(workspaceId, (_prSnapshotVersions.get(workspaceId) ?? 0) + 1)
}

function mergePrSnapshots(
  incoming: Record<string, PrSnapshot>,
  current: Record<string, PrSnapshot>,
  versionsAtStart: Map<string, number>,
): Record<string, PrSnapshot> {
  const next = { ...incoming }
  const ids = new Set([...Object.keys(incoming), ...Object.keys(current)])
  for (const id of ids) {
    const existing = current[id]
    const candidate = incoming[id]
    const changedDuringRequest = (_prSnapshotVersions.get(id) ?? 0) !== (versionsAtStart.get(id) ?? 0)
    const existingTimestamp = existing ? Date.parse(existing.updatedAt) : Number.NaN
    const candidateTimestamp = candidate ? Date.parse(candidate.updatedAt) : Number.NaN
    const existingIsNewer = Number.isFinite(existingTimestamp) && existingTimestamp > candidateTimestamp
    if (changedDuringRequest || existingIsNewer) {
      if (existing) next[id] = existing
      else delete next[id]
    }
  }
  return next
}

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
    // Server message (or transport error) from the most recent failed
    // fetchWorkspaces/fetchArchivedWorkspaces/fetchWorkspacesInfo call. Null
    // means the last load succeeded — this is what lets the sidebar tell a
    // dead backend apart from a genuinely empty account, which used to render
    // identically.
    listLoadError: null as string | null,
    // Consecutive failures of the 30s `/api/workspaces/info` poll. The banner
    // only goes up on the second one: a single dropped poll (a laptop waking
    // up, a proxy blip) must not flash "backend is down" at a user whose
    // backend is fine. The initial load has no such delay — someone who just
    // opened the app is waiting for an answer.
    listPollFailureStreak: 0,
    // True when the last load of the ACTIVE list failed. Keeps a successful
    // archived load from clearing a banner it has no authority over:
    // `retryLoadWorkspaces` runs both loaders back to back.
    activeListLoadFailed: false,
    loadingOlderEvents: false,
    hasMoreEvents: {} as Record<string, boolean>,
    providerUsage: {} as Record<ProviderId, UsageSnapshot | undefined>,
    chatDraft: '',
    queuedMessages: {} as Record<string, { content: string; sessionId: string }>,
    activeAgentSessionIds: {} as Record<string, string>,
    // A model turn may be complete while its engine stream is still draining.
    // Keep this UI-only state separate from persisted workspace status.
    settledAgentSessionIds: {} as Record<string, string>,
    gitRefreshTrigger: 0,
    gitStatsCache: {} as Record<string, GitStats>,
    pendingWakeups: {} as Record<string, PendingWakeup>,
    pendingQuotaBackoffs: {} as Record<string, { targetAt: string; resetsAt: string | null; source: string }>,
    pendingDeferred: {} as Record<string, PendingDeferredToolUse>,
    pendingQueue: {} as Record<string, PendingItem[]>,
    prSnapshots: {} as Record<string, PrSnapshot>,
    autoLoopStates: {} as Record<string, AutoLoopStatus>,
    crons: {} as Record<string, PendingCron[]>,
    // Live step of an in-flight POST /api/workspaces, fed by the ephemeral
    // `workspace:create-progress` events the server emits on the creationId
    // channel. Null whenever no creation is running.
    creationProgress: null as { creationId: string; step: string; index: number; total: number } | null,
    // Server-side memory truth. A workspace absent from this map has no agent,
    // whatever its `status` column says.
    agentLiveness: {} as Record<string, AgentLiveness>,
    // Whether `agentLiveness` reflects a liveness read that completed *after*
    // the workspace's current status took effect. Absence from `agentLiveness`
    // only means "confirmed no controller" once this is true — otherwise the
    // workspace simply hasn't been checked yet for its current status (e.g.
    // the HTTP round trip is still in flight right after a WebSocket status
    // flip). Set by `applyAgentLiveness` and `fetchWorkspacesInfo`, cleared by
    // `updateWorkspaceFromEvent` on every status change. See
    // `shouldWarnAgentNotRunning` in `utils/workspace-status.ts`.
    agentLivenessLoaded: {} as Record<string, boolean>,
  }),

  getters: {
    selectedWorkspace: (state) =>
      state.workspaces.find((w) => w.id === state.selectedWorkspaceId) ??
      state.archivedWorkspaces.find((w) => w.id === state.selectedWorkspaceId) ??
      null,

    needsAttention(state): Workspace[] {
      return state.workspaces.filter(
        (w) =>
          ['error', 'quota', 'awaiting-user'].includes(w.status) ||
          hasPrAttention(state.prSnapshots[w.id]) ||
          (!isBusyStatus(w.status) && !!state.prSnapshots[w.id]?.readyToMerge),
      )
    },

    running(state): Workspace[] {
      return state.workspaces.filter((w) => isBusyStatus(w.status) && !hasPrAttention(state.prSnapshots[w.id]))
    },

    idle(state): Workspace[] {
      return state.workspaces.filter(
        (w) =>
          ['completed', 'idle', 'created'].includes(w.status) &&
          !hasPrAttention(state.prSnapshots[w.id]) &&
          !state.prSnapshots[w.id]?.readyToMerge,
      )
    },

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
    clearWorkspaceLocalState(id: string) {
      delete this.activityFeeds[id]
      delete this.activityFeedIds[id]
      delete this.activityCounts[id]
      delete this.subagents[id]
      delete this.agentTodos[id]
      delete this.hasMoreEvents[id]
      delete this.gitStatsCache[id]
      delete this.pendingWakeups[id]
      delete this.pendingQuotaBackoffs[id]
      delete this.pendingDeferred[id]
      delete this.pendingQueue[id]
      delete this.prSnapshots[id]
      delete this.autoLoopStates[id]
      delete this.crons[id]
      delete this.activeAgentSessionIds[id]
      for (const key of Object.keys(this.queuedMessages)) {
        if (key.startsWith(`${id}:`)) delete this.queuedMessages[key]
      }
      _workspaceEventVersions.delete(id)
      _prSnapshotVersions.delete(id)
      _sessionsRequestVersions.delete(id)
      _workspaceDetailsRequestVersions.delete(id)
      useAgentStreamStore().clear(id)
      localStorage.removeItem(`kobo:session:${id}`)
    },

    setCreationProgress(progress: { creationId: string; step: string; index: number; total: number }) {
      this.creationProgress = progress
    },

    clearCreationProgress() {
      this.creationProgress = null
    },

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

    async togglePrWatch(id: string) {
      const before = this.workspaces.find((w) => w.id === id)
      if (!before) return
      const disabling = before.prWatchDisabledAt === null
      const optimistic = disabling ? new Date().toISOString() : null
      this.workspaces = this.workspaces.map((w) => (w.id === id ? { ...w, prWatchDisabledAt: optimistic } : w))
      try {
        const res = await fetch(`/api/workspaces/${id}/pr-watch-disabled`, {
          method: disabling ? 'POST' : 'DELETE',
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        if (disabling) {
          const updated = (await res.json()) as Workspace
          this.workspaces = this.workspaces.map((w) => (w.id === id ? updated : w))
          delete this.prSnapshots[id]
          markPrSnapshotChanged(id)
        } else {
          const { workspace, prSnapshot } = (await res.json()) as {
            workspace: Workspace
            prSnapshot: PrSnapshot | null
          }
          this.workspaces = this.workspaces.map((w) => (w.id === id ? workspace : w))
          if (prSnapshot) this.prSnapshots[id] = prSnapshot
          else delete this.prSnapshots[id]
          markPrSnapshotChanged(id)
        }
      } catch (err) {
        this.workspaces = this.workspaces.map((w) =>
          w.id === id ? { ...w, prWatchDisabledAt: before.prWatchDisabledAt } : w,
        )
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
      return apiFetch(`/api/git/orphan-worktrees?projectPath=${encodeURIComponent(projectPath)}`, {
        cache: 'no-store',
      })
    },

    async fetchWorkspaces() {
      this.loading = true
      try {
        const data = await apiFetch<{ workspaces?: Workspace[] } | Workspace[]>('/api/workspaces')
        this.workspaces = Array.isArray(data) ? data : (data.workspaces ?? [])
        this.listLoadError = null
        this.activeListLoadFailed = false
        this.listPollFailureStreak = 0
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
        // A dead backend and an empty account used to render identically.
        // Recording the failure — without touching `this.workspaces` — is
        // what lets the sidebar say which one it is, without wiping out a
        // list that was already showing on screen.
        this.listLoadError = err instanceof Error ? err.message : String(err)
        this.activeListLoadFailed = true
        console.error('[workspace store] fetchWorkspaces failed:', err)
      } finally {
        this.loading = false
      }
    },

    /** Re-runs the loaders behind the sidebar's Retry button after a failed load. */
    async retryLoadWorkspaces() {
      await this.fetchWorkspaces()
      if (this.archivedLoaded) await this.fetchArchivedWorkspaces()
    },

    async fetchArchivedWorkspaces() {
      try {
        this.archivedWorkspaces = await apiFetch<Workspace[]>('/api/workspaces/archived')
        this.archivedLoaded = true
        // This loader used to post the banner and never lift it, so a failure
        // survived the backend coming back. It clears its own failure — but
        // never one the active list raised, which it knows nothing about.
        if (!this.activeListLoadFailed) this.listLoadError = null
      } catch (err) {
        this.listLoadError = err instanceof Error ? err.message : String(err)
        console.error('[workspace store] fetchArchivedWorkspaces failed:', err)
      }
    },

    async fetchWorkspaceDetails(id: string) {
      const requestVersion = (_workspaceDetailsRequestVersions.get(id) ?? 0) + 1
      _workspaceDetailsRequestVersions.set(id, requestVersion)
      const eventVersionAtStart = _workspaceEventVersions.get(id) ?? 0
      try {
        const data = await apiFetch<{ workspace?: Workspace; tasks?: Task[] } & Partial<Workspace>>(
          `/api/workspaces/${id}`,
        )

        // Guard against stale response: user may have switched workspace while
        // this request was in flight.
        if (this.selectedWorkspaceId !== id || _workspaceDetailsRequestVersions.get(id) !== requestVersion) return

        // A WebSocket event can flip `status` (e.g. executing -> awaiting-user)
        // while this read is in flight — same class of race `fetchWorkspacesInfo`
        // already guards against via `_workspaceEventVersions`. Don't let a
        // late response resurrect a stale status over a fresher one. This is
        // scoped to `status` only: `agentLiveness` below is server-authoritative
        // and is exactly what this read exists to deliver, so it always applies.
        const statusChangedDuringRequest = (_workspaceEventVersions.get(id) ?? 0) !== eventVersionAtStart
        const incomingRaw = data.workspace ?? data
        const incoming = statusChangedDuringRequest ? { ...incomingRaw } : incomingRaw
        if (statusChangedDuringRequest) {
          delete incoming.status
        }

        // Update workspace in whichever list it lives in (active or archived).
        const idx = this.workspaces.findIndex((w) => w.id === id)
        if (idx >= 0) {
          this.workspaces[idx] = { ...this.workspaces[idx], ...incoming }
        } else {
          const aIdx = this.archivedWorkspaces.findIndex((w) => w.id === id)
          if (aIdx >= 0) {
            this.archivedWorkspaces[aIdx] = { ...this.archivedWorkspaces[aIdx], ...incoming }
          } else if (incoming?.archivedAt) {
            this.archivedWorkspaces.unshift(incoming as Workspace)
          }
        }

        // Update tasks
        if (data.tasks) {
          this.tasks = data.tasks
        }

        // `GET /:id` already serializes the in-memory controller liveness —
        // consume it here so the AgentLivenessChip doesn't have to wait for
        // the next 30s `fetchWorkspacesInfo` poll to stop showing a false
        // "no process" warning right after a legitimate start/status flip.
        if ('agentLiveness' in data) {
          this.applyAgentLiveness(id, data.agentLiveness as AgentLiveness | null)
        }
      } catch (err) {
        console.error('[workspace store] fetchWorkspaceDetails failed:', err)
      }
    },

    /** Pure merge of a single workspace's liveness into the map — sets the
     *  entry when a controller is reported, removes it otherwise so a
     *  stopped/never-started agent doesn't linger as a stale "running".
     *  Always marks the workspace as loaded: a `GET /:id` response that
     *  reaches here — with or without a controller — is a completed,
     *  server-authoritative confirmation for this one workspace. */
    applyAgentLiveness(workspaceId: string, liveness: AgentLiveness | null | undefined) {
      this.agentLivenessLoaded = { ...this.agentLivenessLoaded, [workspaceId]: true }
      if (liveness) {
        this.agentLiveness = { ...this.agentLiveness, [workspaceId]: liveness }
        return
      }
      if (workspaceId in this.agentLiveness) {
        const next = { ...this.agentLiveness }
        delete next[workspaceId]
        this.agentLiveness = next
      }
    },

    async createWorkspace(input: CreateWorkspaceInput) {
      try {
        // Kept on raw fetch on purpose: this is the only call that reads the
        // X-Kobo-Branch-Adjusted / X-Kobo-Source-Fallback response headers,
        // which apiFetch deliberately does not expose. The error path below
        // already reads the server message, so F43 does not apply here.
        const res = await fetch('/api/workspaces', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        })
        if (!res.ok) {
          // The server destroys what it created when a creation step fails —
          // every step past `create-record`, not just a couple of them — so
          // there is nothing to push into the list, only an error to show. It
          // names the step that broke, and says what the rollback could not
          // reach (setup-script side effects outside the worktree).
          const body = (await res.json().catch(() => ({}))) as { error?: unknown; step?: unknown }
          const message = typeof body.error === 'string' ? body.error : `HTTP ${res.status}`
          throw new WorkspaceActionError(message, typeof body.step === 'string' ? body.step : undefined)
        }
        // The server appends a `-<HASH>` suffix to the working branch (and
        // matching worktree path) when the requested name was already taken.
        // The header is the cheapest way to signal that without changing the
        // JSON shape — the resolved branch is already on the returned workspace.
        const branchAdjusted = res.headers.get('X-Kobo-Branch-Adjusted') === '1'
        const sourceFallback = res.headers.get('X-Kobo-Source-Fallback') === 'local'
        const data = await res.json()
        const workspace = data.workspace ?? data
        // Dedup against a concurrent fetchWorkspaces() that may have already
        // inserted this workspace: events emitted by the create flow (setup
        // output, autoloop:enabled, …) can race the POST response and trigger
        // a list refresh that beats the push by a few ms. Without this guard
        // the sidebar shows the same workspace twice until F5.
        const idx = this.workspaces.findIndex((w) => w.id === workspace.id)
        if (idx >= 0) {
          this.workspaces[idx] = workspace
        } else {
          this.workspaces.push(workspace)
        }
        // When created with autoLoop=true, the server flipped auto_loop=1 in DB
        // but the event broadcast lands before this client is subscribed.
        // Refresh states explicitly so the toggle reflects the new row.
        if (input.autoLoop) {
          void this.fetchAutoLoopStates()
        }
        ;(workspace as Workspace & { _branchAdjusted?: boolean })._branchAdjusted = branchAdjusted
        ;(workspace as Workspace & { _sourceFallback?: boolean })._sourceFallback = sourceFallback
        return workspace as Workspace
      } catch (err) {
        console.error('[workspace store] createWorkspace failed:', err)
        throw err
      }
    },

    async startWorkspace(id: string, prompt?: string, agentSessionId?: string, resume?: boolean) {
      try {
        await apiFetch(`/api/workspaces/${id}/start`, {
          method: 'POST',
          body: { prompt, agentSessionId, resume },
        })
        await this.fetchWorkspaces()
      } catch (err) {
        console.error('[workspace store] startWorkspace failed:', err)
        throw err
      }
    },

    async previewEngineHandoff(id: string, engine: string): Promise<string> {
      const res = await fetch(`/api/workspaces/${id}/engine-handoff-preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ engine }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
      return body.handoff as string
    },

    async switchEngine(
      id: string,
      input: {
        engine: string
        model: string
        reasoningEffort: string
        agentPermissionMode: 'plan' | 'bypass' | 'strict' | 'interactive'
        handoff: string
      },
    ): Promise<{ sessionId: string }> {
      const res = await fetch(`/api/workspaces/${id}/switch-engine`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
      const updated = body.workspace as Workspace
      const idx = this.workspaces.findIndex((workspace) => workspace.id === id)
      if (idx >= 0) this.workspaces[idx] = updated
      await this.fetchSessions(id, body.sessionId)
      return { sessionId: body.sessionId as string }
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

    async interruptAgent(id: string, options: { expectedSessionId?: string; disableAutoLoop?: boolean } = {}) {
      try {
        const res = await fetch(`/api/workspaces/${id}/interrupt`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(options),
        })
        if (!res.ok) {
          const body: unknown = await res.json().catch(() => undefined)
          const errorBody =
            typeof body === 'object' && body !== null && !Array.isArray(body)
              ? (body as Record<string, unknown>)
              : undefined
          const message = typeof errorBody?.error === 'string' ? errorBody.error : `HTTP ${res.status}`
          const responseCode = errorBody?.code
          const code =
            (res.status === 409 && (responseCode === 'no_agent_running' || responseCode === 'session_not_active')) ||
            (res.status === 500 && responseCode === 'interrupt_failed')
              ? responseCode
              : undefined
          throw new WorkspaceActionError(message, code)
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
        this.clearWorkspaceLocalState(id)
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

    // Bulk-delete every archived workspace in one request. The backend never
    // aborts mid-batch — failures come back as warnings. Returns the ids that
    // were targeted so the caller can unsubscribe their WS feeds.
    async deleteAllArchived(options?: {
      deleteLocalBranch?: boolean
      deleteRemoteBranch?: boolean
    }): Promise<{ deleted: number; warnings: string[]; ids: string[] }> {
      try {
        // Capture ids before the request so we can clean per-workspace state
        // once the backend confirms the bulk delete.
        const ids = this.archivedWorkspaces.map((w) => w.id)
        const res = await fetch('/api/workspaces/archived', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(options ?? {}),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)

        const body = (await res.json().catch(() => ({}))) as {
          deleted?: number
          warnings?: string[]
        }
        const deleted = typeof body.deleted === 'number' ? body.deleted : 0
        const warnings = Array.isArray(body.warnings) ? body.warnings : []

        this.archivedWorkspaces = []
        for (const id of ids) {
          this.clearWorkspaceLocalState(id)
          if (this.selectedWorkspaceId === id) {
            this.selectedWorkspaceId = null
            this.tasks = []
          }
        }

        return { deleted, warnings, ids }
      } catch (err) {
        console.error('[workspace store] deleteAllArchived failed:', err)
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

    async updateWorkspaceDescription(id: string, description: string | null) {
      const idx = this.workspaces.findIndex((w) => w.id === id)
      if (idx < 0) throw new Error(`Workspace '${id}' not found in store`)
      const previous = this.workspaces[idx].description
      // Optimistic update.
      this.workspaces[idx] = { ...this.workspaces[idx], description }
      try {
        const res = await fetch(`/api/workspaces/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ description }),
        })
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string }
          throw new Error(body.error ?? `HTTP ${res.status}`)
        }
        const updated = (await res.json()) as Workspace
        this.workspaces = this.workspaces.map((workspace) =>
          workspace.id === id ? { ...workspace, ...updated } : workspace,
        )
      } catch (err) {
        // Revert optimistic update.
        const cur = this.workspaces.findIndex((w) => w.id === id)
        if (cur >= 0 && this.workspaces[cur].description === description) {
          this.workspaces[cur] = { ...this.workspaces[cur], description: previous }
        }
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

    async fetchGitStats(id: string, opts: { freshFetch?: boolean; signal?: AbortSignal } = {}): Promise<GitStats> {
      const url = `/api/workspaces/${id}/git-stats${opts.freshFetch ? '?freshFetch=1' : ''}`
      const stats = await apiFetch<GitStats>(url, { signal: opts.signal, timeoutMs: 60_000 })
      this.gitStatsCache[id] = stats
      return stats
    },

    async fetchBranchDivergence(
      id: string,
      opts: { limit?: number; signal?: AbortSignal } = {},
    ): Promise<{ ahead: BranchCommit[]; behind: Commit[]; sourceBranch: string; workingBranch: string }> {
      const limit = opts.limit ?? 50
      const url = `/api/workspaces/${id}/branch-divergence?limit=${limit}`
      const res = await fetch(url, { signal: opts.signal })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return (await res.json()) as {
        ahead: BranchCommit[]
        behind: Commit[]
        sourceBranch: string
        workingBranch: string
      }
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
        if (!res.ok) {
          if (res.status === 409) {
            const body = (await res.json().catch(() => ({}))) as { error?: string }
            const err = new Error(body.error ?? 'worktree-purged') as Error & { code?: string }
            err.code = 'worktree-purged'
            throw err
          }
          throw new Error(`HTTP ${res.status}`)
        }
        const updated = (await res.json()) as Workspace
        this.archivedWorkspaces = this.archivedWorkspaces.filter((w) => w.id !== id)
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
      this.sessions = []
      this.tasks = []
      // Mark as read before fetching details so the API response already reflects the read state
      this.markRead(id)
      this.fetchWorkspaceDetails(id)
      this.fetchSessions(id)
      void this.fetchPendingQuotaBackoff(id)
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
      const requestVersion = (_sessionsRequestVersions.get(workspaceId) ?? 0) + 1
      _sessionsRequestVersions.set(workspaceId, requestVersion)
      try {
        const res = await fetch(`/api/workspaces/${workspaceId}/sessions`)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)

        // Guard against stale response: user may have switched workspace while
        // this request was in flight.
        const sessions = (await res.json()) as AgentSession[]
        if (this.selectedWorkspaceId !== workspaceId || _sessionsRequestVersions.get(workspaceId) !== requestVersion)
          return

        this.sessions = sessions

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

    async deleteSession(workspaceId: string, sessionId: string): Promise<void> {
      const res = await fetch(`/api/workspaces/${workspaceId}/sessions/${sessionId}`, { method: 'DELETE' })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
      const wasSelected = this.selectedSessionId === sessionId
      const updated = body.workspace as Workspace | undefined
      if (updated) {
        const idx = this.workspaces.findIndex((workspace) => workspace.id === workspaceId)
        if (idx >= 0) this.workspaces[idx] = updated
      }
      await this.fetchSessions(workspaceId)
      if (wasSelected && this.selectedWorkspaceId === workspaceId) this.selectSession(this.sessions[0]?.id ?? null)
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
      this.schedulePrSnapshotsRefresh()
    },

    /**
     * Trailing-edge debounce for `fetchPrSnapshots`. `triggerGitRefresh` fires
     * on every git-matching Bash tool:call, which can be many per minute
     * (`git status` loops, etc.). A single pr-snapshots refetch per burst is
     * enough — the backend snapshot is updated only every 30 s by the
     * pr-watcher poll anyway.
     */
    schedulePrSnapshotsRefresh() {
      if (_prSnapshotsDebounceTimer !== null) clearTimeout(_prSnapshotsDebounceTimer)
      _prSnapshotsDebounceTimer = setTimeout(() => {
        _prSnapshotsDebounceTimer = null
        void this.fetchPrSnapshots()
      }, PR_SNAPSHOTS_DEBOUNCE_MS)
    },

    async fetchPrSnapshots(): Promise<void> {
      const requestToken = ++_prSnapshotsRequestToken
      const versionsAtStart = new Map(_prSnapshotVersions)
      try {
        const res = await fetch('/api/workspaces/pr-states', { cache: 'no-store' })
        if (!res.ok) return
        const data = (await res.json()) as Record<string, PrSnapshot>
        if (requestToken !== _prSnapshotsRequestToken) return
        this.prSnapshots = mergePrSnapshots(data, this.prSnapshots, versionsAtStart)
      } catch (err) {
        console.error('[workspace-store] fetchPrSnapshots failed:', err)
      }
    },

    /**
     * Bulk 30s refresh — pulls `/api/workspaces/info` (server-cached, cheap)
     * and updates the workspace list, PR snapshots and git-stats cache in one
     * shot so every non-archived workspace stays ≤30s fresh.
     */
    async fetchWorkspacesInfo(): Promise<void> {
      // Overlapping polls (a slow prior request still in flight when the
      // next 30s tick fires) can resolve out of order. Only the response
      // to the MOST RECENTLY issued request is allowed to write state —
      // otherwise a late-arriving stale response can revert workspaces/
      // prSnapshots that a WebSocket event already brought up to date.
      const requestToken = ++_workspacesInfoRequestToken
      const eventVersionsAtStart = new Map(_workspaceEventVersions)
      const prVersionsAtStart = new Map(_prSnapshotVersions)
      try {
        const data = await apiFetch<{
          workspaces: Workspace[]
          prSnapshots: Record<string, PrSnapshot>
          gitStats: Record<string, GitStats>
          agentLiveness?: Record<string, AgentLiveness>
        }>('/api/workspaces/info', { cache: 'no-store' })
        // The backend answered: that is true whether or not this particular
        // response is still the freshest one, so lift the banner before the
        // staleness check below.
        this.listPollFailureStreak = 0
        this.activeListLoadFailed = false
        this.listLoadError = null
        if (requestToken !== _workspacesInfoRequestToken) return
        // Full replacement, never a merge: an entry that disappeared means the
        // controller is gone, which is the single most important thing to show.
        this.agentLiveness = data.agentLiveness ?? {}
        // Every workspace covered by this snapshot now has a confirmed
        // liveness read, whether or not it appears in `agentLiveness` above —
        // absence from the map above IS the confirmation for those ids.
        const loadedFromInfo = { ...this.agentLivenessLoaded }
        for (const ws of data.workspaces) loadedFromInfo[ws.id] = true
        this.agentLivenessLoaded = loadedFromInfo
        const currentById = new Map(this.workspaces.map((workspace) => [workspace.id, workspace]))
        this.workspaces = data.workspaces.map((incoming) => {
          const current = currentById.get(incoming.id)
          const changedDuringRequest =
            (_workspaceEventVersions.get(incoming.id) ?? 0) !== (eventVersionsAtStart.get(incoming.id) ?? 0)
          return current && changedDuringRequest ? { ...incoming, ...current } : incoming
        })
        for (const ws of this.workspaces) {
          if (['completed', 'idle', 'error', 'quota'].includes(ws.status)) {
            this.finalizeRunningSubagents(ws.id)
          }
        }
        this.prSnapshots = mergePrSnapshots(data.prSnapshots, this.prSnapshots, prVersionsAtStart)
        // Monotonic merge: the server's git-stats cache (lastKnownGitStats) lags
        // up to one pr-watcher tick (~30s) behind a just-completed git op, so a
        // freshly fetched on-demand snapshot can be newer than what this poll
        // carries. Never replace fresher local stats with an older poll snapshot
        // — otherwise the GitPanel reverts to the pre-op state until the user
        // hits refresh. Entries without `computedAt` are treated as oldest.
        const mergedStats = { ...this.gitStatsCache }
        for (const [wsId, incoming] of Object.entries(data.gitStats)) {
          const existing = mergedStats[wsId]
          if (!existing || (incoming.computedAt ?? 0) >= (existing.computedAt ?? 0)) {
            mergedStats[wsId] = incoming
          }
        }
        this.gitStatsCache = mergedStats
      } catch (err) {
        console.error('[workspace-store] fetchWorkspacesInfo failed:', err)
        // A backend that dies AFTER the initial load is the dominant real
        // case — the user leaves the tab open. The poll used to swallow that
        // entirely, leaving a list that looked live but was frozen. Record
        // the failure, and never touch `this.workspaces`: an error must not
        // wipe data that is still valid on screen.
        this.listPollFailureStreak += 1
        if (this.listPollFailureStreak >= 2) {
          this.activeListLoadFailed = true
          this.listLoadError = err instanceof Error ? err.message : String(err)
        }
      }
    },

    async refreshPrSnapshot(workspaceId: string): Promise<PrSnapshot | null> {
      try {
        const res = await fetch(`/api/workspaces/pr-snapshot/refresh/${workspaceId}`, { method: 'POST' })
        if (res.status === 404) {
          const next = { ...this.prSnapshots }
          delete next[workspaceId]
          this.prSnapshots = next
          markPrSnapshotChanged(workspaceId)
          return null
        }
        if (!res.ok) {
          console.error('[workspace-store] refreshPrSnapshot non-OK:', res.status)
          return null
        }
        const data = (await res.json()) as { snapshot: PrSnapshot }
        this.prSnapshots = { ...this.prSnapshots, [workspaceId]: data.snapshot }
        markPrSnapshotChanged(workspaceId)
        return data.snapshot
      } catch (err) {
        console.error('[workspace-store] refreshPrSnapshot failed:', err)
        return null
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

    async fetchCrons(workspaceId: string): Promise<void> {
      try {
        const res = await fetch(`/api/workspaces/${workspaceId}/crons`)
        if (!res.ok) return
        const body = (await res.json()) as { crons: PendingCron[] }
        this.crons[workspaceId] = body.crons
      } catch (err) {
        console.error('[workspace-store] fetchCrons failed:', err)
      }
    },

    async cancelCron(workspaceId: string, cronId: string): Promise<void> {
      const prev = this.crons[workspaceId] ?? []
      this.crons[workspaceId] = prev.filter((c) => c.id !== cronId)
      try {
        const res = await fetch(`/api/workspaces/${workspaceId}/crons/${cronId}`, { method: 'DELETE' })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
      } catch (err) {
        this.crons[workspaceId] = prev
        throw err
      }
    },

    async createCron(
      workspaceId: string,
      input: { expression: string; prompt: string; label?: string; mode: 'fresh' | 'resume'; oneShot: boolean },
    ): Promise<void> {
      const res = await fetch(`/api/workspaces/${workspaceId}/crons`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      await this.fetchCrons(workspaceId)
    },

    async scheduleManualWakeup(
      workspaceId: string,
      input: { delaySeconds: number; prompt: string; mode: 'fresh' | 'resume' },
    ): Promise<void> {
      const res = await fetch(`/api/workspaces/${workspaceId}/pending-wakeup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      const data = (await res.json()) as { ok: boolean; pending: PendingWakeup | null }
      if (data.pending) this.pendingWakeups[workspaceId] = data.pending
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

    async fetchPendingQuotaBackoff(workspaceId: string): Promise<void> {
      try {
        const res = await fetch(`/api/workspaces/${workspaceId}/quota-backoff`, { cache: 'no-store' })
        if (!res.ok) return
        const data = (await res.json()) as { targetAt: string; resetsAt: string | null; source: string } | null
        if (data) this.pendingQuotaBackoffs[workspaceId] = data
        else delete this.pendingQuotaBackoffs[workspaceId]
      } catch (err) {
        console.error('[workspace-store] fetchPendingQuotaBackoff failed:', err)
      }
    },

    setPendingQuotaBackoff(
      workspaceId: string,
      payload: { targetAt: string; resetsAt: string | null; source: string },
    ): void {
      this.pendingQuotaBackoffs[workspaceId] = payload
    },

    clearPendingQuotaBackoff(workspaceId: string): void {
      delete this.pendingQuotaBackoffs[workspaceId]
    },

    async cancelQuotaBackoff(workspaceId: string): Promise<void> {
      const had = this.pendingQuotaBackoffs[workspaceId] !== undefined
      delete this.pendingQuotaBackoffs[workspaceId]
      try {
        const res = await fetch(`/api/workspaces/${workspaceId}/quota-backoff`, { method: 'DELETE' })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
      } catch (err) {
        console.error('[workspace-store] cancelQuotaBackoff failed:', err)
        if (had) await this.fetchPendingQuotaBackoff(workspaceId)
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
      if (head?.kind !== 'question') return undefined
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
      awaitingFreeForm?: boolean,
      response?: string,
    ): Promise<void> {
      const res = await fetch(`/api/workspaces/${workspaceId}/deferred-tool-use/answer`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ answers, toolCallId, awaitingFreeForm, response }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        const message = body.error ?? `HTTP ${res.status}`
        // Self-heal a zombie panel left by a stale replay or a session that
        // ended while the question panel was visible. There is no callback to
        // recover in any of these cases, so retaining the form only lets the
        // user submit the same impossible answer again.
        if (
          /no deferred tool use pending|no agent running|no active engine process|no pending callback/i.test(message)
        ) {
          console.warn('[workspace] submitDeferredAnswer: deferred callback expired — clearing zombie panel locally')
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
      scope: 'once' | 'turn' | 'operation' | 'tool' = 'once',
    ): Promise<void> {
      const res = await fetch(`/api/workspaces/${workspaceId}/deferred-permission/decision`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ toolCallId, decision, reason, scope }),
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

    // --- Claude Code ≥ v0.3.142 Task tools (TaskCreate/TaskUpdate) ---
    // The agent's internal todo list moved from the snapshot-replace `TodoWrite`
    // tool to accumulating `TaskCreate`/`TaskUpdate` tools. We rebuild the same
    // `agentTodos` list the panel reads, keyed by the TaskCreate tool-call id.

    /** Append a todo from a `TaskCreate` tool call (status starts `pending`). */
    agentTaskCreate(
      workspaceId: string,
      toolCallId: string,
      input: { subject?: string; description?: string; activeForm?: string },
    ) {
      const list = this.agentTodos[workspaceId] ? [...this.agentTodos[workspaceId]] : []
      // Idempotent: a replayed event must not duplicate the row.
      if (list.some((t) => t.id === toolCallId)) return
      list.push({
        id: toolCallId,
        content: input.subject || input.description || '',
        status: 'pending',
        activeForm: input.activeForm,
      })
      this.agentTodos[workspaceId] = list
    },

    /** Record the sequential `#N` (from the TaskCreate result) on the row, so a
     *  later TaskUpdate can target it. Numbering is monotonic per workspace. */
    agentTaskSetNumber(workspaceId: string, toolCallId: string, taskNumber: number) {
      const list = this.agentTodos[workspaceId]
      if (!list) return
      this.agentTodos[workspaceId] = list.map((t) => (t.id === toolCallId ? { ...t, taskNumber } : t))
    },

    /** Apply a `TaskUpdate` (matched by `#N`). `status: 'deleted'` removes the
     *  row; any other status updates it (normalized to the panel vocabulary). */
    agentTaskUpdate(
      workspaceId: string,
      taskNumber: number,
      patch: { status?: string; content?: string; activeForm?: string },
    ) {
      const list = this.agentTodos[workspaceId]
      if (!list) return
      if (patch.status === 'deleted') {
        this.agentTodos[workspaceId] = list.filter((t) => t.taskNumber !== taskNumber)
        return
      }
      this.agentTodos[workspaceId] = list.map((t) =>
        t.taskNumber !== taskNumber
          ? t
          : {
              ...t,
              status: patch.status ? normalizeAgentTaskStatus(patch.status) : t.status,
              content: patch.content ?? t.content,
              activeForm: patch.activeForm ?? t.activeForm,
            },
      )
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

    /** Purge a workspace's worktree from disk (auto-archives) while keeping
     *  the chat/session history queryable. Returns the warnings list so the
     *  caller can toast them. */
    async purgeWorktree(workspaceId: string): Promise<{ ok: true; warnings: string[] } | { ok: false; error: string }> {
      try {
        const res = await fetch(`/api/workspaces/${workspaceId}/purge-worktree`, { method: 'POST' })
        const data = await res.json()
        if (!res.ok) {
          return { ok: false, error: data.error ?? `HTTP ${res.status}` }
        }
        const updated = data.workspace as Workspace
        if (updated) {
          this.updateWorkspaceFromEvent(workspaceId, {
            archivedAt: updated.archivedAt,
            worktreePurgedAt: updated.worktreePurgedAt,
            worktreePurgeRestoreData: updated.worktreePurgeRestoreData,
          })
          if (updated.archivedAt && this.archivedLoaded) {
            const exists = this.archivedWorkspaces.some((w) => w.id === workspaceId)
            if (!exists) this.archivedWorkspaces.unshift(updated)
            this.workspaces = this.workspaces.filter((w) => w.id !== workspaceId)
            if (this.selectedWorkspaceId === workspaceId) {
              this.selectedWorkspaceId = null
              this.tasks = []
            }
          }
        }
        return { ok: true, warnings: (data.warnings as string[]) ?? [] }
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        return { ok: false, error }
      }
    },

    /** Dismiss a PR attention badge (changes-requested or CI failure). The
     *  badge stays hidden until the watcher observes a fresher pr.updatedAt. */
    async dismissPrAttention(workspaceId: string, kind: 'changes-requested' | 'ci-failed') {
      const snapshot = this.prSnapshots[workspaceId]
      if (!snapshot) return
      try {
        const res = await fetch(`/api/workspaces/${workspaceId}/dismiss-pr-attention`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ kind, prUpdatedAt: snapshot.updatedAt }),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        // Optimistic store update — the WS event will arrive shortly but the
        // sidebar should flip immediately on click.
        const patch =
          kind === 'changes-requested'
            ? { prChangesDismissedAt: snapshot.updatedAt }
            : { prCiFailureDismissedAt: snapshot.updatedAt }
        this.updateWorkspaceFromEvent(workspaceId, patch)
      } catch (err) {
        console.error('[workspace store] dismissPrAttention failed:', err)
      }
    },

    async restorePrAttention(workspaceId: string, kind: 'changes-requested' | 'ci-failed') {
      try {
        const res = await fetch(`/api/workspaces/${workspaceId}/restore-pr-attention`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ kind }),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        // Optimistic store update — clear the dismissed-at so the badge
        // resurfaces immediately on click.
        const patch = kind === 'changes-requested' ? { prChangesDismissedAt: null } : { prCiFailureDismissedAt: null }
        this.updateWorkspaceFromEvent(workspaceId, patch)
      } catch (err) {
        console.error('[workspace store] restorePrAttention failed:', err)
      }
    },

    queuedMessageKey(workspaceId: string, sessionId: string) {
      return `${workspaceId}:${sessionId}`
    },

    getQueuedMessage(workspaceId: string, sessionId: string | null | undefined) {
      return sessionId ? this.queuedMessages[this.queuedMessageKey(workspaceId, sessionId)] : undefined
    },

    queueMessage(workspaceId: string, content: string, sessionId: string) {
      this.queuedMessages[this.queuedMessageKey(workspaceId, sessionId)] = { content, sessionId }
    },

    cancelQueuedMessage(workspaceId: string, sessionId: string | null | undefined) {
      if (sessionId) delete this.queuedMessages[this.queuedMessageKey(workspaceId, sessionId)]
    },

    flushQueuedMessage(workspaceId: string, sessionId: string) {
      const queued = this.getQueuedMessage(workspaceId, sessionId)
      if (!queued) return
      this.cancelQueuedMessage(workspaceId, sessionId)
      useWebSocketStore().sendChatMessage(workspaceId, queued.content, sessionId)
    },

    setActiveAgentSession(workspaceId: string, sessionId: string) {
      this.activeAgentSessionIds[workspaceId] = sessionId
      delete this.settledAgentSessionIds[workspaceId]
    },

    markAgentTurnSettled(workspaceId: string, sessionId: string) {
      if (this.activeAgentSessionIds[workspaceId] === sessionId) {
        this.settledAgentSessionIds[workspaceId] = sessionId
      }
    },

    isAgentTurnSettled(workspaceId: string): boolean {
      const sessionId = this.activeAgentSessionIds[workspaceId]
      return sessionId !== undefined && this.settledAgentSessionIds[workspaceId] === sessionId
    },

    clearActiveAgentSession(workspaceId: string, sessionId: string) {
      if (this.activeAgentSessionIds[workspaceId] === sessionId) {
        delete this.activeAgentSessionIds[workspaceId]
        delete this.settledAgentSessionIds[workspaceId]
      }
    },

    clearActiveAgentSessionOwner(workspaceId: string) {
      delete this.activeAgentSessionIds[workspaceId]
      delete this.settledAgentSessionIds[workspaceId]
    },

    updateWorkspaceFromEvent(workspaceId: string, data: Partial<Workspace>) {
      _workspaceEventVersions.set(workspaceId, (_workspaceEventVersions.get(workspaceId) ?? 0) + 1)
      const idx = this.workspaces.findIndex((w) => w.id === workspaceId)
      if (idx >= 0) {
        this.workspaces[idx] = { ...this.workspaces[idx], ...data }
      }
      // The status column flips instantly over WebSocket, but `agentLiveness`
      // only otherwise refreshes on the 30s `fetchWorkspacesInfo` poll — a
      // false "no process" warning would flash on the liveness chip for up to
      // 15s after every legitimate start. A single targeted read of the
      // already-selected workspace's `GET /:id` (which already serializes
      // liveness) closes that window without adding a new poll or a
      // dedicated WebSocket channel.
      if (data.status !== undefined) {
        // Any prior liveness confirmation predates this status change and
        // can no longer be trusted to describe it — e.g. a workspace that
        // was confirmed idle a moment ago flips to "executing" here, and
        // that stale "no controller" would otherwise be misread as
        // confirming the brand-new session is already dead. Forget it until
        // a fresh read lands.
        if (workspaceId in this.agentLivenessLoaded) {
          const nextLoaded = { ...this.agentLivenessLoaded }
          delete nextLoaded[workspaceId]
          this.agentLivenessLoaded = nextLoaded
        }
        if (workspaceId === this.selectedWorkspaceId) {
          void this.fetchWorkspaceDetails(workspaceId)
        }
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
      }
    },
  },
})
