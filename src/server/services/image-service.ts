// src/server/services/image-service.ts
import fs from 'node:fs'
import path from 'node:path'
import { nanoid } from 'nanoid'

export interface SavedImage {
  uid: string
  relativePath: string
}

export interface ImageIndexEntry {
  uid: string
  originalName: string
  createdAt: string
}

const ALLOWED_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp'])
const IMAGES_DIR = '.ai/images'
const INDEX_FILE = 'index.json'

// Per-worktree lock to serialize index.json writes
const locks = new Map<string, Promise<void>>()

function withLock<T>(worktreePath: string, fn: () => T): Promise<T> {
  const prev = locks.get(worktreePath) ?? Promise.resolve()
  // The second argument to .then() means: even if the previous operation in the
  // queue rejected, still run fn — one failure must not block the whole queue.
  const next = prev.then(fn, fn)
  locks.set(worktreePath, next.then(() => {}, () => {}))
  return next
}

function readIndex(imagesDir: string): ImageIndexEntry[] {
  const indexPath = path.join(imagesDir, INDEX_FILE)
  if (!fs.existsSync(indexPath)) return []
  try {
    return JSON.parse(fs.readFileSync(indexPath, 'utf-8'))
  } catch (err) {
    console.error(`[image-service] Failed to parse ${indexPath}, treating as empty index:`, err)
    return []
  }
}

function writeIndex(imagesDir: string, entries: ImageIndexEntry[]): void {
  fs.writeFileSync(path.join(imagesDir, INDEX_FILE), JSON.stringify(entries, null, 2))
}

export async function saveImage(
  worktreePath: string,
  fileBuffer: Buffer,
  originalName: string,
): Promise<SavedImage> {
  const ext = path.extname(originalName).toLowerCase().replace('.', '')
  if (!ext) {
    throw new Error(`File has no extension. Allowed: ${[...ALLOWED_EXTENSIONS].join(', ')}`)
  }
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw new Error(`Unsupported image extension: '${ext}'. Allowed: ${[...ALLOWED_EXTENSIONS].join(', ')}`)
  }

  const uid = nanoid(10)
  const imagesDir = path.join(worktreePath, IMAGES_DIR)
  // mkdirSync is idempotent — safe to call outside the lock
  fs.mkdirSync(imagesDir, { recursive: true })

  const filename = `${uid}.${ext}`

  await withLock(worktreePath, () => {
    // Write the image file inside the lock so both the file write and index
    // update happen atomically — avoids orphan files on crash between the two.
    fs.writeFileSync(path.join(imagesDir, filename), fileBuffer)
    const entries = readIndex(imagesDir)
    entries.push({ uid, originalName, createdAt: new Date().toISOString() })
    writeIndex(imagesDir, entries)
  })

  return { uid, relativePath: `${IMAGES_DIR}/${filename}` }
}

export async function deleteImage(worktreePath: string, uid: string): Promise<void> {
  const imagesDir = path.join(worktreePath, IMAGES_DIR)

  await withLock(worktreePath, () => {
    const entries = readIndex(imagesDir)
    const idx = entries.findIndex((e) => e.uid === uid)
    if (idx === -1) {
      throw new Error(`Image '${uid}' not found in index`)
    }

    // Find the file on disk (we need the extension)
    const files = fs.existsSync(imagesDir) ? fs.readdirSync(imagesDir) : []
    const imageFile = files.find((f) => f.startsWith(`${uid}.`))
    if (imageFile) {
      fs.unlinkSync(path.join(imagesDir, imageFile))
    }

    entries.splice(idx, 1)
    writeIndex(imagesDir, entries)
  })
}
