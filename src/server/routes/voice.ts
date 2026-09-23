import { Hono } from 'hono'
import * as settingsService from '../services/settings-service.js'
import * as transcriptionService from '../services/transcription-service.js'
import * as workspaceService from '../services/workspace-service.js'

const app = new Hono()

const MAX_AUDIO_SIZE = 10 * 1024 * 1024
const ALLOWED_AUDIO_MIME = new Set(['audio/webm', 'audio/ogg', 'audio/wav', 'audio/mpeg', 'audio/mp4'])
const LANGUAGE_RE = /^[a-z-]+$/i

function isVoiceLikeError(err: unknown): err is { message: string; code: string; status: number } {
  if (!err || typeof err !== 'object') return false
  const e = err as Record<string, unknown>
  return typeof e.message === 'string' && typeof e.code === 'string' && typeof e.status === 'number'
}

function toVoiceHttpStatus(status: number): 400 | 500 {
  return status === 400 ? 400 : 500
}

async function parseAndTranscribeFromBody(
  c: { req: { parseBody: () => Promise<Record<string, unknown>> }; json: (obj: unknown, status?: number) => Response },
  config: {
    modelName: string
    temperature?: number
    prompt?: string
    translateToEnglish?: boolean
    suppressNonSpeechTokens?: boolean
  },
) {
  const body = await c.req.parseBody()
  const audio = body.audio
  const languageRaw = body.language
  const language = typeof languageRaw === 'string' && languageRaw.trim().length > 0 ? languageRaw.trim() : 'auto'
  if (language !== 'auto' && (!LANGUAGE_RE.test(language) || language.length > 16)) {
    return c.json({ error: `Invalid language '${language}'`, code: 'LANGUAGE_INVALID' }, 400)
  }
  if (!audio || !(audio instanceof File)) {
    return c.json({ error: 'Missing audio field in multipart body', code: 'MIC_AUDIO_INVALID' }, 400)
  }
  if (!ALLOWED_AUDIO_MIME.has(audio.type)) {
    return c.json({ error: `Unsupported audio type '${audio.type}'`, code: 'MIC_AUDIO_INVALID' }, 400)
  }
  const buffer = Buffer.from(await audio.arrayBuffer())
  if (buffer.length === 0 || buffer.length > MAX_AUDIO_SIZE) {
    return c.json({ error: 'Invalid audio size', code: 'MIC_AUDIO_INVALID' }, 400)
  }

  const result = await transcriptionService.transcribeAudio({
    audioBuffer: buffer,
    modelName: config.modelName,
    language,
    temperature: config.temperature,
    prompt: config.prompt,
    translateToEnglish: config.translateToEnglish,
    suppressNonSpeechTokens: config.suppressNonSpeechTokens,
  })
  return c.json(result)
}

app.get('/models', (c) => {
  try {
    return c.json(transcriptionService.listVoiceModels())
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 500)
  }
})

app.get('/runtime', async (c) => {
  try {
    const status = await transcriptionService.getVoiceRuntimeStatus()
    return c.json(status)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message, code: 'VOICE_RUNTIME_CHECK_FAILED' }, 500)
  }
})

app.post('/models/:name/download', async (c) => {
  try {
    const name = c.req.param('name')
    const result = await transcriptionService.downloadVoiceModel(name)
    return c.json(result, 201)
  } catch (err) {
    if (err instanceof transcriptionService.VoiceError || isVoiceLikeError(err)) {
      return c.json({ error: err.message, code: err.code }, toVoiceHttpStatus(err.status))
    }
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message, code: 'MODEL_DOWNLOAD_FAILED' }, 500)
  }
})

app.delete('/models/:name/download', (c) => {
  const name = c.req.param('name')
  const cancelled = transcriptionService.cancelVoiceModelDownload(name)
  if (!cancelled) {
    return c.json({ error: `No download in progress for model '${name}'`, code: 'MODEL_DOWNLOAD_NOT_RUNNING' }, 404)
  }
  return c.body(null, 204)
})

app.delete('/models/:name', (c) => {
  try {
    const name = c.req.param('name')
    transcriptionService.deleteVoiceModel(name)
    return c.body(null, 204)
  } catch (err) {
    if (err instanceof transcriptionService.VoiceError || isVoiceLikeError(err)) {
      return c.json({ error: err.message, code: err.code }, toVoiceHttpStatus(err.status))
    }
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message, code: 'MODEL_DELETE_FAILED' }, 500)
  }
})

app.post('/workspaces/:id/transcribe', async (c) => {
  try {
    const id = c.req.param('id')
    const workspace = workspaceService.getWorkspace(id)
    if (!workspace) return c.json({ error: `Workspace '${id}' not found` }, 404)

    const global = settingsService.getGlobalSettings()
    if (!global.voiceEnabled) {
      return c.json({ error: 'Voice transcription is disabled', code: 'VOICE_DISABLED' }, 400)
    }
    if (!global.voiceModel) {
      return c.json({ error: 'No voice model configured', code: 'MODEL_NOT_CONFIGURED' }, 400)
    }

    return await parseAndTranscribeFromBody(c, {
      modelName: global.voiceModel,
      temperature: global.voiceTemperature,
      prompt: global.voicePrompt,
      translateToEnglish: global.voiceTranslateToEnglish,
      suppressNonSpeechTokens: global.voiceSuppressNonSpeechTokens,
    })
  } catch (err) {
    if (err instanceof transcriptionService.VoiceError || isVoiceLikeError(err)) {
      return c.json({ error: err.message, code: err.code }, toVoiceHttpStatus(err.status))
    }
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message, code: 'TRANSCRIPTION_FAILED' }, 500)
  }
})

// Draft transcription endpoint used before a workspace exists (Create page).
app.post('/transcribe', async (c) => {
  try {
    const global = settingsService.getGlobalSettings()
    if (!global.voiceEnabled) {
      return c.json({ error: 'Voice transcription is disabled', code: 'VOICE_DISABLED' }, 400)
    }
    if (!global.voiceModel) {
      return c.json({ error: 'No voice model configured', code: 'MODEL_NOT_CONFIGURED' }, 400)
    }
    return await parseAndTranscribeFromBody(c, {
      modelName: global.voiceModel,
      temperature: global.voiceTemperature,
      prompt: global.voicePrompt,
      translateToEnglish: global.voiceTranslateToEnglish,
      suppressNonSpeechTokens: global.voiceSuppressNonSpeechTokens,
    })
  } catch (err) {
    if (err instanceof transcriptionService.VoiceError) {
      return c.json({ error: err.message, code: err.code }, toVoiceHttpStatus(err.status))
    }
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message, code: 'TRANSCRIPTION_FAILED' }, 500)
  }
})

export default app
