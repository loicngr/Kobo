import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

vi.mock('@hono/node-server/conninfo', () => ({ getConnInfo: () => ({ remote: { address: '192.0.2.10' } }) }))
vi.mock('../server/services/settings-service.js', () => ({ getGlobalSettings: vi.fn() }))

import { networkAuthMiddleware, operatorDispatchAuthMiddleware } from '../server/middleware/network-auth-middleware.js'
import { requestBodyLimitsMiddleware } from '../server/middleware/traffic-limits-middleware.js'
import credentialsRouter from '../server/routes/mcp-credentials.js'
import { listExternalMcpCredentials } from '../server/services/external-mcp-credentials-service.js'
import { createBrowserSession, revokeNetworkSessions } from '../server/services/network-session-service.js'
import { getGlobalSettings } from '../server/services/settings-service.js'

const policy = { networkAccessEnabled: true, networkAccessBehindProxy: true, networkAccessToken: 'operator' }
let directory: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'kobo-operator-dispatch-'))
  vi.stubEnv('KOBO_HOME', directory)
  vi.stubEnv('KOBO_NETWORK_ACCESS_PROXY_HOST', 'kobo.example.com')
  vi.mocked(getGlobalSettings).mockReturnValue({ ...policy } as never)
})
afterEach(() => {
  revokeNetworkSessions()
  vi.unstubAllEnvs()
  vi.clearAllMocks()
  rmSync(directory, { recursive: true, force: true })
})

it.each([
  { contentLength: false, credential: 'cookie' },
  { contentLength: true, credential: 'cookie' },
  { contentLength: false, credential: 'token' },
  { contentLength: true, credential: 'token' },
])(
  'rejects creating a new MCP credential after operator revocation during upload ($credential, length=$contentLength)',
  async ({ contentLength, credential }) => {
    let entered!: () => void
    const ready = new Promise<void>((resolve) => {
      entered = resolve
    })
    const app = new Hono()
      .use('/api/*', networkAuthMiddleware)
      .use('/api/*', async (_c, next) => {
        entered()
        return next()
      })
      .use('/api/*', requestBodyLimitsMiddleware())
      .use('/api/*', operatorDispatchAuthMiddleware)
      .route('/api/mcp-credentials', credentialsRouter)
    const session = createBrowserSession(policy)
    const bytes = new TextEncoder().encode(JSON.stringify({ name: 'new key', allWorkspaces: true }))
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const body = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value
      },
    })
    const pending = app.request('/api/mcp-credentials', {
      method: 'POST',
      headers: {
        ...(credential === 'cookie'
          ? { Cookie: `__Host-kobo-session=${session.token}` }
          : { 'X-Kobo-Token': policy.networkAccessToken }),
        'Content-Type': 'application/json',
        ...(contentLength ? { 'Content-Length': String(bytes.length) } : {}),
      },
      body,
      duplex: 'half',
    } as RequestInit)
    await ready
    revokeNetworkSessions()
    if (credential === 'token')
      vi.mocked(getGlobalSettings).mockReturnValue({ ...policy, networkAccessToken: 'rotated' } as never)
    controller.enqueue(bytes)
    controller.close()
    expect((await pending).status).toBe(401)
    expect(listExternalMcpCredentials()).toEqual([])
  },
)

it('preserves raw multipart consumers after the final authentication gate', async () => {
  const app = new Hono()
    .use('/api/*', networkAuthMiddleware)
    .use('/api/*', requestBodyLimitsMiddleware())
    .use('/api/*', operatorDispatchAuthMiddleware)
    .post('/api/workspaces/own/attachments', async (c) => {
      const form = await c.req.raw.formData()
      const file = form.get('file') as File
      return c.json({ name: file.name, content: await file.text() })
    })
  const form = new FormData()
  form.set('file', new File(['synthetic attachment'], 'test.txt'))
  const response = await app.request('/api/workspaces/own/attachments', {
    method: 'POST',
    headers: { 'X-Kobo-Token': 'operator' },
    body: form,
  })
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ name: 'test.txt', content: 'synthetic attachment' })
})
