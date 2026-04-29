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
          gitConventions: '',
          setupScript: '',
          devServer: { startCommand: '', stopCommand: '' },
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
          gitConventions: '',
          setupScript: '',
          devServer: { startCommand: '', stopCommand: '' },
        },
        {
          path: '/b',
          displayName: 'B',
          defaultSourceBranch: '',
          defaultModel: '',
          dangerouslySkipPermissions: true,
          prPromptTemplate: '',
          gitConventions: '',
          setupScript: '',
          devServer: { startCommand: '', stopCommand: '' },
        },
      ]
      expect(store.projectPaths).toEqual(['/a', '/b'])
    })
  })
})
