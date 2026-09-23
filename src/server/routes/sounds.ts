import fs from 'node:fs'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { MAX_CUSTOM_SOUND_BYTES } from '../../shared/notification-assets.js'
import {
  CustomSoundError,
  deleteCustomSound,
  listCustomSounds,
  readCustomSound,
  saveCustomSound,
} from '../services/custom-sound-service.js'

/** Multipart framing and the field name add a small, bounded overhead. */
const MAX_REQUEST_BYTES = MAX_CUSTOM_SOUND_BYTES + 64 * 1024

const app = new Hono()

// `listCustomSounds` degrades a damaged manifest to an empty list; it never throws.
app.get('/', (c) => c.json({ sounds: listCustomSounds() }))

app.post('/', bodyLimit({ maxSize: MAX_REQUEST_BYTES }), async (c) => {
  let form: FormData
  try {
    form = await c.req.raw.formData()
  } catch {
    return c.json({ error: 'Invalid multipart body' }, 400)
  }
  const files = form.getAll('sound')
  if (files.length !== 1 || !(files[0] instanceof File)) return c.json({ error: 'Expected one sound file' }, 400)
  try {
    return c.json(await saveCustomSound(files[0]), 201)
  } catch (error) {
    // Only the stable code crosses the boundary: a filesystem error may carry
    // the layout of the user's home directory.
    if (error instanceof CustomSoundError) return c.json({ error: 'Invalid sound file', code: error.code }, 400)
    return c.json({ error: 'Cannot store the sound file' }, 500)
  }
})

app.delete('/:id', (c) => {
  try {
    return deleteCustomSound(c.req.param('id')) ? c.body(null, 204) : c.json({ error: 'Sound not found' }, 404)
  } catch {
    return c.json({ error: 'Cannot remove the sound file' }, 500)
  }
})

// An unknown or deleted sound answers 404; the client then falls back to a bundled tone.
app.get('/:id/file', async (c) => {
  const sound = readCustomSound(c.req.param('id'))
  if (!sound) return c.json({ error: 'Sound not found' }, 404)
  let content: Buffer
  try {
    content = await fs.promises.readFile(sound.filePath)
  } catch {
    // The file vanished between the manifest lookup and the read.
    return c.json({ error: 'Sound not found' }, 404)
  }
  c.header('Content-Type', sound.contentType)
  // Content-addressed by a generated id: the bytes behind an id never change.
  c.header('Cache-Control', 'private, max-age=3600, immutable')
  c.header('X-Content-Type-Options', 'nosniff')
  return c.body(new Uint8Array(content))
})

export default app
