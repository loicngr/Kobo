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
  cancelVoiceModelDownload,
  downloadVoiceModel,
  getVoiceModelsDir,
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

  it('exposes the absolute models directory and per-model file paths and sizes', () => {
    const modelsRoot = path.join(tmpDir, 'voice', 'models', 'whisper')
    fs.mkdirSync(modelsRoot, { recursive: true })
    fs.writeFileSync(path.join(modelsRoot, 'ggml-base.bin'), 'XX')

    const res = listVoiceModels()
    expect(res.modelsDir).toBe(modelsRoot)
    expect(res.modelsDir).toBe(getVoiceModelsDir())
    const base = res.available.find((m) => m.name === 'base')
    expect(base?.filePath).toBe(path.join(modelsRoot, 'ggml-base.bin'))
    expect(base?.installedSizeBytes).toBe(2)
    expect(base?.sizeBytes).toBeGreaterThan(0)
    const tiny = res.available.find((m) => m.name === 'tiny')
    expect(tiny?.installedSizeBytes).toBeUndefined()
  })
})

function streamingFetchMock(bytes: Uint8Array, contentLength?: number) {
  return vi.fn().mockResolvedValue({
    ok: true,
    headers: {
      get: (h: string) => (h.toLowerCase() === 'content-length' ? String(contentLength ?? bytes.length) : null),
    },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(bytes)
        controller.close()
      },
    }),
  })
}

describe('downloadVoiceModel()', () => {
  it('streams model bytes to disk via createWriteStream', async () => {
    const bytes = new TextEncoder().encode('model-bytes')
    vi.stubGlobal('fetch', streamingFetchMock(bytes))

    const out = await downloadVoiceModel('base')
    expect(fs.existsSync(out.filePath)).toBe(true)
    expect(fs.readFileSync(out.filePath, 'utf-8')).toBe('model-bytes')
  })

  it('reports active download progress while running', async () => {
    const chunks = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])]
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        headers: { get: () => '5' },
        body: new ReadableStream({
          async start(controller) {
            controller.enqueue(chunks[0])
            await gate
            controller.enqueue(chunks[1])
            controller.close()
          },
        }),
      }),
    )

    const pending = downloadVoiceModel('base')
    // give the stream a microtask to enqueue chunk 0
    await new Promise((r) => setTimeout(r, 10))
    const midRun = listVoiceModels().available.find((m) => m.name === 'base')
    expect(midRun?.download).toBeDefined()
    expect(midRun?.download?.total).toBe(5)
    release()
    await pending
    const after = listVoiceModels().available.find((m) => m.name === 'base')
    expect(after?.download).toBeUndefined()
    expect(after?.installed).toBe(true)
  })

  it('rejects with MODEL_DOWNLOAD_CANCELLED when cancelled mid-stream', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url: string, init?: { signal?: AbortSignal }) => {
        return Promise.resolve({
          ok: true,
          headers: { get: () => '10' },
          body: new ReadableStream({
            async start(controller) {
              controller.enqueue(new Uint8Array([1, 2]))
              init?.signal?.addEventListener('abort', () =>
                controller.error(init.signal?.reason ?? new Error('aborted')),
              )
              await gate
              controller.close()
            },
          }),
        })
      }),
    )

    const pending = downloadVoiceModel('base')
    await new Promise((r) => setTimeout(r, 10))
    const cancelled = cancelVoiceModelDownload('base')
    expect(cancelled).toBe(true)
    release()
    await expect(pending).rejects.toMatchObject({ code: 'MODEL_DOWNLOAD_CANCELLED' })
    const modelsRoot = path.join(tmpDir, 'voice', 'models', 'whisper')
    // tmp file should be cleaned up; final file should not exist
    expect(fs.existsSync(path.join(modelsRoot, 'ggml-base.bin'))).toBe(false)
    expect(fs.existsSync(path.join(modelsRoot, 'ggml-base.bin.tmp'))).toBe(false)
  })

  it('cancelVoiceModelDownload returns false when no download is active', () => {
    expect(cancelVoiceModelDownload('base')).toBe(false)
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
