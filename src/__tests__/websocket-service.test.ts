import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initSchema } from '../server/db/schema.js'

// ── DB setup (same pattern as workspace-service tests) ──

let tmpDir: string
let dbPath: string

async function resetDb() {
  const { closeDb } = await import('../server/db/index.js')
  closeDb()
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'at-ws-svc-test-'))
  dbPath = path.join(tmpDir, 'test.db')

  const db = new Database(dbPath)
  db.pragma('journal_mode=WAL')
  db.pragma('foreign_keys=ON')
  initSchema(db)
  db.close()
}

// ── Mock WebSocket ──

class MockWebSocket extends EventEmitter {
  readyState = 1 // OPEN
  sentMessages: string[] = []

  send(data: string): void {
    this.sentMessages.push(data)
  }

  close(): void {
    this.readyState = 3 // CLOSED
    this.emit('close')
  }

  simulateMessage(msg: object): void {
    this.emit('message', Buffer.from(JSON.stringify(msg)))
  }
}

beforeEach(async () => {
  await resetDb()
  const { getDb } = await import('../server/db/index.js')
  getDb(dbPath)
})

afterEach(async () => {
  // Clean up clients map
  const { _getClients } = await import('../server/services/websocket-service.js')
  _getClients().clear()

  const { closeDb } = await import('../server/db/index.js')
  closeDb()
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

describe('handleConnection()', () => {
  it('enregistre le client dans la map', async () => {
    const { handleConnection, getClientCount } = await import('../server/services/websocket-service.js')
    const ws = new MockWebSocket()

    handleConnection(ws as unknown as import('ws').WebSocket)

    expect(getClientCount()).toBe(1)
  })

  it('retire le client de la map à la déconnexion', async () => {
    const { handleConnection, getClientCount } = await import('../server/services/websocket-service.js')
    const ws = new MockWebSocket()

    handleConnection(ws as unknown as import('ws').WebSocket)
    expect(getClientCount()).toBe(1)

    ws.close()
    expect(getClientCount()).toBe(0)
  })

  it("retire le client de la map en cas d'erreur", async () => {
    const { handleConnection, getClientCount } = await import('../server/services/websocket-service.js')
    const ws = new MockWebSocket()

    handleConnection(ws as unknown as import('ws').WebSocket)
    ws.emit('error', new Error('test'))

    expect(getClientCount()).toBe(0)
  })
})

describe('subscribe / unsubscribe', () => {
  it("permet au client de s'abonner a un workspace", async () => {
    const { handleConnection, _getClients } = await import('../server/services/websocket-service.js')
    const ws = new MockWebSocket()
    handleConnection(ws as unknown as import('ws').WebSocket)

    ws.simulateMessage({ type: 'subscribe', payload: { workspaceId: 'ws-1' } })

    const subs = _getClients().get(ws as unknown as import('ws').WebSocket)
    expect(subs?.has('ws-1')).toBe(true)

    // Verify confirmation message
    const lastMsg = JSON.parse(ws.sentMessages[ws.sentMessages.length - 1])
    expect(lastMsg.type).toBe('subscribed')
    expect(lastMsg.payload.workspaceId).toBe('ws-1')
  })

  it("permet au client de se desabonner d'un workspace", async () => {
    const { handleConnection, _getClients } = await import('../server/services/websocket-service.js')
    const ws = new MockWebSocket()
    handleConnection(ws as unknown as import('ws').WebSocket)

    ws.simulateMessage({ type: 'subscribe', payload: { workspaceId: 'ws-1' } })
    ws.simulateMessage({ type: 'unsubscribe', payload: { workspaceId: 'ws-1' } })

    const subs = _getClients().get(ws as unknown as import('ws').WebSocket)
    expect(subs?.has('ws-1')).toBe(false)

    const lastMsg = JSON.parse(ws.sentMessages[ws.sentMessages.length - 1])
    expect(lastMsg.type).toBe('unsubscribed')
  })

  it('envoie une erreur si workspaceId manquant pour subscribe', async () => {
    const { handleConnection } = await import('../server/services/websocket-service.js')
    const ws = new MockWebSocket()
    handleConnection(ws as unknown as import('ws').WebSocket)

    ws.simulateMessage({ type: 'subscribe', payload: {} })

    const lastMsg = JSON.parse(ws.sentMessages[ws.sentMessages.length - 1])
    expect(lastMsg.type).toBe('error')
    expect(lastMsg.payload.message).toContain('workspaceId')
  })

  it('envoie une erreur pour du JSON invalide', async () => {
    const { handleConnection } = await import('../server/services/websocket-service.js')
    const ws = new MockWebSocket()
    handleConnection(ws as unknown as import('ws').WebSocket)

    ws.emit('message', Buffer.from('not-json'))

    const lastMsg = JSON.parse(ws.sentMessages[ws.sentMessages.length - 1])
    expect(lastMsg.type).toBe('error')
    expect(lastMsg.payload.message).toContain('Invalid JSON')
  })

  it('envoie une erreur pour un type inconnu', async () => {
    const { handleConnection } = await import('../server/services/websocket-service.js')
    const ws = new MockWebSocket()
    handleConnection(ws as unknown as import('ws').WebSocket)

    ws.simulateMessage({ type: 'unknown:type', payload: {} })

    const lastMsg = JSON.parse(ws.sentMessages[ws.sentMessages.length - 1])
    expect(lastMsg.type).toBe('error')
    expect(lastMsg.payload.message).toContain('Unknown message type')
  })
})

describe('emit()', () => {
  it("persiste l'evenement en base et retourne un id", async () => {
    const { emit } = await import('../server/services/websocket-service.js')
    const { getDb } = await import('../server/db/index.js')

    // Insert a workspace first (foreign key constraint)
    const db = getDb()
    const now = new Date().toISOString()
    db.prepare(
      'INSERT INTO workspaces (id, name, project_path, source_branch, working_branch, status, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run('ws-emit-1', 'Test', '/tmp', 'main', 'feat', 'created', 'claude-opus-4-6', now, now)

    const eventId = emit('ws-emit-1', 'test:event', { hello: 'world' })

    expect(eventId).toBeTruthy()

    const row = db.prepare('SELECT * FROM ws_events WHERE id = ?').get(eventId) as {
      id: string
      workspace_id: string
      type: string
      payload: string
    }
    expect(row).toBeTruthy()
    expect(row.workspace_id).toBe('ws-emit-1')
    expect(row.type).toBe('test:event')
    expect(JSON.parse(row.payload)).toEqual({ hello: 'world' })
  })

  it("broadcast l'evenement aux clients abonnes", async () => {
    const { handleConnection, emit } = await import('../server/services/websocket-service.js')
    const { getDb } = await import('../server/db/index.js')

    // Create workspace
    const db = getDb()
    const now = new Date().toISOString()
    db.prepare(
      'INSERT INTO workspaces (id, name, project_path, source_branch, working_branch, status, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run('ws-bc-1', 'Test', '/tmp', 'main', 'feat', 'created', 'claude-opus-4-6', now, now)

    const ws1 = new MockWebSocket()
    const ws2 = new MockWebSocket()
    const ws3 = new MockWebSocket() // not subscribed

    handleConnection(ws1 as unknown as import('ws').WebSocket)
    handleConnection(ws2 as unknown as import('ws').WebSocket)
    handleConnection(ws3 as unknown as import('ws').WebSocket)

    ws1.simulateMessage({ type: 'subscribe', payload: { workspaceId: 'ws-bc-1' } })
    ws2.simulateMessage({ type: 'subscribe', payload: { workspaceId: 'ws-bc-1' } })

    // Clear sent messages so we only see the broadcast
    ws1.sentMessages = []
    ws2.sentMessages = []
    ws3.sentMessages = []

    emit('ws-bc-1', 'agent:output', { data: 'test' })

    // ws1 and ws2 should receive the event
    expect(ws1.sentMessages.length).toBe(1)
    expect(ws2.sentMessages.length).toBe(1)
    // ws3 should not receive anything
    expect(ws3.sentMessages.length).toBe(0)

    const received = JSON.parse(ws1.sentMessages[0])
    expect(received.type).toBe('agent:output')
    expect(received.workspaceId).toBe('ws-bc-1')
    expect(received.payload).toEqual({ data: 'test' })
  })

  it("n'envoie pas aux clients dont le readyState n'est pas OPEN", async () => {
    const { handleConnection, emit } = await import('../server/services/websocket-service.js')
    const { getDb } = await import('../server/db/index.js')

    const db = getDb()
    const now = new Date().toISOString()
    db.prepare(
      'INSERT INTO workspaces (id, name, project_path, source_branch, working_branch, status, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run('ws-closed-1', 'Test', '/tmp', 'main', 'feat', 'created', 'claude-opus-4-6', now, now)

    const ws = new MockWebSocket()
    handleConnection(ws as unknown as import('ws').WebSocket)
    ws.simulateMessage({ type: 'subscribe', payload: { workspaceId: 'ws-closed-1' } })

    // Set readyState to CLOSING
    ws.readyState = 2
    ws.sentMessages = []

    emit('ws-closed-1', 'test', { x: 1 })

    expect(ws.sentMessages.length).toBe(0)
  })
})

describe('setMessageHandler()', () => {
  it('route les messages chat:message, workspace:start, workspace:stop vers le handler', async () => {
    const { handleConnection, setMessageHandler } = await import('../server/services/websocket-service.js')

    const received: Array<{ type: string; payload: unknown }> = []
    setMessageHandler((type, payload) => {
      received.push({ type, payload })
    })

    const ws = new MockWebSocket()
    handleConnection(ws as unknown as import('ws').WebSocket)

    ws.simulateMessage({ type: 'chat:message', payload: { content: 'hello' } })
    ws.simulateMessage({ type: 'workspace:start', payload: { workspaceId: 'ws-1' } })
    ws.simulateMessage({ type: 'workspace:stop', payload: { workspaceId: 'ws-1' } })

    expect(received.length).toBe(3)
    expect(received[0].type).toBe('chat:message')
    expect(received[1].type).toBe('workspace:start')
    expect(received[2].type).toBe('workspace:stop')

    // Reset handler
    setMessageHandler(() => {})
  })
})

describe('handleSyncRequest()', () => {
  it('renvoie les evenements apres le lastEventId', async () => {
    const { handleConnection, emit, handleSyncRequest } = await import('../server/services/websocket-service.js')
    const { getDb } = await import('../server/db/index.js')

    const db = getDb()
    const now = new Date().toISOString()
    db.prepare(
      'INSERT INTO workspaces (id, name, project_path, source_branch, working_branch, status, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run('ws-sync-1', 'Test', '/tmp', 'main', 'feat', 'created', 'claude-opus-4-6', now, now)

    const ws = new MockWebSocket()
    handleConnection(ws as unknown as import('ws').WebSocket)
    ws.simulateMessage({ type: 'subscribe', payload: { workspaceId: 'ws-sync-1' } })

    // Emit 3 events
    const id1 = emit('ws-sync-1', 'event:1', { n: 1 })
    emit('ws-sync-1', 'event:2', { n: 2 })
    emit('ws-sync-1', 'event:3', { n: 3 })

    ws.sentMessages = []

    // Request sync after the first event
    handleSyncRequest(ws as unknown as import('ws').WebSocket, id1)

    expect(ws.sentMessages.length).toBe(1)
    const syncResponse = JSON.parse(ws.sentMessages[0])
    expect(syncResponse.type).toBe('sync:response')
    expect(syncResponse.payload.events.length).toBe(2)
    expect(syncResponse.payload.events[0].type).toBe('event:2')
    expect(syncResponse.payload.events[1].type).toBe('event:3')
  })

  it('renvoie tous les evenements si lastEventId est vide', async () => {
    const { handleConnection, emit, handleSyncRequest } = await import('../server/services/websocket-service.js')
    const { getDb } = await import('../server/db/index.js')

    const db = getDb()
    const now = new Date().toISOString()
    db.prepare(
      'INSERT INTO workspaces (id, name, project_path, source_branch, working_branch, status, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run('ws-sync-2', 'Test', '/tmp', 'main', 'feat', 'created', 'claude-opus-4-6', now, now)

    const ws = new MockWebSocket()
    handleConnection(ws as unknown as import('ws').WebSocket)
    ws.simulateMessage({ type: 'subscribe', payload: { workspaceId: 'ws-sync-2' } })

    emit('ws-sync-2', 'ev:a', {})
    emit('ws-sync-2', 'ev:b', {})

    ws.sentMessages = []

    handleSyncRequest(ws as unknown as import('ws').WebSocket, '')

    const syncResponse = JSON.parse(ws.sentMessages[0])
    expect(syncResponse.type).toBe('sync:response')
    expect(syncResponse.payload.events.length).toBe(2)
  })

  it("envoie sync:empty si le client n'a aucun abonnement", async () => {
    const { handleConnection, handleSyncRequest } = await import('../server/services/websocket-service.js')

    const ws = new MockWebSocket()
    handleConnection(ws as unknown as import('ws').WebSocket)

    ws.sentMessages = []
    handleSyncRequest(ws as unknown as import('ws').WebSocket, '')

    const msg = JSON.parse(ws.sentMessages[0])
    expect(msg.type).toBe('sync:empty')
  })
})

describe('emit() — resilience FK violation (C3)', () => {
  it('broadcast quand meme si la persistance DB echoue (workspace supprime)', async () => {
    const { handleConnection, emit } = await import('../server/services/websocket-service.js')

    const ws = new MockWebSocket()
    handleConnection(ws as unknown as import('ws').WebSocket)
    ws.simulateMessage({ type: 'subscribe', payload: { workspaceId: 'ws-deleted' } })
    ws.sentMessages = []

    // Pas d'INSERT de workspace => FK violation lors du INSERT ws_events
    // Ne doit pas lever d'exception et doit tout de meme broadcaster
    expect(() => emit('ws-deleted', 'agent:status', { status: 'stopped' })).not.toThrow()

    // Le broadcast doit avoir eu lieu malgre l'echec de la persistance
    expect(ws.sentMessages.length).toBe(1)
    const msg = JSON.parse(ws.sentMessages[0])
    expect(msg.type).toBe('agent:status')
  })
})

describe('handleSyncRequest() — workspaceIds optionnel (I2)', () => {
  it('sync avec workspaceIds fourni sans abonnement prealable', async () => {
    const { handleConnection, emit, handleSyncRequest } = await import('../server/services/websocket-service.js')
    const { getDb } = await import('../server/db/index.js')

    const db = getDb()
    const now = new Date().toISOString()
    db.prepare(
      'INSERT INTO workspaces (id, name, project_path, source_branch, working_branch, status, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run('ws-i2-1', 'Test', '/tmp', 'main', 'feat', 'created', 'claude-opus-4-6', now, now)

    // Emit some events
    emit('ws-i2-1', 'ev:a', { n: 1 })
    emit('ws-i2-1', 'ev:b', { n: 2 })

    // Client connects but does NOT subscribe
    const ws = new MockWebSocket()
    handleConnection(ws as unknown as import('ws').WebSocket)
    ws.sentMessages = []

    // Sync with explicit workspaceIds
    handleSyncRequest(ws as unknown as import('ws').WebSocket, '', ['ws-i2-1'])

    expect(ws.sentMessages.length).toBe(1)
    const syncResponse = JSON.parse(ws.sentMessages[0])
    expect(syncResponse.type).toBe('sync:response')
    expect(syncResponse.payload.events.length).toBe(2)
  })

  it('sync:request via message avec workspaceIds fourni (I2)', async () => {
    const { handleConnection, emit } = await import('../server/services/websocket-service.js')
    const { getDb } = await import('../server/db/index.js')

    const db = getDb()
    const now = new Date().toISOString()
    db.prepare(
      'INSERT INTO workspaces (id, name, project_path, source_branch, working_branch, status, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run('ws-i2-2', 'Test', '/tmp', 'main', 'feat', 'created', 'claude-opus-4-6', now, now)

    const id1 = emit('ws-i2-2', 'ev:1', {})
    emit('ws-i2-2', 'ev:2', {})

    const ws = new MockWebSocket()
    handleConnection(ws as unknown as import('ws').WebSocket)
    // Pas d'abonnement
    ws.sentMessages = []

    ws.simulateMessage({
      type: 'sync:request',
      payload: { lastEventId: id1, workspaceIds: ['ws-i2-2'] },
    })

    expect(ws.sentMessages.length).toBe(1)
    const syncResponse = JSON.parse(ws.sentMessages[0])
    expect(syncResponse.type).toBe('sync:response')
    expect(syncResponse.payload.events.length).toBe(1)
    expect(syncResponse.payload.events[0].type).toBe('ev:2')
  })

  it('envoie sync:empty si ni workspaceIds ni abonnements', async () => {
    const { handleConnection, handleSyncRequest } = await import('../server/services/websocket-service.js')

    const ws = new MockWebSocket()
    handleConnection(ws as unknown as import('ws').WebSocket)
    ws.sentMessages = []

    handleSyncRequest(ws as unknown as import('ws').WebSocket, '', [])

    const msg = JSON.parse(ws.sentMessages[0])
    expect(msg.type).toBe('sync:empty')
  })
})

describe('cleanupOldEvents()', () => {
  it('supprime les anciens evenements en gardant les N derniers', async () => {
    const { emit, cleanupOldEvents } = await import('../server/services/websocket-service.js')
    const { getDb } = await import('../server/db/index.js')

    const db = getDb()
    const now = new Date().toISOString()
    db.prepare(
      'INSERT INTO workspaces (id, name, project_path, source_branch, working_branch, status, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run('ws-cleanup-1', 'Test', '/tmp', 'main', 'feat', 'created', 'claude-opus-4-6', now, now)

    // Emit 5 events
    for (let i = 0; i < 5; i++) {
      emit('ws-cleanup-1', `event:${i}`, { i })
    }

    // Keep only last 2
    cleanupOldEvents('ws-cleanup-1', 2)

    const rows = db.prepare('SELECT * FROM ws_events WHERE workspace_id = ?').all('ws-cleanup-1')
    expect(rows.length).toBe(2)
  })
})

describe('getClientCount()', () => {
  it("retourne 0 quand aucun client n'est connecte", async () => {
    const { getClientCount } = await import('../server/services/websocket-service.js')
    expect(getClientCount()).toBe(0)
  })

  it('retourne le nombre de clients connectes', async () => {
    const { handleConnection, getClientCount } = await import('../server/services/websocket-service.js')

    const ws1 = new MockWebSocket()
    const ws2 = new MockWebSocket()

    handleConnection(ws1 as unknown as import('ws').WebSocket)
    handleConnection(ws2 as unknown as import('ws').WebSocket)

    expect(getClientCount()).toBe(2)
  })
})

// ── Gap 5: emitEphemeral ──────────────────────────────────────────────────────

describe('emitEphemeral()', () => {
  it('broadcast aux clients abonnes', async () => {
    const { handleConnection, emitEphemeral } = await import('../server/services/websocket-service.js')

    const ws = new MockWebSocket()
    handleConnection(ws as unknown as import('ws').WebSocket)
    ws.simulateMessage({ type: 'subscribe', payload: { workspaceId: 'ws-eph-1' } })
    ws.sentMessages = []

    emitEphemeral('ws-eph-1', 'devserver:status', { running: true })

    expect(ws.sentMessages.length).toBe(1)
    const received = JSON.parse(ws.sentMessages[0])
    expect(received.type).toBe('devserver:status')
    expect(received.workspaceId).toBe('ws-eph-1')
    expect(received.payload).toEqual({ running: true })
  })

  it('ne persiste PAS en base de donnees (pas de INSERT)', async () => {
    const { handleConnection, emitEphemeral } = await import('../server/services/websocket-service.js')
    const { getDb } = await import('../server/db/index.js')

    // Create a workspace for FK compliance
    const db = getDb()
    const now = new Date().toISOString()
    db.prepare(
      'INSERT INTO workspaces (id, name, project_path, source_branch, working_branch, status, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run('ws-eph-nodb', 'Test', '/tmp', 'main', 'feat', 'created', 'claude-opus-4-6', now, now)

    const ws = new MockWebSocket()
    handleConnection(ws as unknown as import('ws').WebSocket)
    ws.simulateMessage({ type: 'subscribe', payload: { workspaceId: 'ws-eph-nodb' } })
    ws.sentMessages = []

    emitEphemeral('ws-eph-nodb', 'devserver:status', { running: false })

    // Verify no events were persisted to the DB
    const rows = db
      .prepare('SELECT * FROM ws_events WHERE workspace_id = ? AND type = ?')
      .all('ws-eph-nodb', 'devserver:status')
    expect(rows.length).toBe(0)
  })

  it('ne broadcast PAS aux clients non abonnes', async () => {
    const { handleConnection, emitEphemeral } = await import('../server/services/websocket-service.js')

    const wsSub = new MockWebSocket()
    const wsNotSub = new MockWebSocket()

    handleConnection(wsSub as unknown as import('ws').WebSocket)
    handleConnection(wsNotSub as unknown as import('ws').WebSocket)

    wsSub.simulateMessage({ type: 'subscribe', payload: { workspaceId: 'ws-eph-scope' } })
    // wsNotSub does NOT subscribe

    wsSub.sentMessages = []
    wsNotSub.sentMessages = []

    emitEphemeral('ws-eph-scope', 'devserver:status', { up: true })

    expect(wsSub.sentMessages.length).toBe(1)
    expect(wsNotSub.sentMessages.length).toBe(0)
  })
})
