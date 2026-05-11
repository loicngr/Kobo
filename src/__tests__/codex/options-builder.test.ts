import { describe, expect, it } from 'vitest'
import { buildCodexOptions } from '../../server/services/agent/engines/codex/options-builder.js'

const BASE_INPUT = {
  prompt: 'Do something',
  agentPermissionMode: 'bypass' as const,
  workingDir: '/workspace',
}

// ── Permission mode mapping ───────────────────────────────────────────────────

describe('buildCodexOptions — permission mode mapping', () => {
  it('plan → sandbox: read-only, approvalPolicy: never', () => {
    const { threadParams } = buildCodexOptions({ ...BASE_INPUT, agentPermissionMode: 'plan' })
    expect(threadParams.sandbox).toBe('read-only')
    expect(threadParams.approvalPolicy).toBe('never')
  })

  it('bypass → sandbox: workspace-write, approvalPolicy: never', () => {
    const { threadParams } = buildCodexOptions({ ...BASE_INPUT, agentPermissionMode: 'bypass' })
    expect(threadParams.sandbox).toBe('workspace-write')
    expect(threadParams.approvalPolicy).toBe('never')
  })

  it('strict → sandbox: workspace-write, approvalPolicy: on-request', () => {
    const { threadParams } = buildCodexOptions({ ...BASE_INPUT, agentPermissionMode: 'strict' })
    expect(threadParams.sandbox).toBe('workspace-write')
    expect(threadParams.approvalPolicy).toBe('on-request')
  })

  it('interactive → sandbox: workspace-write, approvalPolicy: unless-trusted', () => {
    const { threadParams } = buildCodexOptions({ ...BASE_INPUT, agentPermissionMode: 'interactive' })
    expect(threadParams.sandbox).toBe('workspace-write')
    expect(threadParams.approvalPolicy).toBe('unless-trusted')
  })
})

// ── Model passthrough ─────────────────────────────────────────────────────────

describe('buildCodexOptions — model', () => {
  it('model "auto" is omitted from threadParams', () => {
    const { threadParams } = buildCodexOptions({ ...BASE_INPUT, model: 'auto' })
    expect(threadParams.model).toBeUndefined()
  })

  it('model undefined is omitted from threadParams', () => {
    const { threadParams } = buildCodexOptions({ ...BASE_INPUT })
    expect(threadParams.model).toBeUndefined()
  })

  it('non-auto model is passed through to threadParams', () => {
    const { threadParams } = buildCodexOptions({ ...BASE_INPUT, model: 'gpt-5.4' })
    expect(threadParams.model).toBe('gpt-5.4')
  })
})

// ── Effort passthrough ────────────────────────────────────────────────────────

describe('buildCodexOptions — effort', () => {
  it('effort "auto" is omitted from threadParams', () => {
    const { threadParams } = buildCodexOptions({ ...BASE_INPUT, effort: 'auto' })
    expect(threadParams.modelReasoningEffort).toBeUndefined()
  })

  it('effort undefined is omitted from threadParams', () => {
    const { threadParams } = buildCodexOptions({ ...BASE_INPUT })
    expect(threadParams.modelReasoningEffort).toBeUndefined()
  })

  it('non-auto effort is passed through to threadParams', () => {
    const { threadParams } = buildCodexOptions({ ...BASE_INPUT, effort: 'high' })
    expect(threadParams.modelReasoningEffort).toBe('high')
  })
})

// ── MCP servers ───────────────────────────────────────────────────────────────

describe('buildCodexOptions — MCP servers', () => {
  it('flattens mcpServers into config.mcp_servers with default_tools_approval_mode: auto', () => {
    const { threadParams } = buildCodexOptions({
      ...BASE_INPUT,
      mcpServers: [{ name: 'kobo-tasks', command: 'node', args: ['/path/to/server.js'], env: { KEY: 'VALUE' } }],
    })
    expect(threadParams.config).toBeDefined()
    const config = threadParams.config as { mcp_servers: Record<string, unknown> }
    expect(config.mcp_servers['kobo-tasks']).toEqual({
      command: 'node',
      args: ['/path/to/server.js'],
      env: { KEY: 'VALUE' },
      default_tools_approval_mode: 'auto',
    })
  })

  it('passes server name verbatim (including hyphens)', () => {
    const { threadParams } = buildCodexOptions({
      ...BASE_INPUT,
      mcpServers: [{ name: 'my-server', command: 'npx', args: [], env: {} }],
    })
    const config = threadParams.config as { mcp_servers: Record<string, unknown> }
    expect(config.mcp_servers['my-server']).toBeDefined()
  })

  it('does not set config when mcpServers is empty', () => {
    const { threadParams } = buildCodexOptions({ ...BASE_INPUT, mcpServers: [] })
    expect(threadParams.config).toBeUndefined()
  })

  it('does not set config when mcpServers is undefined', () => {
    const { threadParams } = buildCodexOptions({ ...BASE_INPUT })
    expect(threadParams.config).toBeUndefined()
  })
})

// ── Brief prepend ─────────────────────────────────────────────────────────────

describe('buildCodexOptions — brief prepend', () => {
  it('prepends the Kōbō MCP brief on fresh runs (no resumeFromEngineSessionId)', () => {
    const { input } = buildCodexOptions({ ...BASE_INPUT, prompt: 'My prompt' })
    expect(input).toHaveLength(1)
    expect(input[0].type).toBe('text')
    const text = (input[0] as { type: 'text'; text: string }).text
    expect(text).toContain('[Kōbō MCP]')
    expect(text).toContain('My prompt')
    expect(text.indexOf('[Kōbō MCP]')).toBeLessThan(text.indexOf('My prompt'))
  })

  it('does NOT prepend the brief when resumeFromEngineSessionId is set', () => {
    const { input } = buildCodexOptions({
      ...BASE_INPUT,
      prompt: 'Resumed prompt',
      resumeFromEngineSessionId: 'thr_existing',
    })
    const text = (input[0] as { type: 'text'; text: string }).text
    expect(text).not.toContain('[Kōbō MCP]')
    expect(text).toBe('Resumed prompt')
  })
})

// ── Required fields ───────────────────────────────────────────────────────────

describe('buildCodexOptions — required fields', () => {
  it('always sets experimentalRawEvents to false', () => {
    const { threadParams } = buildCodexOptions({ ...BASE_INPUT })
    expect(threadParams.experimentalRawEvents).toBe(false)
  })

  it('always sets persistExtendedHistory to false', () => {
    const { threadParams } = buildCodexOptions({ ...BASE_INPUT })
    expect(threadParams.persistExtendedHistory).toBe(false)
  })

  it('returns isResume=false for fresh runs', () => {
    const { isResume } = buildCodexOptions({ ...BASE_INPUT })
    expect(isResume).toBe(false)
  })

  it('returns isResume=true when resumeFromEngineSessionId is set', () => {
    const { isResume } = buildCodexOptions({ ...BASE_INPUT, resumeFromEngineSessionId: 'thr_x' })
    expect(isResume).toBe(true)
  })
})

// ── CollaborationMode (Codex internal mode, separate from sandbox) ────────────

describe('buildCodexOptions — collaborationMode', () => {
  it('sets collaborationMode { mode: "plan" } when Kōbō permission mode is "plan"', () => {
    const result = buildCodexOptions({ ...BASE_INPUT, agentPermissionMode: 'plan' })
    expect(result.collaborationMode.mode).toBe('plan')
    // The settings field must echo model/effort because collaborationMode
    // "takes precedence over model, reasoning_effort, and developer instructions if set".
    expect(result.collaborationMode.settings.developer_instructions).toBeNull()
  })

  it('echoes the resolved model into collaborationMode.settings.model when plan + non-auto model', () => {
    const result = buildCodexOptions({ ...BASE_INPUT, agentPermissionMode: 'plan', model: 'gpt-5.4' })
    expect(result.collaborationMode.settings.model).toBe('gpt-5.4')
  })

  it('echoes the resolved effort into collaborationMode.settings.reasoning_effort when plan + non-auto effort', () => {
    const result = buildCodexOptions({ ...BASE_INPUT, agentPermissionMode: 'plan', effort: 'high' })
    expect(result.collaborationMode.settings.reasoning_effort).toBe('high')
  })

  it.each([
    'bypass',
    'strict',
    'interactive',
  ] as const)('forces collaborationMode { mode: "default" } when Kōbō permission mode is %s (sticky reset)', (mode) => {
    // CollaborationMode is sticky server-side: after a `plan` turn, every
    // subsequent turn stays in plan unless we explicitly send `default`.
    // We therefore always emit the field, never null.
    const result = buildCodexOptions({ ...BASE_INPUT, agentPermissionMode: mode })
    expect(result.collaborationMode.mode).toBe('default')
  })

  it('echoes model/effort in non-plan modes as well (so the override does not blank them)', () => {
    const result = buildCodexOptions({
      ...BASE_INPUT,
      agentPermissionMode: 'bypass',
      model: 'gpt-5.4',
      effort: 'high',
    })
    expect(result.collaborationMode.mode).toBe('default')
    expect(result.collaborationMode.settings.model).toBe('gpt-5.4')
    expect(result.collaborationMode.settings.reasoning_effort).toBe('high')
  })
})
