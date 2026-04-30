import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../server/services/search-service.js', () => ({
  searchEvents: vi.fn(),
}))

import router from '../server/routes/search.js'
import * as searchService from '../server/services/search-service.js'

const app = new Hono()
app.route('/api/search', router)

const fakeResults = [
  {
    workspaceId: 'ws-1',
    workspaceName: 'My Work',
    archived: false,
    type: 'user:message',
    timestamp: '2026-04-17T10:00:00Z',
    snippet: '…some text containing the query…',
  },
]

beforeEach(() => {
  vi.clearAllMocks()
})

describe('GET /api/search', () => {
  it('returns 400 when q is missing', async () => {
    const res = await app.request('/api/search')
    expect(res.status).toBe(400)
  })

  it('returns 400 when q is empty after trim', async () => {
    const res = await app.request('/api/search?q=%20%20%20')
    expect(res.status).toBe(400)
  })

  it('calls searchEvents with trimmed query and defaults', async () => {
    vi.mocked(searchService.searchEvents).mockReturnValue(fakeResults)

    const res = await app.request('/api/search?q=hello')
    expect(res.status).toBe(200)
    expect(searchService.searchEvents).toHaveBeenCalledWith('hello', {
      limit: 50,
      includeArchived: false,
    })
    const body = await res.json()
    expect(body).toEqual(fakeResults)
  })

  it('passes custom limit when provided', async () => {
    vi.mocked(searchService.searchEvents).mockReturnValue([])

    await app.request('/api/search?q=test&limit=10')
    expect(searchService.searchEvents).toHaveBeenCalledWith('test', {
      limit: 10,
      includeArchived: false,
    })
  })

  it('clamps absurd limit values', async () => {
    vi.mocked(searchService.searchEvents).mockReturnValue([])

    await app.request('/api/search?q=test&limit=99999')
    expect(searchService.searchEvents).toHaveBeenCalledWith('test', {
      limit: 200,
      includeArchived: false,
    })
  })

  it('enables includeArchived when query param is "true"', async () => {
    vi.mocked(searchService.searchEvents).mockReturnValue([])

    await app.request('/api/search?q=test&includeArchived=true')
    expect(searchService.searchEvents).toHaveBeenCalledWith('test', {
      limit: 50,
      includeArchived: true,
    })
  })

  it('ignores includeArchived when query param is any other value', async () => {
    vi.mocked(searchService.searchEvents).mockReturnValue([])

    await app.request('/api/search?q=test&includeArchived=yes')
    expect(searchService.searchEvents).toHaveBeenCalledWith('test', {
      limit: 50,
      includeArchived: false,
    })
  })

  it('returns 500 and the error message when the service throws', async () => {
    vi.mocked(searchService.searchEvents).mockImplementation(() => {
      throw new Error('db exploded')
    })

    const res = await app.request('/api/search?q=test')
    expect(res.status).toBe(500)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain('db exploded')
  })
})
