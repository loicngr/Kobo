import { defineStore } from 'pinia'
import { ApiError, apiFetch } from 'src/utils/api'
import { DEFAULT_PR_NOTIFICATION_AUDIO_SETTINGS } from 'src/utils/notification-sounds'
import type { ProjectColor } from 'src/utils/project-color'
import { DEFAULT_WHIP_SHORTCUT } from 'src/utils/whip-shortcut'
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
  forge?: 'auto' | 'github' | 'gitlab' | 'bitbucket-community' | 'none'
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
  /** Default auto-loop finalization prompt; used when a project leaves its own empty. */
  finalizationPrompt: string
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
  autoLoopMaxRetries: number
  browserNotifications: boolean
  audioNotifications: boolean
  audioQuestionNotifications: boolean
  audioWorkspaceCreatedNotifications: boolean
  audioAgentErrorNotifications: boolean
  audioNotificationSound: string
  audioQuestionSound: string
  audioWorkspaceCreatedSound: string
  audioAgentErrorSound: string
  audioPrCiFailedSound: string
  audioPrCiFailedEnabled: boolean
  audioPrCiFailedVolume: number
  audioPrCiRecoveredSound: string
  audioPrCiRecoveredEnabled: boolean
  audioPrCiRecoveredVolume: number
  audioPrChangesRequestedSound: string
  audioPrChangesRequestedEnabled: boolean
  audioPrChangesRequestedVolume: number
  audioPrApprovedSound: string
  audioPrApprovedEnabled: boolean
  audioPrApprovedVolume: number
  audioPrMergeConflictSound: string
  audioPrMergeConflictEnabled: boolean
  audioPrMergeConflictVolume: number
  audioPrReadyToMergeSound: string
  audioPrReadyToMergeEnabled: boolean
  audioPrReadyToMergeVolume: number
  audioPrMergedSound: string
  audioPrMergedEnabled: boolean
  audioPrMergedVolume: number
  audioNotificationVolume: number
  audioQuestionVolume: number
  audioWorkspaceCreatedVolume: number
  audioAgentErrorVolume: number
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
  bitbucketToken: string
  bitbucketUsername: string
  notionEnabled: boolean
  sentryEnabled: boolean
  showThinkingBlocks: boolean
  whipEnabled: boolean
  whipShortcut: string
  whipVolume: number
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
      finalizationPrompt: '',
      notionInitialPromptTemplate: '',
      sentryInitialPromptTemplate: '',
      gitConventions: '',
      editorCommand: '',
      fileManagerCommand: '',
      terminalCommand: '',
      autoPurgeOnPrMerged: false,
      autoLoopMaxRetries: 5,
      browserNotifications: true,
      audioNotifications: true,
      audioQuestionNotifications: false,
      audioWorkspaceCreatedNotifications: false,
      audioAgentErrorNotifications: false,
      audioNotificationSound: 'hey.mp3',
      audioQuestionSound: 'inherit',
      audioWorkspaceCreatedSound: 'inherit',
      audioAgentErrorSound: 'inherit',
      ...DEFAULT_PR_NOTIFICATION_AUDIO_SETTINGS,
      audioNotificationVolume: 1,
      audioQuestionVolume: 1,
      audioWorkspaceCreatedVolume: 1,
      audioAgentErrorVolume: 1,
      notionStatusProperty: '',
      notionInProgressStatus: '',
      notionAssigneeProperty: '',
      notionUserId: '',
      defaultPermissionModeByEngine: { 'claude-code': 'plan', codex: 'plan' } as Record<string, string>,
      notionMcpKey: '',
      sentryMcpKey: '',
      bitbucketToken: '',
      bitbucketUsername: '',
      notionEnabled: true,
      sentryEnabled: true,
      showThinkingBlocks: true,
      whipEnabled: false,
      whipShortcut: DEFAULT_WHIP_SHORTCUT,
      whipVolume: 1,
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
    /** True only after a settings load that actually succeeded. Every write
     *  path checks it: a failed load leaves the form on the DEFAULT values
     *  declared above, and saving those would overwrite the real config. */
    loaded: false,
    /** Server message of the last failed load, null when the last load worked. */
    loadError: null as string | null,
    showVerboseSystemMessages: localStorage.getItem('kobo:showVerboseSystemMessages') === 'true',
  }),

  getters: {
    getProjectByPath: (state) => (path: string) => state.projects.find((p) => p.path === path) ?? null,

    projectPaths: (state) => state.projects.map((p) => p.path),
  },

  actions: {
    /** Throws unless a settings load has actually succeeded. Guards every write. */
    _assertLoaded() {
      if (!this.loaded) {
        throw new Error('Settings were never loaded successfully — refusing to overwrite the stored configuration')
      }
    },

    async fetchSettings() {
      this.loading = true
      try {
        const data = await apiFetch<{ global: GlobalSettings; projects: ProjectSettings[] }>('/api/settings')
        this.global = data.global
        this.projects = data.projects
        this.loadError = null
        this.loaded = true
      } catch (err) {
        // NEVER pretend a failed load is an empty configuration: the form would
        // render the store defaults, and one click on Save would write them
        // over the user's real scripts, conventions and tokens.
        this.loadError = err instanceof Error ? err.message : String(err)
        this.loaded = false
        console.error('[settings store] fetchSettings failed:', err)
      } finally {
        this.loading = false
      }
    },

    async fetchActiveMcpServers() {
      try {
        this.activeMcpServers = await apiFetch<ActiveMcpServer[]>('/api/settings/mcp-servers')
      } catch (err) {
        console.error('[settings store] fetchActiveMcpServers failed:', err)
        this.activeMcpServers = []
      }
    },

    async fetchGlobalDefaults(): Promise<{
      prPromptTemplate: string
      reviewPromptTemplate: string
      ciFixPromptTemplate: string
      finalizationPrompt: string
      gitConventions: string
      notionInitialPromptTemplate: string
      sentryInitialPromptTemplate: string
      changeSourceBranchScript: string
    }> {
      return apiFetch('/api/settings/defaults')
    },

    async updateGlobal(data: Partial<GlobalSettings>) {
      this._assertLoaded()
      this.global = await apiFetch<GlobalSettings>('/api/settings/global', { method: 'PUT', body: data })
    },

    async upsertProject(projectPath: string, data: Partial<Omit<ProjectSettings, 'path'>>) {
      this._assertLoaded()
      const encoded = toBase64Url(projectPath)
      const project = await apiFetch<ProjectSettings>(`/api/settings/projects/${encoded}`, {
        method: 'PUT',
        body: data,
      })
      const idx = this.projects.findIndex((p) => p.path === projectPath)
      if (idx >= 0) {
        this.projects[idx] = project
      } else {
        this.projects.push(project)
      }
    },

    toggleVerboseSystemMessages() {
      this.setVerboseSystemMessages(!this.showVerboseSystemMessages)
    },

    setVerboseSystemMessages(value: boolean) {
      this.showVerboseSystemMessages = value
      localStorage.setItem('kobo:showVerboseSystemMessages', String(value))
    },

    async deleteProject(projectPath: string) {
      this._assertLoaded()
      const encoded = toBase64Url(projectPath)
      await apiFetch(`/api/settings/projects/${encoded}`, { method: 'DELETE' })
      this.projects = this.projects.filter((p) => p.path !== projectPath)
    },

    async fetchVoiceModels() {
      this.voiceModelsLoading = true
      try {
        const data = await apiFetch<{
          modelsDir: string
          available: VoiceModelStatus[]
          activeModel: string | null
        }>('/api/voice/models')
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
      try {
        await apiFetch(`/api/voice/models/${encodeURIComponent(name)}/download`, { method: 'DELETE' })
      } catch (err) {
        // A 404 means the download already finished or was never armed — not
        // a failure from the user's point of view.
        if (!(err instanceof ApiError) || err.status !== 404) throw err
      }
      await this.fetchVoiceModels()
    },

    async fetchVoiceRuntime() {
      try {
        this.voiceRuntime = await apiFetch<VoiceRuntimeStatus>('/api/voice/runtime')
      } catch (err) {
        console.error('[settings store] fetchVoiceRuntime failed:', err)
      }
    },

    async downloadVoiceModel(name: string) {
      await apiFetch(`/api/voice/models/${encodeURIComponent(name)}/download`, { method: 'POST' })
      await this.fetchVoiceModels()
    },

    async deleteVoiceModel(name: string) {
      await apiFetch(`/api/voice/models/${encodeURIComponent(name)}`, { method: 'DELETE' })
      await this.fetchVoiceModels()
    },
  },
})
