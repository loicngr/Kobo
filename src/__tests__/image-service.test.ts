import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { deleteImage, saveImage } from '../server/services/image-service.js'

describe('image-service', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kobo-img-test-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  describe('saveImage', () => {
    it('saves a PNG file and returns uid + relativePath', async () => {
      const result = await saveImage(tmpDir, Buffer.from('fake-image-data'), 'photo.png')

      expect(result.uid).toBeTruthy()
      expect(result.uid).toHaveLength(10)
      expect(result.relativePath).toBe(`.ai/images/${result.uid}.png`)
    })

    it('creates the .ai/images/ directory if it does not exist', async () => {
      const imagesDir = path.join(tmpDir, '.ai', 'images')
      expect(fs.existsSync(imagesDir)).toBe(false)

      await saveImage(tmpDir, Buffer.from('fake-image-data'), 'photo.jpg')

      expect(fs.existsSync(imagesDir)).toBe(true)
    })

    it('writes the file to disk with correct content', async () => {
      const content = Buffer.from('specific-image-bytes')
      const result = await saveImage(tmpDir, content, 'image.webp')

      const filePath = path.join(tmpDir, result.relativePath)
      expect(fs.existsSync(filePath)).toBe(true)
      expect(fs.readFileSync(filePath)).toEqual(content)
    })

    it('creates index.json with the entry', async () => {
      const result = await saveImage(tmpDir, Buffer.from('fake-image-data'), 'test.gif')

      const indexPath = path.join(tmpDir, '.ai', 'images', 'index.json')
      expect(fs.existsSync(indexPath)).toBe(true)

      const entries = JSON.parse(fs.readFileSync(indexPath, 'utf-8'))
      expect(entries).toHaveLength(1)
      expect(entries[0].uid).toBe(result.uid)
      expect(entries[0].originalName).toBe('test.gif')
      expect(entries[0].createdAt).toBeTruthy()
    })

    it('rejects unsupported extension (.exe)', async () => {
      await expect(saveImage(tmpDir, Buffer.from('fake-data'), 'malware.exe')).rejects.toThrow(
        "Unsupported image extension: 'exe'",
      )
    })

    it('rejects unsupported extension (.svg)', async () => {
      await expect(saveImage(tmpDir, Buffer.from('fake-data'), 'image.svg')).rejects.toThrow(
        "Unsupported image extension: 'svg'",
      )
    })

    it('rejects files with no extension', async () => {
      await expect(saveImage(tmpDir, Buffer.from('fake-data'), 'noextension')).rejects.toThrow('File has no extension')
    })

    it('handles multiple saves — index grows with each entry', async () => {
      await saveImage(tmpDir, Buffer.from('data1'), 'a.png')
      await saveImage(tmpDir, Buffer.from('data2'), 'b.jpg')
      await saveImage(tmpDir, Buffer.from('data3'), 'c.jpeg')

      const indexPath = path.join(tmpDir, '.ai', 'images', 'index.json')
      const entries = JSON.parse(fs.readFileSync(indexPath, 'utf-8'))
      expect(entries).toHaveLength(3)
    })

    it('supports all allowed extensions (jpg, jpeg, gif, webp)', async () => {
      const extensions = ['jpg', 'jpeg', 'gif', 'webp']

      for (const ext of extensions) {
        const result = await saveImage(tmpDir, Buffer.from('fake-data'), `image.${ext}`)
        expect(result.relativePath).toMatch(new RegExp(`\\.${ext}$`))
      }

      const indexPath = path.join(tmpDir, '.ai', 'images', 'index.json')
      const entries = JSON.parse(fs.readFileSync(indexPath, 'utf-8'))
      expect(entries).toHaveLength(extensions.length)
    })
  })

  describe('deleteImage', () => {
    it('deletes an existing image file and removes it from the index', async () => {
      const result = await saveImage(tmpDir, Buffer.from('fake-image-data'), 'to-delete.png')
      const filePath = path.join(tmpDir, result.relativePath)
      expect(fs.existsSync(filePath)).toBe(true)

      await deleteImage(tmpDir, result.uid)

      expect(fs.existsSync(filePath)).toBe(false)
    })

    it('throws a descriptive error for an unknown UID', async () => {
      await expect(deleteImage(tmpDir, 'unknownUID')).rejects.toThrow("Image 'unknownUID' not found in index")
    })

    it('after delete, index no longer contains the entry', async () => {
      const r1 = await saveImage(tmpDir, Buffer.from('data1'), 'keep.png')
      const r2 = await saveImage(tmpDir, Buffer.from('data2'), 'remove.jpg')

      await deleteImage(tmpDir, r2.uid)

      const indexPath = path.join(tmpDir, '.ai', 'images', 'index.json')
      const entries = JSON.parse(fs.readFileSync(indexPath, 'utf-8'))
      expect(entries).toHaveLength(1)
      expect(entries[0].uid).toBe(r1.uid)
    })

    it('throws when deleting an already-deleted image', async () => {
      const result = await saveImage(tmpDir, Buffer.from('fake-image-data'), 'once.png')
      await deleteImage(tmpDir, result.uid)

      await expect(deleteImage(tmpDir, result.uid)).rejects.toThrow(`Image '${result.uid}' not found in index`)
    })
  })

  describe('concurrency', () => {
    it('two concurrent saves do not corrupt index.json — both entries are present after', async () => {
      const [r1, r2] = await Promise.all([
        saveImage(tmpDir, Buffer.from('concurrent-data-1'), 'concurrent1.png'),
        saveImage(tmpDir, Buffer.from('concurrent-data-2'), 'concurrent2.png'),
      ])

      const indexPath = path.join(tmpDir, '.ai', 'images', 'index.json')
      const entries = JSON.parse(fs.readFileSync(indexPath, 'utf-8'))

      expect(entries).toHaveLength(2)
      const uids = entries.map((e: { uid: string }) => e.uid)
      expect(uids).toContain(r1.uid)
      expect(uids).toContain(r2.uid)
    })

    it('many concurrent saves all land in index.json without data loss', async () => {
      const saves = Array.from({ length: 10 }, (_, i) => saveImage(tmpDir, Buffer.from(`data-${i}`), `img-${i}.png`))
      const results = await Promise.all(saves)

      const indexPath = path.join(tmpDir, '.ai', 'images', 'index.json')
      const entries = JSON.parse(fs.readFileSync(indexPath, 'utf-8'))

      expect(entries).toHaveLength(10)
      for (const result of results) {
        const found = entries.find((e: { uid: string }) => e.uid === result.uid)
        expect(found).toBeTruthy()
      }
    })
  })
})
