import fs from 'node:fs'
import path from 'node:path'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import {
  DOCUMENT_EXTENSIONS,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_REQUEST_BYTES,
  validateAttachments,
} from '../../shared/attachments.js'
import { attachmentReference, saveAttachments } from '../services/attachment-service.js'
import * as imageService from '../services/image-service.js'
import * as workspaceService from '../services/workspace-service.js'
import { ensureDirectoryInside, isPathInside } from '../utils/safe-path.js'
import { WorkspaceLifecycleBusyError, withWorkspaceLifecycleGuard } from '../utils/workspace-lifecycle-guard.js'

const MAX_FILE_SIZE = MAX_ATTACHMENT_BYTES

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

// New chat uploads share formats, limits and storage with workspace creation.
app.post('/:id/attachments', bodyLimit({ maxSize: MAX_ATTACHMENT_REQUEST_BYTES }), async (c) => {
  try {
    const { id } = c.req.param()
    let form: FormData
    try {
      form = await c.req.raw.formData()
    } catch {
      return c.json({ error: 'Invalid multipart body' }, 400)
    }
    const files = form.getAll('attachment')
    if (files.length !== 1 || !(files[0] instanceof File)) return c.json({ error: 'Expected one attachment file' }, 400)
    const file = files[0]
    const error = validateAttachments([file])
    if (error) return c.json({ error: `Invalid attachment: ${error}`, code: error }, 400)
    return await withWorkspaceLifecycleGuard(id, async () => {
      const workspace = workspaceService.getWorkspace(id)
      if (!workspace) return c.json({ error: 'Workspace not found' }, 404)
      if (workspace.worktreePurgedAt) return c.json({ error: 'Restore the worktree before uploading files' }, 409)
      const [saved] = await saveAttachments(workspace.worktreePath, [file])
      return c.json({ ...saved!, path: saved!.relativePath, reference: attachmentReference(saved!) }, 201)
    })
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : String(error) },
      error instanceof WorkspaceLifecycleBusyError ? 409 : 500,
    )
  }
})

app.delete('/:id/attachments/:filename', async (c) => {
  try {
    const { id, filename } = c.req.param()
    // Accept only the generated document layout, never a caller-supplied path.
    if (
      !/^[A-Za-z0-9_-]{10}\.[a-z]+$/.test(filename) ||
      !(DOCUMENT_EXTENSIONS as readonly string[]).includes(path.extname(filename))
    ) {
      return c.json({ error: 'Invalid attachment filename' }, 400)
    }
    return await withWorkspaceLifecycleGuard(id, async () => {
      const workspace = workspaceService.getWorkspace(id)
      if (!workspace) return c.json({ error: 'Workspace not found' }, 404)
      if (workspace.worktreePurgedAt) return c.json({ error: 'Worktree is purged' }, 409)
      const directory = ensureDirectoryInside(workspace.worktreePath, '.ai/attachments')
      // unlink removes a replaced leaf symlink itself; it never follows it.
      fs.unlinkSync(path.join(directory, filename))
      return c.body(null, 204)
    })
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === 'ENOENT'
    return c.json(
      { error: error instanceof Error ? error.message : String(error) },
      error instanceof WorkspaceLifecycleBusyError ? 409 : missing ? 404 : 500,
    )
  }
})

// POST /:id/images — upload an image
app.post('/:id/images', bodyLimit({ maxSize: MAX_ATTACHMENT_REQUEST_BYTES }), async (c) => {
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
      return c.json({ error: `File too large (${(buffer.length / 1024 / 1024).toFixed(1)} MB). Max: 50 MB` }, 400)
    }

    const worktreePath = workspace.worktreePath
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
    if (!/^\.ai\/images\/[^/]+$/.test(requested) || requested.includes('..')) {
      return c.json({ error: 'Invalid or disallowed image path' }, 400)
    }

    const worktreePath = workspace.worktreePath
    const imagesRoot = path.resolve(worktreePath, '.ai/images')
    const fullPath = path.resolve(worktreePath, requested)
    // Containment check: fullPath must be a descendant of imagesRoot. `+ path.sep`
    // guards against prefix collisions (`.../images-evil`).
    if (fullPath !== imagesRoot && !fullPath.startsWith(imagesRoot + path.sep)) {
      return c.json({ error: 'Path escapes images root' }, 400)
    }

    if (!fs.existsSync(imagesRoot) || fs.lstatSync(imagesRoot).isSymbolicLink()) {
      return c.json({ error: 'Invalid images root' }, 400)
    }
    if (!fs.existsSync(fullPath)) return c.json({ error: 'Image not found' }, 404)
    const fileStat = fs.lstatSync(fullPath)
    if (fileStat.isSymbolicLink()) return c.json({ error: 'Symbolic links are not allowed' }, 400)
    const realWorktree = await fs.promises.realpath(worktreePath)
    const realImagesRoot = await fs.promises.realpath(imagesRoot)
    const realFile = await fs.promises.realpath(fullPath)
    if (!isPathInside(realWorktree, realImagesRoot) || !isPathInside(realImagesRoot, realFile)) {
      return c.json({ error: 'Path escapes images root' }, 400)
    }

    let buffer: Buffer
    try {
      buffer = await fs.promises.readFile(realFile)
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

    const worktreePath = workspace.worktreePath
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
