import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_CUSTOM_SOUND_BYTES, MAX_CUSTOM_SOUNDS } from '../shared/notification-assets.js'

let soundsDir = ''
vi.mock('../server/utils/paths.js', async () => {
  const actual = await vi.importActual<typeof import('../server/utils/paths.js')>('../server/utils/paths.js')
  return { ...actual, getCustomSoundsDir: () => soundsDir }
})

const { CustomSoundError, deleteCustomSound, listCustomSounds, readCustomSound, saveCustomSound } = await import(
  '../server/services/custom-sound-service.js'
)

let root = ''
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kobo-custom-sounds-'))
  soundsDir = path.join(root, 'sounds')
  vi.clearAllMocks()
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

function upload(name: string, bytes = 32): File {
  return new File([new Uint8Array(bytes)], name, { type: '' })
}

describe('listCustomSounds()', () => {
  it('returns an empty list before anything is imported', () => {
    expect(listCustomSounds()).toEqual([])
    expect(fs.existsSync(soundsDir)).toBe(false)
  })

  it('ignores a corrupted manifest instead of throwing', () => {
    fs.mkdirSync(soundsDir, { recursive: true })
    fs.writeFileSync(path.join(soundsDir, 'sounds.json'), '{ not json')
    expect(listCustomSounds()).toEqual([])
  })
})

describe('saveCustomSound()', () => {
  it('stores the file under a generated id and keeps the display name', async () => {
    const saved = await saveCustomSound(upload('My Alert.WAV'))
    expect(saved.name).toBe('My Alert.WAV')
    expect(saved.extension).toBe('.wav')
    expect(saved.id).toMatch(/^[A-Za-z0-9_-]{12}$/)
    expect(saved.reference).toBe(`custom:${saved.id}`)
    expect(fs.existsSync(path.join(soundsDir, `${saved.id}.wav`))).toBe(true)
    expect(listCustomSounds()).toHaveLength(1)
  })

  it('never uses the uploaded filename as a path', async () => {
    const saved = await saveCustomSound(upload('../../escape.mp3'))
    // Sort both sides: the generated id decides where the audio file lands
    // relative to `sounds.json`, so a fixed order fails for roughly one id in
    // nine (any id starting with `t`-`z`).
    expect(fs.readdirSync(soundsDir).sort()).toEqual([`${saved.id}.mp3`, 'sounds.json'].sort())
    expect(fs.existsSync(path.join(root, 'escape.mp3'))).toBe(false)
  })

  it('rejects an unsupported format', async () => {
    await expect(saveCustomSound(upload('clip.flac'))).rejects.toThrow(CustomSoundError)
    await expect(saveCustomSound(upload('clip.flac'))).rejects.toMatchObject({ code: 'type' })
    expect(listCustomSounds()).toEqual([])
  })

  it('rejects a file over the size limit', async () => {
    await expect(saveCustomSound(upload('big.mp3', MAX_CUSTOM_SOUND_BYTES + 1))).rejects.toMatchObject({ code: 'size' })
    expect(listCustomSounds()).toEqual([])
  })

  it('rejects an empty file', async () => {
    await expect(saveCustomSound(upload('empty.mp3', 0))).rejects.toMatchObject({ code: 'size' })
  })

  it('refuses to exceed the catalogue limit', async () => {
    for (let index = 0; index < MAX_CUSTOM_SOUNDS; index++) await saveCustomSound(upload(`sound-${index}.ogg`))
    await expect(saveCustomSound(upload('one-too-many.ogg'))).rejects.toMatchObject({ code: 'count' })
    expect(listCustomSounds()).toHaveLength(MAX_CUSTOM_SOUNDS)
  })
})

describe('readCustomSound()', () => {
  it('resolves a stored sound with its content type', async () => {
    const saved = await saveCustomSound(upload('ping.ogg'))
    expect(readCustomSound(saved.id)).toEqual({
      filePath: path.join(soundsDir, `${saved.id}.ogg`),
      contentType: 'audio/ogg',
    })
  })

  it('returns null for an unknown id', () => {
    expect(readCustomSound('abcdef123456')).toBeNull()
  })

  it.each(['../settings', 'a/b', '', 'short'])('returns null for the malformed id %j', (id) => {
    expect(readCustomSound(id)).toBeNull()
  })

  it('returns null when the manifest entry outlived its file', async () => {
    const saved = await saveCustomSound(upload('gone.wav'))
    fs.rmSync(path.join(soundsDir, `${saved.id}.wav`))
    expect(readCustomSound(saved.id)).toBeNull()
  })
})

describe('deleteCustomSound()', () => {
  it('removes the entry and its file', async () => {
    const saved = await saveCustomSound(upload('bye.mp3'))
    expect(deleteCustomSound(saved.id)).toBe(true)
    expect(listCustomSounds()).toEqual([])
    expect(fs.existsSync(path.join(soundsDir, `${saved.id}.mp3`))).toBe(false)
  })

  it('reports an unknown id without throwing', () => {
    expect(deleteCustomSound('abcdef123456')).toBe(false)
  })

  it('keeps the other sounds', async () => {
    const first = await saveCustomSound(upload('first.wav'))
    const second = await saveCustomSound(upload('second.wav'))
    deleteCustomSound(first.id)
    expect(listCustomSounds().map((sound) => sound.id)).toEqual([second.id])
  })
})
