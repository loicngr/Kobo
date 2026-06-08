import { defineStore } from 'pinia'
import type { ProjectColor } from 'src/utils/project-color'
import { WORKTREES_PATH } from '../../../shared/consts'
import type { SkillSuite } from '../../../shared/skill-suite-prompts'

interface DevServerConfig {
  startCommand: string
  stopCommand: string
}

interface E2eSettings {
  framework: 'cypress' | 'playwright' | 'jest' | 'vitest' | 'other' | ''
  skill: string
  prompt: string
}

interface FinalizationSettings {
  prompt: string
}

interface ProjectSettings {
  path: string
  displayName: string
  defaultSourceBranch: string
  defaultModel: string
  /** @deprecated Read-only legacy field. Use `agentPermissionMode` instead. */
  dangerouslySkipPermissions: boolean
  /** Per-project override of the global `defaultAgentPermissionMode`. */
  agentPermissionMode?: 'plan' | 'bypass' | 'strict' | 'interactive'
  prPromptTemplate: string
  reviewPromptTemplate: string
  ciFixPromptTemplate: string
  notionInitialPromptTemplate: string
  sentryInitialPromptTemplate: string
  gitConventions: string
  setupScript: string
  /**
   * Custom prompt auto-injected into the task-description textarea on the
   * workspace creation page when this project is selected.
   */
  taskPromptTemplate: string
  /** Per-project override of the global cleanup script. Empty = inherit global. */
  cleanupScript: string
  /** Per-project override of the cleanup trigger mode. Empty = inherit global. */
  cleanupScriptMode: '' | 'idle' | 'no-tasks'
  /** Per-project override of the global archive script. Empty = inherit global. */
  archiveScript: string
  /** Per-project override of the global change-source-branch script. Empty = inherit global. */
  changeSourceBranchScript: string
  devServer: DevServerConfig
  e2e: E2eSettings
  finalization: FinalizationSettings
  color: ProjectColor | null
  /** Which forge provides PR/MR features for this project. `auto` = auto-detect. */
  forge?: 'auto' | 'github' | 'gitlab' | 'none'
}

interface GlobalSettings {
  /**
   * Default model id per engine. Keys are engine ids (e.g. `'claude-code'`,
   * `'codex'`), values are model ids from that engine's catalogue (or `'auto'`).
   * Replaces the legacy single-string `defaultModel` since v19.
   */
  defaultModelByEngine: Record<string, string>
  /** @deprecated Read-only legacy field. Use `defaultAgentPermissionMode`. */
  dangerouslySkipPermissions: boolean
  prPromptTemplate: string
  reviewPromptTemplate: string
  ciFixPromptTemplate: string
  notionInitialPromptTemplate: string
  sentryInitialPromptTemplate: string
  gitConventions: string
  /** Shell script run in a worktree after it is created (empty = disabled). */
  setupScript: string
  /** Shell script run after a session completes (empty = disabled). */
  cleanupScript: string
  /** When the cleanup script fires: every session, or only when no task remains. */
  cleanupScriptMode: 'idle' | 'no-tasks'
  /** When true, the cleanup script runs only if the worktree has uncommitted changes. */
  cleanupScriptOnlyOnChanges: boolean
  /** Shell script run server-side when a workspace is archived (empty = disabled). */
  archiveScript: string
  /** Shell script run in place of the built-in cherry-pick when the source branch changes (empty = disabled). */
  changeSourceBranchScript: string
  editorCommand: string
  /**
   * Shell command spawned with the worktree path as first arg to open it in
   * the user's file manager (xdg-open, open, nautilus, dolphin, explorer…).
   * Empty disables the "Open in file manager" button.
   */
  fileManagerCommand: string
  terminalCommand: string
  /** Opt-in: pr-watcher auto-purges the worktree on PR-merged transition. */
  autoPurgeOnPrMerged: boolean
  browserNotifications: boolean
  audioNotifications: boolean
  audioNotificationSound: string
  audioNotificationVolume: number
  notionStatusProperty: string
  notionInProgressStatus: string
  notionAssigneeProperty: string
  notionUserId: string
  /**
   * Default permission mode per engine, applied at workspace creation when the
   * user doesn't pick one explicitly. Codex's entry must be a mode it supports
   * (no `'interactive'` — see backend `defaultPermissionModeByEngine`).
   * Replaces the legacy single-string `defaultPermissionMode` since v20.
   */
  defaultPermissionModeByEngine: Record<string, string>
  notionMcpKey: string
  sentryMcpKey: string
  tags: string[]
  /**
   * User-managed git branch prefixes for the workspace creation page. Stored
   * without the trailing `/`; the first entry is the default pre-selection.
   */
  branchPrefixes: string[]
  worktreesPath: string
  worktreesPrefixByProject: boolean
  voiceEnabled: boolean
  voicePttKey: 'alt' | 'ctrl+space'
  voiceLanguage: string
  voiceModel: string | null
  voiceCommandPath: string
  voiceFfmpegPath: string
  voiceTemperature: number
  voicePrompt: string
  voiceTranslateToEnglish: boolean
  voiceSuppressNonSpeechTokens: boolean
  flattenWorkspaceList: boolean
  skillSuite: SkillSuite
  customReviewTemplate: string
  customAutoLoopReviewGate: string
  customAutoLoopGroomingIntro: string
  customQaPromptTemplate: string
  customBrainstormingInstruction: string
}

export interface VoiceModelDownloadProgress {
  downloaded: number
  total: number
  startedAt: number
}

export interface VoiceModelStatus {
  name: string
  installed: boolean
  fileName: string
  sizeBytes: number
  installedSizeBytes?: number
  filePath: string
  download?: VoiceModelDownloadProgress
}

export interface VoiceRuntimeStatus {
  available: boolean
  command: string
  error?: string
  ffmpegAvailable: boolean
  ffmpegError?: string
}

interface ActiveMcpServer {
  key: string
  command: string
  args: string[]
}

function toBase64Url(str: string): string {
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export type { DevServerConfig, E2eSettings, GlobalSettings, ProjectSettings }

export const useSettingsStore = defineStore('settings', {
  state: () => ({
    global: {
      defaultModelByEngine: { 'claude-code': 'auto', codex: 'auto' } as Record<string, string>,
      dangerouslySkipPermissions: true,
      prPromptTemplate: '',
      reviewPromptTemplate: '',
      ciFixPromptTemplate: '',
      notionInitialPromptTemplate: '',
      sentryInitialPromptTemplate: '',
      gitConventions: '',
      editorCommand: '',
      fileManagerCommand: '',
      terminalCommand: '',
      autoPurgeOnPrMerged: false,
      browserNotifications: true,
      audioNotifications: true,
      audioNotificationSound: 'hey.mp3',
      audioNotificationVolume: 1,
      notionStatusProperty: '',
      notionInProgressStatus: '',
      notionAssigneeProperty: '',
      notionUserId: '',
      defaultPermissionModeByEngine: { 'claude-code': 'plan', codex: 'plan' } as Record<string, string>,
      notionMcpKey: '',
      sentryMcpKey: '',
      tags: [],
      branchPrefixes: [],
      setupScript: '',
      cleanupScript: '',
      cleanupScriptMode: 'no-tasks',
      cleanupScriptOnlyOnChanges: false,
      archiveScript: '',
      changeSourceBranchScript: '',
      worktreesPath: WORKTREES_PATH,
      worktreesPrefixByProject: false,
      voiceEnabled: false,
      voicePttKey: 'alt',
      voiceLanguage: 'auto',
      voiceModel: null,
      voiceCommandPath: '',
      voiceFfmpegPath: '',
      voiceTemperature: 0,
      voicePrompt: '',
      voiceTranslateToEnglish: false,
      voiceSuppressNonSpeechTokens: true,
      flattenWorkspaceList: false,
      skillSuite: 'superpowers' as SkillSuite,
      customReviewTemplate: '',
      customAutoLoopReviewGate: '',
      customAutoLoopGroomingIntro: '',
      customQaPromptTemplate: '',
      customBrainstormingInstruction: '',
    } as GlobalSettings,
    voiceModels: [] as VoiceModelStatus[],
    voiceModelsLoading: false,
    voiceModelsDir: '' as string,
    voiceRuntime: null as VoiceRuntimeStatus | null,
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

    async fetchGlobalDefaults(): Promise<{
      prPromptTemplate: string
      reviewPromptTemplate: string
      ciFixPromptTemplate: string
      gitConventions: string
      notionInitialPromptTemplate: string
      sentryInitialPromptTemplate: string
      changeSourceBranchScript: string
    }> {
      const res = await fetch('/api/settings/defaults')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json()
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

    async fetchVoiceModels() {
      this.voiceModelsLoading = true
      try {
        const res = await fetch('/api/voice/models')
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = (await res.json()) as {
          modelsDir: string
          available: VoiceModelStatus[]
          activeModel: string | null
        }
        this.voiceModels = data.available
        this.voiceModelsDir = data.modelsDir
        this.global.voiceModel = data.activeModel
      } catch (err) {
        console.error('[settings store] fetchVoiceModels failed:', err)
      } finally {
        this.voiceModelsLoading = false
      }
    },

    async cancelVoiceModelDownload(name: string) {
      const res = await fetch(`/api/voice/models/${encodeURIComponent(name)}/download`, { method: 'DELETE' })
      if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`)
      await this.fetchVoiceModels()
    },

    async fetchVoiceRuntime() {
      try {
        const res = await fetch('/api/voice/runtime')
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        this.voiceRuntime = (await res.json()) as VoiceRuntimeStatus
      } catch (err) {
        console.error('[settings store] fetchVoiceRuntime failed:', err)
      }
    },

    async downloadVoiceModel(name: string) {
      const res = await fetch(`/api/voice/models/${encodeURIComponent(name)}/download`, { method: 'POST' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      await this.fetchVoiceModels()
    },

    async deleteVoiceModel(name: string) {
      const res = await fetch(`/api/voice/models/${encodeURIComponent(name)}`, { method: 'DELETE' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      await this.fetchVoiceModels()
    },
  },
})
