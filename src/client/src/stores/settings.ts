import { defineStore } from 'pinia'

interface DevServerConfig {
  startCommand: string
  stopCommand: string
}

interface ProjectSettings {
  path: string
  displayName: string
  defaultSourceBranch: string
  defaultModel: string
  dangerouslySkipPermissions: boolean
  prPromptTemplate: string
  gitConventions: string
  setupScript: string
  devServer: DevServerConfig
}

interface GlobalSettings {
  defaultModel: string
  dangerouslySkipPermissions: boolean
  prPromptTemplate: string
  gitConventions: string
  editorCommand: string
  browserNotifications: boolean
  audioNotifications: boolean
  notionStatusProperty: string
  notionInProgressStatus: string
  defaultPermissionMode: string
  notionMcpKey: string
  sentryMcpKey: string
}

interface ActiveMcpServer {
  key: string
  command: string
  args: string[]
}

function toBase64Url(str: string): string {
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export type { DevServerConfig, GlobalSettings, ProjectSettings }

export const useSettingsStore = defineStore('settings', {
  state: () => ({
    global: {
      defaultModel: 'claude-opus-4-7',
      dangerouslySkipPermissions: true,
      prPromptTemplate: '',
      gitConventions: '',
      editorCommand: '',
      browserNotifications: true,
      audioNotifications: true,
      notionStatusProperty: '',
      notionInProgressStatus: '',
      defaultPermissionMode: 'plan',
      notionMcpKey: '',
      sentryMcpKey: '',
    } as GlobalSettings,
    activeMcpServers: [] as ActiveMcpServer[],
    projects: [] as ProjectSettings[],
    loading: false,
    showVerboseSystemMessages: localStorage.getItem('kobo:showVerboseSystemMessages') === 'true',
  }),

  getters: {
    getProjectByPath: (state) => (path: string) => state.projects.find((p) => p.path === path) ?? null,

    projectPaths: (state) => state.projects.map((p) => p.path),
  },

  actions: {
    async fetchSettings() {
      this.loading = true
      try {
        const res = await fetch('/api/settings')
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = await res.json()
        this.global = data.global
        this.projects = data.projects
      } catch (err) {
        console.error('[settings store] fetchSettings failed:', err)
      } finally {
        this.loading = false
      }
    },

    async fetchActiveMcpServers() {
      try {
        const res = await fetch('/api/settings/mcp-servers')
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        this.activeMcpServers = await res.json()
      } catch (err) {
        console.error('[settings store] fetchActiveMcpServers failed:', err)
        this.activeMcpServers = []
      }
    },

    async updateGlobal(data: Partial<GlobalSettings>) {
      try {
        const res = await fetch('/api/settings/global', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const updated = await res.json()
        this.global = updated
      } catch (err) {
        console.error('[settings store] updateGlobal failed:', err)
        throw err
      }
    },

    async upsertProject(projectPath: string, data: Partial<Omit<ProjectSettings, 'path'>>) {
      try {
        const encoded = toBase64Url(projectPath)
        const res = await fetch(`/api/settings/projects/${encoded}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const project = await res.json()
        const idx = this.projects.findIndex((p) => p.path === projectPath)
        if (idx >= 0) {
          this.projects[idx] = project
        } else {
          this.projects.push(project)
        }
      } catch (err) {
        console.error('[settings store] upsertProject failed:', err)
        throw err
      }
    },

    toggleVerboseSystemMessages() {
      this.showVerboseSystemMessages = !this.showVerboseSystemMessages
      localStorage.setItem('kobo:showVerboseSystemMessages', String(this.showVerboseSystemMessages))
    },

    async deleteProject(projectPath: string) {
      try {
        const encoded = toBase64Url(projectPath)
        const res = await fetch(`/api/settings/projects/${encoded}`, { method: 'DELETE' })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        this.projects = this.projects.filter((p) => p.path !== projectPath)
      } catch (err) {
        console.error('[settings store] deleteProject failed:', err)
        throw err
      }
    },
  },
})
