import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../server/services/workspace-service.js', () => ({ getWorkspace: vi.fn() }))

import imagesRouter from '../server/routes/images.js'
import * as workspaceService from '../server/services/workspace-service.js'
import { isWorkspaceLifecycleBusy, withWorkspaceLifecycleGuard } from '../server/utils/workspace-lifecycle-guard.js'

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

describe('purged workspace', () => {
  let root: string
  let worktree: string
  let keptRoot: string

  function purge(recorded: string | null = keptRoot, id = 'ws-1') {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue({
      id,
      worktreePath: worktree,
      worktreePurgedAt: '2026-09-09T00:00:00Z',
      worktreePurgeRestoreData: JSON.stringify(recorded ? { keptAiPath: recorded } : {}),
    } as never)
  }

  beforeEach(() => {
    vi.clearAllMocks()
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kobo-routes-images-purged-'))
    worktree = path.join(root, 'worktree')
    keptRoot = path.join(root, '.kobo-kept', 'ws-1')
    fs.mkdirSync(path.join(keptRoot, '.ai', 'images'), { recursive: true })
    fs.writeFileSync(path.join(keptRoot, '.ai', 'images', 'p.png'), Buffer.from('kept-png'))
  })

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  it('serves an image from the kept copy', async () => {
    purge()
    const res = await app.request('/api/workspaces/ws-1/images/file?path=.ai/images/p.png')
    expect(res.status).toBe(200)
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('kept-png')
  })

  it('does not serve a recorded path that belongs to another workspace id', async () => {
    const other = path.join(root, '.kobo-kept', 'ws-2')
    fs.mkdirSync(path.join(other, '.ai', 'images'), { recursive: true })
    fs.writeFileSync(path.join(other, '.ai', 'images', 'p.png'), Buffer.from('other-png'))
    purge(other)
    const res = await app.request('/api/workspaces/ws-1/images/file?path=.ai/images/p.png')
    expect(res.status).not.toBe(200)
    expect(res.status).toBeLessThan(500)
  })

  it('answers a client error, never a 500, when the kept folder was deleted by hand or never existed', async () => {
    purge()
    fs.rmSync(keptRoot, { recursive: true, force: true })
    const gone = await app.request('/api/workspaces/ws-1/images/file?path=.ai/images/p.png')
    expect(gone.status).toBe(400)
    purge(null)
    const none = await app.request('/api/workspaces/ws-1/images/file?path=.ai/images/p.png')
    expect(none.status).toBe(400)
  })

  it('refuses a symbolic link inside the kept images folder and a .. path', async () => {
    const outside = path.join(root, 'outside.png')
    fs.writeFileSync(outside, 'outside secret')
    fs.symlinkSync(outside, path.join(keptRoot, '.ai', 'images', 'secret.png'))
    purge()
    const link = await app.request('/api/workspaces/ws-1/images/file?path=.ai/images/secret.png')
    expect(link.status).toBe(400)
    expect(await link.text()).not.toContain('outside secret')
    const up = await app.request('/api/workspaces/ws-1/images/file?path=.ai/images/../../outside.png')
    expect(up.status).toBe(400)
  })

  it('still reads from the worktree when the workspace is not purged, even with restore data', async () => {
    fs.mkdirSync(path.join(worktree, '.ai', 'images'), { recursive: true })
    fs.writeFileSync(path.join(worktree, '.ai', 'images', 'p.png'), Buffer.from('live-png'))
    vi.mocked(workspaceService.getWorkspace).mockReturnValue({
      id: 'ws-1',
      worktreePath: worktree,
      worktreePurgedAt: null,
      worktreePurgeRestoreData: JSON.stringify({ keptAiPath: keptRoot }),
    } as never)
    const res = await app.request('/api/workspaces/ws-1/images/file?path=.ai/images/p.png')
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('live-png')
  })

  it('refuses the legacy image upload and delete with 409 and creates nothing at the worktree path', async () => {
    purge()
    const form = new FormData()
    form.append('image', new File([new Uint8Array([1, 2, 3])], 'a.png', { type: 'image/png' }))
    const upload = await app.request('/api/workspaces/ws-1/images', { method: 'POST', body: form })
    expect(upload.status).toBe(409)
    expect(await upload.json()).toEqual({ error: 'Restore the worktree before uploading files' })
    const del = await app.request('/api/workspaces/ws-1/images/abc123', { method: 'DELETE' })
    expect(del.status).toBe(409)
    expect(await del.json()).toEqual({ error: 'Worktree is purged' })
    expect(fs.existsSync(worktree)).toBe(false)
  })

  it('does not hold the lifecycle guard while the upload body is still being received', async () => {
    fs.mkdirSync(worktree, { recursive: true })
    vi.mocked(workspaceService.getWorkspace).mockReturnValue({ id: 'ws-1', worktreePath: worktree } as never)
    const form = new FormData()
    form.append('image', new File([new Uint8Array([1, 2, 3])], 'a.png', { type: 'image/png' }))
    const encoded = new Response(form)
    const contentType = encoded.headers.get('content-type')!
    const bytes = new Uint8Array(await encoded.arrayBuffer())
    let finish!: () => void
    const stalled = new Promise<void>((resolve) => {
      finish = resolve
    })
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(bytes.slice(0, 10))
        await stalled
        controller.enqueue(bytes.slice(10))
        controller.close()
      },
    })
    const pending = app.request('/api/workspaces/ws-1/images', {
      method: 'POST',
      headers: { 'Content-Type': contentType },
      body,
      duplex: 'half',
    } as RequestInit)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(isWorkspaceLifecycleBusy('ws-1')).toBe(false)
    finish()
    const res = await pending
    expect(await res.clone().text()).toContain('uid')
    expect(res.status).toBe(201)
  })

  it('answers 409 and writes nothing when the workspace was purged while the body was uploading', async () => {
    const live = { id: 'ws-1', worktreePath: worktree } as never
    const purgedNow = { id: 'ws-1', worktreePath: worktree, worktreePurgedAt: '2026-09-09T00:00:00Z' } as never
    vi.mocked(workspaceService.getWorkspace).mockReturnValueOnce(live).mockReturnValue(purgedNow)
    const form = new FormData()
    form.append('image', new File([new Uint8Array([1, 2, 3])], 'a.png', { type: 'image/png' }))
    const res = await app.request('/api/workspaces/ws-1/images', { method: 'POST', body: form })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'Restore the worktree before uploading files' })
    expect(fs.existsSync(worktree)).toBe(false)
  })

  it('answers the same status as the attachment routes when the lifecycle guard is busy', async () => {
    const form = new FormData()
    form.append('image', new File([new Uint8Array([1, 2, 3])], 'a.png', { type: 'image/png' }))
    vi.mocked(workspaceService.getWorkspace).mockReturnValue({ id: 'ws-1', worktreePath: worktree } as never)
    await withWorkspaceLifecycleGuard('ws-1', async () => {
      const upload = await app.request('/api/workspaces/ws-1/images', { method: 'POST', body: form })
      const attachment = new FormData()
      attachment.append('attachment', new File(['%PDF-1.7 content'], 'brief.pdf', { type: 'application/pdf' }))
      const reference = await app.request('/api/workspaces/ws-1/attachments', { method: 'POST', body: attachment })
      expect(upload.status).toBe(reference.status)
      expect(upload.status).toBe(409)
      const del = await app.request('/api/workspaces/ws-1/images/abc123', { method: 'DELETE' })
      const refDel = await app.request('/api/workspaces/ws-1/attachments/abcdefghij.pdf', { method: 'DELETE' })
      expect(del.status).toBe(refDel.status)
      expect(del.status).toBe(409)
    })
  })

  it.each(['.ai', '.ai/images'])(
    'serves nothing when %s in the kept root is a symbolic link to an outside folder',
    async (linked) => {
      const outside = path.join(root, 'outside-dir')
      fs.mkdirSync(path.join(outside, 'images'), { recursive: true })
      fs.writeFileSync(path.join(outside, 'images', 'p.png'), 'outside secret')
      fs.writeFileSync(path.join(outside, 'p.png'), 'outside secret')
      fs.rmSync(path.join(keptRoot, '.ai'), { recursive: true, force: true })
      if (linked === '.ai') {
        fs.symlinkSync(outside, path.join(keptRoot, '.ai'))
      } else {
        fs.mkdirSync(path.join(keptRoot, '.ai'))
        fs.symlinkSync(path.join(outside), path.join(keptRoot, '.ai', 'images'))
      }
      purge()
      const res = await app.request('/api/workspaces/ws-1/images/file?path=.ai/images/p.png')
      expect(res.status).toBeGreaterThanOrEqual(400)
      expect(res.status).toBeLessThan(500)
      expect(await res.text()).not.toContain('outside secret')
    },
  )

  it('still refuses the two attachment routes with 409', async () => {
    purge()
    const form = new FormData()
    form.append('attachment', new File(['%PDF-1.7 content'], 'brief.pdf', { type: 'application/pdf' }))
    const upload = await app.request('/api/workspaces/ws-1/attachments', { method: 'POST', body: form })
    expect(upload.status).toBe(409)
    const del = await app.request('/api/workspaces/ws-1/attachments/abcdefghij.pdf', { method: 'DELETE' })
    expect(del.status).toBe(409)
    expect(fs.existsSync(worktree)).toBe(false)
  })
})
