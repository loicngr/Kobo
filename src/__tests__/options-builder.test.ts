import { describe, expect, it } from 'vitest'
import { buildClaudeOptions } from '../server/services/agent/engines/claude-code/options-builder.js'

describe('buildClaudeOptions', () => {
  it('returns minimal options for the bypass mode', () => {
    const { options, effectivePrompt } = buildClaudeOptions({
      prompt: 'hello',
      agentPermissionMode: 'bypass',
      workingDir: '/tmp/work',
    })
    expect(options.cwd).toBe('/tmp/work')
    expect(options.permissionMode).toBe('bypassPermissions')
    expect(options.allowDangerouslySkipPermissions).toBe(true)
    expect(options.systemPrompt).toEqual({ type: 'preset', preset: 'claude_code' })
    // `tools` is intentionally left undefined — see options-builder.ts: the
    // `claude_code` preset excludes MCP tools, breaking bypassPermissions for
    // them. Letting it default gives the agent the full toolbox.
    expect(options.tools).toBeUndefined()
    expect(options.settingSources).toEqual(['user', 'project', 'local'])
    expect(effectivePrompt).toContain('[Kōbō MCP]')
    expect(effectivePrompt.endsWith('hello')).toBe(true)
  })

  it('plan mode maps to SDK plan and never sets allowDangerouslySkipPermissions', () => {
    const { options } = buildClaudeOptions({
      prompt: 'p',
      agentPermissionMode: 'plan',
      workingDir: '/x',
    })
    expect(options.permissionMode).toBe('plan')
    expect(options.allowDangerouslySkipPermissions).toBeUndefined()
  })

  it('strict mode uses acceptEdits without bypass', () => {
    const { options } = buildClaudeOptions({
      prompt: 'p',
      agentPermissionMode: 'strict',
      workingDir: '/x',
    })
    expect(options.permissionMode).toBe('acceptEdits')
    expect(options.allowDangerouslySkipPermissions).toBeUndefined()
  })

  it('interactive mode maps to SDK default — Kōbō PreToolUse hook handles defer', () => {
    const { options } = buildClaudeOptions({
      prompt: 'p',
      agentPermissionMode: 'interactive',
      workingDir: '/x',
    })
    expect(options.permissionMode).toBe('default')
    expect(options.allowDangerouslySkipPermissions).toBeUndefined()
  })

  it('does not prepend MCP brief on resume', () => {
    const { effectivePrompt, options } = buildClaudeOptions({
      prompt: 'continue',
      agentPermissionMode: 'bypass',
      workingDir: '/x',
      resumeFromEngineSessionId: 'sess-123',
    })
    expect(effectivePrompt).toBe('continue')
    expect(options.resume).toBe('sess-123')
  })

  it('forwards model and effort', () => {
    const { options } = buildClaudeOptions({
      prompt: 'p',
      agentPermissionMode: 'bypass',
      workingDir: '/x',
      model: 'claude-sonnet-4-5',
      effort: 'high',
    })
    expect(options.model).toBe('claude-sonnet-4-5')
    expect(options.extraArgs).toEqual({ effort: 'high' })
  })

  it('skips model and effort when set to auto', () => {
    const { options } = buildClaudeOptions({
      prompt: 'p',
      agentPermissionMode: 'bypass',
      workingDir: '/x',
      model: 'auto',
      effort: 'auto',
    })
    expect(options.model).toBeUndefined()
    expect(options.extraArgs).toBeUndefined()
  })

  it('passes through mcpServers map', () => {
    const { options } = buildClaudeOptions({
      prompt: 'p',
      agentPermissionMode: 'bypass',
      workingDir: '/x',
      mcpServers: { kobo: { command: 'node', args: ['mcp.js'], env: {} } },
    })
    expect(options.mcpServers).toBeDefined()
    expect(Object.keys(options.mcpServers as Record<string, unknown>)).toContain('kobo')
  })
})
