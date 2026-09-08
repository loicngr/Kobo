import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../server/services/workspace-template-service.js', () => ({
  listWorkspaceTemplates: vi.fn(() => []),
  createWorkspaceTemplate: vi.fn(),
  updateWorkspaceTemplate: vi.fn(),
  deleteWorkspaceTemplate: vi.fn(),
}))

import router from '../server/routes/workspace-templates.js'
import * as service from '../server/services/workspace-template-service.js'

const app = new Hono().route('/api/workspace-templates', router)
const template = {
  id: 't1',
  name: 'Fix',
  createdAt: '2026-01-01',
  updatedAt: '2026-01-01',
  preset: { engine: 'codex' },
}

function json(method: string, url: string, body?: unknown) {
  return app.request(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  })
}

describe('/api/workspace-templates', () => {
  beforeEach(() => vi.clearAllMocks())

  it('GET / lists templates', async () => {
    vi.mocked(service.listWorkspaceTemplates).mockReturnValueOnce([template])
    const res = await app.request('/api/workspace-templates')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ templates: [template] })
  })

  it('POST / creates and answers 201', async () => {
    vi.mocked(service.createWorkspaceTemplate).mockReturnValueOnce(template)
    const res = await json('POST', '/api/workspace-templates', { name: 'Fix', preset: { engine: 'codex' } })
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ template })
    expect(service.createWorkspaceTemplate).toHaveBeenCalledWith({ name: 'Fix', preset: { engine: 'codex' } })
  })

  it('POST / answers 400 on a malformed body or a missing name, without touching the service', async () => {
    expect((await json('POST', '/api/workspace-templates', '{ nope')).status).toBe(400)
    expect((await json('POST', '/api/workspace-templates', { preset: {} })).status).toBe(400)
    expect(service.createWorkspaceTemplate).not.toHaveBeenCalled()
  })

  it.each([
    ['Invalid template name: must be 1 to 80 characters', 400],
    ["Template 'Fix' already exists", 409],
    ['Too many templates: the limit is 100', 422],
    ['EACCES: permission denied', 500],
    ['EEXIST: file already exists, mkdir', 500],
  ])('POST / maps the service error "%s" to %i', async (message, status) => {
    vi.mocked(service.createWorkspaceTemplate).mockImplementationOnce(() => {
      throw new Error(message)
    })
    const res = await json('POST', '/api/workspace-templates', { name: 'Fix', preset: {} })
    expect(res.status).toBe(status)
    expect(await res.json()).toEqual({ error: message })
  })

  it('PUT /:id updates, 404 on an unknown id, 409 on a duplicate name', async () => {
    vi.mocked(service.updateWorkspaceTemplate).mockReturnValueOnce({ ...template, name: 'Renamed' })
    expect((await json('PUT', '/api/workspace-templates/t1', { name: 'Renamed' })).status).toBe(200)
    expect(service.updateWorkspaceTemplate).toHaveBeenCalledWith('t1', { name: 'Renamed' })

    vi.mocked(service.updateWorkspaceTemplate).mockReturnValueOnce(null)
    expect((await json('PUT', '/api/workspace-templates/nope', { name: 'x' })).status).toBe(404)

    vi.mocked(service.updateWorkspaceTemplate).mockImplementationOnce(() => {
      throw new Error("Template 'x' already exists")
    })
    expect((await json('PUT', '/api/workspace-templates/t1', { name: 'x' })).status).toBe(409)
  })

  it('PUT /:id answers 400 on a malformed body, without touching the service', async () => {
    const res = await json('PUT', '/api/workspace-templates/t1', '{ nope')
    expect(res.status).toBe(400)
    expect(service.updateWorkspaceTemplate).not.toHaveBeenCalled()
  })

  it('DELETE /:id answers 204, or 404 when nothing was deleted', async () => {
    vi.mocked(service.deleteWorkspaceTemplate).mockReturnValueOnce(true)
    expect((await app.request('/api/workspace-templates/t1', { method: 'DELETE' })).status).toBe(204)
    vi.mocked(service.deleteWorkspaceTemplate).mockReturnValueOnce(false)
    expect((await app.request('/api/workspace-templates/nope', { method: 'DELETE' })).status).toBe(404)
  })
})
