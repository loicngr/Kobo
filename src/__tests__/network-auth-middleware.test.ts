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

function setup(address: string | undefined, enabled: boolean, token: string) {
  vi.mocked(getConnInfo).mockReturnValue({ remote: { address } } as never)
  vi.mocked(getGlobalSettings).mockReturnValue({
    networkAccessEnabled: enabled,
    networkAccessToken: token,
  } as never)
}

beforeEach(() => vi.clearAllMocks())

describe('networkAuthMiddleware', () => {
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
})
