import { defineStore } from 'pinia'
import i18n from 'src/i18n'
import { notify } from 'src/utils/notifications'
import type { DevServerStatus } from './dev-server'
import { useDevServerStore } from './dev-server'
import { useSettingsStore } from './settings'
import { useWorkspaceStore } from './workspace'

const t = i18n.global.t

// Module-level variables — must NOT be reactive (Vue Proxy breaks WebSocket)
let _ws: WebSocket | null = null
let _reconnectTimer: ReturnType<typeof setTimeout> | null = null
let _reconnectAttempt = 0

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

    sendChatMessage(workspaceId: string, content: string) {
      this._send({
        type: 'chat:message',
        payload: { workspaceId, content },
      })
    },

    _send(data: Record<string, unknown>) {
      if (_ws && _ws.readyState === WebSocket.OPEN) {
        _ws.send(JSON.stringify(data))
      }
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
      const eventId = msg.id ?? msg.eventId ?? Date.now().toString()
      if (msg.id) {
        this.lastEventId = msg.id
      } else if (msg.eventId) {
        this.lastEventId = msg.eventId
      }

      const payload = msg.payload ?? {}
      const timestamp = msg.createdAt ?? new Date().toISOString()
      const sessionId = (msg as Record<string, unknown>).sessionId as string | undefined

      const wid = msg.workspaceId ?? (payload.workspaceId as string | undefined) ?? ''

      switch (msg.type) {
        case 'agent:output': {
          const outputType = payload.type as string | undefined

          if (outputType === 'assistant') {
            // Claude stream-json wraps content in message.content
            const message = payload.message as Record<string, unknown> | undefined
            const rawContent = message?.content ?? payload.content
            const contentBlocks = Array.isArray(rawContent) ? rawContent : []
            const textContent = contentBlocks
              .filter((b: unknown) => (b as Record<string, unknown>).type === 'text')
              .map((b: unknown) => (b as Record<string, unknown>).text as string)
              .join('\n')

            if (textContent) {
              workspaceStore.addActivityItem(wid, {
                id: eventId,
                type: 'text',
                content: textContent,
                timestamp,
                sessionId,
                meta: payload,
              })
            }

            const toolUseBlocks = contentBlocks.filter(
              (b: unknown) => (b as Record<string, unknown>).type === 'tool_use',
            )
            for (const block of toolUseBlocks) {
              const b = block as Record<string, unknown>
              const toolName = (b.name as string) ?? 'tool'
              workspaceStore.addActivityItem(wid, {
                id: `${eventId}-${(b.id as string) ?? Math.random()}`,
                type: 'tool_use',
                content: toolName,
                timestamp,
                sessionId,
                meta: b,
              })
              // Trigger git panel refresh when agent runs git-related Bash commands
              if (toolName === 'Bash' && wid) {
                const input = b.input as Record<string, unknown> | undefined
                const cmd = ((input?.command as string) ?? '') + ((input?.description as string) ?? '')
                if (/\bgit\b|commit|push|pull|merge|rebase|checkout|branch/i.test(cmd)) {
                  workspaceStore.triggerGitRefresh()
                }
              }
              // Capture TodoWrite to track agent's internal todos
              if (toolName === 'TodoWrite' && wid) {
                const input = b.input as Record<string, unknown> | undefined
                if (input?.todos && Array.isArray(input.todos)) {
                  workspaceStore.updateAgentTodos(
                    wid,
                    (input.todos as Array<Record<string, unknown>>).map((t) => ({
                      content: (t.content as string) ?? '',
                      status: (t.status as string) ?? 'pending',
                      activeForm: (t.activeForm as string) ?? undefined,
                    })),
                  )
                }
              }
            }
          } else if (outputType === 'tool_use') {
            const toolName = (payload.name as string) ?? 'tool'
            workspaceStore.addActivityItem(wid, {
              id: eventId,
              type: 'tool_use',
              content: toolName,
              timestamp,
              sessionId,
              meta: payload,
            })
            // Capture TodoWrite to track agent's internal todos
            if (toolName === 'TodoWrite' && wid) {
              const input = payload.input as Record<string, unknown> | undefined
              if (input?.todos && Array.isArray(input.todos)) {
                workspaceStore.updateAgentTodos(
                  wid,
                  (input.todos as Array<Record<string, unknown>>).map((t) => ({
                    content: (t.content as string) ?? '',
                    status: (t.status as string) ?? 'pending',
                    activeForm: (t.activeForm as string) ?? undefined,
                  })),
                )
              }
            }
          } else if (outputType === 'tool_result') {
            const resultContent = this._extractToolResultContent(payload.content)
            if (resultContent) {
              workspaceStore.addActivityItem(wid, {
                id: eventId,
                type: 'tool_use',
                content: resultContent,
                timestamp,
                sessionId,
                meta: payload,
              })
            }
          } else if (outputType === 'system') {
            const subtype = payload.subtype as string | undefined
            // Skip noisy events (hooks, and optionally subagent task progress)
            if (subtype === 'hook_started' || subtype === 'hook_response') {
              break
            }

            // Capture subagent state from task_started / task_progress / task_notification
            if (subtype === 'task_started' || subtype === 'task_progress' || subtype === 'task_notification') {
              const toolUseId = payload.tool_use_id as string | undefined
              if (wid && toolUseId) {
                const usage = payload.usage as Record<string, unknown> | undefined
                const taskStatus = payload.status as string | undefined
                const isDone = subtype === 'task_notification' && taskStatus === 'completed'
                workspaceStore.upsertSubagent(wid, {
                  toolUseId,
                  description: (payload.description as string) ?? (payload.summary as string) ?? undefined,
                  taskType: (payload.task_type as string) ?? undefined,
                  status: isDone ? 'done' : 'running',
                  lastToolName: (payload.last_tool_name as string) ?? undefined,
                  totalTokens: (usage?.total_tokens as number) ?? undefined,
                  toolUses: (usage?.tool_uses as number) ?? undefined,
                  durationMs: (usage?.duration_ms as number) ?? undefined,
                })
              }
            }

            if (
              (subtype === 'task_progress' || subtype === 'task_started' || subtype === 'task_notification') &&
              !useSettingsStore().showVerboseSystemMessages
            ) {
              break
            }

            // Map known subtypes to readable messages
            const systemMessages: Record<string, string | ((p: Record<string, unknown>) => string | null)> = {
              init: 'Session started',
              compact: 'Context compacted — conversation history was summarized',
              compact_boundary: (p) =>
                `Compact boundary (${(p.compact_metadata as Record<string, unknown>)?.trigger ?? 'auto'}, ${(p.compact_metadata as Record<string, unknown>)?.pre_tokens ?? '?'} tokens before)`,
              status: (p) => {
                if (p.status === 'compacting') return 'Compacting context...'
                if (p.status) return `Status: ${p.status}`
                return null
              },
            }

            if (subtype === 'init') {
              workspaceStore.fetchSessions(wid)
              // Never auto-switch session on init — let the user stay on
              // "All sessions" so the feed is not filtered and previous
              // activity remains visible across agent restarts/resumes.
              if (!useSettingsStore().showVerboseSystemMessages) break
            }

            const handler = subtype ? systemMessages[subtype] : undefined
            let content: string | null = null

            if (typeof handler === 'function') {
              content = handler(payload)
            } else if (typeof handler === 'string') {
              content = handler
            } else {
              // Unknown subtype — show summary if available, otherwise short label
              const summary = (payload.summary as string) ?? null
              if (summary) {
                content = `[${subtype ?? 'system'}] ${summary}`
              } else {
                content = `[${subtype ?? 'system'}]`
              }
            }

            if (content) {
              workspaceStore.addActivityItem(wid, {
                id: eventId,
                type: 'system',
                content,
                timestamp,
                sessionId,
                meta: payload,
              })
            }
          } else if (outputType === 'result') {
            // Always capture usage stats for the stats panel, regardless of verbose mode
            const usage = payload.usage as Record<string, unknown> | undefined
            if (usage && wid) {
              const inputTokens = (usage.input_tokens ?? usage.inputTokens ?? 0) as number
              const outputTokens = (usage.output_tokens ?? usage.outputTokens ?? 0) as number
              const cost = (payload.cost_usd ?? payload.costUsd ?? usage.cost_usd ?? usage.costUsd ?? 0) as number
              workspaceStore.addUsageStats(wid, { inputTokens, outputTokens, costUsd: cost })
            }

            if (!useSettingsStore().showVerboseSystemMessages) break
            // Show cost/token summary — the result text is already shown as an assistant message
            if (usage) {
              const inputTokens = usage.input_tokens ?? usage.inputTokens
              const outputTokens = usage.output_tokens ?? usage.outputTokens
              const cost = payload.cost_usd ?? payload.costUsd ?? usage.cost_usd ?? usage.costUsd
              const parts: string[] = []
              if (inputTokens) parts.push(`in: ${this._formatTokenCount(inputTokens as number)}`)
              if (outputTokens) parts.push(`out: ${this._formatTokenCount(outputTokens as number)}`)
              if (cost) parts.push(`$${(cost as number).toFixed(4)}`)
              if (parts.length > 0) {
                workspaceStore.addActivityItem(wid, {
                  id: eventId,
                  type: 'system',
                  content: `Session ended [${parts.join(' | ')}]`,
                  timestamp,
                  sessionId,
                  meta: payload,
                })
              }
            }
          } else if (outputType === 'user') {
            // User messages = tool results sent back to Claude
            const message = payload.message as Record<string, unknown> | undefined
            const content = message?.content
            if (typeof content === 'string') {
              workspaceStore.addActivityItem(wid, {
                id: eventId,
                type: 'tool_use',
                content: content.length > 300 ? `${content.slice(0, 300)}...` : content,
                timestamp,
                sessionId,
                meta: payload,
              })
            } else if (Array.isArray(content)) {
              // Tool result with content blocks
              for (const block of content) {
                const b = block as Record<string, unknown>
                if (b.type === 'tool_result') {
                  const toolId = (b.tool_use_id as string) ?? ''
                  // Mark any tracked subagent as done when its tool_result arrives
                  if (wid && toolId && workspaceStore.subagents[wid]?.[toolId]) {
                    workspaceStore.upsertSubagent(wid, { toolUseId: toolId, status: 'done' })
                  }
                  const resultText = typeof b.content === 'string' ? b.content : this._extractReadableContent(b.content)
                  if (resultText) {
                    workspaceStore.addActivityItem(wid, {
                      id: `${eventId}-${toolId}`,
                      type: 'tool_use',
                      content: `Result: ${resultText.length > 300 ? `${resultText.slice(0, 300)}...` : resultText}`,
                      timestamp,
                      sessionId,
                      meta: b,
                    })
                  }
                }
              }
            }
          } else if (outputType === 'rate_limit_event') {
            if (!useSettingsStore().showVerboseSystemMessages) break
            const info = payload.rate_limit_info as Record<string, unknown> | undefined
            if (info) {
              const status = (info.status as string) ?? 'unknown'
              const utilization = info.utilization as number | undefined
              workspaceStore.addActivityItem(wid, {
                id: eventId,
                type: 'system',
                content: `Rate limit: ${status}${utilization !== undefined ? ` (${Math.round(utilization * 100)}% used)` : ''}`,
                timestamp,
                sessionId,
                meta: payload,
              })
            }
          } else if (outputType === 'raw') {
            const rawContent = this._extractReadableContent(payload.content ?? payload)
            if (rawContent) {
              workspaceStore.addActivityItem(wid, {
                id: eventId,
                type: 'raw',
                content: rawContent,
                timestamp,
                sessionId,
                meta: payload,
              })
            }
          } else {
            // Unknown type — show it so nothing is hidden
            const fallbackContent = this._extractReadableContent(payload)
            if (fallbackContent) {
              workspaceStore.addActivityItem(wid, {
                id: eventId,
                type: 'raw',
                content: `[${outputType ?? 'unknown'}] ${fallbackContent}`,
                timestamp,
                sessionId,
                meta: payload,
              })
            }
          }
          break
        }

        case 'agent:status': {
          if (wid) {
            const status = payload.status as string
            workspaceStore.updateWorkspaceFromEvent(wid, { status })
            workspaceStore.fetchWorkspaces()
            if (!this._replaying && (status === 'completed' || status === 'idle' || status === 'error')) {
              const wsName = workspaceStore.workspaces.find((w) => w.id === wid)?.name ?? ''
              const title =
                status === 'error'
                  ? t('notification.agentError', { name: wsName })
                  : t('notification.agentFinished', { name: wsName })
              notify(title, undefined, wid)
            }
          }
          break
        }

        case 'agent:progress':
          if (payload.tasks && Array.isArray(payload.tasks)) {
            workspaceStore.tasks = payload.tasks
          }
          break

        case 'agent:error': {
          if (wid) {
            workspaceStore.updateWorkspaceFromEvent(wid, { status: 'error' })
            workspaceStore.addActivityItem(wid, {
              id: eventId,
              type: 'error',
              content: (payload.message as string) ?? 'Unknown error',
              timestamp,
              sessionId,
              meta: payload,
            })
          }
          break
        }

        case 'user:message': {
          if (wid && payload.content) {
            const content = payload.content as string
            const sender = (payload.sender as string) ?? 'user'
            const items = workspaceStore.activityFeeds[wid] ?? []
            // Check if this message was already added locally (by ChatInput)
            const alreadyExists =
              sender === 'user' &&
              items.some((i) => i.meta?.sender === 'user' && i.content === content && i.meta?.pending)
            if (alreadyExists) {
              // Update ID and sessionId but keep pending=true until agent responds
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
          // Replay persisted events — suppress notifications during replay
          this._replaying = true
          try {
            const events =
              (payload.events as Array<{
                id: string
                workspaceId: string
                type: string
                payload: Record<string, unknown>
                createdAt: string
              }>) ?? []
            for (const evt of events) {
              if (evt.type === 'sync:response') continue
              this._routeMessage(evt)
            }
          } finally {
            this._replaying = false
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
            content: msg.payload?.text ?? '',
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
      }
    },

    /**
     * Extract readable content from a tool_result payload.
     * Returns a short summary string, or empty string to skip.
     */
    _extractToolResultContent(content: unknown): string {
      if (typeof content === 'string') return content
      if (Array.isArray(content)) {
        const texts = content
          .filter((b) => typeof b === 'object' && b !== null && (b as Record<string, unknown>).type === 'text')
          .map((b) => (b as Record<string, unknown>).text as string)
        const joined = texts.join('\n')
        if (joined) return joined
      }
      if (content && typeof content === 'object') {
        return this._extractReadableContent(content)
      }
      return ''
    },

    /**
     * Extract human-readable text from an unknown value.
     * Tries common fields (content, text, message), falls back to truncated JSON.
     */
    _extractReadableContent(value: unknown): string {
      if (typeof value === 'string') return value
      if (!value || typeof value !== 'object') return ''

      const obj = value as Record<string, unknown>

      // Try common text fields
      for (const key of ['content', 'text', 'message', 'description', 'summary']) {
        if (typeof obj[key] === 'string' && obj[key]) {
          return obj[key] as string
        }
      }

      // If there's a nested content array (Claude format), extract text blocks
      if (Array.isArray(obj.content)) {
        const texts = obj.content
          .filter((b: unknown) => typeof b === 'object' && b !== null && (b as Record<string, unknown>).type === 'text')
          .map((b: unknown) => (b as Record<string, unknown>).text as string)
          .filter(Boolean)
        if (texts.length > 0) return texts.join('\n')
      }

      // Last resort: JSON
      return JSON.stringify(obj, null, 2)
    },

    /**
     * Format a token count for display (e.g., 1234 -> "1.2k")
     */
    _formatTokenCount(count: number): string {
      if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`
      if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`
      return String(count)
    },
  },
})
