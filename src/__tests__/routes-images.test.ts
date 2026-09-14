import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../server/services/workspace-service.js', () => ({ getWorkspace: vi.fn() }))

import imagesRouter from '../server/routes/images.js'
import * as workspaceService from '../server/services/workspace-service.js'

const app = new Hono()
app.route('/api/workspaces', imagesRouter)

describe('GET /api/workspaces/:id/images/file', () => {
  let root: string
  let worktree: string

  beforeEach(() => {
    vi.clearAllMocks()
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kobo-routes-images-'))
    worktree = path.join(root, 'worktree')
    fs.mkdirSync(path.join(worktree, '.ai', 'images'), { recursive: true })
    vi.mocked(workspaceService.getWorkspace).mockReturnValue({ id: 'ws-1', worktreePath: worktree } as never)
  })

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  it('uploads a PDF for chat and removes only that document', async () => {
    const form = new FormData()
    form.append('attachment', new File(['%PDF-1.7 content'], 'brief.pdf', { type: 'application/pdf' }))
    const response = await app.request('/api/workspaces/ws-1/attachments', { method: 'POST', body: form })
    expect(response.status).toBe(201)
    const file = await response.json()
    expect(file.kind).toBe('file')
    expect(file.reference).toContain('[file: .ai/attachments/')
    expect(file.reference).toContain('brief.pdf')
    expect(fs.readFileSync(path.join(worktree, file.path), 'utf8')).toBe('%PDF-1.7 content')
    const preserved = path.join(worktree, '.ai/attachments/preserved.md')
    fs.writeFileSync(preserved, 'existing')
    const removed = await app.request(`/api/workspaces/ws-1/attachments/${path.basename(file.path)}`, {
      method: 'DELETE',
    })
    expect(removed.status).toBe(204)
    expect(fs.existsSync(path.join(worktree, file.path))).toBe(false)
    expect(fs.existsSync(preserved)).toBe(true)
  })

  it('accepts an image above the old 10 MiB chat limit', async () => {
    const form = new FormData()
    form.append('attachment', new File([new Uint8Array(11 * 1024 * 1024)], 'large.png', { type: 'image/png' }))
    const response = await app.request('/api/workspaces/ws-1/attachments', { method: 'POST', body: form })
    expect(response.status).toBe(201)
    const file = await response.json()
    expect(file.kind).toBe('image')
    expect(file.reference).toBe(`[image: ${file.path}]`)
    expect(fs.statSync(path.join(worktree, file.path)).size).toBe(11 * 1024 * 1024)
  })

  it('rejects unsupported chat files without writing anything', async () => {
    const form = new FormData()
    form.append('attachment', new File(['script'], 'script.sh', { type: 'text/plain' }))
    const response = await app.request('/api/workspaces/ws-1/attachments', { method: 'POST', body: form })
    expect(response.status).toBe(400)
    expect(fs.existsSync(path.join(worktree, '.ai/attachments'))).toBe(false)
  })

  it('serves a regular image inside the images directory', async () => {
    fs.writeFileSync(path.join(worktree, '.ai', 'images', 'ok.png'), Buffer.from('png-data'))
    const res = await app.request('/api/workspaces/ws-1/images/file?path=.ai/images/ok.png')
    expect(res.status).toBe(200)
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('png-data')
  })

  it('rejects an image symlink that resolves outside the worktree', async () => {
    const outside = path.join(root, 'outside.png')
    fs.writeFileSync(outside, 'outside secret')
    fs.symlinkSync(outside, path.join(worktree, '.ai', 'images', 'secret.png'))

    const res = await app.request('/api/workspaces/ws-1/images/file?path=.ai/images/secret.png')
    expect(res.status).toBe(400)
    expect(await res.text()).not.toContain('outside secret')
  })
})
