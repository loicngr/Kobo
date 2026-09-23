import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import integrationsRouter from '../server/routes/integrations.js'

vi.mock('@hono/node-server/conninfo', () => ({ getConnInfo: () => ({ remote: { address: '127.0.0.1' } }) }))
vi.mock('../server/services/settings-service.js', () => ({
  getGlobalSettings: () => ({
    networkAccessEnabled: true,
    networkAccessBehindProxy: true,
    networkAccessToken: 'test-token',
  }),
}))

import { networkAuthMiddleware } from '../server/middleware/network-auth-middleware.js'

let directory: string
const app = new Hono().route('/api/integrations', integrationsRouter)
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kobo-integrations-route-'))
  vi.stubEnv('KOBO_HOME', directory)
})
afterEach(() => {
  vi.unstubAllEnvs()
  fs.rmSync(directory, { recursive: true, force: true })
})
it('returns status only on save and read, never credentials or command arguments', async () => {
  const response = await app.request('/api/integrations/notion', {
    method: 'PUT',
    body: JSON.stringify({ command: 'node', args: ['PRIVATE_PATH'], env: { TOKEN: 'SECRET_CANARY' } }),
    headers: { 'Content-Type': 'application/json' },
  })
  expect(await response.json()).toEqual({ configured: true })
  expect(await (await app.request('/api/integrations/notion')).json()).toEqual({ configured: true })
})
it('rejects unknown integrations and malformed JSON without leaking raw input', async () => {
  expect((await app.request('/api/integrations/other')).status).toBe(404)
  const response = await app.request('/api/integrations/notion', { method: 'PUT', body: 'SECRET_CANARY' })
  expect(response.status).toBe(400)
  expect(await response.text()).not.toContain('SECRET_CANARY')
})
it('caps submitted credential configuration size', async () => {
  const response = await app.request('/api/integrations/notion', { method: 'PUT', body: 'x'.repeat(65 * 1024) })
  expect(response.status).toBe(413)
})

it('protects credential reads and writes behind the network token gate', async () => {
  const gated = new Hono().use('/api/*', networkAuthMiddleware).route('/api/integrations', integrationsRouter)
  for (const method of ['GET', 'PUT'])
    expect((await gated.request('/api/integrations/notion', { method })).status).toBe(401)
  expect((await gated.request('/api/integrations/notion', { headers: { 'X-Kobo-Token': 'test-token' } })).status).toBe(
    200,
  )
})
