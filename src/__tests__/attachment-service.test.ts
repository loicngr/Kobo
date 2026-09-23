import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  readWorkspaceCreationRequest,
  removeAttachments,
  saveAttachments,
} from '../server/services/attachment-service.js'
import { MAX_ATTACHMENT_BYTES, validateAttachments } from '../shared/attachments.js'

const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})
function root() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kobo-create-images-'))
  roots.push(dir)
  return dir
}
function request(images: File[], metadata = '{}') {
  const form = new FormData()
  form.append('workspace', metadata)
  for (const image of images) form.append('attachments', image)
  return new Request('http://localhost/api/workspaces', { method: 'POST', body: form })
}

describe('creation images', () => {
  it('still reads JSON requests without images', async () => {
    const req = new Request('http://localhost', { method: 'POST', body: JSON.stringify({ name: 'Task' }) })
    expect(await readWorkspaceCreationRequest(req)).toEqual({ body: { name: 'Task' }, attachments: [] })
  })

  it.each(['null', '[]', 'invalid', '{"description":42}'])('rejects malformed workspace metadata: %s', async (body) => {
    await expect(readWorkspaceCreationRequest(request([], body))).rejects.toThrow()
  })

  it('rejects too many files and oversized or empty images', async () => {
    const image = new File(['pixels'], 'screen.png', { type: 'image/png' })
    await expect(readWorkspaceCreationRequest(request(Array(11).fill(image)))).rejects.toThrow('at most 10')
    await expect(
      readWorkspaceCreationRequest(request([new File([], 'empty.png', { type: 'image/png' })])),
    ).rejects.toThrow('non-empty')
    const large = new File([new Uint8Array(MAX_ATTACHMENT_BYTES + 1)], 'large.png', { type: 'image/png' })
    await expect(readWorkspaceCreationRequest(request([large]))).rejects.toThrow('50 MB')
  })

  it('enforces the cumulative limit independently of individual image sizes', () => {
    const image = { type: 'image/png', size: 10 * 1024 * 1024 }
    expect(validateAttachments([{ name: 'large.pdf', type: 'application/pdf', size: 50 * 1024 * 1024 }])).toBeNull()
    expect(validateAttachments(Array(5).fill(image))).toBeNull()
    expect(validateAttachments(Array(6).fill(image))).toBe('total')
  })

  it('rejects ambiguous metadata and non-file attachments', async () => {
    const form = new FormData()
    form.append('workspace', '{}')
    form.append('images', 'not a file')
    const req = () => new Request('http://localhost', { method: 'POST', body: form })
    await expect(readWorkspaceCreationRequest(req())).rejects.toThrow('must be a file')
    form.delete('images')
    form.append('workspace', '{}')
    await expect(readWorkspaceCreationRequest(req())).rejects.toThrow('one JSON workspace')
  })

  it('accepts document extensions even when the browser sends an empty or generic MIME type', async () => {
    const files = [
      new File(['# Brief'], 'brief.MD'),
      new File(['Notes'], 'notes.txt', { type: 'application/octet-stream' }),
      new File(['%PDF-1.7'], 'brief.pdf', { type: 'application/pdf' }),
      new File(['{"key":1}'], 'data.json', { type: 'application/json' }),
    ]
    const result = await readWorkspaceCreationRequest(request(files))
    expect(result.attachments.map((file) => file.name)).toEqual(files.map((file) => file.name))
    const dir = root()
    const saved = await saveAttachments(dir, result.attachments)
    for (let i = 0; i < files.length; i++) {
      expect(saved[i]!.relativePath).toMatch(/^\.ai\/attachments\/[^/]+\.(md|txt|pdf|json)$/)
      expect(fs.readFileSync(path.join(dir, saved[i]!.relativePath))).toEqual(
        Buffer.from(await files[i]!.arrayBuffer()),
      )
    }
    await removeAttachments(dir, saved)
    expect(fs.readdirSync(path.join(dir, '.ai/attachments'))).toEqual([])
  })

  it('cleans up a mixed batch without deleting previously uploaded documents', async () => {
    const dir = root()
    const document = new File(['# Brief'], 'brief.md')
    const [existing] = await saveAttachments(dir, [document])
    const broken = new File(['data'], 'broken.pdf', { type: 'application/pdf' })
    broken.arrayBuffer = async () => {
      throw new Error('Read failed')
    }
    await expect(
      saveAttachments(dir, [document, new File(['png'], 'screen.png', { type: 'image/png' }), broken]),
    ).rejects.toThrow('Read failed')
    expect(fs.readdirSync(path.join(dir, '.ai/attachments'))).toEqual([path.basename(existing!.relativePath)])
    expect(fs.readdirSync(path.join(dir, '.ai/images')).filter((name) => name.endsWith('.png'))).toEqual([])
  })

  it('excludes uploaded documents from Git in an existing worktree', async () => {
    const dir = root()
    execFileSync('git', ['init', '-q', dir])
    fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n')
    const [saved] = await saveAttachments(dir, [new File(['private'], 'spec.pdf', { type: 'application/pdf' })])
    expect(execFileSync('git', ['-C', dir, 'check-ignore', saved!.relativePath], { encoding: 'utf8' }).trim()).toBe(
      saved!.relativePath,
    )
    await saveAttachments(dir, [new File(['notes'], 'notes.md')])
    expect(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8')).toBe('node_modules/\n.ai/attachments/\n')
  })

  it('removes a partially written file when the disk fills up', async () => {
    const dir = root()
    const write = fs.writeFileSync
    vi.spyOn(fs, 'writeFileSync').mockImplementation((target, data, options) => {
      if (typeof target === 'number' || String(target).includes('/.ai/attachments/')) {
        write(target, Buffer.from('partial'), options)
        throw Object.assign(new Error('Disk full'), { code: 'ENOSPC' })
      }
      return write(target, data, options)
    })
    await expect(saveAttachments(dir, [new File(['whole document'], 'brief.md')])).rejects.toThrow('Disk full')
    expect(fs.readdirSync(path.join(dir, '.ai/attachments'))).toEqual([])
  })

  it('rejects a symlinked attachment directory without writing outside the worktree', async () => {
    const dir = root()
    const outside = root()
    fs.mkdirSync(path.join(dir, '.ai'))
    fs.symlinkSync(outside, path.join(dir, '.ai/attachments'))
    await expect(saveAttachments(dir, [new File(['Notes'], 'notes.txt')])).rejects.toThrow('Symbolic links')
    expect(fs.readdirSync(outside)).toEqual([])
  })

  it('combines legacy images and attachments under the same limits', async () => {
    const form = new FormData()
    form.append('workspace', '{}')
    for (let i = 0; i < 6; i++) form.append('images', new File(['png'], 'a.png', { type: 'image/png' }))
    for (let i = 0; i < 5; i++) form.append('attachments', new File(['text'], 'brief.md'))
    await expect(
      readWorkspaceCreationRequest(new Request('http://localhost', { method: 'POST', body: form })),
    ).rejects.toThrow('at most 10')
  })

  it.each(['script.sh', 'app.exe', 'image.svg', 'archive.zip'])(
    'rejects unsupported extension %s even with a text MIME label',
    async (name) => {
      await expect(
        readWorkspaceCreationRequest(request([new File(['data'], name, { type: 'text/plain' })])),
      ).rejects.toThrow('Unsupported attachment')
    },
  )

  it('stores duplicate and traversal upload names under distinct generated names', async () => {
    const dir = root()
    const files = [new File(['one'], '../../brief.md'), new File(['two'], '../../brief.md')]
    const saved = await saveAttachments(dir, files)
    expect(saved[0]!.relativePath).not.toBe(saved[1]!.relativePath)
    expect(saved.every((file) => /^\.ai\/attachments\/[\w-]+\.md$/.test(file.relativePath))).toBe(true)
    expect(fs.readFileSync(path.join(dir, saved[0]!.relativePath), 'utf8')).toBe('one')
    expect(fs.readFileSync(path.join(dir, saved[1]!.relativePath), 'utf8')).toBe('two')
  })

  it('copies the same attachments independently for each comparison workspace', async () => {
    const first = root()
    const second = root()
    const files = [new File(['pixels'], 'clipboard', { type: 'image/png' })]
    const [a] = await saveAttachments(first, files)
    const [b] = await saveAttachments(second, files)
    expect(a!.relativePath).toMatch(/^\.ai\/images\/.+\.png$/)
    expect(a!.uid).not.toBe(b!.uid)
    expect(fs.readFileSync(path.join(first, a!.relativePath), 'utf8')).toBe('pixels')
    expect(fs.readFileSync(path.join(second, b!.relativePath), 'utf8')).toBe('pixels')
    await removeAttachments(first, [a!])
    expect(fs.existsSync(path.join(first, a!.relativePath))).toBe(false)
    expect(fs.existsSync(path.join(second, b!.relativePath))).toBe(true)
  })

  it('removes only newly saved images if a later attachment cannot be written', async () => {
    const dir = root()
    const files = [new File(['pixels'], 'screen.png', { type: 'image/png' })]
    const existing = await saveAttachments(dir, files)
    const broken = new File(['pixels'], 'broken.png', { type: 'image/png' })
    broken.arrayBuffer = async () => {
      throw new Error('Cannot read attachment')
    }
    await expect(saveAttachments(dir, [...files, broken])).rejects.toThrow('Cannot read attachment')
    const index = JSON.parse(fs.readFileSync(path.join(dir, '.ai/images/index.json'), 'utf8'))
    expect(index.map((entry: { uid: string }) => entry.uid)).toEqual(existing.map((image) => image.uid))
    expect(fs.readdirSync(path.join(dir, '.ai/images')).filter((name) => name.endsWith('.png'))).toHaveLength(1)
  })
})
