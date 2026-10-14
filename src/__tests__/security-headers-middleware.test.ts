import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { securityHeadersMiddleware } from '../server/middleware/security-headers-middleware.js'

describe('security headers', () => {
  const app = new Hono()
  app.use('*', securityHeadersMiddleware())
  app.get('/', (c) => c.html('<html>workshop</html>'))
  app.get('/api/settings/network', (c) => c.json({ error: 'unauthorized' }, 401))
  app.get('/assets/app.js', (c) => c.body('/* app */'))

  it.each(['/', '/api/settings/network', '/missing'])(
    'protects %s, including error responses, without breaking same-origin panes',
    async (pathname) => {
      const response = await app.request(pathname)
      expect(response.headers.get('Content-Security-Policy')).toBe("frame-ancestors 'self'")
      expect(response.headers.get('X-Frame-Options')).toBe('SAMEORIGIN')
      expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
      expect(response.headers.get('Referrer-Policy')).toBe('no-referrer')
    },
  )

  it('prevents caching API responses without disabling static asset caches', async () => {
    expect((await app.request('/api/settings/network')).headers.get('Cache-Control')).toBe('no-store')
    expect((await app.request('/assets/app.js')).headers.get('Cache-Control')).toBeNull()
  })

  it('never trusts an arbitrary forwarded scheme to enable HSTS', async () => {
    const response = await app.request('http://localhost/', { headers: { 'X-Forwarded-Proto': 'https' } })
    expect(response.headers.get('Strict-Transport-Security')).toBeNull()
  })
})
