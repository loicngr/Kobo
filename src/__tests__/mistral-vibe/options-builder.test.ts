import { describe, expect, it } from 'vitest'
import { buildMistralOptions } from '../../server/services/agent/engines/mistral-vibe/options-builder.js'
import type { StartOptions } from '../../server/services/agent/engines/types.js'

const base: StartOptions = {
  workspaceId: 'workspace',
  workingDir: '/tmp/project',
  prompt: 'Mission',
  backendUrl: 'http://127.0.0.1:3000',
  koboHome: '/tmp/kobo',
  settings: {} as StartOptions['settings'],
  agentPermissionMode: 'interactive',
}

describe('Mistral launch options', () => {
  it.each([
    ['interactive', 'ask'],
    ['strict', 'accept-edits'],
    ['bypass', 'auto-approve'],
  ] as const)('maps %s to native %s without promoting permissions', (agentPermissionMode, modeId) => {
    expect(buildMistralOptions({ ...base, agentPermissionMode }).modeId).toBe(modeId)
  })
  it.each([
    { agentPermissionMode: 'plan' as const },
    { readOnly: true },
    { model: 'bad\0value' },
    { effort: 'x'.repeat(257) },
    { resumeFromEngineSessionId: '' },
  ])('rejects unsupported launch %j', (overrides) => {
    expect(() => buildMistralOptions({ ...base, ...overrides })).toThrow()
  })
  it.each(['KOBO_HANDOFF_TOKEN'])('rejects restricted managed capability %s', (token) => {
    const env: Record<string, string> =
      token === 'KOBO_HANDOFF_TOKEN'
        ? { KOBO_HANDOFF_ID: 'h', [token]: 'secret' }
        : { KOBO_FINAL_REVIEW_SESSION_ID: 'r', [token]: 'secret' }
    expect(() =>
      buildMistralOptions({ ...base, mcpServers: [{ name: 'kobo-tasks', command: 'node', args: [], env }] }),
    ).toThrow(/read.only/i)
  })
  it('preserves native auto configuration and builds fresh MCP arrays on every launch', () => {
    const options = {
      ...base,
      model: 'auto',
      effort: 'auto',
      env: { VIBE_ACTIVE_MODEL: 'native-model', VIBE_THINKING: 'native-effort' },
      mcpServers: [
        {
          name: 'kobo-tasks',
          command: 'node',
          args: ['mcp.js'],
          env: { KOBO_PROGRESS_SESSION_TOKEN: 'private-token' },
        },
      ],
    }
    const first = buildMistralOptions(options)
    const second = buildMistralOptions({ ...options, resumeFromEngineSessionId: 'native-session' })
    expect(first.cwd).toBe('/tmp/project')
    expect(first.env.VIBE_ACTIVE_MODEL).toBe('native-model')
    expect(first.env.VIBE_THINKING).toBe('native-effort')
    expect(first.env.HOME).toBe(process.env.HOME)
    expect(first.mcpServers).toEqual([
      {
        name: 'kobo-tasks',
        command: 'node',
        args: ['mcp.js'],
        env: [{ name: 'KOBO_PROGRESS_SESSION_TOKEN', value: 'private-token' }],
      },
    ])
    expect(first.mcpServers).not.toBe(second.mcpServers)
    const firstServer = first.mcpServers[0]!
    const secondServer = second.mcpServers[0]!
    if (!('env' in firstServer) || !('env' in secondServer)) throw new Error('Expected stdio MCP')
    expect(firstServer.env).not.toBe(secondServer.env)
    expect(first.prompt).toEqual(second.prompt)
    expect(JSON.stringify(first.prompt)).not.toContain('private-token')
    expect(first.prompt[0]).toEqual({ type: 'text', text: `${first.koboInstructions.promptPrefix}\n\nMission` })
    expect(first.koboInstructions.promptPrefix).toContain('search_tool_functions')
    expect(first.koboInstructions.promptPrefix).toContain('tools.mcp_kobo_tasks.<tool>')
    expect(first.koboInstructions.promptPrefix).toContain('run_typescript')
    expect(first.koboInstructions.promptPrefix).toContain('tools.process')
    expect(first.koboInstructions.promptPrefix).toContain('## Long-running work and continuation')
    expect(first.koboInstructions.promptPrefix).not.toContain('mcp__kobo-tasks__')
  })
  it('does not derive managed capabilities from another integration', () => {
    expect(() =>
      buildMistralOptions({
        ...base,
        mcpServers: [
          { name: 'other', command: 'node', args: [], env: { KOBO_HANDOFF_ID: 'h', KOBO_HANDOFF_TOKEN: 'secret' } },
        ],
      }),
    ).not.toThrow()
  })
})

it('preserves explicit native values for authoritative ACP validation', () => {
  expect(() => buildMistralOptions({ ...base, model: 'native-alias', effort: 'off' })).not.toThrow()
})

it.each<Record<string, string>>([
  { KOBO_REVIEW_ONLY: '1' },
  { KOBO_FINAL_REVIEW_SESSION_ID: 'r', KOBO_FINAL_REVIEW_TOKEN: 'secret' },
])('builds an honest restricted native review prompt %j', (env) => {
  const result = buildMistralOptions({ ...base, mcpServers: [{ name: 'kobo-tasks', command: 'node', args: [], env }] })
  expect(result.modeId).toBe('ask')
  expect(result.koboInstructions.promptPrefix).toContain('without guaranteed filesystem read-only')
  expect(result.koboInstructions.promptPrefix).toContain('Do not modify, create or delete files')
  expect(result.koboInstructions.promptPrefix).toContain('wait for user approval when required')
  expect(result.koboInstructions.promptPrefix).not.toContain('Do not ask the user or wait')
  expect(result.koboInstructions.promptPrefix).not.toContain('Keep existing Kōbō tasks synchronized')
  expect(result.koboInstructions.promptPrefix).not.toContain('use `remember` if')
})
