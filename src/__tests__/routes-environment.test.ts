import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@hono/node-server/conninfo', () => ({ getConnInfo: () => ({ remote: { address: '127.0.0.1' } }) }))
vi.mock('../server/services/settings-service.js', () => ({
  getGlobalSettings: () => ({
    networkAccessEnabled: true,
    networkAccessBehindProxy: true,
    networkAccessToken: 'test-token',
  }),
}))
vi.mock('../server/services/environment-check-service.js', () => ({ getEnvironmentReport: vi.fn() }))

import { networkAuthMiddleware } from '../server/middleware/network-auth-middleware.js'
import environmentRouter from '../server/routes/environment.js'
import { getEnvironmentReport } from '../server/services/environment-check-service.js'

const app = new Hono()
app.use('/api/*', networkAuthMiddleware)
app.route('/api/environment', environmentRouter)
const headers = { 'X-Kobo-Token': 'test-token' }

describe('environment route', () => {
  beforeEach(() => vi.clearAllMocks())
  it('requires the network token behind a reverse proxy, even on loopback', async () => {
    const response = await app.request('/api/environment')
    expect(response.status).toBe(401)
    expect(getEnvironmentReport).not.toHaveBeenCalled()
  })
  it('validates engine and path before running checks', async () => {
    for (const query of ['engine=other', 'engine=codex&projectPath=%00', `projectPath=${'x'.repeat(4097)}`]) {
      expect((await app.request(`/api/environment?${query}`, { headers })).status).toBe(400)
    }
    expect(getEnvironmentReport).not.toHaveBeenCalled()
  })
  it('returns a sanitized error when a probe fails', async () => {
    vi.mocked(getEnvironmentReport).mockRejectedValueOnce(new Error('SECRET_CANARY'))
    const response = await app.request('/api/environment?engine=codex', { headers })
    expect(response.status).toBe(503)
    expect(await response.text()).not.toContain('SECRET_CANARY')
  })
  it('returns the report for an explicitly selected project', async () => {
    const report = { checkedAt: new Date().toISOString(), engine: 'codex' as const, checks: [] }
    vi.mocked(getEnvironmentReport).mockResolvedValueOnce(report)
    const response = await app.request('/api/environment?engine=codex&projectPath=%2Fdemo%20project', { headers })
    expect(await response.json()).toEqual(report)
    expect(getEnvironmentReport).toHaveBeenCalledWith({ engine: 'codex', projectPath: '/demo project' })
  })
})
