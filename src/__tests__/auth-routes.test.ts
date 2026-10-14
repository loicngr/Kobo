import { getConnInfo } from '@hono/node-server/conninfo'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@hono/node-server/conninfo', () => ({ getConnInfo: vi.fn() }))
vi.mock('../server/services/settings-service.js', () => ({ getGlobalSettings: vi.fn() }))

import { networkAuthMiddleware } from '../server/middleware/network-auth-middleware.js'
import router from '../server/routes/auth.js'
import {
  consumeWebSocketTicket,
  createBrowserSession,
  getBrowserSession,
  revokeNetworkSessions,
} from '../server/services/network-session-service.js'
import { getGlobalSettings } from '../server/services/settings-service.js'

const policy = { networkAccessEnabled: true, networkAccessBehindProxy: true, networkAccessToken: 'synthetic' }
const app = new Hono().use('/api/*', networkAuthMiddleware).route('/api/auth', router)
beforeEach(() => {
  vi.mocked(getConnInfo).mockReturnValue({ remote: { address: '127.0.0.1' } } as never)
  vi.mocked(getGlobalSettings).mockReturnValue({ ...policy } as never)
  vi.stubEnv('KOBO_NETWORK_ACCESS_PROXY_HOST', 'kobo.example.com')
})
afterEach(() => {
  revokeNetworkSessions()
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

describe('browser authentication routes', () => {
  it('exchanges an operator token for a host-only secure HttpOnly cookie', async () => {
    const response = await app.request('/api/auth/session', {
      method: 'POST',
      headers: { 'X-Kobo-Token': 'synthetic' },
    })
    expect(response.status).toBe(200)
    const cookie = response.headers.get('Set-Cookie')!
    expect(cookie).toContain('__Host-kobo-session=')
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('Secure')
    expect(cookie).toContain('SameSite=Strict')
    expect(cookie).not.toContain('Domain=')
    expect(await response.text()).not.toContain('synthetic')
  })

  it('supports explicitly configured HTTP local proxy staging without trusting forwarded headers', async () => {
    vi.stubEnv('KOBO_NETWORK_ACCESS_PROXY_HOST', 'http://kobo.localhost')
    const response = await app.request('/api/auth/session', {
      method: 'POST',
      headers: { 'X-Kobo-Token': 'synthetic', 'X-Forwarded-Proto': 'https' },
    })
    const cookie = response.headers.get('Set-Cookie')!
    expect(cookie).toContain('kobo-session=')
    expect(cookie).not.toContain('Secure')
    expect(cookie).not.toContain('__Host-')
  })

  it('denies session minting with an invalid token even on normally trusted loopback', async () => {
    vi.mocked(getGlobalSettings).mockReturnValue({ ...policy, networkAccessBehindProxy: false } as never)
    expect((await app.request('/api/auth/session', { method: 'POST' })).status).toBe(401)
  })

  it('keeps trusted local WebSockets working with a stale cookie after network disable or restart', async () => {
    const local = { ...policy, networkAccessEnabled: false, networkAccessBehindProxy: false }
    vi.mocked(getGlobalSettings).mockReturnValue(local as never)
    const response = await app.request('/api/auth/ws-ticket', {
      method: 'POST',
      headers: { Cookie: 'kobo-session=stale-session', 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/ws' }),
    })
    expect(response.status).toBe(200)
    expect(consumeWebSocketTicket((await response.json()).ticket, '/ws', local)).toBeDefined()
  })

  it('lets a valid operator header override an expired cookie while rejecting the cookie alone', async () => {
    vi.mocked(getConnInfo).mockReturnValue({ remote: { address: '192.0.2.1' } } as never)
    const init = {
      method: 'POST',
      headers: { Cookie: '__Host-kobo-session=stale-session', 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/ws' }),
    }
    expect((await app.request('/api/auth/ws-ticket', init)).status).toBe(401)
    const response = await app.request('/api/auth/ws-ticket', {
      ...init,
      headers: { ...init.headers, 'X-Kobo-Token': 'synthetic' },
    })
    expect(response.status).toBe(200)
  })

  it('rechecks policy after reading the ticket request body', async () => {
    vi.mocked(getGlobalSettings)
      .mockReturnValueOnce({ ...policy } as never)
      .mockReturnValue({ ...policy, networkAccessToken: 'rotated' } as never)
    const response = await app.request('/api/auth/ws-ticket', {
      method: 'POST',
      headers: { 'X-Kobo-Token': 'synthetic', 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/ws' }),
    })
    expect(response.status).toBe(401)
  })

  it('rechecks network disabling after reading the ticket request body', async () => {
    vi.mocked(getGlobalSettings)
      .mockReturnValueOnce({ ...policy } as never)
      .mockReturnValue({ ...policy, networkAccessEnabled: false } as never)
    const response = await app.request('/api/auth/ws-ticket', {
      method: 'POST',
      headers: { 'X-Kobo-Token': 'synthetic', 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/ws' }),
    })
    expect(response.status).toBe(403)
  })

  it('issues a cookie-authenticated path-bound ticket and revokes it on logout', async () => {
    const session = createBrowserSession(policy)
    const headers = { Cookie: `__Host-kobo-session=${session.token}`, 'Content-Type': 'application/json' }
    const response = await app.request('/api/auth/ws-ticket', {
      method: 'POST',
      headers,
      body: JSON.stringify({ path: '/ws' }),
    })
    expect(response.status).toBe(200)
    const { ticket } = await response.json()
    expect((await app.request('/api/auth/session', { method: 'DELETE', headers })).status).toBe(200)
    expect(consumeWebSocketTicket(ticket, '/ws', policy)).toBeUndefined()
    expect(getBrowserSession(session.token, policy)).toBeUndefined()
  })
})
