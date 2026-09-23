import { defineStore } from 'pinia'

export interface Template {
  slug: string
  description: string
  content: string
  createdAt: string
  updatedAt: string
}

interface TemplatesState {
  templates: Template[]
  defaultSlugs: string[]
  loading: boolean
  loaded: boolean
}

export const useTemplatesStore = defineStore('templates', {
  state: (): TemplatesState => ({
    templates: [],
    defaultSlugs: [],
    loading: false,
    loaded: false,
  }),

  getters: {
    isDefault: (state) => (slug: string) => state.defaultSlugs.includes(slug),
  },

  actions: {
    async fetchTemplates() {
      if (this.loading) return
      this.loading = true
      try {
        const res = await fetch('/api/templates')
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const body = (await res.json()) as { templates: Template[]; defaultSlugs?: string[] }
        this.templates = body.templates
        this.defaultSlugs = body.defaultSlugs ?? []
        this.loaded = true
      } catch (err) {
        console.error('[templates store] fetchTemplates failed:', err)
      } finally {
        this.loading = false
      }
    },

    async createTemplate(input: { slug: string; description: string; content: string }): Promise<Template> {
      const res = await fetch('/api/templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      const template: Template = await res.json()
      this.templates.push(template)
      return template
    },

    async updateTemplate(slug: string, updates: { description?: string; content?: string }): Promise<Template> {
      const res = await fetch(`/api/templates/${encodeURIComponent(slug)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      const updated: Template = await res.json()
      const idx = this.templates.findIndex((t) => t.slug === slug)
      if (idx >= 0) this.templates[idx] = updated
      return updated
    },

    async reloadDefaults(): Promise<{ added: string[]; kept: string[] }> {
      const res = await fetch('/api/templates/reload-defaults', { method: 'POST' })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      const result = (await res.json()) as { added: string[]; kept: string[] }
      if (result.added.length > 0) {
        await this.fetchTemplates()
      }
      return result
    },

    async deleteTemplate(slug: string): Promise<void> {
      const res = await fetch(`/api/templates/${encodeURIComponent(slug)}`, { method: 'DELETE' })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      this.templates = this.templates.filter((t) => t.slug !== slug)
    },

    async resetToDefault(slug: string): Promise<Template> {
      const res = await fetch(`/api/templates/${encodeURIComponent(slug)}/reset-default`, { method: 'POST' })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Reset failed' }))
        throw new Error(err.error ?? 'Reset failed')
      }
      const { template } = (await res.json()) as { template: Template }
      const idx = this.templates.findIndex((t) => t.slug === slug)
      if (idx >= 0) this.templates[idx] = template
      else this.templates.push(template)
      return template
    },
  },
})
