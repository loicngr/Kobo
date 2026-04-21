import { describe, expect, it } from 'vitest'
import { buildClaudeArgs } from '../../../../server/services/agent/engines/claude-code/args-builder.js'

const base = {
  prompt: 'hello',
  permissionMode: 'auto-accept' as const,
  skipPermissions: true,
}

describe('buildClaudeArgs', () => {
  it('builds the minimal arg list with stream-json + verbose + skip-permissions + prompt (MCP brief prepended on new sessions)', () => {
    const { args, effectivePrompt } = buildClaudeArgs(base)
    expect(args.slice(0, 4)).toEqual(['--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions'])
    expect(args[args.length - 2]).toBe('-p')
    expect(args[args.length - 1]).toBe(effectivePrompt)
    expect(effectivePrompt).toContain('[Kōbō MCP]')
    expect(effectivePrompt.endsWith('\n\nhello')).toBe(true)
  })

  it('prepends the Kōbō MCP brief on a new session but NOT on --resume', () => {
    const freshNew = buildClaudeArgs(base).effectivePrompt
    expect(freshNew).toContain('[Kōbō MCP]')
    expect(freshNew).toContain('kobo__list_tasks')

    const resumed = buildClaudeArgs({ ...base, resumeFromEngineSessionId: 'sess-abc' }).effectivePrompt
    expect(resumed).not.toContain('[Kōbō MCP]')
    expect(resumed).toBe('hello')
  })

  it('omits --model when model is "auto"', () => {
    expect(buildClaudeArgs({ ...base, model: 'auto' }).args).not.toContain('--model')
  })

  it('appends --model <id> when model is a specific id', () => {
    const { args } = buildClaudeArgs({ ...base, model: 'claude-sonnet-4-6' })
    expect(args).toContain('--model')
    expect(args[args.indexOf('--model') + 1]).toBe('claude-sonnet-4-6')
  })

  it('omits --effort when effort is "auto"', () => {
    expect(buildClaudeArgs({ ...base, effort: 'auto' }).args).not.toContain('--effort')
  })

  it('appends --effort <level> when effort is a specific level', () => {
    const { args } = buildClaudeArgs({ ...base, effort: 'high' })
    expect(args).toContain('--effort')
    expect(args[args.indexOf('--effort') + 1]).toBe('high')
  })

  it('omits --dangerously-skip-permissions when skipPermissions is false', () => {
    const { args } = buildClaudeArgs({ ...base, skipPermissions: false })
    expect(args).not.toContain('--dangerously-skip-permissions')
  })

  it('passes --permission-mode plan to the CLI when permissionMode is "plan"', () => {
    const { args, effectivePrompt } = buildClaudeArgs({ ...base, permissionMode: 'plan' })
    const idx = args.indexOf('--permission-mode')
    expect(idx).toBeGreaterThan(-1)
    expect(args[idx + 1]).toBe('plan')
    // Plan mode is exclusive with --dangerously-skip-permissions.
    expect(args).not.toContain('--dangerously-skip-permissions')
    // No more [PLAN MODE] textual prepend — Claude CLI owns plan mode natively.
    expect(effectivePrompt).not.toContain('[PLAN MODE]')
  })

  it('adds --resume <id> followed by -p <prompt> when resuming (no MCP brief on resume)', () => {
    const { args } = buildClaudeArgs({ ...base, resumeFromEngineSessionId: 'sess-abc' })
    const i = args.indexOf('--resume')
    expect(i).toBeGreaterThan(-1)
    expect(args[i + 1]).toBe('sess-abc')
    expect(args[i + 2]).toBe('-p')
    expect(args[i + 3]).toBe('hello')
  })

  it('appends --mcp-config <path> when mcpConfigPath is set', () => {
    const { args } = buildClaudeArgs({ ...base, mcpConfigPath: '/tmp/.mcp.json' })
    const i = args.indexOf('--mcp-config')
    expect(i).toBeGreaterThan(-1)
    expect(args[i + 1]).toBe('/tmp/.mcp.json')
  })

  it('combines plan mode with resume correctly (flag + resume + bare prompt, no MCP brief, no [PLAN MODE] text)', () => {
    const { args, effectivePrompt } = buildClaudeArgs({
      ...base,
      permissionMode: 'plan',
      resumeFromEngineSessionId: 'sess-xyz',
    })
    expect(args).toContain('--permission-mode')
    expect(args).toContain('plan')
    expect(effectivePrompt).not.toContain('[PLAN MODE]')
    expect(effectivePrompt).not.toContain('[Kōbō MCP]')
    expect(effectivePrompt).toBe('hello')
    const i = args.indexOf('--resume')
    expect(i).toBeGreaterThan(-1)
    expect(args[i + 1]).toBe('sess-xyz')
  })
})
