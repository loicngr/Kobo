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
