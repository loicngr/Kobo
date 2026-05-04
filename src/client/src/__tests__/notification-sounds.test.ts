import { describe, expect, it } from 'vitest'
import {
  DEFAULT_NOTIFICATION_SOUND,
  isKnownSoundId,
  NOTIFICATION_SOUNDS,
  resolveSoundId,
  SOUNDS_DIR,
  soundUrl,
} from '../utils/notification-sounds'

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
