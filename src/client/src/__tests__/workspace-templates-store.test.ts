import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useWorkspaceTemplatesStore } from '../stores/workspace-templates'

const template = {
  id: 't1',
  name: 'Fix',
  createdAt: '2026-01-01',
  updatedAt: '2026-01-01',
  preset: { engine: 'codex' },
}

function respond(status: number, body: unknown) {
  return {
    ok: status < 400,
    status,
    text: async () => JSON.stringify(body),
  } as unknown as Response
}

describe('workspace templates store', () => {
  beforeEach(() => setActivePinia(createPinia()))
  afterEach(() => vi.unstubAllGlobals())

  it('fetches and exposes the list', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respond(200, { templates: [template] })))
    const store = useWorkspaceTemplatesStore()
    await store.fetchTemplates()
    expect(store.templates).toEqual([template])
    expect(store.loaded).toBe(true)
  })

  it('creates and appends', async () => {
    const fetchMock = vi.fn().mockResolvedValue(respond(201, { template }))
    vi.stubGlobal('fetch', fetchMock)
    const store = useWorkspaceTemplatesStore()
    await store.createTemplate({ name: 'Fix', preset: { engine: 'codex' } })
    expect(store.templates).toEqual([template])

    expect(fetchMock).toHaveBeenCalledWith('/api/workspace-templates', expect.objectContaining({ method: 'POST' }))
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toEqual({ name: 'Fix', preset: { engine: 'codex' } })
  })

  it('surfaces the server error message, with the status on the error, so a 409 can be told apart', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respond(409, { error: "Template 'Fix' already exists" })))
    const store = useWorkspaceTemplatesStore()
    await expect(store.createTemplate({ name: 'Fix', preset: {} })).rejects.toMatchObject({
      message: "Template 'Fix' already exists",
      status: 409,
    })
  })

  it('updates in place and deletes', async () => {
    const store = useWorkspaceTemplatesStore()
    store.templates = [template]

    const updateFetch = vi.fn().mockResolvedValue(respond(200, { template: { ...template, name: 'Renamed' } }))
    vi.stubGlobal('fetch', updateFetch)
    await store.updateTemplate('t1', { name: 'Renamed' })
    expect(store.templates[0]?.name).toBe('Renamed')
    expect(updateFetch).toHaveBeenCalledWith('/api/workspace-templates/t1', expect.objectContaining({ method: 'PUT' }))

    const deleteFetch = vi.fn().mockResolvedValue({ ok: true, status: 204 } as Response)
    vi.stubGlobal('fetch', deleteFetch)
    await store.deleteTemplate('t1')
    expect(store.templates).toEqual([])
    expect(deleteFetch).toHaveBeenCalledWith(
      '/api/workspace-templates/t1',
      expect.objectContaining({ method: 'DELETE' }),
    )
  })

  it('pushes the template when updating an id not currently in the list', async () => {
    const store = useWorkspaceTemplatesStore()
    store.templates = []
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respond(200, { template })))
    await store.updateTemplate('t1', { name: 'Fix' })
    expect(store.templates).toEqual([template])
  })

  it('finds a template by name, case-insensitively', () => {
    const store = useWorkspaceTemplatesStore()
    store.templates = [template]
    expect(store.findByName(' fix ')?.id).toBe('t1')
    expect(store.findByName('other')).toBeUndefined()
  })

  it('returns undefined for a blank name rather than matching everything', () => {
    const store = useWorkspaceTemplatesStore()
    store.templates = [template]
    expect(store.findByName('')).toBeUndefined()
    expect(store.findByName('   ')).toBeUndefined()
  })
})
