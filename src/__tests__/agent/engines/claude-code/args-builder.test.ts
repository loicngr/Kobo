import { describe, expect, it } from 'vitest'
import { buildClaudeArgs } from '../../../../server/services/agent/engines/claude-code/args-builder.js'

const base = {
  prompt: 'hello',
  permissionMode: 'auto-accept' as const,
  skipPermissions: true,
}

describe('buildClaudeArgs', () => {
  it('builds the minimal arg list with stream-json + verbose + skip-permissions + prompt', () => {
    const { args, effectivePrompt } = buildClaudeArgs(base)
    expect(args).toEqual([
      '--output-format',
      'stream-json',
      '--verbose',
      '--dangerously-skip-permissions',
      '-p',
      'hello',
    ])
    expect(effectivePrompt).toBe('hello')
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

  it('prepends plan-mode instructions when permissionMode is "plan"', () => {
    const { args, effectivePrompt } = buildClaudeArgs({ ...base, permissionMode: 'plan' })
    expect(effectivePrompt).toContain('[PLAN MODE]')
    expect(effectivePrompt.endsWith('\n\nhello')).toBe(true)
    // The -p value must match effectivePrompt (not the original prompt).
    expect(args[args.length - 1]).toBe(effectivePrompt)
  })

  it('adds --resume <id> followed by -p <prompt> when resuming', () => {
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

  it('preserves plan-mode prompt when combined with resume', () => {
    const { args, effectivePrompt } = buildClaudeArgs({
      ...base,
      permissionMode: 'plan',
      resumeFromEngineSessionId: 'sess-xyz',
    })
    expect(effectivePrompt).toContain('[PLAN MODE]')
    expect(args[args.length - 1]).toBe(effectivePrompt)
  })
})
