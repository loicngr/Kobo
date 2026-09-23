import { describe, expect, it } from 'vitest'
import {
  CUSTOM_SOUND_EXTENSIONS,
  customSoundExtension,
  customSoundId,
  customSoundReference,
  DEFAULT_PUBLIC_NOTIFICATION_SOUND,
  isCustomNotificationSound,
  MAX_CUSTOM_SOUND_BYTES,
  MAX_CUSTOM_SOUNDS,
  normalizePublicNotificationSound,
  normalizePublicSounds,
} from '../shared/notification-assets.js'

const VALID = customSoundReference('abcdef123456')

describe('custom sound identifiers', () => {
  it('builds and reads a reference', () => {
    expect(VALID).toBe('custom:abcdef123456')
    expect(customSoundId(VALID)).toBe('abcdef123456')
  })

  it.each([
    ['custom:abcdef123456', true],
    ['custom:abcdef-23_56', true],
    ['custom:tooshort', false],
    ['custom:way-too-long-identifier', false],
    ['custom:../../etc/passwd', false],
    ['custom:', false],
    ['neutral.wav', false],
    ['', false],
    [null, false],
  ])('recognizes %j as custom: %s', (value, expected) => {
    expect(isCustomNotificationSound(value)).toBe(expected)
  })
})

describe('normalizePublicNotificationSound()', () => {
  it('keeps a well-formed custom reference', () => {
    expect(normalizePublicNotificationSound(VALID)).toBe(VALID)
    expect(normalizePublicNotificationSound(VALID, false)).toBe(VALID)
  })

  it('keeps the bundled sounds and the sentinels', () => {
    expect(normalizePublicNotificationSound('ready.wav')).toBe('ready.wav')
    expect(normalizePublicNotificationSound('inherit')).toBe('inherit')
    expect(normalizePublicNotificationSound('none')).toBe('none')
  })

  it('rewrites a malformed custom reference', () => {
    expect(normalizePublicNotificationSound('custom:../secret')).toBe(DEFAULT_PUBLIC_NOTIFICATION_SOUND)
    expect(normalizePublicNotificationSound('hey.mp3')).toBe(DEFAULT_PUBLIC_NOTIFICATION_SOUND)
  })

  it('preserves custom references across a whole settings object', () => {
    const settings: Record<string, unknown> = {
      audioNotificationSound: VALID,
      audioQuestionSound: 'inherit',
      audioPrMergedSound: 'custom:bad',
    }
    normalizePublicSounds(settings)
    expect(settings).toEqual({
      audioNotificationSound: VALID,
      audioQuestionSound: 'inherit',
      audioPrMergedSound: DEFAULT_PUBLIC_NOTIFICATION_SOUND,
    })
  })
})

describe('upload constraints', () => {
  it('accepts only browser-decodable extensions', () => {
    expect([...CUSTOM_SOUND_EXTENSIONS]).toEqual(['.wav', '.mp3', '.ogg', '.webm'])
  })

  it.each([
    ['alert.wav', '.wav'],
    ['ALERT.MP3', '.mp3'],
    ['my sound.ogg', '.ogg'],
    ['clip.webm', '.webm'],
    ['clip.flac', null],
    ['noextension', null],
    ['', null],
  ])('resolves the extension of %j', (name, expected) => {
    expect(customSoundExtension(name)).toBe(expected)
  })

  it('bounds size and count', () => {
    expect(MAX_CUSTOM_SOUND_BYTES).toBe(2 * 1024 * 1024)
    expect(MAX_CUSTOM_SOUNDS).toBe(20)
  })
})
