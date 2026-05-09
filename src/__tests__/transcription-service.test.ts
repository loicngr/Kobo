import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { execFilePromiseMock } = vi.hoisted(() => ({
  execFilePromiseMock: vi.fn(),
}))

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
  const mock = Object.assign(vi.fn(), {
    [Symbol.for('nodejs.util.promisify.custom')]: execFilePromiseMock,
  })
  return {
    ...actual,
    execFile: mock,
  }
})

vi.mock('../server/services/settings-service.js', () => ({
  getGlobalSettings: vi.fn(),
}))

import * as settingsService from '../server/services/settings-service.js'
import {
  downloadVoiceModel,
  listVoiceModels,
  transcribeAudio,
  type VoiceError,
} from '../server/services/transcription-service.js'

let tmpDir: string
let originalKoboHome: string | undefined
let originalEnforce: string | undefined

beforeEach(() => {
  vi.clearAllMocks()
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kobo-voice-test-'))
  originalKoboHome = process.env.KOBO_HOME
  originalEnforce = process.env.KOBO_ENFORCE_LOCAL_HOME
  process.env.KOBO_HOME = tmpDir
  delete process.env.KOBO_ENFORCE_LOCAL_HOME
  vi.mocked(settingsService.getGlobalSettings).mockReturnValue({
    voiceModel: 'base',
  } as never)
})

afterEach(() => {
  if (originalKoboHome === undefined) delete process.env.KOBO_HOME
  else process.env.KOBO_HOME = originalKoboHome
  if (originalEnforce === undefined) delete process.env.KOBO_ENFORCE_LOCAL_HOME
  else process.env.KOBO_ENFORCE_LOCAL_HOME = originalEnforce
  if (tmpDir && fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('listVoiceModels()', () => {
  it('marks installed models and returns active model from settings', () => {
    const modelsRoot = path.join(tmpDir, 'voice', 'models', 'whisper')
    fs.mkdirSync(modelsRoot, { recursive: true })
    fs.writeFileSync(path.join(modelsRoot, 'ggml-base.bin'), 'ok')

    const res = listVoiceModels()
    expect(res.activeModel).toBe('base')
    const base = res.available.find((m) => m.name === 'base')
    expect(base?.installed).toBe(true)
  })
})

describe('downloadVoiceModel()', () => {
  it('downloads and writes model to local voice directory', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: async () => new TextEncoder().encode('model-bytes').buffer,
      }),
    )

    const out = await downloadVoiceModel('base')
    expect(fs.existsSync(out.filePath)).toBe(true)
    expect(fs.readFileSync(out.filePath, 'utf-8')).toBe('model-bytes')
  })
})

describe('transcribeAudio()', () => {
  it('throws MODEL_NOT_INSTALLED when model file is missing', async () => {
    await expect(transcribeAudio({ audioBuffer: Buffer.from([1]), modelName: 'base' })).rejects.toMatchObject({
      code: 'MODEL_NOT_INSTALLED',
    })
  })

  it('throws LANGUAGE_INVALID on invalid language value', async () => {
    const modelsRoot = path.join(tmpDir, 'voice', 'models', 'whisper')
    fs.mkdirSync(modelsRoot, { recursive: true })
    fs.writeFileSync(path.join(modelsRoot, 'ggml-base.bin'), 'ok')

    await expect(
      transcribeAudio({ audioBuffer: Buffer.from([1, 2]), modelName: 'base', language: 'fr$' }),
    ).rejects.toMatchObject({ code: 'LANGUAGE_INVALID' })
  })

  it('returns transcription text when whisper output exists', async () => {
    const modelsRoot = path.join(tmpDir, 'voice', 'models', 'whisper')
    fs.mkdirSync(modelsRoot, { recursive: true })
    fs.writeFileSync(path.join(modelsRoot, 'ggml-base.bin'), 'ok')

    execFilePromiseMock.mockImplementation(async (_cmd: string, args: string[]) => {
      const outFlag = args.indexOf('-of')
      if (outFlag >= 0) {
        const outBase = args[outFlag + 1]
        fs.writeFileSync(`${outBase}.txt`, 'bonjour le monde')
      }
      return { stderr: '' }
    })

    const res = await transcribeAudio({
      audioBuffer: Buffer.from([1, 2, 3]),
      modelName: 'base',
      language: 'fr',
    })
    expect(res.text).toBe('bonjour le monde')
    expect(res.model).toBe('base')
    expect(res.language).toBe('fr')
  })

  it('wraps missing whisper output as TRANSCRIPTION_FAILED', async () => {
    const modelsRoot = path.join(tmpDir, 'voice', 'models', 'whisper')
    fs.mkdirSync(modelsRoot, { recursive: true })
    fs.writeFileSync(path.join(modelsRoot, 'ggml-base.bin'), 'ok')

    execFilePromiseMock.mockResolvedValue({ stderr: 'no output written' })

    await expect(
      transcribeAudio({ audioBuffer: Buffer.from([1, 2, 3]), modelName: 'base', language: 'fr' }),
    ).rejects.toMatchObject<Partial<VoiceError>>({ code: 'TRANSCRIPTION_FAILED' })
  })
})
