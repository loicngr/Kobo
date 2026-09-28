import { describe, expect, it, vi } from 'vitest'

type CanUseTool = (
  name: string,
  input: Record<string, unknown>,
  ctx: { signal: AbortSignal; toolUseID: string },
) => Promise<{ behavior: string; message?: string; interrupt?: boolean }>

let capturedCanUseTool: CanUseTool | undefined
let releaseStream: (() => void) | undefined

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn((args: { options: { canUseTool?: CanUseTool } }) => {
    capturedCanUseTool = args.options.canUseTool
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: 'system', subtype: 'init', session_id: 'sess-read-only', model: 'm', slash_commands: [] }
        await new Promise<void>((resolve) => {
          releaseStream = resolve
        })
      },
      interrupt: vi.fn(),
    }
  }),
}))

import { createClaudeCodeEngine } from '../server/services/agent/engines/claude-code/engine.js'
import type { AgentEvent } from '../server/services/agent/engines/types.js'

describe('claude-code engine - read-only review session', () => {
  it('denies every permission request, questions included, without waiting on the user', async () => {
    const events: AgentEvent[] = []
    await createClaudeCodeEngine().start(
      {
        workspaceId: 'w-read-only',
        workingDir: '/tmp',
        prompt: 'review',
        agentPermissionMode: 'plan',
        readOnly: true,
        backendUrl: 'http://localhost:3000',
        koboHome: '/tmp/kobo',
        settings: {} as never,
      },
      (ev) => events.push(ev),
    )
    try {
      const ctx = { signal: new AbortController().signal, toolUseID: 'toolu_1' }
      for (const tool of ['ExitPlanMode', 'Bash', 'mcp__kobo-tasks__mark_task_done', 'AskUserQuestion']) {
        const result = await capturedCanUseTool!(tool, {}, ctx)
        expect(result).toMatchObject({ behavior: 'deny', interrupt: false })
        expect(result.message).toContain('read-only')
      }
      expect(events.some((ev) => ev.kind === 'session:user-input-requested')).toBe(false)
    } finally {
      releaseStream?.()
    }
  })
})
