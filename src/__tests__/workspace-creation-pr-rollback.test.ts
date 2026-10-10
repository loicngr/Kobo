import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeDb, getDb } from '../server/db/index.js'
import { runMigrations } from '../server/db/migrations.js'
import prs from '../server/routes/pull-requests.js'
import workspaces from '../server/routes/workspaces.js'
import { getForgeProvider } from '../server/services/forge/registry.js'
import * as notionService from '../server/services/notion-service.js'
import { _setSettingsPath, updateGlobalSettings, upsertProject } from '../server/services/settings-service.js'
import { executeWorkspaceCreationTool } from '../server/services/workspace-creation-mcp-service.js'
import * as workspaceService from '../server/services/workspace-service.js'
import { createWorkspace } from '../server/services/workspace-service.js'
import { createTempRepo, type TempRepo } from './helpers/temp-git-repo.js'

describe('MCP PR checkout creation rollback', () => {
  let repo: TempRepo
  let checkout: string
  const prUrl = 'https://github.com/team/repo/pull/12'
  beforeEach(() => {
    repo = createTempRepo()
    closeDb()
    runMigrations(getDb(path.join(repo.path, '..', 'fixture.db')))
    _setSettingsPath(path.join(repo.path, '..', 'settings.json'))
    upsertProject(repo.path, { forge: 'none' })
    updateGlobalSettings({ notionEnabled: false })
    repo.git(['checkout', '-b', 'feature/pr'])
    repo.commit('.gitignore', 'ignored.txt\n', 'PR fixture')
    repo.git(['push', '-u', 'origin', 'feature/pr'])
    repo.git(['checkout', 'main'])
    const provider = getForgeProvider('none')
    vi.spyOn(provider, 'isAvailable').mockResolvedValue({ available: true })
    vi.spyOn(provider, 'listPullRequests').mockResolvedValue({
      items: [
        {
          number: 12,
          url: prUrl,
          headBranch: 'feature/pr',
          baseBranch: 'main',
          isFork: false,
          title: 'PR',
          author: 'test',
          isDraft: false,
          updatedAt: '2026-10-10T00:00:00Z',
          body: '',
          ci: null,
          reviewDecision: null,
        },
      ],
      nextCursor: null,
    })
  })
  afterEach(() => {
    vi.restoreAllMocks()
    closeDb()
    repo.cleanup()
  })

  async function dispatch(url: string, init: RequestInit) {
    if (url.startsWith('/api/pull-requests')) {
      const response = await prs.request(`http://local${url.slice('/api/pull-requests'.length)}`, init)
      if (url.endsWith('/resolve') && response.ok) checkout = (await response.clone().json()).worktreePath
      return response
    }
    return workspaces.request('http://local/', init)
  }

  it('removes its fresh checkout when the real create route rejects a disabled Notion import', async () => {
    const before = repo.git(['worktree', 'list', '--porcelain'])
    await expect(
      executeWorkspaceCreationTool(
        'create_workspace',
        {
          name: 'PR',
          project_path: repo.path,
          pr_url: prUrl,
          notion_url: 'https://www.notion.so/12345678901234567890123456789012',
        },
        dispatch,
      ),
    ).rejects.toMatchObject({ status: 403, stage: 'create' })
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM workspaces').get()).toEqual({ n: 0 })
    expect(fs.existsSync(checkout)).toBe(false)
    expect(repo.git(['worktree', 'list', '--porcelain'])).toBe(before)
    expect(repo.git(['rev-parse', 'feature/pr'])).toBe(repo.git(['rev-parse', 'origin/feature/pr']))
  })

  it.each(['untracked', 'ignored', 'commit', 'adopted'])(
    'preserves a new checkout that was %s before creation failed',
    async (change) => {
      const guardedDispatch = async (url: string, init: RequestInit) => {
        if (url !== '/api/workspaces') return dispatch(url, init)
        if (change === 'adopted') {
          createWorkspace({
            name: 'Adopted',
            projectPath: repo.path,
            sourceBranch: 'main',
            workingBranch: 'feature/pr',
            worktreePath: checkout,
          })
        } else if (change === 'commit') {
          fs.writeFileSync(path.join(checkout, 'new.txt'), 'valuable')
          repo.git(['add', 'new.txt'], checkout)
          repo.git(['commit', '-m', 'User commit'], checkout)
        } else fs.writeFileSync(path.join(checkout, change === 'ignored' ? 'ignored.txt' : 'new.txt'), 'valuable')
        return new Response(JSON.stringify({ error: 'Creation rejected' }), { status: 422 })
      }
      await expect(
        executeWorkspaceCreationTool(
          'create_workspace',
          { name: 'PR', project_path: repo.path, pr_url: prUrl },
          guardedDispatch,
        ),
      ).rejects.toMatchObject({
        status: 422,
        details: { checkoutRecovery: { removed: false, worktreePath: expect.any(String) } },
      })
      expect(fs.existsSync(checkout)).toBe(true)
    },
  )

  it('never removes a reused checkout when creation fails', async () => {
    checkout = path.join(repo.path, '..', 'existing-checkout')
    repo.git(['worktree', 'add', checkout, 'feature/pr'])
    const diagnosis = await (
      await dispatch('/api/pull-requests/diagnose', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectPath: repo.path, prNumber: 12 }),
      })
    ).json()
    await expect(
      executeWorkspaceCreationTool(
        'create_workspace',
        {
          name: 'PR',
          project_path: repo.path,
          pr_url: prUrl,
          pr_checkout: { fingerprint: diagnosis.fingerprint, decisions: { orphanWorktree: 'attach' } },
          notion_url: 'https://www.notion.so/12345678901234567890123456789012',
        },
        dispatch,
      ),
    ).rejects.toMatchObject({ status: 403, details: { checkoutRecovery: { removed: false } } })
    expect(fs.existsSync(checkout)).toBe(true)
  })

  it('preserves the checkout and reports recovery information when creation outcome is unknown', async () => {
    const uncertainDispatch = async (url: string, init: RequestInit) => {
      if (url !== '/api/workspaces') return dispatch(url, init)
      throw new Error('Dispatch interrupted')
    }
    await expect(
      executeWorkspaceCreationTool(
        'create_workspace',
        {
          name: 'PR',
          project_path: repo.path,
          pr_url: prUrl,
        },
        uncertainDispatch,
      ),
    ).rejects.toMatchObject({
      status: 500,
      stage: 'create',
      details: { checkoutRecovery: { removed: false, worktreePath: expect.any(String) } },
    })
    expect(fs.existsSync(checkout)).toBe(true)
  })
  it('rejects adoption when compensation removed a previously inspected checkout', async () => {
    let release!: () => void
    let reached!: () => void
    const inspected = new Promise<void>((resolve) => {
      reached = resolve
    })
    const resume = new Promise<void>((resolve) => {
      release = resolve
    })
    vi.spyOn(notionService, 'extractNotionPage').mockImplementation(async () => {
      reached()
      await resume
      return { title: '', ticketId: '', status: '', goal: '', todos: [], gherkinFeatures: [] }
    })
    updateGlobalSettings({ notionEnabled: true })
    let adoptedMissing = false
    vi.spyOn(workspaceService, 'createWorkspace').mockImplementation((args) => {
      adoptedMissing = !fs.existsSync(args.worktreePath!)
      throw new Error('Stop fixture before creating records or launching engine')
    })
    let other!: ReturnType<typeof workspaces.request>
    const competingDispatch = async (url: string, init: RequestInit) => {
      if (url !== '/api/workspaces') return dispatch(url, init)
      other = workspaces.request('http://local/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Other',
          projectPath: repo.path,
          sourceBranch: 'main',
          workingBranch: 'feature/pr',
          worktreePath: checkout,
          notionUrl: 'https://www.notion.so/12345678901234567890123456789012',
        }),
      })
      await inspected
      return new Response(JSON.stringify({ error: 'Creation rejected' }), { status: 422 })
    }
    try {
      await expect(
        executeWorkspaceCreationTool(
          'create_workspace',
          { name: 'PR', project_path: repo.path, pr_url: prUrl },
          competingDispatch,
        ),
      ).rejects.toMatchObject({ status: 422 })
      expect(fs.existsSync(checkout)).toBe(false)
    } finally {
      release()
    }
    const response = await other
    expect(response.status).toBe(422)
    expect(workspaceService.createWorkspace).not.toHaveBeenCalled()
    expect(adoptedMissing).toBe(false)
  })

  it.each(['directory', 'branch'])('rejects a checkout whose %s changes during source import', async (change) => {
    checkout = path.join(repo.path, '..', 'existing-checkout')
    repo.git(['worktree', 'add', checkout, 'feature/pr'])
    updateGlobalSettings({ notionEnabled: true })
    vi.spyOn(notionService, 'extractNotionPage').mockImplementation(async () => {
      if (change === 'branch') repo.git(['checkout', '-b', 'other-branch'], checkout)
      else {
        const gitFile = fs.readFileSync(path.join(checkout, '.git'))
        fs.renameSync(checkout, `${checkout}-original`)
        fs.mkdirSync(checkout)
        fs.writeFileSync(path.join(checkout, '.git'), gitFile)
      }
      return { title: '', ticketId: '', status: '', goal: '', todos: [], gherkinFeatures: [] }
    })
    vi.spyOn(workspaceService, 'createWorkspace').mockImplementation(() => {
      throw new Error('Stop fixture before launching an agent')
    })
    const response = await workspaces.request('http://local/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Other',
        projectPath: repo.path,
        sourceBranch: 'main',
        worktreePath: checkout,
        notionUrl: 'https://www.notion.so/12345678901234567890123456789012',
      }),
    })
    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({ step: 'inspect-worktree' })
    expect(workspaceService.createWorkspace).not.toHaveBeenCalled()
    expect(fs.existsSync(checkout)).toBe(true)
  })
})
