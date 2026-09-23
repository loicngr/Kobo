import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_NOTIFICATION_SOUND,
  DEFAULT_PR_NOTIFICATION_SOUND_SETTINGS,
  DEFAULT_WORKSPACE_CREATED_SOUND,
  INHERIT_NOTIFICATION_SOUND,
  isKnownSoundId,
  NO_NOTIFICATION_SOUND,
  NOTIFICATION_SOUNDS,
  normalizeNotificationSoundSelection,
  normalizeSoundSelectionForForm,
  PR_NOTIFICATION_SOUND_SETTING_KEYS,
  resolveNotificationSoundOverride,
  resolveSoundId,
  resolveSoundIdForForm,
  SOUNDS_DIR,
  setCustomSoundUrl,
  setKnownCustomSoundIds,
  soundUrl,
} from '../utils/notification-sounds'

const NEW_SOUND_IDS = ['neutral.wav', 'ready.wav'] as const

const testDir = path.dirname(fileURLToPath(import.meta.url))

describe('NOTIFICATION_SOUNDS', () => {
  it('exposes a non-empty list', () => {
    expect(NOTIFICATION_SOUNDS.length).toBeGreaterThan(0)
  })

  it('uses unique ids', () => {
    const ids = NOTIFICATION_SOUNDS.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('uses unique label keys', () => {
    const keys = NOTIFICATION_SOUNDS.map((s) => s.labelKey)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('every id ends with a known audio extension', () => {
    for (const s of NOTIFICATION_SOUNDS) {
      expect(s.id).toMatch(/\.(mp3|ogg|wav|m4a)$/)
    }
  })

  it('every labelKey starts with the settings.notificationSound namespace', () => {
    for (const s of NOTIFICATION_SOUNDS) {
      expect(s.labelKey).toMatch(/^settings\.notificationSound[A-Z]/)
    }
  })

  it('DEFAULT_NOTIFICATION_SOUND is one of the listed ids', () => {
    expect(NOTIFICATION_SOUNDS.some((s) => s.id === DEFAULT_NOTIFICATION_SOUND)).toBe(true)
  })

  it('exposes the dedicated default sound for workspace creation', () => {
    expect(DEFAULT_WORKSPACE_CREATED_SOUND).toBe(INHERIT_NOTIFICATION_SOUND)
  })

  it('registers all notification assets and keeps every file present', () => {
    expect(NOTIFICATION_SOUNDS).toHaveLength(2)
    expect(NOTIFICATION_SOUNDS.map((sound) => sound.id)).toEqual(expect.arrayContaining([...NEW_SOUND_IDS]))
    for (const id of NEW_SOUND_IDS) {
      const asset = path.resolve(testDir, `../../public/sounds/${id}`)
      expect(fs.existsSync(asset), id).toBe(true)
      expect(fs.statSync(asset).size, id).toBeGreaterThan(0)
    }
  })

  it.each(['neutral.wav', 'ready.wav'])('resolves the new sound %s', (id) => {
    expect(isKnownSoundId(id)).toBe(true)
    expect(resolveSoundId(id)).toBe(id)
    expect(soundUrl(id)).toBe(`/sounds/${id}`)
  })
})

describe('isKnownSoundId()', () => {
  it('returns true for a listed id', () => {
    expect(isKnownSoundId(DEFAULT_NOTIFICATION_SOUND)).toBe(true)
  })

  it('returns false for an unknown id', () => {
    expect(isKnownSoundId('nope.mp3')).toBe(false)
  })

  it('returns false for an empty string', () => {
    expect(isKnownSoundId('')).toBe(false)
  })
})

describe('resolveSoundId()', () => {
  it('returns the input id when known', () => {
    expect(resolveSoundId(NOTIFICATION_SOUNDS[1]!.id)).toBe(NOTIFICATION_SOUNDS[1]!.id)
  })

  it('falls back to DEFAULT for an unknown id', () => {
    expect(resolveSoundId('unknown.mp3')).toBe(DEFAULT_NOTIFICATION_SOUND)
  })

  it('falls back to DEFAULT for null', () => {
    expect(resolveSoundId(null)).toBe(DEFAULT_NOTIFICATION_SOUND)
  })

  it('falls back to DEFAULT for undefined', () => {
    expect(resolveSoundId(undefined)).toBe(DEFAULT_NOTIFICATION_SOUND)
  })

  it('falls back to DEFAULT for empty string', () => {
    expect(resolveSoundId('')).toBe(DEFAULT_NOTIFICATION_SOUND)
  })
})

describe('soundUrl()', () => {
  it('builds the URL under SOUNDS_DIR for a known id', () => {
    expect(soundUrl(DEFAULT_NOTIFICATION_SOUND)).toBe(`${SOUNDS_DIR}/${DEFAULT_NOTIFICATION_SOUND}`)
  })

  it('builds the default URL for an unknown id', () => {
    expect(soundUrl('nope.mp3')).toBe(`${SOUNDS_DIR}/${DEFAULT_NOTIFICATION_SOUND}`)
  })
})

describe('PR notification sound selections', () => {
  it('defines all seven PR sound settings with inherit defaults', () => {
    expect(PR_NOTIFICATION_SOUND_SETTING_KEYS).toHaveLength(7)
    expect(Object.values(DEFAULT_PR_NOTIFICATION_SOUND_SETTINGS)).toEqual(Array(7).fill(INHERIT_NOTIFICATION_SOUND))
  })

  it.each([
    ['inherit', undefined],
    ['none', null],
    ['ready.wav', 'ready.wav'],
    ['missing.mp3', undefined],
    ['', undefined],
    [null, undefined],
  ])('resolves event selection %j to %j', (selection, expected) => {
    expect(resolveNotificationSoundOverride(selection)).toBe(expected)
  })

  it.each([
    ['inherit', 'inherit'],
    ['none', 'none'],
    ['ready.wav', 'ready.wav'],
    ['missing.mp3', 'inherit'],
    ['', 'inherit'],
    [undefined, 'inherit'],
  ])('normalizes stored selection %j to %j', (selection, expected) => {
    expect(normalizeNotificationSoundSelection(selection)).toBe(expected)
  })

  it('uses distinct inherit and no-sound sentinels', () => {
    expect(INHERIT_NOTIFICATION_SOUND).not.toBe(NO_NOTIFICATION_SOUND)
  })
})

describe('imported custom sounds', () => {
  afterEach(() => setKnownCustomSoundIds([]))

  it('is unknown until the catalogue is registered', () => {
    expect(isKnownSoundId('custom:abcdef123456')).toBe(false)
    expect(resolveSoundId('custom:abcdef123456')).toBe(DEFAULT_NOTIFICATION_SOUND)
    expect(soundUrl('custom:abcdef123456')).toBe(`${SOUNDS_DIR}/${DEFAULT_NOTIFICATION_SOUND}`)
  })

  it('resolves and serves a registered sound from the API', () => {
    setKnownCustomSoundIds(['custom:abcdef123456'])
    expect(isKnownSoundId('custom:abcdef123456')).toBe(true)
    expect(resolveSoundId('custom:abcdef123456')).toBe('custom:abcdef123456')
    expect(soundUrl('custom:abcdef123456')).toBe('/api/sounds/abcdef123456/file')
  })

  it('accepts bare ids as well as references when registering', () => {
    setKnownCustomSoundIds(['abcdef123456'])
    expect(isKnownSoundId('custom:abcdef123456')).toBe(true)
  })

  it('falls back once a registered sound is deleted', () => {
    setKnownCustomSoundIds(['custom:abcdef123456'])
    setKnownCustomSoundIds([])
    expect(resolveSoundId('custom:abcdef123456')).toBe(DEFAULT_NOTIFICATION_SOUND)
    expect(normalizeNotificationSoundSelection('custom:abcdef123456')).toBe(INHERIT_NOTIFICATION_SOUND)
  })

  it('ignores a malformed reference even when registered', () => {
    setKnownCustomSoundIds(['custom:../../secret'])
    expect(isKnownSoundId('custom:../../secret')).toBe(false)
    expect(soundUrl('custom:../../secret')).toBe(`${SOUNDS_DIR}/${DEFAULT_NOTIFICATION_SOUND}`)
  })

  it('keeps a registered sound selectable as an event override', () => {
    setKnownCustomSoundIds(['custom:abcdef123456'])
    expect(resolveNotificationSoundOverride('custom:abcdef123456')).toBe('custom:abcdef123456')
    expect(normalizeNotificationSoundSelection('custom:abcdef123456')).toBe('custom:abcdef123456')
  })
})

describe('settings-form normalization', () => {
  afterEach(() => setKnownCustomSoundIds([]))

  // Regression: the form value is written straight back on save, so degrading a
  // reference here silently erased the user's eleven sound selections the first
  // time Settings was opened on any tab other than Notifications.
  it('keeps a custom reference the catalogue has not loaded yet', () => {
    expect(resolveSoundIdForForm('custom:abcdef123456')).toBe('custom:abcdef123456')
    expect(normalizeSoundSelectionForForm('custom:abcdef123456')).toBe('custom:abcdef123456')
    expect(isKnownSoundId('custom:abcdef123456')).toBe(false)
  })

  it.each([
    ['ready.wav', 'ready.wav'],
    ['inherit', 'inherit'],
    ['none', 'none'],
    ['custom:bad', 'inherit'],
    ['missing.mp3', 'inherit'],
    ['', 'inherit'],
    [undefined, 'inherit'],
  ])('normalizes the stored selection %j to %j', (selection, expected) => {
    expect(normalizeSoundSelectionForForm(selection)).toBe(expected)
  })

  it('falls back to the default sound for a malformed general selection', () => {
    expect(resolveSoundIdForForm('custom:bad')).toBe(DEFAULT_NOTIFICATION_SOUND)
    expect(resolveSoundIdForForm(undefined)).toBe(DEFAULT_NOTIFICATION_SOUND)
  })
})

describe('authenticated playback URL', () => {
  afterEach(() => setKnownCustomSoundIds([]))

  // A media element carries no X-Kobo-Token, so the API URL answers 401 over
  // LAN access. The store swaps in a blob URL once the bytes are downloaded.
  it('prefers a preloaded blob URL over the API URL', () => {
    setKnownCustomSoundIds(['custom:abcdef123456'])
    expect(soundUrl('custom:abcdef123456')).toBe('/api/sounds/abcdef123456/file')
    setCustomSoundUrl('custom:abcdef123456', 'blob:kobo/1')
    expect(soundUrl('custom:abcdef123456')).toBe('blob:kobo/1')
  })

  it('ignores a blob URL for a sound that is not in the catalogue', () => {
    setCustomSoundUrl('custom:abcdef123456', 'blob:kobo/1')
    expect(soundUrl('custom:abcdef123456')).toBe(`${SOUNDS_DIR}/${DEFAULT_NOTIFICATION_SOUND}`)
  })

  it('keeps a resolved blob URL across a catalogue refresh', () => {
    setKnownCustomSoundIds(['custom:abcdef123456'])
    setCustomSoundUrl('custom:abcdef123456', 'blob:kobo/1')
    setKnownCustomSoundIds(['custom:abcdef123456', 'custom:zyxwvu654321'])
    expect(soundUrl('custom:abcdef123456')).toBe('blob:kobo/1')
    expect(soundUrl('custom:zyxwvu654321')).toBe('/api/sounds/zyxwvu654321/file')
  })
})
