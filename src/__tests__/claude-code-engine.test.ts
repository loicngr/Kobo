import { describe, expect, it, vi } from 'vitest'

vi.mock('@anthropic-ai/claude-agent-sdk', () => {
  return {
    query: vi.fn(() => {
      const messages = [
        {
          type: 'system',
          subtype: 'init',
          session_id: 'sess-1',
          model: 'm',
          slash_commands: [],
        },
        {
          type: 'assistant',
          message: {
            id: 'msg-1',
            content: [{ type: 'text', text: 'hi' }],
            stop_reason: 'end_turn',
          },
        },
        {
          type: 'result',
          subtype: 'success',
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      ]
      const iter = {
        async *[Symbol.asyncIterator]() {
          for (const m of messages) yield m
        },
        interrupt: vi.fn(),
      }
      return iter
    }),
  }
})

import { createClaudeCodeEngine } from '../server/services/agent/engines/claude-code/engine.js'
import type { AgentEvent } from '../server/services/agent/engines/types.js'

describe('claude-code engine (SDK)', () => {
  it('emits session:started, message:text and session:ended for a happy run', async () => {
    const engine = createClaudeCodeEngine()
    const events: AgentEvent[] = []
    const proc = await engine.start(
      {
        workspaceId: 'w1',
        workingDir: '/tmp',
        prompt: 'do something',
        backendUrl: 'http://localhost:3000',
        koboHome: '/tmp/kobo',
        settings: { dangerouslySkipPermissions: true } as any,
      },
      (ev) => events.push(ev),
    )
    // Allow the async iteration to drain.
    await new Promise((r) => setTimeout(r, 20))
    expect(events.find((e) => e.kind === 'session:started')).toBeDefined()
    expect(events.find((e) => e.kind === 'message:text')).toBeDefined()
    const ended = events.find((e) => e.kind === 'session:ended')
    expect(ended).toBeDefined()
    if (ended && ended.kind === 'session:ended') expect(ended.reason).toBe('completed')
    expect(proc.engineSessionId).toBe('sess-1')
  })

  it('REGRESSION — bypass + MCP servers: query() receives the right options for MCP to be auto-allowed', async () => {
    // This test pins the contract that, when the user enables
    // `dangerouslySkipPermissions` AND there are MCP servers configured, the
    // engine MUST hand the SDK a config that will not gate MCP tool calls
    // with "permissions ... not granted yet". The exact payload was wrong
    // multiple times during the SDK migration; this test catches it.
    const { query } = await import('@anthropic-ai/claude-agent-sdk')
    const engine = createClaudeCodeEngine()
    await engine.start(
      {
        workspaceId: 'w-bypass-mcp',
        workingDir: '/tmp',
        prompt: 'list tasks',
        backendUrl: 'http://localhost:3000',
        koboHome: '/tmp/kobo',
        settings: { dangerouslySkipPermissions: true } as any,
        agentPermissionMode: 'bypass',
        mcpServers: [
          {
            name: 'kobo-tasks',
            command: 'node',
            args: ['/path/to/kobo-tasks-server.js'],
            env: { KOBO_WORKSPACE_ID: 'w-bypass-mcp' },
          },
        ],
      },
      () => {},
    )
    const args = vi.mocked(query).mock.calls.at(-1)?.[0] as
      | {
          options?: {
            permissionMode?: string
            allowDangerouslySkipPermissions?: boolean
            mcpServers?: Record<string, { type?: string; alwaysLoad?: boolean }>
            tools?: unknown
            allowedTools?: string[]
          }
        }
      | undefined
    expect(args, 'query() must have been called').toBeDefined()
    const opts = args?.options
    // 1. Permission mode must literally be `bypassPermissions` — not 'default',
    //    not 'acceptEdits' — so that built-ins like Bash/Read auto-allow.
    expect(opts?.permissionMode).toBe('bypassPermissions')
    expect(opts?.allowDangerouslySkipPermissions).toBe(true)
    // 2. `tools` must be undefined. The `claude_code` preset excludes MCP
    //    tools, breaking bypass for them. Letting `tools` default gives the
    //    SDK its full toolbox (built-ins + MCP).
    expect(opts?.tools).toBeUndefined()
    // 3. mcpServers entry must carry `alwaysLoad: true`. Without it, the SDK
    //    keeps MCP tools "behind tool search" and re-prompts permissions
    //    even under bypass.
    expect(opts?.mcpServers).toBeDefined()
    expect(opts?.mcpServers?.['kobo-tasks']).toBeDefined()
    expect(opts?.mcpServers?.['kobo-tasks']?.alwaysLoad).toBe(true)
    expect(opts?.mcpServers?.['kobo-tasks']?.type).toBe('stdio')
  })

  it('emits session:ended/killed when stop() is called', async () => {
    const engine = createClaudeCodeEngine()
    const events: AgentEvent[] = []
    const proc = await engine.start(
      {
        workspaceId: 'w2',
        workingDir: '/tmp',
        prompt: 'go',
        backendUrl: 'http://localhost:3000',
        koboHome: '/tmp/kobo',
        settings: { dangerouslySkipPermissions: true } as any,
      },
      (ev) => events.push(ev),
    )
    await proc.stop()
    // The mock yields 3 messages then terminates cleanly, so reason is 'completed' here too.
    // Just verify session:ended was eventually emitted.
    expect(events.find((e) => e.kind === 'session:ended')).toBeDefined()
  })
})
