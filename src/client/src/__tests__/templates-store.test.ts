import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useTemplatesStore } from '../stores/templates'

const fakeTemplate = {
  slug: 'review-quality',
  description: 'Code review',
  content: 'Review {working_branch}',
  createdAt: '2026-04-10T00:00:00.000Z',
  updatedAt: '2026-04-10T00:00:00.000Z',
}

beforeEach(() => {
  setActivePinia(createPinia())
  global.fetch = vi.fn()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useTemplatesStore', () => {
  describe('fetchTemplates()', () => {
    it('populates state on success and sets loaded: true', async () => {
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ templates: [fakeTemplate] }),
      } as Response)
      const store = useTemplatesStore()
      await store.fetchTemplates()
      expect(store.templates).toEqual([fakeTemplate])
      expect(store.loaded).toBe(true)
      expect(store.loading).toBe(false)
    })

    it('leaves loaded: false and logs on network error', async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
      vi.mocked(global.fetch).mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) } as Response)
      const store = useTemplatesStore()
      await store.fetchTemplates()
      expect(store.loaded).toBe(false)
      expect(store.templates).toEqual([])
      expect(spy).toHaveBeenCalled()
      spy.mockRestore()
    })

    it('is a no-op when already loading', async () => {
      const store = useTemplatesStore()
      store.loading = true
      await store.fetchTemplates()
      expect(global.fetch).not.toHaveBeenCalled()
    })
  })

  describe('createTemplate()', () => {
    it('pushes into state on 201', async () => {
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => fakeTemplate,
      } as Response)
      const store = useTemplatesStore()
      const created = await store.createTemplate({
        slug: 'review-quality',
        description: 'Code review',
        content: 'Review {working_branch}',
      })
      expect(created).toEqual(fakeTemplate)
      expect(store.templates).toEqual([fakeTemplate])
    })

    it('throws server error message on 409 and leaves state unchanged', async () => {
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: false,
        status: 409,
        json: async () => ({ error: "Template 'review-quality' already exists" }),
      } as Response)
      const store = useTemplatesStore()
      store.templates = []
      await expect(store.createTemplate({ slug: 'review-quality', description: 'd', content: 'c' })).rejects.toThrow(
        /already exists/,
      )
      expect(store.templates).toEqual([])
    })
  })

  describe('updateTemplate()', () => {
    it('replaces the template in state on 200', async () => {
      const store = useTemplatesStore()
      store.templates = [fakeTemplate]
      const updated = { ...fakeTemplate, content: 'new content' }
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => updated,
      } as Response)
      const result = await store.updateTemplate('review-quality', { content: 'new content' })
      expect(result).toEqual(updated)
      expect(store.templates[0].content).toBe('new content')
    })

    it('throws on 404 and leaves state unchanged', async () => {
      const store = useTemplatesStore()
      store.templates = [fakeTemplate]
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: async () => ({ error: "Template 'unknown' not found" }),
      } as Response)
      await expect(store.updateTemplate('unknown', { content: 'x' })).rejects.toThrow(/not found/)
      expect(store.templates).toEqual([fakeTemplate])
    })
  })

  describe('deleteTemplate()', () => {
    it('removes the template from state on 200', async () => {
      const store = useTemplatesStore()
      store.templates = [fakeTemplate, { ...fakeTemplate, slug: 'other' }]
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true }),
      } as Response)
      await store.deleteTemplate('review-quality')
      expect(store.templates.map((t) => t.slug)).toEqual(['other'])
    })

    it('throws on 404 and leaves state unchanged', async () => {
      const store = useTemplatesStore()
      store.templates = [fakeTemplate]
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: async () => ({ error: "Template 'unknown' not found" }),
      } as Response)
      await expect(store.deleteTemplate('unknown')).rejects.toThrow(/not found/)
      expect(store.templates).toEqual([fakeTemplate])
    })
  })
})
