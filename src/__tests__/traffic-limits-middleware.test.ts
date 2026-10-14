import { Hono } from 'hono'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@hono/node-server/conninfo', () => ({ getConnInfo: () => ({ remote: { address: '127.0.0.1' } }) }))

import { requestBodyLimitsMiddleware, trafficLimitsMiddleware } from '../server/middleware/traffic-limits-middleware.js'

afterEach(() => vi.useRealTimers())

describe('traffic limits', () => {
  it('rate-limits login attempts and permits retries after the fixed window', async () => {
    vi.useFakeTimers()
    const app = new Hono()
      .use('*', trafficLimitsMiddleware())
      .post('/api/auth/session', (c) => c.json({ error: 'unauthorized' }, 401))
    for (let i = 0; i < 20; i++) expect((await app.request('/api/auth/session', { method: 'POST' })).status).toBe(401)
    const blocked = await app.request('/api/auth/session', { method: 'POST' })
    expect(blocked.status).toBe(429)
    expect(blocked.headers.get('Retry-After')).toBe('60')
    vi.advanceTimersByTime(60_001)
    expect((await app.request('/api/auth/session', { method: 'POST' })).status).toBe(401)
  })

  it('does not consume unauthenticated bodies before the auth gate', async () => {
    let consumed: boolean | undefined
    const app = new Hono()
    app.use('*', trafficLimitsMiddleware())
    app.use('*', async (c) => {
      consumed = c.req.raw.bodyUsed
      return c.json({ error: 'unauthorized' }, 401)
    })
    app.use('*', requestBodyLimitsMiddleware())
    const response = await app.request('/api/workspaces', { method: 'POST', body: 'x'.repeat(2 * 1024 * 1024) })
    expect(response.status).toBe(401)
    expect(consumed).toBe(false)
  })

  it('keeps ordinary authenticated requests under 1 MiB', async () => {
    const app = new Hono()
      .use('*', requestBodyLimitsMiddleware())
      .post('/api/settings/global', (c) => c.json({ ok: true }))
    expect(
      (await app.request('/api/settings/global', { method: 'POST', body: 'x'.repeat(1024 * 1024 + 1) })).status,
    ).toBe(413)
  })

  it('bounds concurrent MCP requests and releases the slot after completion', async () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let entered!: () => void
    const ready = new Promise<void>((resolve) => {
      entered = resolve
    })
    let count = 0
    const app = new Hono().use('*', trafficLimitsMiddleware()).post('/api/mcp', async (c) => {
      if (++count === 32) entered()
      await held
      return c.json({ ok: true })
    })
    const pending = Array.from({ length: 32 }, () => app.request('/api/mcp', { method: 'POST' }))
    await ready
    expect((await app.request('/api/mcp', { method: 'POST' })).status).toBe(429)
    release()
    await Promise.all(pending)
    expect((await app.request('/api/mcp', { method: 'POST' })).status).toBe(200)
  })

  it.each([undefined, String(1024 * 1024 + 1)])(
    'reserves at most four large/unknown body slots (%s) while ordinary MCP calls continue',
    async (contentLength) => {
      let release!: () => void
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      let entered!: () => void
      const ready = new Promise<void>((resolve) => {
        entered = resolve
      })
      let count = 0
      const app = new Hono().use('*', trafficLimitsMiddleware()).post('/api/mcp', async (c) => {
        if (!c.req.raw.body) return c.json({ ok: true })
        if (++count === 4) entered()
        await held
        return c.json({ ok: true })
      })
      const request = () =>
        app.request('/api/mcp', {
          method: 'POST',
          body: 'x'.repeat(1024 * 1024 + 1),
          ...(contentLength ? { headers: { 'Content-Length': contentLength } } : {}),
        })
      const pending = Array.from({ length: 4 }, request)
      await ready
      expect((await request()).status).toBe(429)
      expect((await app.request('/api/mcp', { method: 'POST' })).status).toBe(200)
      release()
      await Promise.all(pending)
      expect((await request()).status).toBe(200)
    },
  )
})
