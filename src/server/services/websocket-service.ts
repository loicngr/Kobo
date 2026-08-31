import { nanoid } from 'nanoid'
import type WebSocket from 'ws'
import { getDb } from '../db/index.js'
import { getAllPersistedSnapshots } from './usage/db.js'

// ── Types ──────────────────────────────────────────────────────────────────────

/** A persisted or ephemeral event broadcast to subscribed WebSocket clients. */
export interface WsEvent {
  id: string
  workspaceId: string
  type: string
  payload: unknown
  sessionId?: string
  createdAt: string
  replayable: boolean
}

/** Incoming message from a WebSocket client. */
export interface WsMessage {
  type: string
  payload: unknown
}

// ── State ──────────────────────────────────────────────────────────────────────

/** Maps each WS client to the set of workspaceIds they are subscribed to */
const clients = new Map<WebSocket, Set<string>>()

/** Above this many bytes queued for a single client, we stop sending it events
 *  rather than growing the process heap on its behalf. It will catch up through
 *  `sync:request` on its next reconnect. */
const MAX_BUFFERED_BYTES = 1024 * 1024

// ── Message handler (decoupled routing) ────────────────────────────────────────

/** Callback for routed WS messages (chat, workspace, devserver commands). */
export type MessageHandler = (type: string, payload: unknown) => void
let messageHandler: MessageHandler | null = null

/** Register the handler that processes routed WS messages (e.g. chat:message, workspace:start). */
export function setMessageHandler(handler: MessageHandler): void {
  messageHandler = handler
}

// ── Connection handling ────────────────────────────────────────────────────────

/** Handle a new WebSocket connection: register, dispatch messages, ping keepalive. */
export function handleConnection(ws: WebSocket): void {
  // Register client with empty subscription set
  clients.set(ws, new Set())

  // Push the latest persisted snapshot per provider so the client renders
  // immediately instead of waiting up to POLL_INTERVAL_MS for the next tick.
  try {
    for (const snap of getAllPersistedSnapshots()) {
      ws.send(
        JSON.stringify({
          type: 'usage:snapshot',
          payload: { providerId: snap.providerId, snapshot: snap },
        }),
      )
    }
  } catch (err) {
    console.error('[ws] usage hydration failed:', err)
  }

  ws.on('message', (data: WebSocket.RawData) => {
    let msg: WsMessage
    try {
      msg = JSON.parse(data.toString()) as WsMessage
    } catch {
      ws.send(JSON.stringify({ type: 'error', payload: { message: 'Invalid JSON' } }))
      return
    }

    const { type, payload } = msg

    switch (type) {
      case 'subscribe': {
        const workspaceId = (payload as { workspaceId?: string })?.workspaceId
        if (!workspaceId) {
          ws.send(JSON.stringify({ type: 'error', payload: { message: 'Missing workspaceId' } }))
          return
        }
        const subs = clients.get(ws)
        subs?.add(workspaceId)
        ws.send(JSON.stringify({ type: 'subscribed', payload: { workspaceId } }))
        break
      }

      case 'unsubscribe': {
        const workspaceId = (payload as { workspaceId?: string })?.workspaceId
        if (!workspaceId) {
          ws.send(JSON.stringify({ type: 'error', payload: { message: 'Missing workspaceId' } }))
          return
        }
        const subs = clients.get(ws)
        subs?.delete(workspaceId)
        ws.send(JSON.stringify({ type: 'unsubscribed', payload: { workspaceId } }))
        break
      }

      case 'sync:request': {
        const p = payload as { lastEventId?: string; workspaceIds?: string[] } | null
        const lastEventId = p?.lastEventId ?? ''
        const workspaceIds = p?.workspaceIds
        handleSyncRequest(ws, lastEventId, workspaceIds)
        break
      }

      // Routed messages — delegated to the orchestrator via messageHandler
      case 'chat:message':
      case 'workspace:start':
      case 'workspace:stop':
      case 'devserver:start':
      case 'devserver:stop': {
        if (messageHandler) {
          messageHandler(type, payload)
        }
        break
      }

      default:
        ws.send(JSON.stringify({ type: 'error', payload: { message: `Unknown message type: ${type}` } }))
    }
  })

  // Heartbeat with a verdict. Pinging without ever waiting for a pong detected
  // nothing: half-open sockets stayed in `clients` for ever, and every emit
  // kept serialising a message for a peer that will never read it.
  let isAlive = true
  ws.on('pong', () => {
    isAlive = true
  })
  const pingInterval = setInterval(() => {
    if (ws.readyState !== 1 /* WebSocket.OPEN */) {
      clearInterval(pingInterval)
      clients.delete(ws)
      return
    }
    if (!isAlive) {
      console.warn('[ws] client missed the heartbeat — terminating the connection')
      clearInterval(pingInterval)
      clients.delete(ws)
      ws.terminate()
      return
    }
    isAlive = false
    ws.ping()
  }, 30_000)

  ws.on('close', () => {
    clearInterval(pingInterval)
    clients.delete(ws)
  })

  ws.on('error', () => {
    clearInterval(pingInterval)
    clients.delete(ws)
  })
}

// ── Broadcasting ───────────────────────────────────────────────────────────────

/**
 * Broadcast an event to all clients subscribed to the given workspace.
 * Persists the event to the ws_events table.
 * Returns the event id.
 */
export function emit(workspaceId: string, type: string, payload: unknown, sessionId?: string): string {
  const id = nanoid()
  const createdAt = new Date().toISOString()
  let replayable = false

  // Best-effort persist — don't let FK violation (deleted workspace) break the broadcast
  try {
    const db = getDb()
    db.prepare(
      'INSERT INTO ws_events (id, workspace_id, type, payload, session_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(id, workspaceId, type, JSON.stringify(payload), sessionId ?? null, createdAt)
    replayable = true
  } catch (err) {
    console.error(`[websocket-service] Failed to persist event (workspace=${workspaceId}, type=${type}):`, err)
  }

  // Build the event object to send
  const event: WsEvent = { id, workspaceId, type, payload, sessionId, createdAt, replayable }
  const message = JSON.stringify(event)

  // Broadcast to subscribed clients. Wrap `.send` in try/catch so a dropped
  // client doesn't throw and abort delivery to the remaining subscribers.
  let emitSendErrorLogged = false
  for (const [ws, subs] of clients) {
    if (subs.has(workspaceId) && ws.readyState === 1 /* WebSocket.OPEN */) {
      if (((ws as { bufferedAmount?: number }).bufferedAmount ?? 0) > MAX_BUFFERED_BYTES) {
        if (!emitSendErrorLogged) {
          console.warn(`[ws] client backlogged, dropping live events (workspace=${workspaceId}, type=${type})`)
          emitSendErrorLogged = true
        }
        continue
      }
      try {
        ws.send(message)
      } catch (err) {
        if (!emitSendErrorLogged) {
          console.warn(`[ws] emit send failed (workspace=${workspaceId}, type=${type}):`, err)
          emitSendErrorLogged = true
        }
      }
    }
  }

  return id
}

/**
 * Broadcast an event to subscribed clients WITHOUT persisting to the database.
 * Used for ephemeral status updates (e.g., dev-server status) that don't need replay.
 */
export function emitEphemeral(workspaceId: string, type: string, payload: unknown): void {
  const id = nanoid()
  const createdAt = new Date().toISOString()
  const event: WsEvent = { id, workspaceId, type, payload, createdAt, replayable: false }
  const message = JSON.stringify(event)

  let sendErrorLogged = false
  for (const [ws, subs] of clients) {
    if (subs.has(workspaceId) && ws.readyState === 1 /* WebSocket.OPEN */) {
      if (((ws as { bufferedAmount?: number }).bufferedAmount ?? 0) > MAX_BUFFERED_BYTES) {
        if (!sendErrorLogged) {
          console.warn(`[ws] client backlogged, dropping ephemeral event (workspace=${workspaceId}, type=${type})`)
          sendErrorLogged = true
        }
        continue
      }
      try {
        ws.send(message)
      } catch (err) {
        if (!sendErrorLogged) {
          console.warn(`[ws] emitEphemeral send failed (workspace=${workspaceId}, type=${type}):`, err)
          sendErrorLogged = true
        }
      }
    }
  }
}

// ── Sync (replay missed events) ────────────────────────────────────────────────

/**
 * Replay all events after lastEventId for workspaces the client is subscribed to.
 * If workspaceIds is provided, uses those instead of the client's current subscriptions.
 */
export function handleSyncRequest(ws: WebSocket, lastEventId: string, workspaceIds?: string[]): void {
  const resolvedIds: string[] =
    workspaceIds && workspaceIds.length > 0
      ? workspaceIds
      : (() => {
          const subs = clients.get(ws)
          return subs ? [...subs] : []
        })()

  if (resolvedIds.length === 0) {
    ws.send(JSON.stringify({ type: 'sync:empty', payload: { message: 'No subscriptions' } }))
    return
  }

  // Initial window size: on a fresh connection (no lastEventId), we only
  // replay the most recent slice of history. The client fetches older
  // events on-demand via GET /api/workspaces/:id/events as the user scrolls
  // up. This keeps first-paint fast on long-lived workspaces with tens of
  // thousands of events without ever deleting anything from the DB.
  const INITIAL_WINDOW = 300
  /** Hard ceiling on one replay message. A tab left open overnight used to ask
   *  for every row since its cursor at once; the client simply asks again with
   *  the new cursor when `truncated` is set. */
  const MAX_REPLAY_EVENTS = 2_000

  interface EventRow {
    rid: number
    id: string
    workspace_id: string
    type: string
    payload: string
    session_id: string | null
    created_at: string
  }

  try {
    const db = getDb()
    let mode: 'snapshot' | 'delta' = 'snapshot'
    let truncated = false
    const rows: EventRow[] = []

    const lastRow = lastEventId
      ? (db.prepare('SELECT rowid FROM ws_events WHERE id = ?').get(lastEventId) as { rowid: number } | undefined)
      : undefined

    // One bounded query PER workspace. With `workspace_id IN (...)` SQLite
    // materialised and sorted the whole history of every requested workspace
    // before applying the limit — so the limit protected the message, not the
    // server.
    if (lastRow) {
      mode = 'delta'
      const statement = db.prepare(
        'SELECT rowid AS rid, * FROM ws_events WHERE workspace_id = ? AND rowid > ? ORDER BY rowid ASC LIMIT ?',
      )
      for (const workspaceId of resolvedIds) {
        const batch = statement.all(workspaceId, lastRow.rowid, MAX_REPLAY_EVENTS) as EventRow[]
        if (batch.length === MAX_REPLAY_EVENTS) truncated = true
        rows.push(...batch)
      }
    } else {
      const statement = db.prepare(
        'SELECT rowid AS rid, * FROM ws_events WHERE workspace_id = ? ORDER BY rowid DESC LIMIT ?',
      )
      for (const workspaceId of resolvedIds) {
        const batch = statement.all(workspaceId, INITIAL_WINDOW) as EventRow[]
        rows.push(...batch)
      }
    }

    rows.sort((a, b) => a.rid - b.rid)
    if (rows.length > MAX_REPLAY_EVENTS) {
      if (mode === 'delta') {
        // Keep the OLDEST slice: the client's cursor then advances and its next
        // sync:request picks up exactly where this message stopped.
        rows.length = MAX_REPLAY_EVENTS
      } else {
        // Snapshot mode has no cursor to advance — the client is looking at a
        // fresh window and wants what just happened. Dropping the head here
        // (rather than the tail) is the difference between "the last few
        // minutes" and "ancient history with no way to reach the present".
        rows.splice(0, rows.length - MAX_REPLAY_EVENTS)
      }
      truncated = true
    }

    const events: WsEvent[] = rows.map((row) => {
      let parsedPayload: unknown
      try {
        parsedPayload = JSON.parse(row.payload)
      } catch {
        console.error('[ws] corrupt ws_events row, falling back to raw:', {
          id: row.id,
          workspace_id: row.workspace_id,
          type: row.type,
        })
        parsedPayload = { raw: row.payload }
      }
      return {
        id: row.id,
        workspaceId: row.workspace_id,
        type: row.type,
        payload: parsedPayload,
        sessionId: row.session_id ?? undefined,
        createdAt: row.created_at,
        replayable: true,
      }
    })

    ws.send(JSON.stringify({ type: 'sync:response', payload: { events, mode, truncated } }))
  } catch (err) {
    // This handler runs inside ws's 'message' callback: an uncaught SQLite
    // error here used to reach the process, not the client.
    console.error('[ws] sync request failed:', err)
    try {
      ws.send(
        JSON.stringify({
          type: 'sync:error',
          payload: { message: err instanceof Error ? err.message : String(err) },
        }),
      )
    } catch {
      /* the client is gone too — nothing left to tell it */
    }
  }
}

// ── Utilities ──────────────────────────────────────────────────────────────────

/**
 * Return number of connected clients.
 */
export function getClientCount(): number {
  return clients.size
}

/**
 * Get the internal clients map — exposed for testing only.
 * @internal
 */
export function _getClients(): Map<WebSocket, Set<string>> {
  return clients
}

// ── Global broadcast ───────────────────────────────────────────────────────────

/**
 * Broadcast an ephemeral event to every connected WebSocket client,
 * regardless of which workspaces they have subscribed to. Used for
 * global events like migration progress.
 */
export function broadcastAll(type: string, payload: unknown): void {
  const message = JSON.stringify({ type, payload })
  let sendErrorLogged = false
  for (const client of clients.keys()) {
    if (client.readyState === 1 /* WebSocket.OPEN */) {
      try {
        client.send(message)
      } catch (err) {
        // client dropped; next iteration will fail its .readyState check.
        // Log the first occurrence so real regressions surface without
        // flooding the console if many clients die at once.
        if (!sendErrorLogged) {
          console.warn('[ws] broadcastAll send failed:', err)
          sendErrorLogged = true
        }
      }
    }
  }
}

/**
 * Return a mutable set view of connected clients — exposed for testing only.
 * Adding/removing clients via this handle registers/unregisters them with the
 * internal `clients` map so helpers like `broadcastAll` see them.
 * @internal
 */
export function _connectionsForTest(): { add: (ws: WebSocket) => void; delete: (ws: WebSocket) => boolean } {
  return {
    add: (ws: WebSocket) => {
      if (!clients.has(ws)) clients.set(ws, new Set())
    },
    delete: (ws: WebSocket) => clients.delete(ws),
  }
}
