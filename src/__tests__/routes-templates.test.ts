import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mock the service layer so we can assert on route wiring without hitting disk
vi.mock('../server/services/templates-service.js', () => ({
  listTemplates: vi.fn(),
  createTemplate: vi.fn(),
  updateTemplate: vi.fn(),
  deleteTemplate: vi.fn(),
}))

import * as templatesService from '../server/services/templates-service.js'
import templatesRouter from '../server/routes/templates.js'

const app = new Hono()
app.route('/api/templates', templatesRouter)

const fakeTemplate = {
  slug: 'review-quality',
  description: 'Code review',
  content: 'Review {working_branch}',
  createdAt: '2026-04-10T00:00:00.000Z',
  updatedAt: '2026-04-10T00:00:00.000Z',
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('GET /api/templates', () => {
  it('returns the list of templates', async () => {
    vi.mocked(templatesService.listTemplates).mockReturnValue([fakeTemplate])
    const res = await app.request('/api/templates')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.templates).toEqual([fakeTemplate])
  })

  it('returns 500 on unexpected service error', async () => {
    vi.mocked(templatesService.listTemplates).mockImplementation(() => {
      throw new Error('disk exploded')
    })
    const res = await app.request('/api/templates')
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toContain('disk exploded')
  })
})

describe('POST /api/templates', () => {
  it('creates a template and returns 201', async () => {
    vi.mocked(templatesService.createTemplate).mockReturnValue(fakeTemplate)
    const res = await app.request('/api/templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: 'review-quality', description: 'Code review', content: 'Review {working_branch}' }),
    })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.slug).toBe('review-quality')
    expect(templatesService.createTemplate).toHaveBeenCalledWith({
      slug: 'review-quality',
      description: 'Code review',
      content: 'Review {working_branch}',
    })
  })

  it('returns 400 when a required field is missing', async () => {
    const res = await app.request('/api/templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: 'only-slug' }),
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/required/i)
    expect(templatesService.createTemplate).not.toHaveBeenCalled()
  })

  it('returns 400 on validation error from the service', async () => {
    vi.mocked(templatesService.createTemplate).mockImplementation(() => {
      throw new Error('Invalid slug: must match ...')
    })
    const res = await app.request('/api/templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: 'Bad Slug', description: 'd', content: 'c' }),
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('Invalid slug')
  })

  it('returns 409 on duplicate slug', async () => {
    vi.mocked(templatesService.createTemplate).mockImplementation(() => {
      throw new Error("Template 'review-quality' already exists")
    })
    const res = await app.request('/api/templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: 'review-quality', description: 'd', content: 'c' }),
    })
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error).toContain('already exists')
  })

  it('returns 500 on an unexpected I/O error from the service', async () => {
    vi.mocked(templatesService.createTemplate).mockImplementation(() => {
      throw new Error('ENOSPC: no space left on device')
    })
    const res = await app.request('/api/templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: 'ok-slug', description: 'd', content: 'c' }),
    })
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toContain('ENOSPC')
  })
})

describe('PATCH /api/templates/:slug', () => {
  it('updates a template and returns 200', async () => {
    const updated = { ...fakeTemplate, content: 'new content' }
    vi.mocked(templatesService.updateTemplate).mockReturnValue(updated)
    const res = await app.request('/api/templates/review-quality', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'new content' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.content).toBe('new content')
    expect(templatesService.updateTemplate).toHaveBeenCalledWith('review-quality', { content: 'new content' })
  })

  it('returns 404 when not found', async () => {
    vi.mocked(templatesService.updateTemplate).mockReturnValue(null)
    const res = await app.request('/api/templates/unknown', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'x' }),
    })
    expect(res.status).toBe(404)
  })

  it('returns 400 on validation error', async () => {
    vi.mocked(templatesService.updateTemplate).mockImplementation(() => {
      throw new Error('Invalid content: must be 1..4096 chars')
    })
    const res = await app.request('/api/templates/review-quality', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '' }),
    })
    expect(res.status).toBe(400)
  })

  it('returns 500 on an unexpected I/O error from the service', async () => {
    vi.mocked(templatesService.updateTemplate).mockImplementation(() => {
      throw new Error('EACCES: permission denied')
    })
    const res = await app.request('/api/templates/review-quality', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'new' }),
    })
    expect(res.status).toBe(500)
  })
})

describe('DELETE /api/templates/:slug', () => {
  it('deletes a template and returns 200', async () => {
    vi.mocked(templatesService.deleteTemplate).mockReturnValue(true)
    const res = await app.request('/api/templates/review-quality', { method: 'DELETE' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
  })

  it('returns 404 when not found', async () => {
    vi.mocked(templatesService.deleteTemplate).mockReturnValue(false)
    const res = await app.request('/api/templates/unknown', { method: 'DELETE' })
    expect(res.status).toBe(404)
  })
})
