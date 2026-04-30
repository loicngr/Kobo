import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../server/services/usage/poller.js', () => ({
  refreshNow: vi.fn(),
}))

import app from '../server/routes/usage.js'
import { refreshNow } from '../server/services/usage/poller.js'

const baseUrl = 'http://localhost'

describe('POST /api/usage/:providerId/refresh', () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(() => vi.restoreAllMocks())

  it('returns 200 + snapshot on a known provider with status ok', async () => {
    vi.mocked(refreshNow).mockResolvedValueOnce({
      providerId: 'claude-code',
      status: 'ok',
      buckets: [],
      fetchedAt: '2026-04-29T14:30:00Z',
    })
    const res = await app.request(`${baseUrl}/claude-code/refresh`, { method: 'POST' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { snapshot: { status: string } }
    expect(body.snapshot.status).toBe('ok')
  })

  it('returns 200 + snapshot when the provider returned status unauthenticated', async () => {
    vi.mocked(refreshNow).mockResolvedValueOnce({
      providerId: 'claude-code',
      status: 'unauthenticated',
      buckets: [],
      fetchedAt: '2026-04-29T14:30:00Z',
    })
    const res = await app.request(`${baseUrl}/claude-code/refresh`, { method: 'POST' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { snapshot: { status: string } }
    expect(body.snapshot.status).toBe('unauthenticated')
  })

  it('returns 404 when refreshNow returns null (unknown provider id)', async () => {
    vi.mocked(refreshNow).mockResolvedValueOnce(null)
    const res = await app.request(`${baseUrl}/codex/refresh`, { method: 'POST' })
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/codex/i)
  })

  it('returns 500 + error body when refreshNow throws unexpectedly', async () => {
    vi.mocked(refreshNow).mockRejectedValueOnce(new Error('boom'))
    const res = await app.request(`${baseUrl}/claude-code/refresh`, { method: 'POST' })
    expect(res.status).toBe(500)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('boom')
  })
})
