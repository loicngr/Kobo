import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { callWorkspaceDialogueTool } from '../mcp-server/workspace-dialogue-client.js'

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({ StreamableHTTPClientTransport: class {} }))
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    async connect() {}
    async close() {}
    callTool(_request: unknown, _schema: unknown, options: { signal: AbortSignal }) {
      return new Promise((resolve, reject) => {
        const abort = () => {
          clearTimeout(timer)
          reject(new Error('deadline'))
        }
        const timer = setTimeout(() => {
          options.signal.removeEventListener('abort', abort)
          resolve({ content: [] })
        }, 45_000)
        options.signal.addEventListener('abort', abort, { once: true })
      })
    }
  },
}))
beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), ms)
    return controller.signal
  })
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
})
it('lets native Vibe discovery finish after the ordinary 30-second deadline', async () => {
  const pending = callWorkspaceDialogueTool('http://localhost', 'list_agent_options', {
    workspace_id: 'own',
    engine: 'mistral-vibe',
  })
  const assertion = expect(pending).resolves.toEqual({ content: [] })
  await vi.advanceTimersByTimeAsync(45_000)
  await assertion
  expect(AbortSignal.timeout).toHaveBeenCalledWith(90_000)
})
it('keeps ordinary catalogue reads bounded to 30 seconds', async () => {
  const pending = callWorkspaceDialogueTool('http://localhost', 'list_agent_options', {
    workspace_id: 'own',
    engine: 'codex',
  })
  const assertion = expect(pending).rejects.toThrow('deadline')
  await vi.advanceTimersByTimeAsync(30_000)
  await assertion
  expect(AbortSignal.timeout).toHaveBeenCalledWith(30_000)
})
