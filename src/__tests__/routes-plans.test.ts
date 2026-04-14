import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../server/services/workspace-service.js', () => ({
  getWorkspace: vi.fn(),
}))

import plansRouter from '../server/routes/plans.js'
import * as workspaceService from '../server/services/workspace-service.js'

const app = new Hono()
app.route('/api/workspaces', plansRouter)

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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kobo-plans-test-'))
  worktreePath = path.join(tmpDir, '.worktrees', 'feature', 'test')
  fs.mkdirSync(worktreePath, { recursive: true })
  fakeWorkspace.projectPath = tmpDir
  vi.mocked(workspaceService.getWorkspace).mockReturnValue(fakeWorkspace as never)
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('GET /api/workspaces/:id/plans', () => {
  it('returns empty list when no plan directories exist', async () => {
    const res = await app.request('/api/workspaces/ws-1/plans')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.plans).toEqual([])
  })

  it('returns .md files from docs/plans/, docs/superpowers/plans/, and docs/superpowers/specs/', async () => {
    const plansDir = path.join(worktreePath, 'docs', 'plans')
    const superDir = path.join(worktreePath, 'docs', 'superpowers', 'plans')
    const specsDir = path.join(worktreePath, 'docs', 'superpowers', 'specs')
    fs.mkdirSync(plansDir, { recursive: true })
    fs.mkdirSync(superDir, { recursive: true })
    fs.mkdirSync(specsDir, { recursive: true })
    fs.writeFileSync(path.join(plansDir, 'old-plan.md'), '# Old', 'utf-8')
    fs.writeFileSync(path.join(superDir, 'new-plan.md'), '# New', 'utf-8')
    fs.writeFileSync(path.join(specsDir, 'design-doc.md'), '# Design', 'utf-8')
    fs.writeFileSync(path.join(plansDir, 'notes.txt'), 'ignore me', 'utf-8')

    const res = await app.request('/api/workspaces/ws-1/plans')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.plans.length).toBe(3)
    expect(body.plans.map((p: { name: string }) => p.name).sort()).toEqual([
      'design-doc.md',
      'new-plan.md',
      'old-plan.md',
    ])
    for (const plan of body.plans) {
      expect(plan.path).toBeTruthy()
      expect(plan.name).toBeTruthy()
      expect(plan.modifiedAt).toBeTruthy()
    }
  })

  it('returns plans sorted by modifiedAt descending', async () => {
    const plansDir = path.join(worktreePath, 'docs', 'plans')
    fs.mkdirSync(plansDir, { recursive: true })
    fs.writeFileSync(path.join(plansDir, 'older.md'), '# Older', 'utf-8')
    const laterFile = path.join(plansDir, 'newer.md')
    fs.writeFileSync(laterFile, '# Newer', 'utf-8')
    const futureTime = new Date(Date.now() + 10000)
    fs.utimesSync(laterFile, futureTime, futureTime)

    const res = await app.request('/api/workspaces/ws-1/plans')
    const body = await res.json()
    expect(body.plans[0].name).toBe('newer.md')
    expect(body.plans[1].name).toBe('older.md')
  })

  it('returns 404 for unknown workspace', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(null as never)
    const res = await app.request('/api/workspaces/unknown/plans')
    expect(res.status).toBe(404)
  })
})

describe('GET /api/workspaces/:id/plan-file', () => {
  it('returns file content for a valid path', async () => {
    const plansDir = path.join(worktreePath, 'docs', 'plans')
    fs.mkdirSync(plansDir, { recursive: true })
    fs.writeFileSync(path.join(plansDir, 'my-plan.md'), '# My Plan\n\nHello world', 'utf-8')

    const res = await app.request('/api/workspaces/ws-1/plan-file?path=docs/plans/my-plan.md')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.content).toBe('# My Plan\n\nHello world')
    expect(body.path).toBe('docs/plans/my-plan.md')
  })

  it('returns file content from docs/superpowers/plans/', async () => {
    const superDir = path.join(worktreePath, 'docs', 'superpowers', 'plans')
    fs.mkdirSync(superDir, { recursive: true })
    fs.writeFileSync(path.join(superDir, 'feature.md'), '# Feature', 'utf-8')

    const res = await app.request('/api/workspaces/ws-1/plan-file?path=docs/superpowers/plans/feature.md')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.content).toBe('# Feature')
  })

  it('returns file content from docs/superpowers/specs/ (design docs)', async () => {
    const specsDir = path.join(worktreePath, 'docs', 'superpowers', 'specs')
    fs.mkdirSync(specsDir, { recursive: true })
    fs.writeFileSync(path.join(specsDir, 'design.md'), '# Design', 'utf-8')

    const res = await app.request('/api/workspaces/ws-1/plan-file?path=docs/superpowers/specs/design.md')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.content).toBe('# Design')
  })

  it('returns 404 for non-existent file', async () => {
    const res = await app.request('/api/workspaces/ws-1/plan-file?path=docs/plans/nope.md')
    expect(res.status).toBe(404)
  })

  it('returns 400 for path traversal attempt', async () => {
    const res = await app.request('/api/workspaces/ws-1/plan-file?path=docs/plans/../../etc/passwd')
    expect(res.status).toBe(400)
  })

  it('returns 400 for path outside allowed directories', async () => {
    const res = await app.request('/api/workspaces/ws-1/plan-file?path=src/server/index.ts')
    expect(res.status).toBe(400)
  })

  it('returns 400 when path query param is missing', async () => {
    const res = await app.request('/api/workspaces/ws-1/plan-file')
    expect(res.status).toBe(400)
  })

  it('returns 404 for unknown workspace', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(null as never)
    const res = await app.request('/api/workspaces/unknown/plan-file?path=docs/plans/x.md')
    expect(res.status).toBe(404)
  })
})
