import { nanoid } from 'nanoid'
import type WebSocket from 'ws'
import { getDb } from '../db/index.js'

// ── Types ──────────────────────────────────────────────────────────────────────

/** A persisted or ephemeral event broadcast to subscribed WebSocket clients. */
export interface WsEvent {
  id: string
  workspaceId: string
  type: string
  payload: unknown
  sessionId?: string
  createdAt: string
}

/** Incoming message from a WebSocket client. */
export interface WsMessage {
  type: string
  payload: unknown
}

// ── State ──────────────────────────────────────────────────────────────────────

/** Maps each WS client to the set of workspaceIds they are subscribed to */
const clients = new Map<WebSocket, Set<string>>()

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

  // Ping every 30s to keep the connection alive and detect stale clients
  const pingInterval = setInterval(() => {
    if (ws.readyState === ws.OPEN) {
      ws.ping()
    } else {
      clearInterval(pingInterval)
    }
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

  // Best-effort persist — don't let FK violation (deleted workspace) break the broadcast
  try {
    const db = getDb()
    db.prepare(
      'INSERT INTO ws_events (id, workspace_id, type, payload, session_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(id, workspaceId, type, JSON.stringify(payload), sessionId ?? null, createdAt)
  } catch (err) {
    console.error(`[websocket-service] Failed to persist event (workspace=${workspaceId}, type=${type}):`, err)
  }

  // Build the event object to send
  const event: WsEvent = { id, workspaceId, type, payload, sessionId, createdAt }
  const message = JSON.stringify(event)

  // Broadcast to subscribed clients. Wrap `.send` in try/catch so a dropped
  // client doesn't throw and abort delivery to the remaining subscribers.
  let emitSendErrorLogged = false
  for (const [ws, subs] of clients) {
    if (subs.has(workspaceId) && ws.readyState === 1 /* WebSocket.OPEN */) {
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
  const event: WsEvent = { id, workspaceId, type, payload, createdAt }
  const message = JSON.stringify(event)

  let sendErrorLogged = false
  for (const [ws, subs] of clients) {
    if (subs.has(workspaceId) && ws.readyState === 1 /* WebSocket.OPEN */) {
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

  const db = getDb()

  // Build a query with placeholders for all subscribed workspaces
  const placeholders = resolvedIds.map(() => '?').join(', ')

  let rows: Array<{
    id: string
    workspace_id: string
    type: string
    payload: string
    session_id: string | null
    created_at: string
  }>

  // Initial window size: on a fresh connection (no lastEventId), we only
  // replay the most recent slice of history. The client fetches older
  // events on-demand via GET /api/workspaces/:id/events as the user scrolls
  // up. This keeps first-paint fast on long-lived workspaces with tens of
  // thousands of events without ever deleting anything from the DB.
  const INITIAL_WINDOW = 300

  if (lastEventId) {
    // Resume path: replay every event strictly after the cursor (delta
    // since last seen). If the cursor is stale/unknown, fall back to the
    // recent window rather than streaming the entire history.
    const lastRow = db.prepare('SELECT rowid FROM ws_events WHERE id = ?').get(lastEventId) as
      | { rowid: number }
      | undefined

    if (lastRow) {
      rows = db
        .prepare(`SELECT * FROM ws_events WHERE workspace_id IN (${placeholders}) AND rowid > ? ORDER BY rowid ASC`)
        .all(...resolvedIds, lastRow.rowid) as typeof rows
    } else {
      rows = db
        .prepare(`SELECT * FROM ws_events WHERE workspace_id IN (${placeholders}) ORDER BY rowid DESC LIMIT ?`)
        .all(...resolvedIds, INITIAL_WINDOW) as typeof rows
      rows.reverse()
    }
  } else {
    // Fresh connect: most recent INITIAL_WINDOW events, in chronological order.
    rows = db
      .prepare(`SELECT * FROM ws_events WHERE workspace_id IN (${placeholders}) ORDER BY rowid DESC LIMIT ?`)
      .all(...resolvedIds, INITIAL_WINDOW) as typeof rows
    rows.reverse()
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
    }
  })

  ws.send(JSON.stringify({ type: 'sync:response', payload: { events } }))
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
