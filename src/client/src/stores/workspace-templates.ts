import { defineStore } from 'pinia'
import { apiFetch } from 'src/utils/api'
import type { WorkspacePreset } from 'src/utils/workspace-preset'

export interface WorkspaceTemplate {
  id: string
  name: string
  createdAt: string
  updatedAt: string
  preset: WorkspacePreset
}

export const useWorkspaceTemplatesStore = defineStore('workspace-templates', {
  state: () => ({
    templates: [] as WorkspaceTemplate[],
    loading: false,
    loaded: false,
  }),

  getters: {
    findByName: (state) => (name: string) => {
      const wanted = name.trim().toLowerCase()
      if (!wanted) return undefined
      return state.templates.find((t) => t.name.toLowerCase() === wanted)
    },
  },

  actions: {
    async fetchTemplates(): Promise<void> {
      if (this.loading) return
      this.loading = true
      try {
        const body = await apiFetch<{ templates: WorkspaceTemplate[] }>('/api/workspace-templates')
        this.templates = body.templates
        this.loaded = true
      } catch (err) {
        console.error('[workspace-templates store] fetchTemplates failed:', err)
      } finally {
        this.loading = false
      }
    },

    async createTemplate(input: { name: string; preset: WorkspacePreset }): Promise<WorkspaceTemplate> {
      const { template } = await apiFetch<{ template: WorkspaceTemplate }>('/api/workspace-templates', {
        method: 'POST',
        body: input,
      })
      this.templates.push(template)
      return template
    },

    async updateTemplate(id: string, updates: { name?: string; preset?: WorkspacePreset }): Promise<WorkspaceTemplate> {
      const { template } = await apiFetch<{ template: WorkspaceTemplate }>(
        `/api/workspace-templates/${encodeURIComponent(id)}`,
        { method: 'PUT', body: updates },
      )
      const index = this.templates.findIndex((t) => t.id === id)
      if (index >= 0) this.templates[index] = template
      else this.templates.push(template)
      return template
    },

    async deleteTemplate(id: string): Promise<void> {
      await apiFetch(`/api/workspace-templates/${encodeURIComponent(id)}`, { method: 'DELETE' })
      this.templates = this.templates.filter((t) => t.id !== id)
    },
  },
})
