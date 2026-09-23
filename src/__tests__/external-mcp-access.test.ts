import { getConnInfo } from '@hono/node-server/conninfo'
import { Hono } from 'hono'
import { expect, it, vi } from 'vitest'
import { hostCheckMiddleware } from '../server/middleware/host-check-middleware.js'
import { networkAuthMiddleware } from '../server/middleware/network-auth-middleware.js'
import mcp from '../server/routes/mcp.js'
import { getGlobalSettings } from '../server/services/settings-service.js'
import { executeWorkspaceDialogueTool } from '../server/services/workspace-dialogue-service.js'

vi.mock('@hono/node-server/conninfo', () => ({ getConnInfo: vi.fn() }))
vi.mock('../server/services/settings-service.js', () => ({ getGlobalSettings: vi.fn() }))
vi.mock('../server/services/workspace-dialogue-service.js', () => ({
  executeWorkspaceDialogueTool: vi.fn(async () => []),
}))

const app = new Hono().use('*', hostCheckMiddleware).use('/api/*', networkAuthMiddleware).route('/api/mcp', mcp)

it.each([
  { address: '127.0.0.1', enabled: false, status: 200 },
  { address: '192.0.2.10', enabled: false, token: 'secret', status: 403 },
  { address: '192.0.2.10', enabled: true, status: 401 },
  { address: '192.0.2.10', enabled: true, token: 'wrong', status: 401 },
  { address: '192.0.2.10', enabled: true, token: 'secret', status: 200 },
  { address: '127.0.0.1', enabled: true, behindProxy: true, status: 401 },
  { address: '127.0.0.1', enabled: true, behindProxy: true, token: 'secret', status: 200 },
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
      ...(scenario.token ? { Authorization: `Bearer ${scenario.token}` } : {}),
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
