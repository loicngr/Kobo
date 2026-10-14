import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getConnInfo } from '@hono/node-server/conninfo'
import { Hono } from 'hono'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { hostCheckMiddleware } from '../server/middleware/host-check-middleware.js'
import { networkAuthMiddleware } from '../server/middleware/network-auth-middleware.js'
import mcp from '../server/routes/mcp.js'
import { createExternalMcpCredential } from '../server/services/external-mcp-credentials-service.js'
import { executeMemoryMcpTool } from '../server/services/memory-mcp-service.js'
import { getGlobalSettings } from '../server/services/settings-service.js'
import { executeWorkspaceDialogueTool } from '../server/services/workspace-dialogue-service.js'

vi.mock('@hono/node-server/conninfo', () => ({ getConnInfo: vi.fn() }))
vi.mock('../server/services/settings-service.js', () => ({ getGlobalSettings: vi.fn() }))
vi.mock('../server/services/workspace-dialogue-service.js', () => ({
  executeWorkspaceDialogueTool: vi.fn(async () => []),
}))
vi.mock('../server/services/memory-mcp-service.js', () => ({ executeMemoryMcpTool: vi.fn(() => ({ items: [] })) }))

let token: string
let previousHome: string | undefined
let home: string
beforeAll(() => {
  previousHome = process.env.KOBO_HOME
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'kobo-mcp-access-'))
  process.env.KOBO_HOME = home
  token = createExternalMcpCredential({ name: 'test', allWorkspaces: true }).token
})
afterAll(() => {
  if (previousHome === undefined) delete process.env.KOBO_HOME
  else process.env.KOBO_HOME = previousHome
  fs.rmSync(home, { recursive: true, force: true })
})

const app = new Hono().use('*', hostCheckMiddleware).use('/api/*', networkAuthMiddleware).route('/api/mcp', mcp)

it.each([
  { address: '127.0.0.1', enabled: false, status: 401 },
  { address: '127.0.0.1', enabled: false, token: 'dedicated', status: 200 },
  { address: '192.0.2.10', enabled: true, token: 'secret', status: 401 },
  { address: '192.0.2.10', enabled: false, token: 'secret', status: 403 },
  { address: '192.0.2.10', enabled: true, status: 401 },
  { address: '192.0.2.10', enabled: true, token: 'wrong', status: 401 },
  { address: '192.0.2.10', enabled: true, token: 'dedicated', status: 200 },
  { address: '127.0.0.1', enabled: true, behindProxy: true, status: 401 },
  { address: '127.0.0.1', enabled: true, behindProxy: true, token: 'dedicated', status: 200 },
  { address: '127.0.0.1', enabled: true, origin: 'https://evil.example', status: 403 },
  { address: '127.0.0.1', enabled: false, host: 'evil.example', status: 403 },
])('protects MCP tool dispatch with the existing access policy: %j', async (scenario) => {
  vi.clearAllMocks()
  vi.mocked(getConnInfo).mockReturnValue({ remote: { address: scenario.address } })
  vi.mocked(getGlobalSettings).mockReturnValue({
    networkAccessEnabled: scenario.enabled,
    networkAccessToken: 'secret',
    networkAccessBehindProxy: scenario.behindProxy ?? false,
  } as never)
  const response = await app.request(`http://${scenario.host ?? 'localhost'}/api/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(scenario.token ? { Authorization: `Bearer ${scenario.token === 'dedicated' ? token : scenario.token}` } : {}),
      ...(scenario.origin ? { Origin: scenario.origin } : {}),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'list_workspaces', arguments: {} },
    }),
  })
  expect(response.status).toBe(scenario.status)
  expect(executeWorkspaceDialogueTool).toHaveBeenCalledTimes(scenario.status === 200 ? 1 : 0)
})

it.each([
  { address: '192.0.2.10', enabled: true, status: 401 },
  { address: '192.0.2.10', enabled: true, token: 'wrong', status: 401 },
  { address: '127.0.0.1', enabled: true, behindProxy: true, status: 401 },
  { address: '127.0.0.1', enabled: false, host: 'evil.example', status: 403 },
  { address: '127.0.0.1', enabled: false, origin: 'https://evil.example', status: 403 },
])('blocks memory dispatch before tool execution under the existing access policy: %j', async (scenario) => {
  vi.clearAllMocks()
  vi.mocked(getConnInfo).mockReturnValue({ remote: { address: scenario.address } })
  vi.mocked(getGlobalSettings).mockReturnValue({
    networkAccessEnabled: scenario.enabled,
    networkAccessToken: 'secret',
    networkAccessBehindProxy: scenario.behindProxy ?? false,
  } as never)
  const response = await app.request(`http://${scenario.host ?? 'localhost'}/api/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(scenario.token ? { Authorization: `Bearer ${scenario.token === 'dedicated' ? token : scenario.token}` } : {}),
      ...(scenario.origin ? { Origin: scenario.origin } : {}),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'list_memory_scopes', arguments: {} },
    }),
  })
  expect(response.status).toBe(scenario.status)
  expect(executeMemoryMcpTool).not.toHaveBeenCalled()
})
