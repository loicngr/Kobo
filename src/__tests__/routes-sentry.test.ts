import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../server/services/sentry-service.js', () => ({
  extractSentryIssue: vi.fn(),
}))

import sentryRouter from '../server/routes/sentry.js'
import * as sentryService from '../server/services/sentry-service.js'

function makeRequest(body: unknown): Request {
  return new Request('http://localhost/extract', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('POST /api/sentry/extract', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 400 when url is missing', async () => {
    const res = await sentryRouter.fetch(makeRequest({}))
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain('Missing required field: url')
  })

  it('returns 200 with the extracted content on success', async () => {
    const fake = {
      issueId: 'X-1',
      issueNumericId: '1',
      title: 'Boom',
      culprit: 'cmd',
      url: 'u',
      platform: 'p',
      firstSeen: '',
      lastSeen: '',
      occurrences: 1,
      tags: {},
      offendingSpans: [],
      extraContext: '',
    }
    vi.mocked(sentryService.extractSentryIssue).mockResolvedValueOnce(fake)
    const res = await sentryRouter.fetch(makeRequest({ url: 'https://sentry.io/issues/1' }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual(fake)
  })

  it('returns 500 when extraction throws', async () => {
    vi.mocked(sentryService.extractSentryIssue).mockRejectedValueOnce(new Error('boom'))
    const res = await sentryRouter.fetch(makeRequest({ url: 'https://sentry.io/issues/1' }))
    expect(res.status).toBe(500)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('boom')
  })
})
