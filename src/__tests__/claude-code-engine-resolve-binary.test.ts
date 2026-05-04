import { describe, expect, it, vi } from 'vitest'

vi.mock('@anthropic-ai/claude-agent-sdk', () => {
  return {
    query: vi.fn(() => {
      const messages = [
        { type: 'system', subtype: 'init', session_id: 'sess-bin', model: 'm', slash_commands: [] },
        {
          type: 'assistant',
          message: { id: 'msg', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' },
        },
        { type: 'result', subtype: 'success', usage: { input_tokens: 1, output_tokens: 1 } },
      ]
      return {
        async *[Symbol.asyncIterator]() {
          for (const m of messages) yield m
        },
        interrupt: vi.fn(),
      }
    }),
  }
})

vi.mock('../server/services/agent/engines/claude-code/resolve-binary.js', () => ({
  resolveClaudeBinaryPath: () => '/fake/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude',
  detectPlatform: () => ({ platform: 'linux', arch: 'x64', isGlibc: true }),
}))

import { createClaudeCodeEngine } from '../server/services/agent/engines/claude-code/engine.js'

describe('claude-code engine — pathToClaudeCodeExecutable wiring', () => {
  it('passes the resolved glibc binary path to the SDK query options', async () => {
    const { query } = await import('@anthropic-ai/claude-agent-sdk')
    const engine = createClaudeCodeEngine()
    await engine.start(
      {
        workspaceId: 'w-bin',
        workingDir: '/tmp',
        prompt: 'go',
        backendUrl: 'http://localhost:3000',
        koboHome: '/tmp/kobo',
        // biome-ignore lint/suspicious/noExplicitAny: test fixture, not the public surface
        settings: { dangerouslySkipPermissions: true } as any,
      },
      () => {},
    )
    await new Promise((r) => setTimeout(r, 20))
    const calls = vi.mocked(query).mock.calls
    expect(calls.length).toBeGreaterThan(0)
    const firstCallArg = calls[0]?.[0]
    expect(firstCallArg).toBeDefined()
    expect(firstCallArg?.options?.pathToClaudeCodeExecutable).toBe(
      '/fake/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude',
    )
  })
})
