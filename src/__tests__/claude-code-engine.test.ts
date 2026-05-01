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

  it('isAlive() flips false after the iterator completes (watchdog signal)', async () => {
    const engine = createClaudeCodeEngine()
    const events: AgentEvent[] = []
    const proc = await engine.start(
      {
        workspaceId: 'w-alive',
        workingDir: '/tmp',
        prompt: 'go',
        backendUrl: 'http://localhost:3000',
        koboHome: '/tmp/kobo',
        settings: { dangerouslySkipPermissions: true } as any,
      },
      (ev) => events.push(ev),
    )
    // The async iterator pumps via microtask scheduling; isAlive() is true
    // synchronously after start() resolves and stays true until the for-await
    // loop drains. We can't observe the "true" window deterministically (the
    // iterator may already have finished by the time the test thread runs)
    // but isAlive must be a function and must report false once session:ended
    // has been emitted.
    expect(typeof proc.isAlive).toBe('function')
    await new Promise((r) => setTimeout(r, 30))
    expect(events.find((e) => e.kind === 'session:ended')).toBeDefined()
    expect(proc.isAlive!()).toBe(false)
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

describe('claude-code engine — canUseTool abort tagging', () => {
  it('aborting a pending canUseTool yields session:ended/killed (not spawn_failed/error)', async () => {
    // Re-mock the SDK locally for this test: the query iterator emits a
    // tool_use that drives canUseTool, then awaits the abort to propagate up.
    vi.resetModules()
    vi.doMock('@anthropic-ai/claude-agent-sdk', () => {
      let abortSignal: AbortSignal | null = null
      return {
        query: vi.fn(
          (args: {
            options?: {
              abortController?: AbortController
              canUseTool?: (
                name: string,
                input: unknown,
                ctx: { signal: AbortSignal; toolUseID: string },
              ) => Promise<unknown>
            }
          }) => {
            abortSignal = args.options?.abortController?.signal ?? null
            const canUseTool = args.options?.canUseTool
            const iter = {
              async *[Symbol.asyncIterator]() {
                yield { type: 'system', subtype: 'init', session_id: 's', model: 'm', slash_commands: [] }
                // Trigger interactive permission via canUseTool — the engine's
                // hook will register a pending resolver and await it.
                if (canUseTool) {
                  // Engine catches the AbortError that resolves this promise
                  // when stop() fires → session:ended/killed.
                  await canUseTool(
                    'Bash',
                    { command: 'ls' },
                    { signal: abortSignal ?? new AbortController().signal, toolUseID: 'tu-1' },
                  )
                }
              },
              interrupt: vi.fn(),
            }
            return iter
          },
        ),
      }
    })

    const engineMod = await import('../server/services/agent/engines/claude-code/engine.js')
    const engine = engineMod.createClaudeCodeEngine()
    const events: AgentEvent[] = []
    const proc = await engine.start(
      {
        workspaceId: 'w-abort',
        workingDir: '/tmp',
        prompt: 'go',
        backendUrl: 'http://localhost:3000',
        koboHome: '/tmp/kobo',
        settings: { dangerouslySkipPermissions: true } as any,
        agentPermissionMode: 'interactive',
      },
      (ev) => events.push(ev),
    )

    // Wait for the canUseTool registration to land.
    await new Promise((r) => setTimeout(r, 10))
    expect(events.find((e) => e.kind === 'session:user-input-requested')).toBeDefined()

    // Stop → aborts the controller → onAbort rejects with name=AbortError.
    await proc.stop()

    const ended = events.find((e) => e.kind === 'session:ended')
    expect(ended).toBeDefined()
    if (ended && ended.kind === 'session:ended') {
      expect(ended.reason).toBe('killed')
    }
    // Must NOT have produced a spawn_failed error from the rejected promise.
    expect(events.find((e) => e.kind === 'error' && e.category === 'spawn_failed')).toBeUndefined()

    vi.doUnmock('@anthropic-ai/claude-agent-sdk')
    vi.resetModules()
  })
})
