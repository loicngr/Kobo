import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { _setSettingsPath, getSettings, updateGlobalSettings } from '../server/services/settings-service.js'

let directory: string
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kobo-public-sounds-'))
  _setSettingsPath(path.join(directory, 'settings.json'))
})
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }))

it('uses an original tone on fresh installations with audio disabled', () => {
  const { global } = getSettings()
  expect(global.audioNotificationSound).toBe('neutral.wav')
  expect(global.audioNotifications).toBe(false)
})
it('migrates removed sounds without enabling or increasing audio', () => {
  const settings = getSettings()
  fs.writeFileSync(
    path.join(directory, 'settings.json'),
    JSON.stringify({
      ...settings,
      schemaVersion: 60,
      global: {
        ...settings.global,
        audioNotifications: true,
        audioNotificationVolume: 0.3,
        audioNotificationSound: 'hey.mp3',
        audioQuestionSound: 'none',
        audioPrMergedSound: 'inherit',
      },
    }),
  )
  _setSettingsPath(path.join(directory, 'settings.json'))
  const { global } = getSettings()
  expect(global.audioNotificationSound).toBe('neutral.wav')
  expect(global.audioNotifications).toBe(true)
  expect(global.audioNotificationVolume).toBe(0.3)
  expect(global.audioQuestionSound).toBe('none')
  expect(global.audioPrMergedSound).toBe('inherit')
  expect(getSettings().global).toEqual(global)
})
it('normalizes obsolete or unknown identifiers sent by an old client', () => {
  getSettings()
  updateGlobalSettings({ audioNotificationSound: 'unknown.mp3', audioQuestionSound: 'ready.wav' })
  expect(getSettings().global.audioNotificationSound).toBe('neutral.wav')
  expect(getSettings().global.audioQuestionSound).toBe('ready.wav')
})
