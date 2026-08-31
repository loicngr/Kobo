import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSettingsStore } from '../stores/settings'

describe('settings store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
  })

  afterEach(() => vi.unstubAllGlobals())

  describe('showVerboseSystemMessages', () => {
    it('defaults to false when localStorage is empty', () => {
      const store = useSettingsStore()
      expect(store.showVerboseSystemMessages).toBe(false)
    })

    it('toggles and persists to localStorage', () => {
      const store = useSettingsStore()
      store.toggleVerboseSystemMessages()
      expect(store.showVerboseSystemMessages).toBe(true)
      expect(localStorage.getItem('kobo:showVerboseSystemMessages')).toBe('true')

      store.toggleVerboseSystemMessages()
      expect(store.showVerboseSystemMessages).toBe(false)
      expect(localStorage.getItem('kobo:showVerboseSystemMessages')).toBe('false')
    })
  })

  describe('getters', () => {
    it('getProjectByPath returns matching project', () => {
      const store = useSettingsStore()
      store.projects = [
        {
          path: '/a',
          displayName: 'A',
          defaultSourceBranch: 'main',
          defaultModel: '',
          dangerouslySkipPermissions: true,
          prPromptTemplate: '',
          reviewPromptTemplate: '',
          ciFixPromptTemplate: '',
          notionInitialPromptTemplate: '',
          sentryInitialPromptTemplate: '',
          gitConventions: '',
          setupScript: '',
          taskPromptTemplate: '',
          cleanupScript: '',
          cleanupScriptMode: '',
          archiveScript: '',
          changeSourceBranchScript: '',
          devServer: { startCommand: '', stopCommand: '' },
          e2e: { framework: '', skill: '', prompt: '' },
          finalization: { prompt: '' },
          color: null,
        },
      ]
      expect(store.getProjectByPath('/a')?.displayName).toBe('A')
      expect(store.getProjectByPath('/nonexistent')).toBeNull()
    })

    it('projectPaths lists all configured paths', () => {
      const store = useSettingsStore()
      store.projects = [
        {
          path: '/a',
          displayName: 'A',
          defaultSourceBranch: '',
          defaultModel: '',
          dangerouslySkipPermissions: true,
          prPromptTemplate: '',
          reviewPromptTemplate: '',
          ciFixPromptTemplate: '',
          notionInitialPromptTemplate: '',
          sentryInitialPromptTemplate: '',
          gitConventions: '',
          setupScript: '',
          taskPromptTemplate: '',
          cleanupScript: '',
          cleanupScriptMode: '',
          archiveScript: '',
          changeSourceBranchScript: '',
          devServer: { startCommand: '', stopCommand: '' },
          e2e: { framework: '', skill: '', prompt: '' },
          finalization: { prompt: '' },
          color: null,
        },
        {
          path: '/b',
          displayName: 'B',
          defaultSourceBranch: '',
          defaultModel: '',
          dangerouslySkipPermissions: true,
          prPromptTemplate: '',
          reviewPromptTemplate: '',
          ciFixPromptTemplate: '',
          notionInitialPromptTemplate: '',
          sentryInitialPromptTemplate: '',
          gitConventions: '',
          setupScript: '',
          taskPromptTemplate: '',
          cleanupScript: '',
          cleanupScriptMode: '',
          archiveScript: '',
          changeSourceBranchScript: '',
          devServer: { startCommand: '', stopCommand: '' },
          e2e: { framework: '', skill: '', prompt: '' },
          finalization: { prompt: '' },
          color: null,
        },
      ]
      expect(store.projectPaths).toEqual(['/a', '/b'])
    })
  })

  it('exposes notionInitialPromptTemplate and sentryInitialPromptTemplate on store types', () => {
    const store = useSettingsStore()
    expect(store.global.notionInitialPromptTemplate).toBeDefined()
    expect(store.global.sentryInitialPromptTemplate).toBeDefined()
  })

  it('defaults the whip feature to disabled', () => {
    const store = useSettingsStore()
    expect(store.global.whipEnabled).toBe(false)
    expect(store.global.whipShortcut).toBe('mod+shift+x')
    expect(store.global.whipVolume).toBe(1)
  })

  it('defaults every PR notification sound to inherit', () => {
    const store = useSettingsStore()
    expect(store.global).toMatchObject({
      audioPrCiFailedSound: 'inherit',
      audioPrCiFailedEnabled: false,
      audioPrCiFailedVolume: 1,
      audioPrCiRecoveredSound: 'inherit',
      audioPrCiRecoveredEnabled: false,
      audioPrCiRecoveredVolume: 1,
      audioPrChangesRequestedSound: 'inherit',
      audioPrChangesRequestedEnabled: false,
      audioPrChangesRequestedVolume: 1,
      audioPrApprovedSound: 'inherit',
      audioPrApprovedEnabled: false,
      audioPrApprovedVolume: 1,
      audioPrMergeConflictSound: 'inherit',
      audioPrMergeConflictEnabled: false,
      audioPrMergeConflictVolume: 1,
      audioPrReadyToMergeSound: 'inherit',
      audioPrReadyToMergeEnabled: false,
      audioPrReadyToMergeVolume: 1,
      audioPrMergedSound: 'inherit',
      audioPrMergedEnabled: false,
      audioPrMergedVolume: 1,
    })
  })

  describe('load failure is not an empty configuration', () => {
    it('records the server message and refuses to consider itself loaded', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          status: 500,
          text: async () => JSON.stringify({ error: 'settings.json is unreadable' }),
        } as unknown as Response),
      )
      const store = useSettingsStore()

      await store.fetchSettings()

      expect(store.loadError).toBe('settings.json is unreadable')
      expect(store.loaded).toBe(false)
      expect(store.loading).toBe(false)
    })

    it('refuses to save global settings that were never loaded', async () => {
      const fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)
      const store = useSettingsStore()
      store.loaded = false

      // The whole point: a failed load leaves the form on DEFAULTS, and saving
      // those defaults would silently destroy the real configuration on disk.
      await expect(store.updateGlobal({ editorCommand: 'code' })).rejects.toThrow(/never loaded/i)
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('refuses to write a project whose settings were never loaded', async () => {
      const fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)
      const store = useSettingsStore()
      store.loaded = false

      await expect(store.upsertProject('/tmp/proj', { displayName: 'X' })).rejects.toThrow(/never loaded/i)
      await expect(store.deleteProject('/tmp/proj')).rejects.toThrow(/never loaded/i)
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('clears the failure and unlocks writes once a load succeeds', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ global: { editorCommand: 'vim' }, projects: [] }),
        } as unknown as Response),
      )
      const store = useSettingsStore()
      store.loadError = 'previous failure'

      await store.fetchSettings()

      expect(store.loadError).toBeNull()
      expect(store.loaded).toBe(true)
      expect(store.global.editorCommand).toBe('vim')
    })

    it('surfaces the server message when saving fails', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          status: 400,
          text: async () => JSON.stringify({ error: 'worktreesPath must be relative' }),
        } as unknown as Response),
      )
      const store = useSettingsStore()
      store.loaded = true

      await expect(store.updateGlobal({ worktreesPath: '/abs' })).rejects.toThrow('worktreesPath must be relative')
    })
  })
})
