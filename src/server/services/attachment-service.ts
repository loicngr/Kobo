import fs from 'node:fs'
import path from 'node:path'
import { nanoid } from 'nanoid'
import { attachmentFormat, validateAttachments } from '../../shared/attachments.js'
import { ensureDirectoryInside, resolvePathInside } from '../utils/safe-path.js'
import { deleteImage, saveImage } from './image-service.js'

export interface SavedAttachment {
  uid: string
  relativePath: string
  kind: 'image' | 'file'
  originalName: string
}

export class AttachmentRequestError extends Error {}

/** Existing JSON clients stay supported; browser attachments travel with the creation request. */
export async function readWorkspaceCreationRequest<T>(request: Request): Promise<{ body: T; attachments: File[] }> {
  let body: unknown
  let attachments: File[] = []
  try {
    if (request.headers.get('content-type')?.toLowerCase().startsWith('multipart/form-data')) {
      const form = await request.formData()
      const metadata = form.get('workspace')
      if (typeof metadata !== 'string' || form.getAll('workspace').length !== 1) {
        throw new AttachmentRequestError('Expected one JSON workspace field')
      }
      body = JSON.parse(metadata)
      const files = [...form.getAll('attachments'), ...form.getAll('images')]
      if (files.some((file) => !(file instanceof File))) {
        throw new AttachmentRequestError('Each attachment must be a file')
      }
      attachments = files as File[]
    } else {
      body = await request.json()
    }
  } catch (error) {
    if (error instanceof AttachmentRequestError) throw error
    throw new AttachmentRequestError('Invalid workspace creation body')
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new AttachmentRequestError('Workspace must be a JSON object')
  }
  if ('description' in body && body.description !== undefined && typeof body.description !== 'string') {
    throw new AttachmentRequestError('description must be a string')
  }
  const error = validateAttachments(attachments)
  if (error) {
    const messages = {
      type: 'Unsupported attachment type. Use PNG, JPEG, GIF, WebP, PDF, Markdown or text documents',
      size: 'Each attachment must be non-empty and no larger than 50 MB',
      count: 'A workspace can be created with at most 10 attachments',
      total: 'Creation attachments must total no more than 50 MB',
    }
    throw new AttachmentRequestError(messages[error])
  }
  return { body: body as T, attachments }
}

/** Remove only this creation's files, preserving existing worktree content. */
export async function removeAttachments(
  worktreePath: string,
  attachments: readonly SavedAttachment[],
): Promise<string[]> {
  const warnings: string[] = []
  for (const attachment of attachments) {
    try {
      if (attachment.kind === 'image') {
        await deleteImage(worktreePath, attachment.uid)
      } else {
        const directory = ensureDirectoryInside(worktreePath, '.ai/attachments')
        // Paths come exclusively from saveAttachments; never use the original upload name.
        fs.unlinkSync(path.join(directory, path.basename(attachment.relativePath)))
      }
    } catch (error) {
      warnings.push(
        `Could not remove creation attachment '${attachment.uid}': ${error instanceof Error ? error.message : error}`,
      )
    }
  }
  return warnings
}

export async function saveAttachments(worktreePath: string, files: readonly File[]): Promise<SavedAttachment[]> {
  const saved: SavedAttachment[] = []
  try {
    for (const file of files) {
      const format = attachmentFormat(file)
      if (!format) throw new AttachmentRequestError('Unsupported attachment type')
      const buffer = Buffer.from(await file.arrayBuffer())
      if (format.kind === 'image') {
        const name =
          path.extname(file.name).toLowerCase() === format.extension
            ? file.name
            : `${file.name || 'image'}${format.extension}`
        saved.push({ ...(await saveImage(worktreePath, buffer, name)), kind: 'image', originalName: file.name })
      } else {
        const directory = ensureDirectoryInside(worktreePath, '.ai/attachments')
        const ignorePath = resolvePathInside(worktreePath, '.gitignore')
        const ignore = fs.existsSync(ignorePath) ? fs.readFileSync(ignorePath, 'utf8') : ''
        if (!ignore.split('\n').some((line) => line.trim() === '.ai/attachments/')) {
          fs.appendFileSync(ignorePath, `${ignore && !ignore.endsWith('\n') ? '\n' : ''}.ai/attachments/\n`)
        }
        const uid = nanoid(10)
        const filename = `${uid}${format.extension}`
        const descriptor = fs.openSync(path.join(directory, filename), 'wx', 0o600)
        // Track ownership as soon as exclusive creation succeeds: a failed
        // write can leave bytes on disk and must participate in rollback.
        saved.push({ uid, relativePath: `.ai/attachments/${filename}`, kind: 'file', originalName: file.name })
        try {
          fs.writeFileSync(descriptor, buffer)
        } finally {
          fs.closeSync(descriptor)
        }
      }
    }
    return saved
  } catch (error) {
    const warnings = await removeAttachments(worktreePath, saved)
    for (const warning of warnings) console.error(`[creation-attachments] ${warning}`)
    throw error
  }
}

export function attachmentReference(attachment: SavedAttachment): string {
  return attachment.kind === 'image'
    ? `[image: ${attachment.relativePath}]`
    : `Attached document ${JSON.stringify(attachment.originalName)}: [file: ${attachment.relativePath}]`
}
