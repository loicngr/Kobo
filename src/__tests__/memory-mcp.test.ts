import { describe, expect, it, vi } from 'vitest'
import { callMemoryTool, isMemoryOutputSuppressed } from '../mcp-server/memory-client.js'
import { isMemoryToolName, MEMORY_TOOL_DEFINITIONS, validateMemoryToolArguments } from '../shared/memory-tools.js'

describe('memory MCP tools', () => {
  it('suppresses the backend terminal-budget marker instead of exposing it to the model', () => {
    expect(isMemoryOutputSuppressed({ memoryOutputSuppressed: true })).toBe(true)
    expect(isMemoryOutputSuppressed({ memoryOutputSuppressed: false })).toBe(false)
    expect(isMemoryOutputSuppressed({ budgetExhausted: true })).toBe(false)
  })

  it('publishes bounded read tools and one mutation tool', () => {
    expect(MEMORY_TOOL_DEFINITIONS.map(({ name }) => name)).toEqual([
      'list_memory_scopes',
      'list_memories',
      'read_memory',
      'search_memories',
      'list_memory_operations',
      'remember',
    ])
    expect(MEMORY_TOOL_DEFINITIONS.slice(0, 5).every((tool) => tool.annotations?.readOnlyHint)).toBe(true)
    expect(MEMORY_TOOL_DEFINITIONS.at(-1)?.annotations?.readOnlyHint).toBe(false)
  })

  it('strictly rejects forged actor, workspace and session fields', () => {
    expect(isMemoryToolName('remember')).toBe(true)
    expect(isMemoryToolName('clear_memory')).toBe(false)
    expect(() =>
      validateMemoryToolArguments('remember', {
        scope_id: 'scope-1',
        key: 'k',
        title: 'title',
        body: 'body',
        actor: { kind: 'human' },
      }),
    ).toThrow(/Unexpected/)
    expect(() => validateMemoryToolArguments('list_memories', { workspace_id: 'other' })).toThrow(/Unexpected/)
  })

  it('forwards through the injected transport with capability headers and no SQLite access', async () => {
    const fetcher = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify({ result: 'ok' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    )
    const result = await callMemoryTool({
      backendUrl: 'http://kobo.test',
      name: 'list_memory_scopes',
      args: {},
      capability: 'secret-capability',
      networkToken: 'network-token',
      fetcher,
    })

    expect(result).toEqual({ result: 'ok' })
    expect(fetcher).toHaveBeenCalledTimes(1)
    const request = fetcher.mock.calls[0]!
    const [url, init] = request
    expect(url).toBe('http://kobo.test/api/memory/agent/list_memory_scopes')
    if (!init) throw new Error('Expected request options')
    const headers = init.headers as Record<string, string>
    expect(headers['X-Kobo-Memory-Session']).toBe('secret-capability')
    expect(headers['X-Kobo-Token']).toBe('network-token')
  })

  it('aborts a stalled capability-bound request after the configured timeout', async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const signal = init?.signal
      if (!signal) throw new Error('Expected a bounded request signal')
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    })

    await expect(
      callMemoryTool({
        backendUrl: 'http://kobo.test',
        name: 'list_memory_scopes',
        args: {},
        capability: 'secret-capability',
        fetcher,
        timeoutMs: 5,
      }),
    ).rejects.toMatchObject({ name: 'TimeoutError' })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})
