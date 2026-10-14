import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@hono/node-server/conninfo', () => ({
  getConnInfo: vi.fn(),
}))
vi.mock('../server/services/settings-service.js', () => ({
  getGlobalSettings: vi.fn(),
}))

import { getConnInfo } from '@hono/node-server/conninfo'
import { networkAuthMiddleware } from '../server/middleware/network-auth-middleware.js'
import { getGlobalSettings } from '../server/services/settings-service.js'

const app = new Hono()
app.use('/api/*', networkAuthMiddleware)
app.get('/api/ping', (c) => c.json({ ok: true }))
app.post('/api/mcp', (c) => c.json({ ok: true }))
app.get('/api/health', (c) => c.json({ status: 'ok' }))

function setup(address: string | undefined, enabled: boolean, token: string, behindProxy = false) {
  vi.mocked(getConnInfo).mockReturnValue({ remote: { address } } as never)
  vi.mocked(getGlobalSettings).mockReturnValue({
    networkAccessEnabled: enabled,
    networkAccessToken: token,
    networkAccessBehindProxy: behindProxy,
  } as never)
}

beforeEach(() => vi.clearAllMocks())

describe('networkAuthMiddleware', () => {
  it('delegates MCP authentication to its dedicated route instead of accepting operator Bearer tokens', async () => {
    setup('192.168.1.5', true, 'secret')
    // This sentinel has no route auth; real MCP route tests cover dedicated keys.
    expect((await app.request('/api/mcp', { method: 'POST' })).status).toBe(200)
    expect((await app.request('/api/ping', { headers: { Authorization: 'Bearer secret' } })).status).toBe(401)
  })
  it('keeps external MCP disabled for remote clients when network access is disabled', async () => {
    setup('192.168.1.5', false, 'secret')
    expect((await app.request('/api/mcp', { method: 'POST' })).status).toBe(403)
  })
  it.each(['Authorization', 'X-Kobo-Token'])(
    'never elevates a provided MCP key through the loopback exemption (%s)',
    async (header) => {
      setup('127.0.0.1', true, 'secret')
      const value = header === 'Authorization' ? 'Bearer kobo_mcp_synthetic' : 'kobo_mcp_synthetic'
      expect((await app.request('/api/ping', { headers: { [header]: value } })).status).toBe(401)
    },
  )
  it.each(['/api/internal-mcp', '/api/internal-mcp/', '/api/internal-mcp/nested'])(
    'does not let a remote operator token reach %s',
    async (pathname) => {
      setup('192.168.1.5', true, 'secret')
      expect((await app.request(pathname, { method: 'POST', headers: { 'X-Kobo-Token': 'secret' } })).status).toBe(403)
    },
  )
  it('allows loopback without a token', async () => {
    setup('127.0.0.1', true, 'secret')
    const res = await app.request('/api/ping')
    expect(res.status).toBe(200)
  })
  it('403 when disabled and non-loopback', async () => {
    setup('192.168.1.5', false, 'secret')
    const res = await app.request('/api/ping')
    expect(res.status).toBe(403)
  })
  it('401 when enabled, non-loopback, no token', async () => {
    setup('192.168.1.5', true, 'secret')
    const res = await app.request('/api/ping')
    expect(res.status).toBe(401)
  })
  it('401 with a wrong token', async () => {
    setup('192.168.1.5', true, 'secret')
    const res = await app.request('/api/ping', { headers: { 'X-Kobo-Token': 'nope' } })
    expect(res.status).toBe(401)
  })
  it('passes with the correct token', async () => {
    setup('192.168.1.5', true, 'secret')
    const res = await app.request('/api/ping', { headers: { 'X-Kobo-Token': 'secret' } })
    expect(res.status).toBe(200)
  })
  it('401 when behindProxy is true, loopback address, no token', async () => {
    setup('127.0.0.1', true, 'secret', true)
    const res = await app.request('/api/ping')
    expect(res.status).toBe(401)
  })
  it('200 when behindProxy is true, loopback address, correct token', async () => {
    setup('127.0.0.1', true, 'secret', true)
    const res = await app.request('/api/ping', { headers: { 'X-Kobo-Token': 'secret' } })
    expect(res.status).toBe(200)
  })
  it('/api/health is always exempt, even behind a proxy with no token', async () => {
    setup('203.0.113.9', true, 'secret', true)
    const res = await app.request('/api/health')
    expect(res.status).toBe(200)
  })
})
