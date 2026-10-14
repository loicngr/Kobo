import { describe, expect, it, vi } from 'vitest'

type CanUseTool = (
  name: string,
  input: Record<string, unknown>,
  ctx: { signal: AbortSignal; toolUseID: string },
) => Promise<{ behavior: string; message?: string; interrupt?: boolean }>

let capturedHooks:
  | {
      SubagentStart?: Array<{ hooks: Array<() => Promise<{ hookSpecificOutput: { additionalContext: string } }>> }>
      PostToolUse?: Array<{ hooks: unknown[] }>
    }
  | undefined
let capturedCanUseTool: CanUseTool | undefined
let releaseStream: (() => void) | undefined

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn((args: { options: { canUseTool?: CanUseTool; hooks?: typeof capturedHooks } }) => {
    capturedCanUseTool = args.options.canUseTool
    capturedHooks = args.options.hooks
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

it('allows only launch-scoped progress metadata in read-only sessions', async () => {
  for (const scoped of [false, true]) {
    await createClaudeCodeEngine().start(
      {
        workspaceId: 'w',
        workingDir: '/tmp',
        prompt: 'review',
        agentPermissionMode: 'plan',
        readOnly: true,
        backendUrl: 'http://localhost',
        koboHome: '/tmp',
        settings: {} as never,
        mcpServers: scoped
          ? [{ name: 'kobo-tasks', command: 'node', args: [], env: { KOBO_PROGRESS_SESSION_TOKEN: 'token' } }]
          : [],
      },
      () => {},
    )
    try {
      if (scoped) {
        expect(capturedHooks?.PostToolUse?.[0].hooks).toHaveLength(1)
        const guidance = (await capturedHooks!.SubagentStart![0].hooks[0]()).hookSpecificOutput.additionalContext
        expect(guidance).toContain('Pass this requirement to all subagents')
        expect(guidance).toContain('update the same bar at each actual phase change or meaningful completed milestone')
        expect(guidance).toContain('before your final report')
      } else {
        expect(capturedHooks?.SubagentStart).toBeUndefined()
        expect(capturedHooks?.PostToolUse).toBeUndefined()
      }
      const ctx = { signal: new AbortController().signal, toolUseID: 'progress' }
      for (const name of ['create_progress_bar', 'update_progress_bar', 'finish_progress_bar', 'list_progress_bars'])
        expect(await capturedCanUseTool!(`mcp__kobo-tasks__${name}`, {}, ctx)).toMatchObject({
          behavior: scoped ? 'allow' : 'deny',
        })
      for (const name of ['mcp__other__create_progress_bar', 'mcp__kobo-tasks__remember', 'Edit'])
        expect(await capturedCanUseTool!(name, {}, ctx)).toMatchObject({ behavior: 'deny' })
    } finally {
      releaseStream?.()
    }
  }
})

it('permits only a managed capability-scoped handoff report in read-only generation', async () => {
  for (const serverName of ['other-server', 'kobo-tasks']) {
    await createClaudeCodeEngine().start(
      {
        workspaceId: 'handoff',
        workingDir: '/tmp',
        prompt: 'report',
        agentPermissionMode: 'plan',
        readOnly: true,
        backendUrl: 'http://localhost:3000',
        koboHome: '/tmp/kobo',
        settings: {} as never,
        mcpServers: [
          { name: serverName, command: 'node', args: [], env: { KOBO_HANDOFF_ID: 'h', KOBO_HANDOFF_TOKEN: 'private' } },
        ],
      },
      () => {},
    )
    try {
      const ctx = { signal: new AbortController().signal, toolUseID: 'h' }
      expect((await capturedCanUseTool!('mcp__kobo-tasks__submit_session_handoff', {}, ctx)).behavior).toBe(
        serverName === 'kobo-tasks' ? 'allow' : 'deny',
      )
      for (const tool of [
        'AskUserQuestion',
        'Write',
        'mcp__kobo-tasks__mark_task_done',
        'mcp__other__submit_session_handoff',
      ])
        expect((await capturedCanUseTool!(tool, {}, ctx)).behavior).toBe('deny')
    } finally {
      releaseStream?.()
    }
  }
})

it.each([false, true])(
  'prepares the actual Claude instructions before dispatch even if persistence fails (%s)',
  async (failSnapshot) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const prepared = vi.fn(() => {
      if (failSnapshot) throw new Error('private persistence detail')
    })
    await createClaudeCodeEngine().start(
      {
        workspaceId: 'snapshot',
        workingDir: '/tmp',
        prompt: 'mission',
        agentPermissionMode: 'plan',
        backendUrl: 'http://localhost:3000',
        koboHome: '/tmp/kobo',
        settings: {} as never,
        onPromptPrepared: prepared,
        mcpServers: [
          { name: 'kobo-tasks', command: 'node', args: [], env: { KOBO_PROGRESS_SESSION_TOKEN: 'private' } },
        ],
      },
      () => {},
    )
    try {
      expect(prepared).toHaveBeenCalledTimes(1)
      expect(prepared).toHaveBeenCalledWith(
        expect.objectContaining({
          promptPrefix: expect.stringContaining('create_progress_bar'),
          systemAppend: expect.stringContaining('tracked background'),
        }),
      )
      expect(capturedCanUseTool).toBeTypeOf('function')
      expect(JSON.stringify(warn.mock.calls)).not.toContain('private persistence detail')
    } finally {
      releaseStream?.()
      warn.mockRestore()
    }
  },
)

it.each(['plan', 'bypass', 'strict'] as const)(
  'does not silently promote a normal %s launch through ExitPlanMode',
  async (mode) => {
    const events: AgentEvent[] = []
    await createClaudeCodeEngine().start(
      {
        workspaceId: 'plan-exit',
        workingDir: '/tmp',
        prompt: 'plan',
        agentPermissionMode: mode,
        backendUrl: 'http://localhost:3000',
        koboHome: '/tmp/kobo',
        settings: {} as never,
        mcpServers: [
          { name: 'kobo-tasks', command: 'node', args: [], env: { KOBO_PROGRESS_SESSION_TOKEN: 'private' } },
        ],
      },
      (event) => events.push(event),
    )
    try {
      const ctx = { signal: new AbortController().signal, toolUseID: 'exit' }
      const result = await capturedCanUseTool!('ExitPlanMode', {}, ctx)
      expect(result.behavior).toBe(mode === 'plan' ? 'deny' : 'allow')
      if (mode === 'plan') expect(result.message).toContain('explicitly select permissions in Kōbō')
      expect((await capturedCanUseTool!('mcp__kobo-tasks__create_progress_bar', {}, ctx)).behavior).toBe('allow')
      expect(events.some((event) => event.kind === 'session:user-input-requested')).toBe(false)
    } finally {
      releaseStream?.()
    }
  },
)
