import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../server/services/content-migration-service.js', () => ({
  getContentMigrationStatus: vi.fn(() => ({ state: 'idle', total: 0, processed: 0 })),
}))

describe('migrationGuard', () => {
  it('passes through when migration state is idle or done', async () => {
    const { migrationGuard } = await import('../server/middleware/migration-guard.js')
    const app = new Hono()
    app.use('*', migrationGuard)
    app.post('/mut', (c) => c.json({ ok: true }))
    const res = await app.request('/mut', { method: 'POST' })
    expect(res.status).toBe(200)
  })

  it('returns 503 when migration is running', async () => {
    const mod = await import('../server/services/content-migration-service.js')
    vi.mocked(mod.getContentMigrationStatus).mockReturnValue({ state: 'running', total: 10, processed: 5 })
    const { migrationGuard } = await import('../server/middleware/migration-guard.js')
    const app = new Hono()
    app.use('*', migrationGuard)
    app.post('/mut', (c) => c.json({ ok: true }))
    const res = await app.request('/mut', { method: 'POST' })
    expect(res.status).toBe(503)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('migration-in-progress')
  })

  it('returns 503 when state is backing-up or error', async () => {
    const mod = await import('../server/services/content-migration-service.js')
    for (const state of ['backing-up', 'error'] as const) {
      vi.mocked(mod.getContentMigrationStatus).mockReturnValue({ state, total: 0, processed: 0 })
      const { migrationGuard } = await import('../server/middleware/migration-guard.js')
      const app = new Hono()
      app.use('*', migrationGuard)
      app.post('/mut', (c) => c.json({ ok: true }))
      const res = await app.request('/mut', { method: 'POST' })
      expect(res.status).toBe(503)
    }
  })
})

describe('GET /api/migration/status', () => {
  it('returns the current status', async () => {
    const mod = await import('../server/services/content-migration-service.js')
    vi.mocked(mod.getContentMigrationStatus).mockReturnValue({
      state: 'running',
      total: 100,
      processed: 42,
      startedAt: '2026-04-18T00:00:00Z',
    })
    const { migrationRouter } = await import('../server/routes/migration.js')
    const app = new Hono()
    app.route('/api/migration', migrationRouter)
    const res = await app.request('/api/migration/status')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { state: string; processed: number }
    expect(body.state).toBe('running')
    expect(body.processed).toBe(42)
  })
})
