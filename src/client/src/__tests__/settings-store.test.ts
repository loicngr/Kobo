import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import { useSettingsStore } from '../stores/settings'

describe('settings store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
  })

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
})
