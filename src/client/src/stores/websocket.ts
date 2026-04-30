import { defineStore } from 'pinia'
import i18n from 'src/i18n'
import { useAgentStreamStore } from 'src/stores/agent-stream'
import type { AgentEvent } from 'src/types/agent-event'
import type { ProviderId, UsageSnapshot } from 'src/types/usage'
import { notify } from 'src/utils/notifications'
import type { DevServerStatus } from './dev-server'
import { useDevServerStore } from './dev-server'
import type { MigrationStatus } from './migration'
import { useMigrationStore } from './migration'
import { useWorkspaceStore } from './workspace'

const t = i18n.global.t

// Module-level variables — must NOT be reactive (Vue Proxy breaks WebSocket)
let _ws: WebSocket | null = null
let _reconnectTimer: ReturnType<typeof setTimeout> | null = null
let _reconnectAttempt = 0
// Suppress notifications when the dispatcher is invoked during sync:response
// replay. Mutated by the store's `_replaying` guard via `setReplaying`.
let _replayingNotifications = false

/** Internal: set by the store while processing `sync:response` to mute notifications. */
export function _setReplayingForDispatch(value: boolean): void {
  _replayingNotifications = value
}

/**
 * Handle `session:started` side-effects: flip the local workspace status to
 * `executing` AND switch the selected session to the one that just started.
 *
 * The session switch matters for auto-loop: each iteration spawns a FRESH
 * session (resume=false), and without this switch the UI stays on the
 * previous session's chat while streaming happens in the new one.
 * Skipped during sync:response replay so we don't clobber the user's
 * selection when reconnecting.
 */
function _handleSessionStarted(workspaceId: string, event: AgentEvent, sessionId?: string): void {
  if (event.kind !== 'session:started') return
  const workspaceStore = useWorkspaceStore()

  const cur = workspaceStore.workspaces.find((w) => w.id === workspaceId)
  if (
    cur &&
    (cur.status === 'completed' || cur.status === 'idle' || cur.status === 'error' || cur.status === 'quota')
  ) {
    workspaceStore.updateWorkspaceFromEvent(workspaceId, { status: 'executing' })
  }

  if (_replayingNotifications) return
  if (!sessionId) return
  if (workspaceStore.selectedWorkspaceId !== workspaceId) return
  if (workspaceStore.selectedSessionId === sessionId) return

  void workspaceStore.fetchSessions(workspaceId, sessionId).catch((err) => {
    console.error('[websocket] fetchSessions on session:started failed:', err)
  })
}

/**
 * Central dispatcher for normalised `AgentEvent`s received via WebSocket
 * (`agent:event` frames or `sync:response` replays).
 *
 * Always appends to the per-workspace event stream (consumed by ActivityFeed
 * + sibling panels via `foldEvents`), and routes the side-effect-bearing
 * kinds (`usage`, `rate_limit`, `subagent:progress`, `session:ended`,
 * `error{quota}`) to the workspace store so the existing Stats / Quota /
 * Subagents panels keep working and the user gets completion notifications.
 *
 * Exported so it can be tested in isolation without spinning up the WS.
 */
export function dispatchAgentEvent(
  workspaceId: string,
  event: AgentEvent,
  timestamp?: string,
  eventId?: string,
  sessionId?: string | null,
): void {
  useAgentStreamStore().append(workspaceId, event, timestamp, eventId, sessionId)
  _handleSessionStarted(workspaceId, event, sessionId ?? undefined)

  const workspaceStore = useWorkspaceStore()

  if (event.kind === 'usage') {
    workspaceStore.addUsageStats(workspaceId, {
      inputTokens: event.inputTokens,
      outputTokens: event.outputTokens,
      costUsd: event.costUsd ?? 0,
    })
    return
  }

  if (event.kind === 'rate_limit') {
    workspaceStore.setRateLimitUsage(workspaceId, event.info)
    return
  }

  if (event.kind === 'subagent:progress') {
    workspaceStore.upsertSubagent(workspaceId, {
      toolUseId: event.toolCallId,
      status: event.status,
      description: event.description,
      taskType: event.taskType,
      lastToolName: event.lastToolName,
      totalTokens: event.totalTokens,
      toolUses: event.toolUses,
      durationMs: event.durationMs,
    })
    return
  }

  // The agent's own internal todo list is carried by the `TodoWrite` tool
  // call. Mirror its latest snapshot into the workspace store so the
  // "Agent todos" panel on the right can render it. No ack/ordering logic —
  // each call fully replaces the previous list, matching the tool's contract.
  if (event.kind === 'tool:call' && event.name === 'TodoWrite') {
    const input = event.input as Record<string, unknown> | undefined
    const rawTodos = input?.todos
    if (Array.isArray(rawTodos)) {
      workspaceStore.updateAgentTodos(
        workspaceId,
        (rawTodos as Array<Record<string, unknown>>).map((t) => ({
          content: typeof t.content === 'string' ? t.content : '',
          status: typeof t.status === 'string' ? t.status : 'pending',
          activeForm: typeof t.activeForm === 'string' ? t.activeForm : undefined,
        })),
      )
    }
    return
  }

  // Detect Bash tool calls that perform git operations and bump the
  // `gitRefreshTrigger` so GitPanel re-fetches stats a few seconds after
  // the command completes. The regex is deliberately loose — false
  // positives just cause an extra stats refresh, whereas a miss means
  // the panel stays stale until the user clicks refresh.
  if (event.kind === 'tool:call' && event.name === 'Bash') {
    const input = event.input as Record<string, unknown> | undefined
    const cmd = `${(input?.command as string | undefined) ?? ''} ${(input?.description as string | undefined) ?? ''}`
    if (/\bgit\b|commit|push|pull|merge|rebase|checkout|branch/i.test(cmd)) {
      workspaceStore.triggerGitRefresh()
    }
    // Extra: when the agent renames the current branch in-place
    // (`git branch -m [<old>] <new>`), the DB's `workingBranch` drifts from
    // what git actually tracks. Fire a resync so the rest of Kōbō (push,
    // PR, diff scopes, commits panel) stays aligned.
    if (/\bgit\s+branch\s+-m\b/i.test(cmd)) {
      setTimeout(() => {
        void workspaceStore.resyncWorkspaceBranch(workspaceId).catch((err) => {
          console.error('[websocket] Branch resync failed:', err)
        })
      }, 2500)
    }
    // Extra: `gh pr create` opens a new PR on GitHub. The generic git
    // regex above does not match `gh`, so without this block the
    // GitPanel would only show the new PR after the 30 s pr-watcher
    // poll (or a manual refresh). Schedule a refresh 3 s later — long
    // enough for the `gh` CLI to finish its round-trip to GitHub so the
    // subsequent `gh pr view` sees the freshly created PR. The regex is
    // deliberately loose (would also match a hypothetical
    // `gh pr create-from-template`) — a false positive just causes an
    // extra idempotent refresh.
    if (/\bgh\s+pr\s+create\b/i.test(cmd)) {
      setTimeout(() => workspaceStore.triggerGitRefresh(), 3000)
    }
    // Don't return — tool:call may need other side-effects in the future.
  }

  // `ExitPlanMode` is the native Claude CLI tool that signals the agent is
  // leaving plan-read-only mode to start implementation. Kōbō mirrors that
  // transition into `workspace.permissionMode` so the next turn no longer
  // spawns the CLI with `--permission-mode plan` (and the UI badge updates
  // from "Plan" to "Auto-accept" in real time).
  if (event.kind === 'tool:call' && event.name === 'ExitPlanMode') {
    const cur = workspaceStore.workspaces.find((w) => w.id === workspaceId)
    if (cur?.permissionMode === 'plan') {
      // Optimistic local update so the badge flips immediately.
      workspaceStore.updateWorkspaceFromEvent(workspaceId, { permissionMode: 'auto-accept' })
      // Persist to DB — best-effort. If it fails the local state will be
      // corrected on the next fetchWorkspaces / workspace refresh.
      void workspaceStore.updatePermissionMode(workspaceId, 'auto-accept').catch((err) => {
        console.error('[websocket] failed to persist ExitPlanMode flip:', err)
      })
    }
  }

  // session:started — handled separately in _handleSessionStarted (which also
  // has access to the sessionId for auto-loop session switching). Nothing else
  // to do here for this kind.
  if (event.kind === 'session:started') return

  // Session lifecycle: session:ended signals completion/error/kill. Refresh
  // the workspace list so the new DB status shows up, and surface a
  // notification if not replaying.
  if (event.kind === 'session:ended') {
    const currentStatus = workspaceStore.workspaces.find((w) => w.id === workspaceId)?.status
    const derivedStatus =
      currentStatus === 'quota'
        ? 'quota'
        : event.reason === 'completed'
          ? 'completed'
          : event.reason === 'error'
            ? 'error'
            : 'idle'
    workspaceStore.updateWorkspaceFromEvent(workspaceId, { status: derivedStatus })
    // Subagents live inside the parent session: when it ends, any still in
    // `running` are orphaned. Flip them to `done` so AgentBusyBanner doesn't
    // keep reporting "1 sub-agent en cours" on a completed workspace.
    workspaceStore.finalizeRunningSubagents(workspaceId)
    workspaceStore.fetchWorkspaces()
    if (!_replayingNotifications && event.reason !== 'killed') {
      const wsName = workspaceStore.workspaces.find((w) => w.id === workspaceId)?.name ?? ''
      const title =
        event.reason === 'error'
          ? t('notification.agentError', { name: wsName })
          : t('notification.agentFinished', { name: wsName })
      notify(title, undefined, workspaceId)
    }
    return
  }

  // Quota errors: flip the workspace to 'quota' in the local cache and fetch
  // the authoritative state. No notification — the user will see the panel.
  if (event.kind === 'error' && event.category === 'quota') {
    workspaceStore.updateWorkspaceFromEvent(workspaceId, { status: 'quota' })
    workspaceStore.fetchWorkspaces()
  }
}

export const useWebSocketStore = defineStore('websocket', {
  state: () => ({
    connected: false,
    lastEventId: null as string | null,
    _replaying: false,
  }),

  actions: {
    connect() {
      if (_ws) return

      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      const url = `${protocol}//${window.location.host}/ws`

      const ws = new WebSocket(url)
      _ws = ws

      ws.addEventListener('open', () => {
        this.connected = true
        _reconnectAttempt = 0

        // Re-subscribe to all known workspaces (subscriptions are lost on reconnect)
        const workspaceStore = useWorkspaceStore()
        const allIds = workspaceStore.workspaces.map((w) => w.id)
        for (const wid of allIds) {
          this._send({ type: 'subscribe', payload: { workspaceId: wid } })
        }

        // Request sync to catch up on missed events
        if (this.lastEventId) {
          this._send({
            type: 'sync:request',
            payload: { lastEventId: this.lastEventId, workspaceIds: allIds },
          })
        }
      })

      ws.addEventListener('message', (event) => {
        try {
          const msg = JSON.parse(event.data)
          this._routeMessage(msg)
        } catch {
          // Ignore unparseable messages
        }
      })

      ws.addEventListener('close', () => {
        this.connected = false
        _ws = null
        this._scheduleReconnect()
      })

      ws.addEventListener('error', () => {
        // close event will fire after error, triggering reconnect
      })
    },

    disconnect() {
      if (_reconnectTimer) {
        clearTimeout(_reconnectTimer)
        _reconnectTimer = null
      }
      if (_ws) {
        _ws.close()
        _ws = null
      }
      this.connected = false
    },

    subscribe(workspaceId: string) {
      this._send({
        type: 'subscribe',
        payload: { workspaceId },
      })
      // Request all past events for this workspace to restore activity feed
      this._send({
        type: 'sync:request',
        payload: { workspaceIds: [workspaceId] },
      })
    },

    unsubscribe(workspaceId: string) {
      this._send({
        type: 'unsubscribe',
        payload: { workspaceId },
      })
    },

    sendChatMessage(
      workspaceId: string,
      content: string,
      sessionId?: string,
      permissionModeOverride?: 'auto-accept' | 'plan',
    ) {
      this._send({
        type: 'chat:message',
        payload: { workspaceId, content, sessionId, permissionModeOverride },
      })

      // Optimistic status update — flip to `executing` instantly if the
      // workspace is in a terminal state so the "Agent busy" banner,
      // typing spinner and stop button show without waiting 1-3s for the
      // round-trip: client → WS → backend → CLI spawn → init → session:started.
      // If the backend actually fails to start, a session:ended event will
      // come back soon and correct the status via the existing handler.
      const ws = useWorkspaceStore()
      const cur = ws.workspaces.find((w) => w.id === workspaceId)
      if (
        cur &&
        (cur.status === 'completed' || cur.status === 'idle' || cur.status === 'error' || cur.status === 'quota')
      ) {
        ws.updateWorkspaceFromEvent(workspaceId, { status: 'executing' })
      }
    },

    _send(data: Record<string, unknown>) {
      if (_ws && _ws.readyState === WebSocket.OPEN) {
        _ws.send(JSON.stringify(data))
      }
    },

    // Public surface for callers that need to know whether their `_send`-based
    // call would actually go out (e.g. the review submit needs to surface
    // failures to the user instead of silently dropping the payload).
    isConnected(): boolean {
      return _ws !== null && _ws.readyState === WebSocket.OPEN
    },

    _scheduleReconnect() {
      if (_reconnectTimer) return

      // Exponential backoff: 1s, 2s, 4s, 8s, 16s, max 30s
      const delay = Math.min(1000 * 2 ** _reconnectAttempt, 30000)
      _reconnectAttempt++

      _reconnectTimer = setTimeout(() => {
        _reconnectTimer = null
        this.connect()
      }, delay)
    },

    _routeMessage(msg: {
      // WsEvent format from server
      id?: string
      workspaceId?: string
      type: string
      payload?: Record<string, unknown>
      createdAt?: string
      // Legacy/direct format
      eventId?: string
    }) {
      const workspaceStore = useWorkspaceStore()

      // Track event ID for sync — server sends WsEvent with 'id' field
      if (msg.id) {
        this.lastEventId = msg.id
      } else if (msg.eventId) {
        this.lastEventId = msg.eventId
      }

      const payload = msg.payload ?? {}

      const wid = msg.workspaceId ?? (payload.workspaceId as string | undefined) ?? ''

      switch (msg.type) {
        case 'agent:event': {
          if (!wid) break
          // The payload IS the normalised AgentEvent — emitted by
          // event-router.ts as `emit(workspaceId, 'agent:event', event)`.
          const ts = (msg as { createdAt?: string }).createdAt
          const evtId = msg.id ?? msg.eventId
          const sid = (msg as { sessionId?: string | null }).sessionId ?? null
          dispatchAgentEvent(wid, payload as unknown as AgentEvent, ts, evtId, sid)
          break
        }

        case 'agent:progress':
          if (payload.tasks && Array.isArray(payload.tasks)) {
            workspaceStore.tasks = payload.tasks
          }
          break

        case 'user:message': {
          if (wid && payload.content) {
            // User messages are now represented as `message:text` events in
            // the agent-stream, but we still surface them via the workspace
            // store's legacy activityFeeds slot so ChatInput's "pending"
            // resolution logic keeps working.
            const content = payload.content as string
            const sender = (payload.sender as string) ?? 'user'
            const sessionId = (msg as Record<string, unknown>).sessionId as string | undefined
            const eventId = msg.id ?? msg.eventId ?? `user-${Date.now()}`
            const timestamp = msg.createdAt ?? new Date().toISOString()
            const items = workspaceStore.activityFeeds[wid] ?? []
            const alreadyExists =
              sender === 'user' &&
              items.some((i) => i.meta?.sender === 'user' && i.content === content && i.meta?.pending)
            if (alreadyExists) {
              const idx = items.findIndex((i) => i.meta?.sender === 'user' && i.content === content && i.meta?.pending)
              if (idx >= 0) {
                items[idx] = { ...items[idx], id: eventId, sessionId }
              }
            } else {
              workspaceStore.addActivityItem(wid, {
                id: eventId,
                type: 'text',
                content,
                timestamp,
                sessionId,
                meta: { sender },
              })
            }
          }
          break
        }

        case 'sync:response': {
          // Replay persisted events — suppress notifications during replay.
          this._replaying = true
          _setReplayingForDispatch(true)
          try {
            const events =
              (payload.events as Array<{
                id: string
                workspaceId: string
                type: string
                payload: Record<string, unknown>
                createdAt: string
                sessionId?: string | null
              }>) ?? []
            // Group agent:event payloads per workspace for bulk reset (O(1)
            // reactivity instead of O(n) append notifications), then route
            // every other event through the normal dispatcher.
            const grouped = new Map<
              string,
              {
                events: AgentEvent[]
                timestamps: string[]
                sessionIds: Array<string | null>
                eventIds: Array<string | null>
                oldestId: string | undefined
              }
            >()
            for (const evt of events) {
              if (evt.type === 'sync:response') continue
              if (evt.type === 'agent:event' && evt.workspaceId) {
                const bucket = grouped.get(evt.workspaceId) ?? {
                  events: [],
                  timestamps: [],
                  sessionIds: [],
                  eventIds: [],
                  oldestId: undefined,
                }
                bucket.events.push(evt.payload as unknown as AgentEvent)
                bucket.timestamps.push(evt.createdAt)
                bucket.sessionIds.push(evt.sessionId ?? null)
                bucket.eventIds.push(evt.id ?? null)
                if (!bucket.oldestId) bucket.oldestId = evt.id
                grouped.set(evt.workspaceId, bucket)
                continue
              }
              this._routeMessage(evt)
            }
            if (grouped.size > 0) {
              const streamStore = useAgentStreamStore()
              for (const [
                workspaceId,
                { events: list, timestamps: tsList, sessionIds: sList, eventIds: eList, oldestId },
              ] of grouped) {
                // `hasMoreOlder` starts true optimistically — the infinite
                // scroll fetch will learn the real answer on its first hit.
                streamStore.reset(workspaceId, list, tsList, {
                  oldestId,
                  hasMoreOlder: true,
                  sessionIds: sList,
                  eventIds: eList,
                })
                // Replay side-effects (usage/rate_limit/subagent) without
                // re-appending — append was already replaced by reset().
                for (const ev of list) {
                  if (ev.kind === 'usage' || ev.kind === 'rate_limit' || ev.kind === 'subagent:progress') {
                    // reset() already pushed the event into the stream, so
                    // only route the side-effect — but dispatchAgentEvent
                    // also calls append(). To keep things simple we accept
                    // the duplicate-in-stream cost of the replayed event on
                    // the side-effect branches; the conversation view is
                    // driven by foldEvents, and these kinds are filtered out
                    // of the conversation anyway.
                    //
                    // Call the side-effect bits manually to avoid appending
                    // twice to the stream.
                    const workspaceStore = useWorkspaceStore()
                    if (ev.kind === 'usage') {
                      workspaceStore.addUsageStats(workspaceId, {
                        inputTokens: ev.inputTokens,
                        outputTokens: ev.outputTokens,
                        costUsd: ev.costUsd ?? 0,
                      })
                    } else if (ev.kind === 'rate_limit') {
                      workspaceStore.setRateLimitUsage(workspaceId, ev.info)
                    } else if (ev.kind === 'subagent:progress') {
                      workspaceStore.upsertSubagent(workspaceId, {
                        toolUseId: ev.toolCallId,
                        status: ev.status,
                        description: ev.description,
                        taskType: ev.taskType,
                        lastToolName: ev.lastToolName,
                        totalTokens: ev.totalTokens,
                        toolUses: ev.toolUses,
                        durationMs: ev.durationMs,
                      })
                    }
                  }
                }
              }
            }
          } finally {
            this._replaying = false
            _setReplayingForDispatch(false)
          }
          break
        }

        case 'usage:snapshot': {
          const p = payload as { providerId?: ProviderId; snapshot?: UsageSnapshot }
          if (p.providerId && p.snapshot) {
            workspaceStore.applyUsageSnapshot({ providerId: p.providerId, snapshot: p.snapshot })
          }
          break
        }

        case 'devserver:status': {
          const devServerStore = useDevServerStore()
          if (wid) {
            devServerStore.updateFromWsEvent(wid, payload as unknown as DevServerStatus)
          }
          break
        }

        case 'task:updated': {
          if (wid) {
            workspaceStore.fetchWorkspaceDetails(wid)
          }
          break
        }

        case 'setup:output':
          workspaceStore.addActivityItem(wid, {
            id: msg.id ?? `setup-${Date.now()}`,
            type: 'text',
            content: (msg.payload?.text as string) ?? '',
            timestamp: msg.createdAt ?? new Date().toISOString(),
            meta: { sender: 'setup' },
          })
          break

        case 'setup:complete':
          workspaceStore.addActivityItem(wid, {
            id: msg.id ?? `setup-complete-${Date.now()}`,
            type: 'text',
            content: '[setup] Complete',
            timestamp: msg.createdAt ?? new Date().toISOString(),
            meta: { sender: 'setup' },
          })
          break

        case 'setup:error':
          workspaceStore.addActivityItem(wid, {
            id: msg.id ?? `setup-error-${Date.now()}`,
            type: 'text',
            content: `[setup] Error: ${msg.payload?.message ?? 'unknown'}`,
            timestamp: msg.createdAt ?? new Date().toISOString(),
            meta: { sender: 'error' },
          })
          break

        case 'workspace:unread': {
          if (wid) {
            const hasUnread = (payload.hasUnread as boolean) ?? false
            workspaceStore.updateWorkspaceFromEvent(wid, { hasUnread })
          }
          break
        }

        case 'workspace:archived':
        case 'workspace:unarchived': {
          // Refresh active list; if the archived tab was ever opened, refresh that too.
          workspaceStore.fetchWorkspaces()
          if (workspaceStore.archivedLoaded) {
            workspaceStore.fetchArchivedWorkspaces()
          }
          break
        }

        case 'wakeup:scheduled': {
          if (wid) {
            const p = payload as { targetAt?: string; reason?: string }
            if (typeof p.targetAt === 'string') {
              workspaceStore.setPendingWakeup(wid, { targetAt: p.targetAt, reason: p.reason })
            }
          }
          break
        }

        case 'wakeup:cancelled':
        case 'wakeup:fired':
        case 'wakeup:skipped': {
          if (wid) workspaceStore.clearPendingWakeup(wid)
          break
        }

        case 'autoloop:enabled':
        case 'autoloop:disabled':
        case 'autoloop:iteration-started':
        case 'autoloop:ready-flipped': {
          // Refresh the full state map — small payload, keeps code simple.
          void workspaceStore.fetchAutoLoopStates()
          break
        }

        case 'migration:progress':
        case 'migration:error':
          useMigrationStore().update(payload as unknown as MigrationStatus)
          break
      }
    },
  },
})
