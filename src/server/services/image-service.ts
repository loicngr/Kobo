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
  const key = worktreePath
  const prev = locks.get(key) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  locks.set(key, next.then(() => {}, () => {}))
  return next
}

function readIndex(imagesDir: string): ImageIndexEntry[] {
  const indexPath = path.join(imagesDir, INDEX_FILE)
  if (!fs.existsSync(indexPath)) return []
  return JSON.parse(fs.readFileSync(indexPath, 'utf-8'))
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
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw new Error(`Unsupported image extension: '${ext}'. Allowed: ${[...ALLOWED_EXTENSIONS].join(', ')}`)
  }

  const uid = nanoid(10)
  const imagesDir = path.join(worktreePath, IMAGES_DIR)
  fs.mkdirSync(imagesDir, { recursive: true })

  const filename = `${uid}.${ext}`
  fs.writeFileSync(path.join(imagesDir, filename), fileBuffer)

  await withLock(worktreePath, () => {
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
