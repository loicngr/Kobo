import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initBrowserSessionSchema } from '../server/db/browser-session-schema.js'
import {
  consumeWebSocketTicket,
  createBrowserSession,
  createWebSocketTicket,
  getBrowserSession,
  initializeBrowserSessions,
  isNetworkSocketAuthorized,
  isNetworkTransportAllowed,
  registerNetworkSocket,
  revokeBrowserSession,
  revokeNetworkSessions,
} from '../server/services/network-session-service.js'

const policy = { networkAccessEnabled: true, networkAccessBehindProxy: true, networkAccessToken: 'synthetic' }
let db: Database.Database
beforeEach(() => {
  db = new Database(':memory:')
  initBrowserSessionSchema(db)
  initializeBrowserSessions(db)
})
afterEach(() => {
  revokeNetworkSessions()
  initializeBrowserSessions(undefined)
  db.close()
  vi.useRealTimers()
})

describe('network sessions', () => {
  it('keeps disabled network access local even when a valid ticket was issued locally', () => {
    const disabled = { ...policy, networkAccessEnabled: false, networkAccessBehindProxy: false }
    expect(isNetworkTransportAllowed('127.0.0.1', disabled)).toBe(true)
    expect(isNetworkTransportAllowed('203.0.113.3', disabled)).toBe(false)
    expect(isNetworkTransportAllowed(undefined, disabled)).toBe(false)
    expect(isNetworkTransportAllowed('127.0.0.1', { ...disabled, networkAccessBehindProxy: true })).toBe(false)
    const ws = Object.assign(new EventEmitter(), { terminate: vi.fn() })
    expect(registerNetworkSocket(ws as never, '203.0.113.3', disabled, () => disabled)).toBe(false)
    expect(ws.terminate).toHaveBeenCalledOnce()
  })

  it('fails closed if policy cannot be read during a socket callback', () => {
    const current = vi.fn(() => policy)
    const ws = Object.assign(new EventEmitter(), { terminate: vi.fn() })
    expect(registerNetworkSocket(ws as never, '127.0.0.1', policy, current)).toBe(true)
    current.mockImplementation(() => {
      throw new Error('unreadable settings')
    })
    expect(isNetworkSocketAuthorized(ws as never)).toBe(false)
    expect(ws.terminate).toHaveBeenCalledOnce()
  })

  it('expires browser sessions and binds them to the effective authentication policy', () => {
    vi.useFakeTimers()
    const session = createBrowserSession(policy)
    expect(getBrowserSession(session.token, policy)).toBeDefined()
    expect(getBrowserSession(session.token, { ...policy, networkAccessToken: 'rotated' })).toBeUndefined()
    vi.advanceTimersByTime(12 * 60 * 60 * 1000 + 1)
    expect(getBrowserSession(session.token, policy)).toBeUndefined()
  })

  it('issues short-lived single-use tickets bound to one exact WebSocket path', () => {
    const ticket = createWebSocketTicket('/ws', policy)
    expect(consumeWebSocketTicket(ticket, '/ws/terminal/other', policy)).toBeUndefined()
    expect(consumeWebSocketTicket(ticket, '/ws', policy)).toBeUndefined()
    const valid = createWebSocketTicket('/ws/terminal/workspace-1', policy)
    expect(consumeWebSocketTicket(valid, '/ws/terminal/workspace-1', policy)).toBeDefined()
    expect(consumeWebSocketTicket(valid, '/ws/terminal/workspace-1', policy)).toBeUndefined()
    expect(() => createWebSocketTicket('/ws/terminal/../other', policy)).toThrow()
  })

  it('rejects expired or revoked tickets', () => {
    vi.useFakeTimers()
    const expired = createWebSocketTicket('/ws', policy)
    vi.advanceTimersByTime(61_000)
    expect(consumeWebSocketTicket(expired, '/ws', policy)).toBeUndefined()
    const revoked = createWebSocketTicket('/ws', policy)
    revokeNetworkSessions()
    expect(consumeWebSocketTicket(revoked, '/ws', policy)).toBeUndefined()
  })

  it('terminates active sockets immediately when the authentication policy is revoked', () => {
    const ws = Object.assign(new EventEmitter(), { terminate: vi.fn(), readyState: 1 })
    registerNetworkSocket(ws as never, '127.0.0.1', policy, () => policy)
    expect(isNetworkSocketAuthorized(ws as never)).toBe(true)
    revokeNetworkSessions()
    expect(ws.terminate).toHaveBeenCalledOnce()
    expect(isNetworkSocketAuthorized(ws as never)).toBe(false)
  })

  it('invalidates only the browser session being logged out, including its tickets and sockets', () => {
    const first = createBrowserSession(policy)
    const second = createBrowserSession(policy)
    const ticket = createWebSocketTicket('/ws', policy, first)
    const ws = Object.assign(new EventEmitter(), { terminate: vi.fn(), readyState: 1 })
    registerNetworkSocket(ws as never, '127.0.0.1', policy, () => policy, first)
    revokeBrowserSession(first.token)
    expect(getBrowserSession(first.token, policy)).toBeUndefined()
    expect(getBrowserSession(second.token, policy)).toBeDefined()
    expect(consumeWebSocketTicket(ticket, '/ws', policy)).toBeUndefined()
    expect(ws.terminate).toHaveBeenCalledOnce()
  })
})

describe('remembered browser sessions', () => {
  it('stores only hashes and restores remembered sessions, not ordinary sessions or tickets', () => {
    const regular = createBrowserSession(policy)
    const remembered = createBrowserSession(policy, true)
    const ticket = createWebSocketTicket('/ws', policy, remembered)
    expect(db.prepare('SELECT * FROM browser_sessions').all()).toEqual([
      {
        token_hash: createHash('sha256').update(remembered.token).digest('hex'),
        expires_at: remembered.expiresAt,
        policy_fingerprint: remembered.policy,
      },
    ])
    const persisted = JSON.stringify(db.prepare('SELECT * FROM browser_sessions').all())
    expect(persisted).not.toContain(remembered.token)
    expect(persisted).not.toContain(policy.networkAccessToken)
    initializeBrowserSessions(db)
    expect(getBrowserSession(regular.token, policy)).toBeUndefined()
    expect(getBrowserSession(remembered.token, policy)).toEqual(remembered)
    expect(consumeWebSocketTicket(ticket, '/ws', policy)).toBeUndefined()
  })

  it('expires after 30 days without sliding renewal and prunes expired rows on startup', () => {
    vi.useFakeTimers()
    const remembered = createBrowserSession(policy, true)
    vi.advanceTimersByTime(29 * 24 * 60 * 60 * 1000)
    initializeBrowserSessions(db)
    expect(getBrowserSession(remembered.token, policy)).toEqual(remembered)
    vi.advanceTimersByTime(24 * 60 * 60 * 1000)
    expect(getBrowserSession(remembered.token, policy)).toBeUndefined()
    initializeBrowserSessions(db)
    expect(db.prepare('SELECT COUNT(*) AS count FROM browser_sessions').get()).toEqual({ count: 0 })
  })

  it('persists targeted logout and global revocation across restarts', () => {
    const first = createBrowserSession(policy, true)
    const second = createBrowserSession(policy, true)
    revokeBrowserSession(first.token)
    initializeBrowserSessions(db)
    expect(getBrowserSession(first.token, policy)).toBeUndefined()
    expect(getBrowserSession(second.token, policy)).toBeDefined()
    revokeNetworkSessions()
    initializeBrowserSessions(db)
    expect(getBrowserSession(second.token, policy)).toBeUndefined()
  })

  it.each([
    { ...policy, networkAccessToken: 'rotated' },
    { ...policy, networkAccessEnabled: false },
    { ...policy, networkAccessBehindProxy: false },
  ])('rejects restored sessions under a different policy', (changed) => {
    const remembered = createBrowserSession(policy, true)
    initializeBrowserSessions(db)
    expect(getBrowserSession(remembered.token, changed)).toBeUndefined()
  })

  it('does not overflow long socket timers and reconnects without asking for an operator token', () => {
    vi.useFakeTimers()
    const remembered = createBrowserSession(policy, true)
    const socket = () => Object.assign(new EventEmitter(), { terminate: vi.fn() })
    const first = socket()
    expect(registerNetworkSocket(first as never, '127.0.0.1', policy, () => policy, remembered)).toBe(true)
    vi.advanceTimersByTime(1000)
    expect(first.terminate).not.toHaveBeenCalled()
    vi.advanceTimersByTime(12 * 60 * 60 * 1000)
    expect(first.terminate).toHaveBeenCalledOnce()
    expect(getBrowserSession(remembered.token, policy)).toBeDefined()
    const ticket = createWebSocketTicket('/ws', policy, remembered)
    expect(consumeWebSocketTicket(ticket, '/ws', policy)).toBeDefined()
    const next = socket()
    expect(registerNetworkSocket(next as never, '127.0.0.1', policy, () => policy, remembered)).toBe(true)
    revokeBrowserSession(remembered.token)
    expect(next.terminate).toHaveBeenCalledOnce()
  })

  it('counts restored sessions towards the existing capacity limit', () => {
    for (let i = 0; i < 256; i++) createBrowserSession(policy, true)
    initializeBrowserSessions(db)
    expect(() => createBrowserSession(policy, true)).toThrow('Session capacity reached')
  })
})
