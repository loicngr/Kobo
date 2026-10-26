import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'

describe('GET /api/engines', () => {
  it('returns the registry with capabilities', async () => {
    const { enginesRouter } = await import('../server/routes/engines.js')
    const app = new Hono()
    app.route('/api/engines', enginesRouter)
    const res = await app.request('/api/engines')
    expect(res.status).toBe(200)
    const body = (await res.json()) as Array<{
      id: string
      displayName: string
      capabilities: {
        supportsMcp: boolean
        supportsSkills: boolean
        supportsSubagents: boolean
        supportsQuotaStatus: boolean
        models: Array<{ id: string }>
      }
    }>

    expect(body).toHaveLength(3)
    expect(body.find((engine) => engine.id === 'mistral-vibe')).toMatchObject({
      displayName: 'Mistral Vibe',
      capabilities: { supportsReadOnly: false, supportsLiveSteering: false, supportsMcp: true, supportsResume: true },
    })
    const claude = body.find((e) => e.id === 'claude-code')
    expect(claude).toBeDefined()
    expect(claude!.displayName.length).toBeGreaterThan(0)
    expect(claude!.capabilities.supportsMcp).toBe(true)
    expect(claude!.capabilities.supportsSubagents).toBe(true)
    expect(claude!.capabilities.supportsQuotaStatus).toBe(true)

    const codex = body.find((e) => e.id === 'codex')
    expect(codex).toBeDefined()
    expect(codex!.displayName.length).toBeGreaterThan(0)
    expect(codex!.capabilities.supportsMcp).toBe(true)
    expect(codex!.capabilities.supportsSkills).toBe(false)
    // Migrated from the SDK to the app-server protocol: sub-agent events
    // (collabAgentToolCall), structured rate-limit info, and interactive
    // approvals are all available.
    expect(codex!.capabilities.supportsSubagents).toBe(true)
    expect(codex!.capabilities.supportsQuotaStatus).toBe(true)
    // Codex catalogue must surface the OpenAI model IDs, not Claude ones.
    expect(codex!.capabilities.models.some((m) => m.id === 'gpt-6.1-sol')).toBe(true)
    expect(codex!.capabilities.models.some((m) => m.id.startsWith('claude-'))).toBe(false)
  })
})

it('passes contextual native options through the operator engines route without exposing arbitrary configuration', async () => {
  const service = await import('../server/services/mistral-options-service.js')
  const projection = {
    model: { currentValue: 'alias', options: [{ value: 'alias', name: 'Native model' }] },
    thinking: { currentValue: 'off', options: [{ value: 'off', name: 'Disabled' }] },
  }
  const read = vi.spyOn(service, 'getMistralOptions').mockResolvedValue(projection)
  try {
    const { enginesRouter } = await import('../server/routes/engines.js')
    const app = new Hono().route('/api/engines', enginesRouter)
    const response = await app.request(
      '/api/engines/mistral-vibe/options?workspaceId=workspace&model=alias&agentPermissionMode=strict',
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(projection)
    expect(read).toHaveBeenCalledWith({
      workspaceId: 'workspace',
      projectPath: undefined,
      model: 'alias',
      agentPermissionMode: 'strict',
    })
  } finally {
    read.mockRestore()
  }
})
