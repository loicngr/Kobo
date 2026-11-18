import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('quasar', () => ({ Notify: { create: vi.fn() } }))

import { useSettingsStore } from '../stores/settings'
import { useWebSocketStore } from '../stores/websocket'
import { useWorkspaceStore, type Workspace } from '../stores/workspace'

const OFF = { muteBrowser: false, muteSound: false, muteToast: false, muteDrawer: false, keepQuestions: false }
let played = 0

describe('PR events through the real notifyPr and notify', () => {
  beforeEach(() => {
    played = 0
    vi.stubGlobal(
      'Audio',
      class {
        volume = 1
        currentTime = 0
        addEventListener() {}
        removeEventListener() {}
        play() {
          played++
          return Promise.resolve()
        }
      } as unknown as typeof Audio,
    )
    setActivePinia(createPinia())
    vi.spyOn(useWorkspaceStore(), 'refreshPrSnapshot').mockResolvedValue(undefined as never)
    Object.assign(useSettingsStore().global, { audioPrCiFailedEnabled: true })
  })

  function route() {
    useWebSocketStore()._routeMessage({ type: 'pr:ci-failed', workspaceId: 'w1', payload: { prNumber: 1 } })
  }

  it('plays the sound when the workspace is not muted', () => {
    useWorkspaceStore().workspaces = [{ id: 'w1', notificationPrefs: OFF } as unknown as Workspace]
    route()
    expect(played).toBe(1)
  })

  it('muteSound silences it', () => {
    useWorkspaceStore().workspaces = [
      { id: 'w1', notificationPrefs: { ...OFF, muteSound: true } } as unknown as Workspace,
    ]
    route()
    expect(played).toBe(0)
  })
})
