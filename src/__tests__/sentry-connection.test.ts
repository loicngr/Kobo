import { beforeEach, describe, expect, it, vi } from 'vitest'
import { testSentryConnection } from '../server/services/sentry-service.js'
import { callMcpTool, initializeMcp, spawnMcpProcess } from '../server/utils/mcp-client.js'
import { stopMcpProcess } from '../server/utils/mcp-process.js'

vi.mock('../server/services/settings-service.js', () => ({
  getGlobalSettings: () => ({ sentryMcpKey: 'sentry' }),
}))
vi.mock('../server/services/integration-config-service.js', () => ({
  getIntegrationConfig: () => ({ command: 'sentry-mcp', args: [], env: {} }),
}))
vi.mock('../server/utils/mcp-client.js', () => ({
  spawnMcpProcess: vi.fn(() => ({})),
  initializeMcp: vi.fn(),
  callMcpTool: vi.fn(),
}))
vi.mock('../server/utils/mcp-process.js', () => ({ stopMcpProcess: vi.fn() }))

describe('testSentryConnection', () => {
  beforeEach(() => vi.resetAllMocks())

  it('tests authenticated read access without requiring the unavailable whoami tool', async () => {
    vi.mocked(callMcpTool).mockImplementation(async (_process, name) => {
      if (name !== 'find_organizations') throw new Error('Unknown tool')
      return { content: [{ type: 'text', text: '[]' }] }
    })

    await expect(testSentryConnection()).resolves.toMatchObject({ ok: true })
    const process = vi.mocked(spawnMcpProcess).mock.results[0].value
    expect(initializeMcp).toHaveBeenCalledWith(process)
    expect(callMcpTool).toHaveBeenCalledExactlyOnceWith(process, 'find_organizations', {})
    expect(stopMcpProcess).toHaveBeenCalledWith(process)
  })

  it('preserves real tool failures and closes the process', async () => {
    vi.mocked(callMcpTool).mockRejectedValue(new Error('MCP tool reported a failure'))
    await expect(testSentryConnection()).rejects.toThrow('MCP tool reported a failure')
    expect(stopMcpProcess).toHaveBeenCalledOnce()
  })

  it('closes the process when initialization fails without calling a tool', async () => {
    vi.mocked(initializeMcp).mockRejectedValue(new Error('MCP transport failed'))
    await expect(testSentryConnection()).rejects.toThrow('MCP transport failed')
    expect(callMcpTool).not.toHaveBeenCalled()
    expect(stopMcpProcess).toHaveBeenCalledOnce()
  })
})
