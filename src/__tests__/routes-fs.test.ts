import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fsRouter from '../server/routes/fs.js'

const app = new Hono()
app.route('/api/fs', fsRouter)

describe('GET /api/fs/list-dirs', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kobo-fs-test-'))
    fs.mkdirSync(path.join(tmpDir, 'beta'))
    fs.mkdirSync(path.join(tmpDir, 'alpha'))
    fs.mkdirSync(path.join(tmpDir, '.hidden'))
    fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'x')
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('lists visible subdirectories sorted, excluding files and dotfolders', async () => {
    const res = await app.request(`/api/fs/list-dirs?path=${encodeURIComponent(tmpDir)}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      path: string
      parent: string | null
      entries: { name: string; path: string }[]
    }
    expect(body.path).toBe(tmpDir)
    expect(body.entries.map((e) => e.name)).toEqual(['alpha', 'beta'])
    expect(body.entries[0].path).toBe(path.join(tmpDir, 'alpha'))
    expect(body.parent).toBe(path.dirname(tmpDir))
  })

  it('returns 404 for a non-existent directory', async () => {
    const res = await app.request(`/api/fs/list-dirs?path=${encodeURIComponent(path.join(tmpDir, 'nope'))}`)
    expect(res.status).toBe(404)
  })

  it('returns 400 when the path points to a file', async () => {
    const res = await app.request(`/api/fs/list-dirs?path=${encodeURIComponent(path.join(tmpDir, 'file.txt'))}`)
    expect(res.status).toBe(400)
  })

  it('defaults to the home directory when path is omitted', async () => {
    const res = await app.request('/api/fs/list-dirs')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { path: string }
    expect(body.path).toBe(os.homedir())
  })
})
