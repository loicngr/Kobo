import { once } from 'node:events'
import { createServer, request } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'
import {
  createBrowserSession,
  revokeBrowserSession,
  revokeNetworkSessions,
} from '../server/services/network-session-service.js'
import {
  openPreview,
  previewOrigin,
  previewRequestHeaders,
  previewTarget,
  startPreviewGateway,
  stopPreviewGateway,
} from '../server/services/preview-service.js'

const state = vi.hoisted(() => ({
  lookupFails: false,
  workspace: {
    id: 'workspace-A',
    projectPath: '/project',
    workingBranch: 'feature/test',
    archivedAt: null as string | null,
    worktreePurgedAt: null,
  },
  status: { status: 'running', url: '', agentUrl: '' },
  policy: { networkAccessEnabled: true, networkAccessBehindProxy: true, networkAccessToken: 'operator-secret' },
}))
vi.mock('../server/services/workspace-service.js', () => ({
  getWorkspace: (id: string) => {
    if (state.lookupFails) throw new Error('Database unavailable')
    return id === state.workspace.id ? state.workspace : undefined
  },
}))
vi.mock('../server/services/settings-service.js', () => ({ getGlobalSettings: () => state.policy }))
vi.mock('../server/services/dev-server-service.js', () => ({ getStatus: vi.fn(async () => state.status) }))
let upstream: ReturnType<typeof createServer>
let gateway: ReturnType<typeof startPreviewGateway>
let ws: WebSocketServer
let seenHeaders: Record<string, unknown>
let port: number
beforeEach(async () => {
  state.lookupFails = false
  state.workspace.archivedAt = null
  state.status.status = 'running'
  state.policy.networkAccessToken = 'operator-secret'
  vi.stubEnv('KOBO_PREVIEW_DOMAIN', 'preview.kobo.example.com')
  vi.stubEnv('KOBO_PREVIEW_PORT', '0')
  vi.stubEnv('KOBO_NETWORK_ACCESS_PROXY_HOST', 'kobo.example.com')
  upstream = createServer((req, res) => {
    seenHeaders = req.headers
    res.setHeader('X-Frame-Options', 'DENY')
    res.setHeader('Content-Security-Policy', "default-src 'self'; frame-ancestors 'none'")
    res.setHeader('Set-Cookie', ['app=ok; Domain=localhost; Path=/', '__Host-kobo-preview=evil; Path=/'])
    if (req.url === '/redirect') res.writeHead(302, { Location: `${state.status.url}/login` })
    if (req.url === '/browser-redirect') res.writeHead(302, { Location: `${state.status.url}/login?next=app#form` })
    if (req.url === '/external-redirect') res.writeHead(302, { Location: 'https://auth.example.com/login' })
    if (req.url === '/other-port') res.writeHead(302, { Location: 'http://localhost:1/other' })
    if (req.url === '/relative-redirect') res.writeHead(302, { Location: '/login' })
    if (req.url === '/bad-redirect') res.writeHead(302, { Location: `${state.status.url}%invalid` })
    res.end(req.url)
  }).listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  state.status.url = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`
  state.status.agentUrl = state.status.url
  ws = new WebSocketServer({ server: upstream })
  ws.on('connection', (socket) => socket.on('message', (data) => socket.send(data)))
  gateway = startPreviewGateway()
  await once(gateway!, 'listening')
  port = (gateway!.address() as AddressInfo).port
})
afterEach(async () => {
  stopPreviewGateway()
  revokeNetworkSessions()
  for (const client of ws.clients) client.terminate()
  ws.close()
  upstream.closeAllConnections()
  await new Promise<void>((resolve) => upstream.close(() => resolve()))
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})
function get(path: string, host: string, cookie = '', origin?: string) {
  return new Promise<{ status: number; headers: Record<string, any>; body: string }>((resolve, reject) => {
    const req = request(
      { hostname: '127.0.0.1', port, path, headers: { host, cookie, ...(origin ? { origin } : {}) } },
      (res) => {
        let body = ''
        res.on('data', (chunk) => {
          body += chunk
        })
        res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }))
      },
    )
    req.on('error', reject)
    req.end()
  })
}
async function authorize() {
  const session = createBrowserSession(state.policy)
  const result = await openPreview(state.workspace.id, session)
  const url = new URL(result.url)
  const response = await get(url.pathname + url.search, url.host)
  return { session, url, cookie: response.headers['set-cookie'][0].split(';')[0] as string, response }
}
describe('private preview gateway', () => {
  it('keeps local access direct, including a Docker agent URL', async () => {
    vi.stubEnv('KOBO_PREVIEW_DOMAIN', '')
    state.status.agentUrl = 'http://host.docker.internal:8720'
    expect(await openPreview(state.workspace.id)).toEqual({
      url: state.status.url,
      publicUrl: state.status.url,
      remote: false,
    })
  })
  it('requires a session and a running, available workspace', async () => {
    await expect(openPreview(state.workspace.id)).rejects.toThrow('Sign in')
    state.status.status = 'stopped'
    await expect(openPreview(state.workspace.id)).rejects.toThrow('not running')
    state.workspace.archivedAt = 'now'
    await expect(openPreview(state.workspace.id)).rejects.toThrow('unavailable')
  })
  it('uses a single-use host-bound ticket and never forwards Kōbō credentials', async () => {
    const { url, cookie, response } = await authorize()
    expect(response.status).toBe(303)
    expect(response.headers['set-cookie'][0]).toContain('Secure; HttpOnly; SameSite=Strict')
    expect((await get(url.pathname + url.search, url.host)).status).toBe(403)
    expect((await get('/clients', url.host)).status).toBe(403)
    expect((await get('/clients', 'another.example.com', cookie)).status).toBe(403)
    expect((await get('/clients', url.host, cookie, 'https://evil.example')).status).toBe(403)
    const proxied = await get('/clients?foo=bar', url.host, `${cookie}; app=ok; kobo-session=secret`)
    expect(proxied.status).toBe(200)
    expect(proxied.body).toBe('/clients?foo=bar')
    expect(seenHeaders.cookie).toBe('app=ok')
    expect(proxied.headers['x-frame-options']).toBeUndefined()
    expect(proxied.headers['content-security-policy']).toBe(
      "default-src 'self'; frame-ancestors https://kobo.example.com",
    )
    expect(proxied.headers['set-cookie']).toEqual(['app=ok; Path=/'])
    expect((await get('/redirect', url.host, cookie)).headers.location).toBe(`${url.origin}/login`)
    expect((await get('/bad-redirect', url.host, cookie)).headers.location).toBeUndefined()
  })
  it('revokes HTTP access on logout, policy rotation and archive', async () => {
    const first = await authorize()
    revokeBrowserSession(first.session.token)
    expect((await get('/', first.url.host, first.cookie)).status).toBe(403)
    const second = await authorize()
    state.policy.networkAccessToken = 'rotated'
    expect((await get('/', second.url.host, second.cookie)).status).toBe(403)
    const third = await authorize()
    state.workspace.archivedAt = 'now'
    expect((await get('/', third.url.host, third.cookie)).status).toBe(403)
  })
  it('relays authenticated WebSockets for HMR and closes them when the gateway stops', async () => {
    const { url, cookie } = await authorize()
    const socket = new WebSocket(`ws://127.0.0.1:${port}/hmr`, {
      headers: { Host: url.host, Cookie: cookie, Origin: url.origin },
    })
    await once(socket, 'open')
    socket.send('update')
    const [message] = await once(socket, 'message')
    expect(message.toString()).toBe('update')
    const closed = once(socket, 'close')
    stopPreviewGateway()
    await closed
  })
  it('expires unused tickets and fails closed if workspace lookup fails', async () => {
    const session = createBrowserSession(state.policy)
    const link = new URL((await openPreview(state.workspace.id, session)).url)
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 61000)
    expect((await get(link.pathname + link.search, link.host)).status).toBe(403)
    clock.mockRestore()
    const auth = await authorize()
    state.lookupFails = true
    expect((await get('/', auth.url.host, auth.cookie)).status).toBe(403)
  })
  it('disconnects an active WebSocket after logout', async () => {
    const { session, url, cookie } = await authorize()
    const socket = new WebSocket(`ws://127.0.0.1:${port}/hmr`, {
      headers: { Host: url.host, Cookie: cookie, Origin: url.origin },
    })
    await once(socket, 'open')
    const closed = once(socket, 'close')
    revokeBrowserSession(session.token)
    await closed
  }, 10000)
  it('preserves the advertised path, query and fragment when opening a remote preview', async () => {
    const entry = '/app/?tab=clients#form'
    state.status.url += entry
    state.status.agentUrl += entry
    const { url, response } = await authorize()
    expect(response.headers.location).toBe(url.origin + entry)
    const session = createBrowserSession(state.policy)
    expect((await openPreview(state.workspace.id, session)).publicUrl).toBe(url.origin + entry)
  })
  it('keeps a double-slash entry path on the authorized preview host', async () => {
    state.status.url += '//other.example/path'
    state.status.agentUrl = state.status.url
    const { url, response } = await authorize()
    expect(new URL(response.headers.location).origin).toBe(url.origin)
    expect(new URL(response.headers.location).pathname).toBe('//other.example/path')
  })
  it('rewrites only declared dev-server origins, including the browser localhost alias', async () => {
    state.status.url = state.status.url.replace('127.0.0.1', 'localhost')
    const { url, cookie } = await authorize()
    expect((await get('/browser-redirect', url.host, cookie)).headers.location).toBe(
      `${url.origin}/login?next=app#form`,
    )
    expect((await get('/relative-redirect', url.host, cookie)).headers.location).toBe(`${url.origin}/login`)
    expect((await get('/external-redirect', url.host, cookie)).headers.location).toBe('https://auth.example.com/login')
    expect((await get('/other-port', url.host, cookie)).headers.location).toBe('http://localhost:1/other')
  })
  it('validates DNS labels and refuses arbitrary proxy destinations', () => {
    expect(previewOrigin('Case_ID', 'preview.example.com')).toMatch(/^https:\/\/[a-f0-9]{32}\.preview\.example\.com$/)
    expect(() => previewOrigin('id', 'example.com/path')).toThrow()
    expect(() => previewTarget('http://169.254.169.254/latest')).toThrow()
    expect(() => previewTarget('http://user:password@localhost')).toThrow()
    vi.stubEnv('KOBO_DEV_SERVER_DOCKER_HOST', 'host.docker.internal')
    expect(previewTarget('http://host.docker.internal:8720').port).toBe('8720')
    const headers = previewRequestHeaders(
      {
        host: 'untrusted',
        'x-kobo-token': 'secret',
        'x-forwarded-host': 'evil',
        connection: 'x-extra',
        'x-extra': 'secret',
      },
      new URL(state.status.url),
      'https://preview.example.com',
    )
    expect(headers['x-extra']).toBeUndefined()
    expect(headers['x-kobo-token']).toBeUndefined()
    expect(headers['x-forwarded-host']).toBe('preview.example.com')
  })
})
