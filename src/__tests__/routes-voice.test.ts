import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../server/services/settings-service.js', () => ({
  getGlobalSettings: vi.fn(),
}))

vi.mock('../server/services/workspace-service.js', () => ({
  getWorkspace: vi.fn(),
}))

vi.mock('../server/services/transcription-service.js', () => {
  class VoiceError extends Error {
    code: string
    status: number
    constructor(message: string, code: string, status = 400) {
      super(message)
      this.code = code
      this.status = status
    }
  }
  return {
    VoiceError,
    listVoiceModels: vi.fn(),
    getVoiceRuntimeStatus: vi.fn(),
    downloadVoiceModel: vi.fn(),
    deleteVoiceModel: vi.fn(),
    transcribeAudio: vi.fn(),
  }
})

import router from '../server/routes/voice.js'
import * as settingsService from '../server/services/settings-service.js'
import * as transcriptionService from '../server/services/transcription-service.js'
import * as workspaceService from '../server/services/workspace-service.js'

const app = new Hono()
app.route('/api/voice', router)

const fakeWorkspace = { id: 'ws-1' }

beforeEach(() => {
  vi.clearAllMocks()
})

describe('GET /api/voice/models', () => {
  it('returns model inventory', async () => {
    vi.mocked(transcriptionService.listVoiceModels).mockReturnValue({
      available: [{ name: 'base', installed: true, fileName: 'ggml-base.bin' }],
      activeModel: 'base',
    })

    const res = await app.request('/api/voice/models')
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.activeModel).toBe('base')
    expect(data.available).toHaveLength(1)
  })
})

describe('GET /api/voice/runtime', () => {
  it('returns runtime status', async () => {
    vi.mocked(transcriptionService.getVoiceRuntimeStatus).mockResolvedValue({
      available: false,
      command: 'whisper-cli',
      error: 'spawn whisper-cli ENOENT',
      ffmpegAvailable: false,
      ffmpegError: 'spawn ffmpeg ENOENT',
    })

    const res = await app.request('/api/voice/runtime')
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.available).toBe(false)
  })
})

describe('POST /api/voice/workspaces/:id/transcribe', () => {
  it('returns 400 when feature is disabled', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(fakeWorkspace as never)
    vi.mocked(settingsService.getGlobalSettings).mockReturnValue({
      voiceEnabled: false,
      voiceModel: 'base',
    } as never)

    const body = new FormData()
    body.append('audio', new File([new Uint8Array([1, 2])], 'a.webm', { type: 'audio/webm' }))

    const res = await app.request('/api/voice/workspaces/ws-1/transcribe', { method: 'POST', body })
    expect(res.status).toBe(400)
    const data = await res.json()
    expect(data.code).toBe('VOICE_DISABLED')
  })

  it('returns 400 when language is invalid', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(fakeWorkspace as never)
    vi.mocked(settingsService.getGlobalSettings).mockReturnValue({
      voiceEnabled: true,
      voiceModel: 'base',
    } as never)

    const body = new FormData()
    body.append('audio', new File([new Uint8Array([1, 2])], 'a.webm', { type: 'audio/webm' }))
    body.append('language', 'fr$')

    const res = await app.request('/api/voice/workspaces/ws-1/transcribe', { method: 'POST', body })
    expect(res.status).toBe(400)
    const data = await res.json()
    expect(data.code).toBe('LANGUAGE_INVALID')
  })

  it('returns 200 with transcription payload on success', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(fakeWorkspace as never)
    vi.mocked(settingsService.getGlobalSettings).mockReturnValue({
      voiceEnabled: true,
      voiceModel: 'base',
    } as never)
    vi.mocked(transcriptionService.transcribeAudio).mockResolvedValue({
      text: 'bonjour',
      durationMs: 123,
      model: 'base',
      language: 'fr',
    })

    const body = new FormData()
    body.append('audio', new File([new Uint8Array([1, 2, 3])], 'a.webm', { type: 'audio/webm' }))
    body.append('language', 'fr')

    const res = await app.request('/api/voice/workspaces/ws-1/transcribe', { method: 'POST', body })
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.text).toBe('bonjour')
    expect(transcriptionService.transcribeAudio).toHaveBeenCalledOnce()
  })

  it('maps VoiceError to structured code/status', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(fakeWorkspace as never)
    vi.mocked(settingsService.getGlobalSettings).mockReturnValue({
      voiceEnabled: true,
      voiceModel: 'base',
    } as never)
    vi.mocked(transcriptionService.transcribeAudio).mockRejectedValue(
      new transcriptionService.VoiceError("Model 'base' is not installed", 'MODEL_NOT_INSTALLED', 400),
    )

    const body = new FormData()
    body.append('audio', new File([new Uint8Array([1, 2, 3])], 'a.webm', { type: 'audio/webm' }))

    const res = await app.request('/api/voice/workspaces/ws-1/transcribe', { method: 'POST', body })
    expect(res.status).toBe(400)
    const data = await res.json()
    expect(data.code).toBe('MODEL_NOT_INSTALLED')
  })
})

describe('POST /api/voice/transcribe', () => {
  it('supports draft transcription without workspace id', async () => {
    vi.mocked(settingsService.getGlobalSettings).mockReturnValue({
      voiceEnabled: true,
      voiceModel: 'base',
    } as never)
    vi.mocked(transcriptionService.transcribeAudio).mockResolvedValue({
      text: 'draft text',
      durationMs: 88,
      model: 'base',
      language: 'fr',
    })

    const body = new FormData()
    body.append('audio', new File([new Uint8Array([1, 2, 3])], 'a.webm', { type: 'audio/webm' }))
    body.append('language', 'fr')

    const res = await app.request('/api/voice/transcribe', { method: 'POST', body })
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.text).toBe('draft text')
  })
})
