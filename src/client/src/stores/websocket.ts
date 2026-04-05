import { defineStore } from 'pinia'
import type { DevServerStatus } from './dev-server'
import { useDevServerStore } from './dev-server'
import { useWorkspaceStore } from './workspace'

export const useWebSocketStore = defineStore('websocket', {
  state: () => ({
    connected: false,
    lastEventId: null as string | null,
    _ws: null as WebSocket | null,
    _reconnectTimer: null as ReturnType<typeof setTimeout> | null,
    _reconnectAttempt: 0,
  }),

  actions: {
    connect() {
      if (this._ws) return

      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      const url = `${protocol}//${window.location.host}/ws`

      const ws = new WebSocket(url)
      this._ws = ws

      ws.addEventListener('open', () => {
        this.connected = true
        this._reconnectAttempt = 0

        // Request sync if we have a last event ID
        if (this.lastEventId) {
          ws.send(
            JSON.stringify({
              type: 'sync:request',
              payload: { lastEventId: this.lastEventId },
            }),
          )
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
        this._ws = null
        this._scheduleReconnect()
      })

      ws.addEventListener('error', () => {
        // close event will fire after error, triggering reconnect
      })
    },

    disconnect() {
      if (this._reconnectTimer) {
        clearTimeout(this._reconnectTimer)
        this._reconnectTimer = null
      }
      if (this._ws) {
        this._ws.close()
        this._ws = null
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
      if (this._ws && this._ws.readyState === WebSocket.OPEN) {
        this._ws.send(JSON.stringify(data))
      }
    },

    _scheduleReconnect() {
      if (this._reconnectTimer) return

      // Exponential backoff: 1s, 2s, 4s, 8s, 16s, max 30s
      const delay = Math.min(1000 * 2 ** this._reconnectAttempt, 30000)
      this._reconnectAttempt++

      this._reconnectTimer = setTimeout(() => {
        this._reconnectTimer = null
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
              workspaceStore.addActivityItem(wid, {
                id: `${eventId}-${(b.id as string) ?? Math.random()}`,
                type: 'tool_use',
                content: (b.name as string) ?? 'tool',
                timestamp,
                sessionId,
                meta: b,
              })
            }
          } else if (outputType === 'tool_use') {
            workspaceStore.addActivityItem(wid, {
              id: eventId,
              type: 'tool_use',
              content: (payload.name as string) ?? 'tool',
              timestamp,
              sessionId,
              meta: payload,
            })
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
            // Skip noisy hook events
            if (subtype === 'hook_started' || subtype === 'hook_response') {
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
              // Switch to this new session
              if (sessionId) {
                workspaceStore.selectSession(sessionId)
              }
            }

            const handler = subtype ? systemMessages[subtype] : undefined
            let content: string | null = null

            if (typeof handler === 'function') {
              content = handler(payload)
            } else if (typeof handler === 'string') {
              content = handler
            } else {
              // Unknown subtype — show as formatted JSON
              content = `[${subtype ?? 'system'}] ${JSON.stringify(payload, null, 2)}`
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
            // Only show cost/token summary — the result text is already shown as an assistant message
            const usage = payload.usage as Record<string, unknown> | undefined
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
                  const resultText = typeof b.content === 'string' ? b.content : this._extractReadableContent(b.content)
                  if (resultText) {
                    const toolId = (b.tool_use_id as string) ?? ''
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
            workspaceStore.updateWorkspaceFromEvent(wid, { status: payload.status as string })
            workspaceStore.fetchWorkspaces()
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
          // Replay persisted events to restore activity feed after refresh
          const events =
            (payload.events as Array<{
              id: string
              workspaceId: string
              type: string
              payload: Record<string, unknown>
              createdAt: string
            }>) ?? []
          for (const evt of events) {
            this._routeMessage(evt)
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
