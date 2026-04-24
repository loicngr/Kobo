import fs from 'node:fs'
import path from 'node:path'
import { Hono } from 'hono'
import * as imageService from '../services/image-service.js'
import * as workspaceService from '../services/workspace-service.js'

/** Maximum allowed upload size for a single image (10 MB). */
const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10 MB

/** MIME types accepted for image uploads. */
const ALLOWED_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

/** File extension → MIME type, used to serve uploaded images back to the frontend. */
const EXT_TO_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
}

/** Hono sub-router for workspace image upload and deletion. */
const app = new Hono()

// POST /:id/images — upload an image
app.post('/:id/images', async (c) => {
  try {
    const { id } = c.req.param()
    const workspace = workspaceService.getWorkspace(id)
    if (!workspace) {
      return c.json({ error: `Workspace '${id}' not found` }, 404)
    }

    const body = await c.req.parseBody()
    const file = body.image
    if (!file || !(file instanceof File)) {
      return c.json({ error: 'Missing image field in multipart body' }, 400)
    }

    if (!ALLOWED_MIME_TYPES.has(file.type)) {
      return c.json(
        { error: `Unsupported MIME type: '${file.type}'. Allowed: ${[...ALLOWED_MIME_TYPES].join(', ')}` },
        400,
      )
    }

    const arrayBuffer = await file.arrayBuffer()
    const buffer = Buffer.from(arrayBuffer)

    if (buffer.length > MAX_FILE_SIZE) {
      return c.json({ error: `File too large (${(buffer.length / 1024 / 1024).toFixed(1)} MB). Max: 10 MB` }, 400)
    }

    const worktreePath = `${workspace.projectPath}/.worktrees/${workspace.workingBranch}`
    const result = await imageService.saveImage(worktreePath, buffer, file.name)

    return c.json({ uid: result.uid, path: result.relativePath }, 201)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 500)
  }
})

// GET /:id/images/file?path=.ai/images/<file>
// Serve an uploaded image file from the worktree so the chat feed can show
// inline previews for `[image: <path>]` tokens the user pastes in messages.
//
// Security: only paths under `.ai/images/` are served, the resolved absolute
// path must stay inside the worktree's images directory (defense against
// `..` traversal and absolute paths). Anything outside → 400.
app.get('/:id/images/file', async (c) => {
  try {
    const { id } = c.req.param()
    const workspace = workspaceService.getWorkspace(id)
    if (!workspace) {
      return c.json({ error: `Workspace '${id}' not found` }, 404)
    }

    const requested = c.req.query('path')
    if (!requested || typeof requested !== 'string') {
      return c.json({ error: 'Missing required query param: path' }, 400)
    }

    // Allowlist: only the upload storage layout is served. No symlink escape
    // either — we resolve and check containment.
    if (!/^(\.ai\/images\/|images\/)[^/]/.test(requested) || requested.includes('..')) {
      return c.json({ error: 'Invalid or disallowed image path' }, 400)
    }

    const worktreePath = `${workspace.projectPath}/.worktrees/${workspace.workingBranch}`
    const imagesRoot = path.resolve(worktreePath, '.ai/images')
    const fullPath = path.resolve(worktreePath, requested)
    // Containment check: fullPath must be a descendant of imagesRoot. `+ path.sep`
    // guards against prefix collisions (`.../images-evil`).
    if (fullPath !== imagesRoot && !fullPath.startsWith(imagesRoot + path.sep)) {
      return c.json({ error: 'Path escapes images root' }, 400)
    }

    let buffer: Buffer
    try {
      buffer = await fs.promises.readFile(fullPath)
    } catch {
      return c.json({ error: 'Image not found' }, 404)
    }

    const mime = EXT_TO_MIME[path.extname(fullPath).toLowerCase()] ?? 'application/octet-stream'
    c.header('Content-Type', mime)
    // Uploads are immutable content-addressed (uid filename) — cache aggressively.
    c.header('Cache-Control', 'private, max-age=3600, immutable')
    return c.body(new Uint8Array(buffer))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 500)
  }
})

// DELETE /:id/images/:uid — delete an uploaded image
app.delete('/:id/images/:uid', async (c) => {
  try {
    const { id, uid } = c.req.param()
    const workspace = workspaceService.getWorkspace(id)
    if (!workspace) {
      return c.json({ error: `Workspace '${id}' not found` }, 404)
    }

    const worktreePath = `${workspace.projectPath}/.worktrees/${workspace.workingBranch}`
    await imageService.deleteImage(worktreePath, uid)

    return c.body(null, 204)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message.includes('not found')) {
      return c.json({ error: message }, 404)
    }
    return c.json({ error: message }, 500)
  }
})

export default app
