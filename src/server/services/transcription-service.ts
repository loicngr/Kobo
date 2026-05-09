import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
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
  },
  {
    name: 'base',
    fileName: 'ggml-base.bin',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin?download=true',
  },
  {
    name: 'small',
    fileName: 'ggml-small.bin',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin?download=true',
  },
  {
    name: 'medium',
    fileName: 'ggml-medium.bin',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin?download=true',
  },
  {
    name: 'large-v3',
    fileName: 'ggml-large-v3.bin',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin?download=true',
  },
]

function voiceHome(): string {
  return path.join(getKoboHome(), 'voice')
}

function modelsDir(): string {
  return path.join(voiceHome(), 'models', 'whisper')
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
  available: Array<{ name: string; installed: boolean; fileName: string }>
  activeModel: string | null
} {
  ensureVoiceDirs()
  const settings = getGlobalSettings()
  const available = VOICE_MODELS.map((m) => ({
    name: m.name,
    fileName: m.fileName,
    installed: fs.existsSync(path.join(modelsDir(), m.fileName)),
  }))
  return { available, activeModel: settings.voiceModel }
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
  const res = await fetch(model.url)
  if (!res.ok) {
    throw new VoiceError(`Failed to download model '${name}' (HTTP ${res.status})`, 'MODEL_DOWNLOAD_FAILED', 500)
  }
  const filePath = path.join(modelsDir(), model.fileName)
  const tmpPath = `${filePath}.tmp`
  try {
    const bytes = Buffer.from(await res.arrayBuffer())
    fs.writeFileSync(tmpPath, bytes)
    fs.renameSync(tmpPath, filePath)
  } finally {
    if (fs.existsSync(tmpPath)) fs.rmSync(tmpPath, { force: true })
  }
  return { name, filePath }
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
