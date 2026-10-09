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

it('permits only the scoped final-review report tool while preserving read-only denials', async () => {
  for (const scoped of [false, true]) {
    await createClaudeCodeEngine().start(
      {
        workspaceId: 'w-final-review',
        workingDir: '/tmp',
        prompt: 'review',
        agentPermissionMode: 'plan',
        readOnly: true,
        backendUrl: 'http://localhost:3000',
        koboHome: '/tmp/kobo',
        settings: {} as never,
        mcpServers: scoped
          ? [
              {
                name: 'kobo-tasks',
                command: 'node',
                args: [],
                env: { KOBO_FINAL_REVIEW_TOKEN: 'scoped-token', KOBO_FINAL_REVIEW_SESSION_ID: 'review-session' },
              },
            ]
          : [],
      },
      () => {},
    )
    try {
      const ctx = { signal: new AbortController().signal, toolUseID: 'report' }
      expect(
        await capturedCanUseTool!('mcp__kobo-tasks__submit_final_review', { summary: 'clear', findings: [] }, ctx),
      ).toMatchObject({ behavior: scoped ? 'allow' : 'deny' })
      for (const name of [
        'mcp__other__submit_final_review',
        'mcp__kobo-tasks__mark_task_done',
        'Edit',
        'AskUserQuestion',
        'ExitPlanMode',
      ]) {
        expect(await capturedCanUseTool!(name, {}, ctx)).toMatchObject({ behavior: 'deny' })
      }
    } finally {
      releaseStream?.()
    }
  }
})
