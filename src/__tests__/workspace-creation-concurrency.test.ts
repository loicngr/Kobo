import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { closeDb, getDb } from '../server/db/index.js'
import { runMigrations } from '../server/db/migrations.js'
import router from '../server/routes/workspaces.js'
import { startAgent } from '../server/services/agent/orchestrator.js'
import { listWorkspaces } from '../server/services/workspace-service.js'
import { makeEffectiveSettings, makeGlobalSettings } from './helpers/fixtures.js'

vi.mock('../server/services/agent/orchestrator.js', () => ({
  startAgent: vi.fn(() => ({ agentSessionId: 'test-session' })),
  stopAgentAndWait: vi.fn(async () => 'not-running'),
  forgetRateLimitInfo: vi.fn(),
  forgetTasksDoneSnapshot: vi.fn(),
  forgetResumeFailed: vi.fn(),
  forgetPendingQueue: vi.fn(),
  forgetPreAwaitStatus: vi.fn(),
  forgetSessionId: vi.fn(),
}))
vi.mock('../server/services/dev-server-service.js', () => ({ stopDevServer: vi.fn(async () => {}) }))
vi.mock('../server/services/terminal-service.js', () => ({ destroyTerminal: vi.fn() }))
vi.mock('../server/services/settings-service.js', () => ({
  getGlobalSettings: () => makeGlobalSettings({ worktreesPath: '.worktrees', worktreesPrefixByProject: false }),
  getProjectSettings: () => null,
  getEffectiveSettings: () => makeEffectiveSettings({ setupScript: '', gitConventions: '' }),
}))
vi.mock('../server/utils/git-ops.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../server/utils/git-ops.js')>()),
  // Both requests finish preflight together; all allocation and mutation use real Git.
  fetchSourceBranchOrThrowAsync: vi.fn(async () => {}),
}))

const app = new Hono().route('/api/workspaces', router)
let directory: string
let repository: string
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(startAgent).mockReturnValue({ agentSessionId: 'test-session' } as ReturnType<typeof startAgent>)
  closeDb()
  directory = mkdtempSync(join(tmpdir(), 'kobo-create-race-'))
  repository = join(directory, 'repo')
  execFileSync('git', ['init', '-b', 'main', repository], { stdio: 'pipe' })
  writeFileSync(join(repository, 'README.md'), 'Temporary concurrency fixture\n')
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repository, stdio: 'pipe' })
  git('add', 'README.md')
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'Fixture')
  git('update-ref', 'refs/remotes/origin/main', 'HEAD')
  runMigrations(getDb(join(directory, 'kobo.db')))
})
afterEach(() => {
  closeDb()
  rmSync(directory, { recursive: true, force: true })
})

function create(overrides: Record<string, unknown> = {}) {
  return app.request('/api/workspaces', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Concurrent creation',
      projectPath: repository,
      sourceBranch: 'main',
      workingBranch: 'feature/concurrent',
      skipSetupScript: true,
      ...overrides,
    }),
  })
}

it('creates distinct surviving worktrees for concurrent requests for the same branch', async () => {
  const responses = await Promise.all([create(), create()])
  const workspaces = listWorkspaces()
  // Assert survival first: a failed second request must never demolish the first checkout.
  expect(workspaces.length).toBeGreaterThan(0)
  for (const workspace of workspaces) expect(existsSync(workspace.worktreePath)).toBe(true)
  expect(responses.map((response) => response.status)).toEqual([201, 201])
  expect(workspaces).toHaveLength(2)
  expect(new Set(workspaces.map((workspace) => workspace.worktreePath)).size).toBe(2)
  expect(new Set(workspaces.map((workspace) => workspace.workingBranch)).size).toBe(2)
  expect(startAgent).toHaveBeenCalledTimes(2)
})

it('keeps the first checkout when the second concurrent creation rolls back its failed agent', async () => {
  vi.mocked(startAgent)
    .mockReturnValueOnce({ agentSessionId: 'first-session' } as ReturnType<typeof startAgent>)
    .mockImplementationOnce(() => {
      throw new Error('Agent startup failure')
    })
  const responses = await Promise.all([create(), create()])
  expect(responses.map((response) => response.status).sort()).toEqual([201, 500])
  const workspaces = listWorkspaces()
  expect(workspaces).toHaveLength(1)
  expect(existsSync(join(workspaces[0]!.worktreePath, 'README.md'))).toBe(true)
  const checkouts = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: repository, encoding: 'utf8' })
  expect(checkouts.match(/^worktree /gm)).toHaveLength(2) // Main repository and successful workspace.
  expect(checkouts).toContain(workspaces[0]!.worktreePath)
})

it('attaches an existing worktree only once when reuse requests arrive concurrently', async () => {
  const worktreePath = join(directory, 'external')
  execFileSync('git', ['worktree', 'add', '-b', 'feature/external', worktreePath, 'main'], {
    cwd: repository,
    stdio: 'pipe',
  })
  const responses = await Promise.all([create({ worktreePath }), create({ worktreePath })])
  expect(responses.map((response) => response.status).sort()).toEqual([201, 422])
  expect(listWorkspaces()).toHaveLength(1)
  expect(existsSync(join(worktreePath, 'README.md'))).toBe(true)
  expect(startAgent).toHaveBeenCalledTimes(1)
})

it('removes its checkout and new branch when a post-checkout hook fails after Git created them', async () => {
  writeFileSync(join(repository, '.git/hooks/post-checkout'), '#!/usr/bin/env sh\nexit 1\n', { mode: 0o755 })
  const response = await create()
  expect(response.status).toBe(500)
  expect(listWorkspaces()).toHaveLength(0)
  expect(existsSync(join(repository, '.worktrees/feature/concurrent'))).toBe(false)
  const checkouts = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: repository, encoding: 'utf8' })
  expect(checkouts.match(/^worktree /gm)).toHaveLength(1)
  expect(
    execFileSync('git', ['branch', '--list', 'feature/concurrent'], { cwd: repository, encoding: 'utf8' }).trim(),
  ).toBe('')
  expect(startAgent).not.toHaveBeenCalled()
})
