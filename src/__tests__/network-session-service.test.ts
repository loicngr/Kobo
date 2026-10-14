import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  consumeWebSocketTicket,
  createBrowserSession,
  createWebSocketTicket,
  getBrowserSession,
  isNetworkSocketAuthorized,
  isNetworkTransportAllowed,
  registerNetworkSocket,
  revokeBrowserSession,
  revokeNetworkSessions,
} from '../server/services/network-session-service.js'

const policy = { networkAccessEnabled: true, networkAccessBehindProxy: true, networkAccessToken: 'synthetic' }
afterEach(() => {
  revokeNetworkSessions()
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
