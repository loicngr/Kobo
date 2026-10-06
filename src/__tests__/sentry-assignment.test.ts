import { beforeEach, describe, expect, it, vi } from 'vitest'
import { assignSentryIssueToSelf } from '../server/services/sentry-service.js'
import { callMcpTool, listMcpToolNames } from '../server/utils/mcp-client.js'
import { stopMcpProcess } from '../server/utils/mcp-process.js'

vi.mock('../server/services/settings-service.js', () => ({
  getGlobalSettings: () => ({ sentryMcpKey: 'sentry' }),
}))
vi.mock('../server/services/integration-config-service.js', () => ({
  getIntegrationConfig: () => ({ command: 'sentry-mcp', args: [], env: {} }),
}))
vi.mock('../server/utils/mcp-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../server/utils/mcp-client.js')>()),
  spawnMcpProcess: vi.fn(() => ({ on: vi.fn() })),
  initializeMcp: vi.fn(),
  listMcpToolNames: vi.fn(),
  callMcpTool: vi.fn(),
}))
vi.mock('../server/utils/mcp-process.js', () => ({ stopMcpProcess: vi.fn() }))

const url = 'https://example.sentry.io/issues/123/'
describe('Sentry self-assignment', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(listMcpToolNames).mockResolvedValue(['execute_sentry_tool', 'update_issue'])
    vi.mocked(callMcpTool).mockImplementation(async (_process, name) => {
      if (name === 'whoami') throw new Error('Unknown tool')
      if (name === 'execute_sentry_tool') return { content: [{ type: 'text', text: '{"user":{"id":"42"}}' }] }
      return { content: [{ type: 'text', text: 'Updated' }] }
    })
  })

  it('resolves the current user through the catalog before assigning exactly once', async () => {
    await expect(assignSentryIssueToSelf(url)).resolves.toMatchObject({ assigned: true })
    expect(callMcpTool).toHaveBeenNthCalledWith(1, expect.anything(), 'execute_sentry_tool', {
      name: 'whoami',
      arguments: {},
    })
    expect(callMcpTool).toHaveBeenNthCalledWith(2, expect.anything(), 'update_issue', {
      issueUrl: url,
      assignedTo: 'user:42',
    })
    expect(callMcpTool).toHaveBeenCalledTimes(2)
    expect(stopMcpProcess).toHaveBeenCalledOnce()
  })

  it('preserves direct whoami support for legacy servers', async () => {
    vi.mocked(listMcpToolNames).mockResolvedValue(['whoami', 'update_issue', 'execute_sentry_tool'])
    vi.mocked(callMcpTool).mockResolvedValueOnce({ content: [{ type: 'text', text: 'User ID: 42' }] })
    await expect(assignSentryIssueToSelf(url)).resolves.toMatchObject({ assigned: true })
    expect(callMcpTool).toHaveBeenNthCalledWith(1, expect.anything(), 'whoami', {})
  })

  it('skips assignment when neither identity tool is available', async () => {
    vi.mocked(listMcpToolNames).mockResolvedValue(['update_issue'])
    await expect(assignSentryIssueToSelf(url)).resolves.toMatchObject({ assigned: false })
    expect(callMcpTool).not.toHaveBeenCalled()
    expect(stopMcpProcess).toHaveBeenCalledOnce()
  })

  it.each([
    { content: [{ type: 'text', text: '{"user":null}' }] },
    { isError: true, content: [{ type: 'text', text: '{"user":{"id":"42"}}' }] },
  ])('does not write when identity lookup fails or returns no user', async (response) => {
    vi.mocked(callMcpTool).mockResolvedValueOnce(response)
    await expect(assignSentryIssueToSelf(url)).resolves.toMatchObject({ assigned: false })
    expect(callMcpTool).toHaveBeenCalledTimes(1)
    expect(stopMcpProcess).toHaveBeenCalledOnce()
  })

  it('does not retry a failed or ambiguous write', async () => {
    vi.mocked(callMcpTool).mockImplementation(async (_process, name) => {
      if (name === 'update_issue') throw new Error('MCP transport failed')
      return { content: [{ type: 'text', text: '{"user":{"id":"42"}}' }] }
    })
    await expect(assignSentryIssueToSelf(url)).resolves.toMatchObject({ assigned: false })
    expect(callMcpTool).toHaveBeenCalledTimes(2)
    expect(stopMcpProcess).toHaveBeenCalledOnce()
  })
})
