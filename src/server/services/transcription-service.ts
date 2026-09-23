import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import { getKoboHome } from '../utils/paths.js'
import { getGlobalSettings } from './settings-service.js'

const execFileAsync = promisify(execFile)
const MAX_LANG_LENGTH = 16

export class VoiceError extends Error {
  code: string
  status: number
  constructor(message: string, code: string, status = 400) {
    super(message)
    this.code = code
    this.status = status
    this.name = 'VoiceError'
  }
}

export interface VoiceModelDefinition {
  name: string
  fileName: string
  url: string
  // Expected size in bytes (from huggingface ggml-*.bin). Used to show the
  // weight before any HTTP call and to compute progress %.
  sizeBytes: number
}

export interface VoiceModelInfo {
  name: string
  fileName: string
  installed: boolean
  sizeBytes: number
  installedSizeBytes?: number
  filePath: string
  download?: VoiceModelDownloadProgress
}

export interface VoiceModelDownloadProgress {
  downloaded: number
  total: number
  startedAt: number
}

export interface VoiceRuntimeStatus {
  available: boolean
  command: string
  error?: string
  ffmpegAvailable: boolean
  ffmpegError?: string
}

export const VOICE_MODELS: VoiceModelDefinition[] = [
  {
    name: 'tiny',
    fileName: 'ggml-tiny.bin',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin?download=true',
    sizeBytes: 77_691_713,
  },
  {
    name: 'base',
    fileName: 'ggml-base.bin',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin?download=true',
    sizeBytes: 147_964_211,
  },
  {
    name: 'small',
    fileName: 'ggml-small.bin',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin?download=true',
    sizeBytes: 487_701_384,
  },
  {
    name: 'medium',
    fileName: 'ggml-medium.bin',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin?download=true',
    sizeBytes: 1_533_763_059,
  },
  {
    name: 'large-v3',
    fileName: 'ggml-large-v3.bin',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin?download=true',
    sizeBytes: 3_094_623_691,
  },
]

interface ActiveDownload {
  downloaded: number
  total: number
  startedAt: number
  controller: AbortController
}

const activeDownloads = new Map<string, ActiveDownload>()

function voiceHome(): string {
  return path.join(getKoboHome(), 'voice')
}

function modelsDir(): string {
  return path.join(voiceHome(), 'models', 'whisper')
}

export function getVoiceModelsDir(): string {
  return modelsDir()
}

function resolveWhisperCommand(): string {
  const global = getGlobalSettings()
  const fromSettings = (global.voiceCommandPath ?? '').trim()
  if (fromSettings.length > 0) return fromSettings
  return process.env.WHISPER_CPP_COMMAND || 'whisper-cli'
}

function resolveFfmpegCommand(): string {
  const global = getGlobalSettings()
  const fromSettings = (global.voiceFfmpegPath ?? '').trim()
  if (fromSettings.length > 0) return fromSettings
  return 'ffmpeg'
}

function ensureVoiceDirs(): void {
  fs.mkdirSync(modelsDir(), { recursive: true })
}

function resolveModel(name: string): VoiceModelDefinition {
  const model = VOICE_MODELS.find((m) => m.name === name)
  if (!model) throw new VoiceError(`Unknown voice model '${name}'`, 'MODEL_UNKNOWN', 400)
  return model
}

export function listVoiceModels(): {
  modelsDir: string
  available: VoiceModelInfo[]
  activeModel: string | null
} {
  ensureVoiceDirs()
  const settings = getGlobalSettings()
  const dir = modelsDir()
  const available: VoiceModelInfo[] = VOICE_MODELS.map((m) => {
    const filePath = path.join(dir, m.fileName)
    const installed = fs.existsSync(filePath)
    let installedSizeBytes: number | undefined
    if (installed) {
      try {
        installedSizeBytes = fs.statSync(filePath).size
      } catch {
        installedSizeBytes = undefined
      }
    }
    const active = activeDownloads.get(m.name)
    const download: VoiceModelDownloadProgress | undefined = active
      ? { downloaded: active.downloaded, total: active.total, startedAt: active.startedAt }
      : undefined
    return {
      name: m.name,
      fileName: m.fileName,
      installed,
      sizeBytes: m.sizeBytes,
      installedSizeBytes,
      filePath,
      download,
    }
  })
  return { modelsDir: dir, available, activeModel: settings.voiceModel }
}

export async function getVoiceRuntimeStatus(): Promise<VoiceRuntimeStatus> {
  const command = resolveWhisperCommand()
  let ffmpegAvailable = true
  let ffmpegError: string | undefined
  try {
    await execFileAsync(resolveFfmpegCommand(), ['-version'], { timeout: 5000 })
  } catch (err) {
    ffmpegAvailable = false
    ffmpegError = err instanceof Error ? err.message : String(err)
  }
  try {
    await execFileAsync(command, ['-h'], { timeout: 5000 })
    return { available: ffmpegAvailable, command, ffmpegAvailable, ffmpegError }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { available: false, command, error: message, ffmpegAvailable, ffmpegError }
  }
}

export async function downloadVoiceModel(name: string): Promise<{ name: string; filePath: string }> {
  ensureVoiceDirs()
  const model = resolveModel(name)
  if (activeDownloads.has(name)) {
    throw new VoiceError(`Model '${name}' is already downloading`, 'MODEL_DOWNLOAD_IN_PROGRESS', 409)
  }
  const controller = new AbortController()
  const state: ActiveDownload = {
    downloaded: 0,
    total: model.sizeBytes,
    startedAt: Date.now(),
    controller,
  }
  activeDownloads.set(name, state)

  const filePath = path.join(modelsDir(), model.fileName)
  const tmpPath = `${filePath}.tmp`
  try {
    const res = await fetch(model.url, { signal: controller.signal })
    if (!res.ok) {
      throw new VoiceError(`Failed to download model '${name}' (HTTP ${res.status})`, 'MODEL_DOWNLOAD_FAILED', 500)
    }
    const contentLength = Number.parseInt(res.headers.get('content-length') ?? '', 10)
    if (Number.isFinite(contentLength) && contentLength > 0) state.total = contentLength
    if (!res.body) {
      throw new VoiceError(`Empty response body for model '${name}'`, 'MODEL_DOWNLOAD_FAILED', 500)
    }

    const source = Readable.fromWeb(res.body as never)
    source.on('data', (chunk: Buffer | string) => {
      state.downloaded += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length
    })
    const dest = fs.createWriteStream(tmpPath)
    await pipeline(source, dest)
    fs.renameSync(tmpPath, filePath)
    return { name, filePath }
  } catch (err) {
    if (fs.existsSync(tmpPath)) fs.rmSync(tmpPath, { force: true })
    if (controller.signal.aborted) {
      throw new VoiceError(`Download for model '${name}' was cancelled`, 'MODEL_DOWNLOAD_CANCELLED', 400)
    }
    throw err
  } finally {
    activeDownloads.delete(name)
  }
}

export function cancelVoiceModelDownload(name: string): boolean {
  const state = activeDownloads.get(name)
  if (!state) return false
  state.controller.abort()
  return true
}

export function deleteVoiceModel(name: string): void {
  const model = resolveModel(name)
  const filePath = path.join(modelsDir(), model.fileName)
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
}

function getInstalledModelPath(name: string): string {
  const model = resolveModel(name)
  const fullPath = path.join(modelsDir(), model.fileName)
  if (!fs.existsSync(fullPath)) {
    throw new VoiceError(`Model '${name}' is not installed`, 'MODEL_NOT_INSTALLED', 400)
  }
  return fullPath
}

export async function transcribeAudio(params: {
  audioBuffer: Buffer
  language?: string
  modelName: string
  temperature?: number
  prompt?: string
  translateToEnglish?: boolean
  suppressNonSpeechTokens?: boolean
}): Promise<{ text: string; durationMs: number; model: string; language: string }> {
  const { audioBuffer, modelName } = params
  const language = params.language && params.language.trim().length > 0 ? params.language : 'auto'
  const temperature = Number.isFinite(Number(params.temperature))
    ? Math.max(0, Math.min(1, Number(params.temperature)))
    : 0
  const prompt = (params.prompt ?? '').trim()
  const translateToEnglish = params.translateToEnglish === true
  const suppressNst = params.suppressNonSpeechTokens !== false
  if (language.length > MAX_LANG_LENGTH || !/^[a-z-]+$/i.test(language)) {
    throw new VoiceError(`Invalid language '${language}'`, 'LANGUAGE_INVALID', 400)
  }
  const modelPath = getInstalledModelPath(modelName)
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kobo-voice-'))
  const audioPath = path.join(tmpDir, 'input.webm')
  const wavPath = path.join(tmpDir, 'input.wav')

  try {
    fs.writeFileSync(audioPath, audioBuffer)
    // Normalize browser-recorded audio (webm/ogg/...) to a mono WAV file that
    // whisper-cli can decode reliably across platforms.
    await execFileAsync(resolveFfmpegCommand(), ['-y', '-i', audioPath, '-ar', '16000', '-ac', '1', wavPath], {
      timeout: 60000,
    })

    const cmd = resolveWhisperCommand()
    const args = [
      '-m',
      modelPath,
      '-f',
      wavPath,
      '-otxt',
      '-of',
      path.join(tmpDir, 'out'),
      '--temperature',
      String(temperature),
    ]
    if (language !== 'auto') args.push('-l', language)
    if (translateToEnglish) args.push('--translate')
    if (suppressNst) args.push('--suppress-nst')
    if (prompt.length > 0) args.push('--prompt', prompt)

    const start = Date.now()
    const { stderr } = await execFileAsync(cmd, args, { timeout: 120000 })
    const durationMs = Date.now() - start
    const outTxt = path.join(tmpDir, 'out.txt')
    if (!fs.existsSync(outTxt)) {
      throw new VoiceError(`Transcription output missing (${stderr || 'no stderr'})`, 'TRANSCRIPTION_FAILED', 500)
    }
    const text = fs.readFileSync(outTxt, 'utf-8').trim()
    return { text, durationMs, model: modelName, language }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message.includes('ENOENT')) {
      throw new VoiceError('Voice runtime missing (whisper-cli or ffmpeg)', 'VOICE_RUNTIME_MISSING', 500)
    }
    if (message.includes('timed out')) {
      throw new VoiceError('Whisper transcription timed out', 'TRANSCRIPTION_TIMEOUT', 500)
    }
    throw err
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}
