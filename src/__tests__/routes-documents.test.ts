import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../server/services/workspace-service.js', () => ({
  getWorkspace: vi.fn(),
}))

import documentsRouter from '../server/routes/documents.js'
import * as workspaceService from '../server/services/workspace-service.js'

const app = new Hono()
app.route('/api/workspaces', documentsRouter)

let tmpDir = ''
let worktreePath = ''

const fakeWorkspace = {
  id: 'ws-1',
  name: 'test',
  projectPath: '',
  sourceBranch: 'main',
  workingBranch: 'feature/test',
  status: 'executing',
  model: 'claude-opus-4-6',
  permissionMode: 'auto-accept',
  devServerStatus: 'stopped',
  hasUnread: false,
  archivedAt: null,
  createdAt: '2026-01-01',
  updatedAt: '2026-01-01',
}

beforeEach(() => {
  vi.clearAllMocks()
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kobo-documents-test-'))
  worktreePath = path.join(tmpDir, '.worktrees', 'feature', 'test')
  fs.mkdirSync(worktreePath, { recursive: true })
  fakeWorkspace.projectPath = tmpDir
  vi.mocked(workspaceService.getWorkspace).mockReturnValue(fakeWorkspace as never)
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('GET /api/workspaces/:id/documents', () => {
  it('returns empty list when no document directories exist', async () => {
    const res = await app.request('/api/workspaces/ws-1/documents')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.documents).toEqual([])
  })

  it('returns .md files from docs/plans, docs/superpowers, and .ai/thoughts', async () => {
    const plansDir = path.join(worktreePath, 'docs', 'plans')
    const superPlansDir = path.join(worktreePath, 'docs', 'superpowers', 'plans')
    const superSpecsDir = path.join(worktreePath, 'docs', 'superpowers', 'specs')
    const thoughtsDir = path.join(worktreePath, '.ai', 'thoughts')
    fs.mkdirSync(plansDir, { recursive: true })
    fs.mkdirSync(superPlansDir, { recursive: true })
    fs.mkdirSync(superSpecsDir, { recursive: true })
    fs.mkdirSync(thoughtsDir, { recursive: true })
    fs.writeFileSync(path.join(plansDir, 'old-plan.md'), '# Old', 'utf-8')
    fs.writeFileSync(path.join(superPlansDir, 'new-plan.md'), '# New', 'utf-8')
    fs.writeFileSync(path.join(superSpecsDir, 'design-doc.md'), '# Design', 'utf-8')
    fs.writeFileSync(path.join(thoughtsDir, 'SENTRY-42.md'), '# Sentry', 'utf-8')
    fs.writeFileSync(path.join(plansDir, 'notes.txt'), 'ignore me', 'utf-8')

    const res = await app.request('/api/workspaces/ws-1/documents')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.documents.map((d: { name: string }) => d.name).sort()).toEqual([
      'SENTRY-42.md',
      'design-doc.md',
      'new-plan.md',
      'old-plan.md',
    ])
  })

  it('scans recursively into sub-folders', async () => {
    const nested = path.join(worktreePath, 'docs', 'superpowers', 'plans', '2026-04')
    fs.mkdirSync(nested, { recursive: true })
    fs.writeFileSync(path.join(nested, 'deep.md'), '# Deep', 'utf-8')

    const res = await app.request('/api/workspaces/ws-1/documents')
    const body = await res.json()
    expect(body.documents.length).toBe(1)
    expect(body.documents[0].path).toBe('docs/superpowers/plans/2026-04/deep.md')
    expect(body.documents[0].name).toBe('deep.md')
  })

  it('returns documents sorted by modifiedAt descending', async () => {
    const plansDir = path.join(worktreePath, 'docs', 'plans')
    fs.mkdirSync(plansDir, { recursive: true })
    fs.writeFileSync(path.join(plansDir, 'older.md'), '# Older', 'utf-8')
    const laterFile = path.join(plansDir, 'newer.md')
    fs.writeFileSync(laterFile, '# Newer', 'utf-8')
    const futureTime = new Date(Date.now() + 10000)
    fs.utimesSync(laterFile, futureTime, futureTime)

    const res = await app.request('/api/workspaces/ws-1/documents')
    const body = await res.json()
    expect(body.documents[0].name).toBe('newer.md')
    expect(body.documents[1].name).toBe('older.md')
  })

  it('returns 404 for unknown workspace', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(null as never)
    const res = await app.request('/api/workspaces/unknown/documents')
    expect(res.status).toBe(404)
  })
})

describe('GET /api/workspaces/:id/document', () => {
  it('returns file content for a valid path under docs/plans', async () => {
    const plansDir = path.join(worktreePath, 'docs', 'plans')
    fs.mkdirSync(plansDir, { recursive: true })
    fs.writeFileSync(path.join(plansDir, 'my-plan.md'), '# My Plan\n\nHello world', 'utf-8')

    const res = await app.request('/api/workspaces/ws-1/document?path=docs/plans/my-plan.md')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.content).toBe('# My Plan\n\nHello world')
    expect(body.path).toBe('docs/plans/my-plan.md')
  })

  it('returns file content from docs/superpowers/plans/', async () => {
    const superDir = path.join(worktreePath, 'docs', 'superpowers', 'plans')
    fs.mkdirSync(superDir, { recursive: true })
    fs.writeFileSync(path.join(superDir, 'feature.md'), '# Feature', 'utf-8')

    const res = await app.request('/api/workspaces/ws-1/document?path=docs/superpowers/plans/feature.md')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.content).toBe('# Feature')
  })

  it('returns file content from .ai/thoughts/', async () => {
    const thoughtsDir = path.join(worktreePath, '.ai', 'thoughts')
    fs.mkdirSync(thoughtsDir, { recursive: true })
    fs.writeFileSync(path.join(thoughtsDir, 'SENTRY-42.md'), '# Sentry 42', 'utf-8')

    const res = await app.request('/api/workspaces/ws-1/document?path=.ai/thoughts/SENTRY-42.md')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.content).toBe('# Sentry 42')
  })

  it('returns file content from a nested sub-folder', async () => {
    const nested = path.join(worktreePath, 'docs', 'superpowers', 'plans', '2026-04')
    fs.mkdirSync(nested, { recursive: true })
    fs.writeFileSync(path.join(nested, 'deep.md'), '# Deep', 'utf-8')

    const res = await app.request('/api/workspaces/ws-1/document?path=docs/superpowers/plans/2026-04/deep.md')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.content).toBe('# Deep')
  })

  it('returns 404 for non-existent file', async () => {
    const res = await app.request('/api/workspaces/ws-1/document?path=docs/plans/nope.md')
    expect(res.status).toBe(404)
  })

  it('returns 400 for path traversal attempt', async () => {
    const res = await app.request('/api/workspaces/ws-1/document?path=docs/plans/../../etc/passwd')
    expect(res.status).toBe(400)
  })

  it('returns 400 for path outside allowed directories', async () => {
    const res = await app.request('/api/workspaces/ws-1/document?path=src/server/index.ts')
    expect(res.status).toBe(400)
  })

  it('returns 400 for non-markdown extension', async () => {
    const plansDir = path.join(worktreePath, 'docs', 'plans')
    fs.mkdirSync(plansDir, { recursive: true })
    fs.writeFileSync(path.join(plansDir, 'notes.txt'), 'plain', 'utf-8')
    const res = await app.request('/api/workspaces/ws-1/document?path=docs/plans/notes.txt')
    expect(res.status).toBe(400)
  })

  it('returns 400 when path query param is missing', async () => {
    const res = await app.request('/api/workspaces/ws-1/document')
    expect(res.status).toBe(400)
  })

  it('returns 404 for unknown workspace', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(null as never)
    const res = await app.request('/api/workspaces/unknown/document?path=docs/plans/x.md')
    expect(res.status).toBe(404)
  })
})
