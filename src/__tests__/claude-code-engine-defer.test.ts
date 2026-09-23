import { describe, expect, it, vi } from 'vitest'

let lastQueryArgs: { prompt: string; options: Record<string, unknown> } | undefined

vi.mock('@anthropic-ai/claude-agent-sdk', () => {
  return {
    query: vi.fn((args: { prompt: string; options: Record<string, unknown> }) => {
      lastQueryArgs = args
      // Drive the canUseTool callback from inside the iterator so the engine
      // emits a session:user-input-requested event and we can resolve it from
      // outside via engineProcess.resolvePendingUserInput.
      const opts = args.options as {
        canUseTool?: (
          name: string,
          input: Record<string, unknown>,
          ctx: { signal: AbortSignal; toolUseID: string },
        ) => Promise<unknown>
      }
      const messages: unknown[] = [
        { type: 'system', subtype: 'init', session_id: 'sess-can-use', model: 'm', slash_commands: [] },
      ]
      let lastPermissionResult: unknown
      return {
        async *[Symbol.asyncIterator]() {
          for (const m of messages) yield m
          if (opts.canUseTool) {
            const ctrl = new AbortController()
            const result = await opts.canUseTool(
              'AskUserQuestion',
              { questions: [{ question: 'Q?', options: [{ label: 'A' }] }] },
              { signal: ctrl.signal, toolUseID: 'toolu_match' },
            )
            lastPermissionResult = result
            yield {
              type: 'result',
              subtype: 'success',
              usage: { input_tokens: 1, output_tokens: 1 },
            }
          }
        },
        interrupt: vi.fn(),
        getLastPermissionResult: () => lastPermissionResult,
      }
    }),
  }
})

import { createClaudeCodeEngine } from '../server/services/agent/engines/claude-code/engine.js'
import type { AgentEvent } from '../server/services/agent/engines/types.js'

describe('claude-code engine — canUseTool integration', () => {
  it('emits session:user-input-requested when SDK invokes canUseTool for AskUserQuestion', async () => {
    const engine = createClaudeCodeEngine()
    const events: AgentEvent[] = []
    const proc = await engine.start(
      {
        workspaceId: 'w-defer',
        workingDir: '/tmp',
        prompt: 'go',
        backendUrl: 'http://localhost:3000',
        koboHome: '/tmp/kobo',
        settings: { dangerouslySkipPermissions: true } as any,
      },
      (ev) => events.push(ev),
    )

    // Wait until the iterator has run far enough to dispatch canUseTool.
    await new Promise((r) => setTimeout(r, 30))

    const requested = events.find((e) => e.kind === 'session:user-input-requested')
    expect(requested).toBeDefined()
    if (requested && requested.kind === 'session:user-input-requested') {
      expect(requested.requestKind).toBe('question')
      expect(requested.toolCallId).toBe('toolu_match')
      expect(requested.toolName).toBe('AskUserQuestion')
    }

    // Resolve the pending callback from outside — this is what answerPendingQuestion does.
    const resolved = proc.resolvePendingUserInput('toolu_match', {
      kind: 'question',
      answers: { 'Q?': 'A' },
    })
    expect(resolved).toBe(true)

    // Allow the iterator to finish post-resolve.
    await new Promise((r) => setTimeout(r, 30))

    // The mock SDK records the PermissionResult our engine returned to canUseTool.
    const sdkMod = await import('@anthropic-ai/claude-agent-sdk')
    const lastCall = vi.mocked(sdkMod.query).mock.results.at(-1)?.value as
      | { getLastPermissionResult?: () => { behavior?: string; updatedInput?: Record<string, unknown> } }
      | undefined
    const permission = lastCall?.getLastPermissionResult?.()
    expect(permission?.behavior).toBe('allow')
    expect(permission?.updatedInput?.answers).toEqual({ 'Q?': 'A' })
    expect(permission?.updatedInput?.questions).toBeDefined()
  })

  it('forwards canUseTool to the SDK options', async () => {
    const engine = createClaudeCodeEngine()
    await engine.start(
      {
        workspaceId: 'w-cf',
        workingDir: '/tmp',
        prompt: 'go',
        backendUrl: 'http://localhost:3000',
        koboHome: '/tmp/kobo',
        settings: { dangerouslySkipPermissions: true } as any,
      },
      () => {},
    )
    const opts = lastQueryArgs?.options as { canUseTool?: unknown } | undefined
    expect(typeof opts?.canUseTool).toBe('function')
  })

  it('resolvePendingUserInput returns false when no pending entry matches', async () => {
    const engine = createClaudeCodeEngine()
    const proc = await engine.start(
      {
        workspaceId: 'w-nope',
        workingDir: '/tmp',
        prompt: 'go',
        backendUrl: 'http://localhost:3000',
        koboHome: '/tmp/kobo',
        settings: { dangerouslySkipPermissions: true } as any,
      },
      () => {},
    )
    expect(proc.resolvePendingUserInput('does-not-exist', { kind: 'question', answers: {} })).toBe(false)
  })
})
