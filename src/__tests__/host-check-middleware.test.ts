import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../server/services/network-access-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../server/services/network-access-service.js')>()),
  getLanHostnames: vi.fn(),
}))
vi.mock('../server/services/settings-service.js', () => ({
  getGlobalSettings: vi.fn(),
}))
// The middleware only needs the bound port; mocking it keeps the whole agent
// stack out of this test.
vi.mock('../server/services/agent/orchestrator.js', () => ({
  getBackendPort: vi.fn(() => 3000),
}))

import { hostCheckMiddleware } from '../server/middleware/host-check-middleware.js'
import { getLanHostnames } from '../server/services/network-access-service.js'
import { getGlobalSettings } from '../server/services/settings-service.js'

const app = new Hono()
app.use('*', hostCheckMiddleware)
app.get('/api/ping', (c) => c.json({ ok: true }))
app.get('/api/health', (c) => c.json({ status: 'ok' }))
app.post('/api/write', (c) => c.json({ written: true }))

function setup(options: { enabled?: boolean; behindProxy?: boolean; lanHostnames?: string[] } = {}) {
  vi.mocked(getLanHostnames).mockReturnValue(options.lanHostnames ?? [])
  vi.mocked(getGlobalSettings).mockReturnValue({
    networkAccessEnabled: options.enabled ?? false,
    networkAccessBehindProxy: options.behindProxy ?? false,
  } as never)
}

beforeEach(() => vi.clearAllMocks())

describe('hostCheckMiddleware', () => {
  it('serves a request addressed to the machine own name', async () => {
    setup()
    const res = await app.request('http://localhost:3000/api/ping')
    expect(res.status).toBe(200)
  })

  it('settles a loopback request without reading the settings file', async () => {
    // This middleware runs on every path, static assets included. Reading the
    // settings means a synchronous readFileSync plus the whole migration
    // pipeline, so the common case has to be decided without it.
    setup()
    const res = await app.request('http://127.0.0.1:3000/api/ping')

    expect(res.status).toBe(200)
    expect(getGlobalSettings).not.toHaveBeenCalled()
    expect(getLanHostnames).not.toHaveBeenCalled()
  })

  it('refuses a request addressed to a foreign domain (DNS rebinding)', async () => {
    setup()
    const res = await app.request('http://evil.com/api/ping')
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'forbidden host' })
  })

  it('serves /api/health whatever the host, so a container healthcheck keeps working', async () => {
    setup()
    const res = await app.request('http://kobo-container:3000/api/health')
    expect(res.status).toBe(200)
  })

  it('serves a LAN address only once network access is enabled', async () => {
    setup({ enabled: false, lanHostnames: ['192.168.1.20'] })
    expect((await app.request('http://192.168.1.20:3000/api/ping')).status).toBe(403)

    setup({ enabled: true, lanHostnames: ['192.168.1.20'] })
    expect((await app.request('http://192.168.1.20:3000/api/ping')).status).toBe(200)
  })

  it('serves any host behind a reverse proxy, where the token gate owns the boundary', async () => {
    setup({ behindProxy: true })
    const res = await app.request('http://kobo.example.com/api/ping')
    expect(res.status).toBe(200)
  })
})

describe('hostCheckMiddleware — cross-site writes', () => {
  // A page on evil.com reaching http://localhost:3000 sends a legitimate
  // `Host: localhost:3000` — the browser puts it there — so the host check
  // alone cannot see it. Reading the reply is already blocked (no CORS
  // headers), but the write would still land: Hono parses a JSON body whatever
  // the Content-Type, so a `text/plain` POST is a CORS simple request and
  // needs no preflight. Origin is what tells the two apart.
  it('refuses a write driven by a page on another site', async () => {
    setup()
    const res = await app.request('http://localhost:3000/api/write', {
      method: 'POST',
      headers: { origin: 'http://evil.com' },
    })

    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'forbidden origin' })
  })

  it('serves a write from the app own page', async () => {
    setup()
    const res = await app.request('http://localhost:3000/api/write', {
      method: 'POST',
      headers: { origin: 'http://localhost:3000' },
    })
    expect(res.status).toBe(200)
  })

  it('serves a write carrying no Origin, as the CLI and the MCP callbacks send', async () => {
    setup()
    const res = await app.request('http://localhost:3000/api/write', { method: 'POST' })
    expect(res.status).toBe(200)
  })

  it('refuses a page served from another loopback port', async () => {
    // Kōbō starts a dev server per workspace on a loopback port, serving code
    // an agent just wrote. Such a page must not count as the real interface.
    setup()
    const res = await app.request('http://localhost:3000/api/write', {
      method: 'POST',
      headers: { origin: 'http://localhost:5173' },
    })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'forbidden origin' })
  })

  it('refuses a cross-site read too, so a rebinding page gains nothing', async () => {
    setup()
    const res = await app.request('http://localhost:3000/api/ping', {
      headers: { origin: 'http://evil.com' },
    })
    expect(res.status).toBe(403)
  })
})
