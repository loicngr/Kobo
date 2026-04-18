import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'

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
      capabilities: { supportsMcp: boolean }
    }>
    const claude = body.find((e) => e.id === 'claude-code')
    expect(claude).toBeDefined()
    expect(claude!.displayName.length).toBeGreaterThan(0)
    expect(claude!.capabilities.supportsMcp).toBe(true)
  })
})
