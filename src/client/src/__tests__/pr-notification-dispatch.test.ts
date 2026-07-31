import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('quasar', () => ({ Notify: { create: vi.fn() } }))
vi.mock('src/utils/notifications', () => ({ notify: vi.fn() }))

import { notify } from 'src/utils/notifications'
import { type GlobalSettings, useSettingsStore } from '../stores/settings'
import { useWebSocketStore } from '../stores/websocket'
import { useWorkspaceStore } from '../stores/workspace'

const CASES = [
  ['pr:ci-failed', 'audioPrCiFailedSound', 'faaah.mp3'],
  ['pr:ci-recovered', 'audioPrCiRecoveredSound', 'for-shure.mp3'],
  ['pr:changes-requested', 'audioPrChangesRequestedSound', 'arrete-de-mentir.mp3'],
  ['pr:approved', 'audioPrApprovedSound', 'hey.mp3'],
  ['pr:merge-conflict', 'audioPrMergeConflictSound', 'gta-v-death.mp3'],
  ['pr:ready-to-merge', 'audioPrReadyToMergeSound', 'travail_termine.mp3'],
  ['pr:merged', 'audioPrMergedSound', '7eme-compagnie-03.mp3'],
] as const satisfies ReadonlyArray<[string, keyof GlobalSettings, string]>

describe('PR notification WebSocket dispatch', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    vi.spyOn(useWorkspaceStore(), 'refreshPrSnapshot').mockResolvedValue(undefined as never)
  })

  it.each(CASES)('routes %s through its own setting', (eventType, settingKey, sound) => {
    const settings = useSettingsStore()
    settings.global[settingKey] = sound

    useWebSocketStore()._routeMessage({
      type: eventType,
      workspaceId: 'w1',
      payload: { prNumber: 42, prUrl: 'https://example.test/pr/42' },
    })

    expect(notify).toHaveBeenLastCalledWith(expect.any(String), undefined, 'w1', sound, 1, true)
  })

  it('disables CI-failure audio without suppressing the browser notification', () => {
    useSettingsStore().global.audioPrCiFailedEnabled = false

    useWebSocketStore()._routeMessage({
      type: 'pr:ci-failed',
      workspaceId: 'w1',
      payload: { prNumber: 42, prUrl: 'https://example.test/pr/42' },
    })

    expect(notify).toHaveBeenCalledWith(expect.any(String), undefined, 'w1', undefined, 1, false)
  })

  it('uses the approved event volume instead of the general volume', () => {
    const settings = useSettingsStore().global
    settings.audioNotificationVolume = 0.9
    settings.audioPrApprovedSound = 'hey.mp3'
    settings.audioPrApprovedVolume = 0.35

    useWebSocketStore()._routeMessage({
      type: 'pr:approved',
      workspaceId: 'w1',
      payload: { prNumber: 42, prUrl: 'https://example.test/pr/42' },
    })

    expect(notify).toHaveBeenLastCalledWith(expect.any(String), undefined, 'w1', 'hey.mp3', 0.35, true)
  })

  it.each(['inherit', 'unknown.mp3', ''])('inherits for stored value %j', (selection) => {
    useSettingsStore().global.audioPrApprovedSound = selection

    useWebSocketStore()._routeMessage({
      type: 'pr:approved',
      workspaceId: 'w1',
      payload: { prNumber: 42, prUrl: 'https://example.test/pr/42' },
    })

    expect(notify).toHaveBeenLastCalledWith(expect.any(String), undefined, 'w1', undefined, 1, true)
  })
})
