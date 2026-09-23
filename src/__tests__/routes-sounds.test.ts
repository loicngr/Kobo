import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import soundsRouter from '../server/routes/sounds.js'
import { MAX_CUSTOM_SOUND_BYTES } from '../shared/notification-assets.js'

vi.mock('@hono/node-server/conninfo', () => ({ getConnInfo: () => ({ remote: { address: '127.0.0.1' } }) }))
vi.mock('../server/services/settings-service.js', () => ({
  getGlobalSettings: () => ({
    networkAccessEnabled: true,
    networkAccessBehindProxy: true,
    networkAccessToken: 'test-token',
  }),
}))

import { networkAuthMiddleware } from '../server/middleware/network-auth-middleware.js'

const app = new Hono().route('/api/sounds', soundsRouter)
let directory: string

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kobo-sounds-route-'))
  vi.stubEnv('KOBO_HOME', directory)
})
afterEach(() => {
  vi.unstubAllEnvs()
  fs.rmSync(directory, { recursive: true, force: true })
})

function upload(name: string, bytes = 16): FormData {
  const form = new FormData()
  form.append('sound', new File([new Uint8Array(bytes)], name, { type: 'audio/wav' }))
  return form
}

it('lists nothing before an import', async () => {
  const response = await app.request('/api/sounds')
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ sounds: [] })
})

it('imports a sound and serves it back with its content type', async () => {
  const created = await app.request('/api/sounds', { method: 'POST', body: upload('alert.wav') })
  expect(created.status).toBe(201)
  const sound = (await created.json()) as { id: string; name: string; reference: string }
  expect(sound.name).toBe('alert.wav')
  expect(sound.reference).toBe(`custom:${sound.id}`)

  const listed = (await (await app.request('/api/sounds')).json()) as { sounds: Array<{ id: string }> }
  expect(listed.sounds.map((entry) => entry.id)).toEqual([sound.id])

  const file = await app.request(`/api/sounds/${sound.id}/file`)
  expect(file.status).toBe(200)
  expect(file.headers.get('Content-Type')).toBe('audio/wav')
  expect((await file.arrayBuffer()).byteLength).toBe(16)
})

it('rejects an unsupported format with a stable code', async () => {
  const response = await app.request('/api/sounds', { method: 'POST', body: upload('clip.flac') })
  expect(response.status).toBe(400)
  expect(await response.json()).toMatchObject({ code: 'type' })
})

it('rejects a request without exactly one file', async () => {
  const form = new FormData()
  form.append('sound', 'not-a-file')
  expect((await app.request('/api/sounds', { method: 'POST', body: form })).status).toBe(400)
  expect((await app.request('/api/sounds', { method: 'POST', body: new FormData() })).status).toBe(400)
})

it('rejects a non-multipart body without crashing', async () => {
  const response = await app.request('/api/sounds', {
    method: 'POST',
    body: 'raw',
    headers: { 'Content-Type': 'application/json' },
  })
  expect(response.status).toBe(400)
})

it('caps the uploaded body size', async () => {
  const response = await app.request('/api/sounds', {
    method: 'POST',
    body: upload('big.wav', MAX_CUSTOM_SOUND_BYTES + 1024 * 128),
  })
  expect(response.status).toBe(413)
})

it('deletes an imported sound and reports an unknown one', async () => {
  const sound = (await (await app.request('/api/sounds', { method: 'POST', body: upload('bye.wav') })).json()) as {
    id: string
  }
  expect((await app.request(`/api/sounds/${sound.id}`, { method: 'DELETE' })).status).toBe(204)
  expect((await app.request(`/api/sounds/${sound.id}`, { method: 'DELETE' })).status).toBe(404)
  expect((await app.request(`/api/sounds/${sound.id}/file`)).status).toBe(404)
})

it.each(['..%2F..%2Fsettings.json', 'short', 'abcdef123456'])('refuses to serve the id %s', async (id) => {
  expect((await app.request(`/api/sounds/${id}/file`)).status).toBe(404)
})

it('protects the catalogue behind the network token gate', async () => {
  const gated = new Hono().use('/api/*', networkAuthMiddleware).route('/api/sounds', soundsRouter)
  expect((await gated.request('/api/sounds')).status).toBe(401)
  expect((await gated.request('/api/sounds', { headers: { 'X-Kobo-Token': 'test-token' } })).status).toBe(200)
})
