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
  loading: boolean
  loaded: boolean
}

export const useTemplatesStore = defineStore('templates', {
  state: (): TemplatesState => ({
    templates: [],
    loading: false,
    loaded: false,
  }),

  actions: {
    async fetchTemplates() {
      if (this.loading) return
      this.loading = true
      try {
        const res = await fetch('/api/templates')
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const body = (await res.json()) as { templates: Template[] }
        this.templates = body.templates
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

    async updateTemplate(
      slug: string,
      updates: { description?: string; content?: string },
    ): Promise<Template> {
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

    async deleteTemplate(slug: string): Promise<void> {
      const res = await fetch(`/api/templates/${encodeURIComponent(slug)}`, { method: 'DELETE' })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      this.templates = this.templates.filter((t) => t.slug !== slug)
    },
  },
})
