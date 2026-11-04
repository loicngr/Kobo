import { defineStore } from 'pinia'
import { apiFetchResponse, apiResponseError } from 'src/utils/api'

export interface Sprint {
  id: string
  name: string
  sortOrder: number
  createdAt: string
  updatedAt: string
}

export const ALL_SPRINTS = '__all__'
export const NO_SPRINT = '__none__'
const STORAGE_KEY = 'kobo:active-sprint'

function readActiveSprint() {
  try {
    return sessionStorage.getItem(STORAGE_KEY) || ALL_SPRINTS
  } catch {
    return ALL_SPRINTS
  }
}

export const useSprintStore = defineStore('sprints', {
  state: () => ({
    sprints: [] as Sprint[],
    loaded: false,
    requestVersion: 0,
    active: readActiveSprint(),
  }),
  actions: {
    setActive(id: string) {
      this.active = id
      try {
        sessionStorage.setItem(STORAGE_KEY, id)
      } catch {
        /* storage is optional */
      }
    },
    async fetchSprints() {
      const version = ++this.requestVersion
      this.loaded = false
      const response = await apiFetchResponse('/api/sprints')
      if (!response.ok) throw await apiResponseError(response)
      const data = (await response.json()) as { sprints?: Sprint[] }
      if (!Array.isArray(data.sprints)) throw new Error('Invalid sprint catalogue')
      if (version !== this.requestVersion) return
      this.sprints = data.sprints
      this.loaded = true
    },
    async create(name: string): Promise<Sprint | null> {
      const response = await apiFetchResponse('/api/sprints', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      if (!response.ok) throw await apiResponseError(response)
      const { sprint } = (await response.json()) as { sprint: Sprint }
      if (!this.sprints.some((item) => item.id === sprint.id)) this.sprints.push(sprint)
      await this.fetchSprints().catch((error) => console.error('[sprints]', error))
      return this.sprints.find((item) => item.id === sprint.id) ?? null
    },
    async mutate(path: string, method: string, body?: unknown) {
      const response = await apiFetchResponse(`/api/sprints${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      if (!response.ok) throw await apiResponseError(response)
      await this.fetchSprints()
    },
  },
})
