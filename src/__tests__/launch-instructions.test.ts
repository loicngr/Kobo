import { describe, expect, it } from 'vitest'
import { buildClaudeOptions } from '../server/services/agent/engines/claude-code/options-builder.js'
import { buildCodexOptions } from '../server/services/agent/engines/codex/options-builder.js'

const env = { KOBO_PROGRESS_SESSION_TOKEN: 'private-progress-token' }
const base = { prompt: 'Mission', agentPermissionMode: 'plan' as const, workingDir: '/tmp/project' }

for (const engine of ['claude-code', 'codex'] as const) {
  const build = (overrides: Record<string, unknown> = {}, extraEnv = {}) => {
    const input = { ...base, ...overrides }
    const managed = { command: 'node', args: ['mcp.js'], env: { ...env, ...extraEnv } }
    if (engine === 'claude-code') {
      const result = buildClaudeOptions({ ...input, mcpServers: { 'kobo-tasks': managed } })
      return `${result.effectivePrompt}\n${(result.options.systemPrompt as { append: string }).append}`
    }
    return (
      buildCodexOptions({ ...input, mcpServers: [{ name: 'kobo-tasks', ...managed }] }).input[0] as { text: string }
    ).text
  }

  describe(`${engine} current launch instructions`, () => {
    it.each([undefined, 'existing-session'])(
      'keeps Plan restrictions explicit on fresh/resume %s',
      (resumeFromEngineSessionId) => {
        const text = build({ resumeFromEngineSessionId })
        expect(text).toContain('Approving a plan does not change these permissions')
        expect(text).toContain('Do not write files or mutate tasks, workspace state, memory, or other MCP data')
        expect(text).toContain('create_progress_bar')
        expect(text).toContain('update the same bar at each actual phase change or meaningful completed milestone')
        expect(text).toContain('omit both current and total for step-only updates')
        expect(text).toContain('before your final report')
        expect(text).not.toContain('must wait until the plan is approved')
        expect(text).not.toContain('kobo__')
        expect(text).not.toContain('private-progress-token')
      },
    )

    it('directs relevant discovery without expanding permissions or polling', () => {
      const text = build({ agentPermissionMode: 'bypass' })
      expect(text).toContain('descriptions and schemas of the available tools')
      expect(text).toContain('Prefer relevant Kōbō tools')
      expect(text).toContain('do not call every tool or poll')
      expect(text).toContain('Availability does not grant permission')
      expect(text).toContain('preserve the user’s description')
      expect(text).toContain('whether a native process or Docker services')
      expect(text).toContain('use the returned `agentUrl`')
      expect(text).toContain('`url` is the browser/SSH-tunnel address')
      expect(text).toContain('documented service-local address')
    })

    it('does not suggest unavailable operations during an automatic-return review', () => {
      const text = build({ readOnly: true })
      expect(text).toContain('Do not ask the user')
      expect(text).not.toContain('AskUserQuestion')
      expect(text).not.toContain('schedule_wakeup')
      expect(text).not.toContain('submit_final_review')
      expect(text).not.toContain('set_auto_loop')
    })

    it('recognizes restricted handoff even without readOnly flag', () => {
      const text = build({ agentPermissionMode: 'bypass' }, { KOBO_HANDOFF_ID: 'h', KOBO_HANDOFF_TOKEN: 'secret' })
      expect(text).toContain('Do not ask the user')
      expect(text).not.toContain('schedule_wakeup')
      expect(text).not.toContain('mark_task_done')
    })

    it('mentions final verdict only when the managed capability exists', () => {
      const text = build({ readOnly: true }, { KOBO_FINAL_REVIEW_SESSION_ID: 'r', KOBO_FINAL_REVIEW_TOKEN: 'secret' })
      expect(text).toContain('submit_final_review')
      expect(text).not.toContain('schedule_wakeup')
    })

    it('distinguishes tracked work, detached work and auto-loop continuation', () => {
      const text = build({ agentPermissionMode: 'bypass', autoLoop: true })
      expect(text).toContain('tracked background')
      expect(text).toContain('detached')
      expect(text).toContain('Auto-loop owns the next iteration')
      expect(text).toContain('parent coordinates')
      expect(text).toContain('subagents must not schedule')
    })
  })
}

it('keeps snapshot text identical to injected application instructions without environment data', () => {
  const result = buildClaudeOptions({ ...base, mcpServers: { 'kobo-tasks': { command: 'node', env } } })
  expect(result.effectivePrompt).toBe(`${result.koboInstructions.promptPrefix}\n\nMission`)
  expect((result.options.systemPrompt as { append: string }).append).toBe(result.koboInstructions.systemAppend)
  expect(JSON.stringify(result.koboInstructions)).not.toContain('private-progress-token')
})

it('does not advertise progress for missing or unmanaged capabilities', () => {
  const result = buildClaudeOptions({ ...base, mcpServers: { 'other-server': { command: 'node', env } } })
  expect(result.effectivePrompt).not.toContain('create_progress_bar')
})

it('gives handoff precedence when both report capabilities are present', () => {
  const result = buildCodexOptions({
    ...base,
    mcpServers: [
      {
        name: 'kobo-tasks',
        command: 'node',
        args: [],
        env: {
          KOBO_HANDOFF_ID: 'h',
          KOBO_HANDOFF_TOKEN: 'secret',
          KOBO_FINAL_REVIEW_SESSION_ID: 's',
          KOBO_FINAL_REVIEW_TOKEN: 'secret',
        },
      },
    ],
  })
  const text = (result.input[0] as { text: string }).text
  expect(text).toContain('submit_session_handoff')
  expect(text).not.toContain('submit_final_review')
})

it('passes parent-owned scheduling rules into delegated progress instructions', async () => {
  const { PROGRESS_BAR_PROMPT } = await import('../shared/progress-bar-prompts.js')
  expect(PROGRESS_BAR_PROMPT).toContain('Subagents must not schedule or replace workspace wakeups')
})

it('puts Vibe native discovery and continuation in the dispatched prompt', async () => {
  const { buildKoboLaunchInstructions } = await import('../shared/launch-instructions.js')
  const instructions = buildKoboLaunchInstructions({
    engine: 'mistral-vibe',
    permissionMode: 'interactive',
    autoLoop: true,
  })
  expect(instructions.promptPrefix).toContain('search_tool_functions')
  expect(instructions.promptPrefix).toContain('tools.mcp_kobo_tasks.<tool>')
  expect(instructions.promptPrefix).toContain('run_typescript')
  expect(instructions.promptPrefix).toContain('tools.process')
  expect(instructions.promptPrefix).toContain('Auto-loop owns the next iteration')
  expect(instructions.promptPrefix).not.toContain('mcp__kobo-tasks__')
  expect(instructions.systemAppend).toBe('')
})
