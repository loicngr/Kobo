import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { closeDb } from '../server/db/index.js'
import routes from '../server/routes/workspaces.js'
import { _setSettingsPath } from '../server/services/settings-service.js'
import { executeWorkspaceLifecycleTool } from '../server/services/workspace-lifecycle-mcp-service.js'
import { createWorkspace, getWorkspace } from '../server/services/workspace-service.js'
import { isWorkspaceLifecycleBusy } from '../server/utils/workspace-lifecycle-guard.js'
import { resetDb } from './helpers/reset-db.js'

const gate = vi.hoisted(() => ({
  reached: () => {},
  stop: Promise.resolve(),
}))
vi.mock('../server/services/agent/orchestrator.js', async (original) => ({
  ...(await original()),
  stopAgentAndWait: async () => {
    gate.reached()
    await gate.stop
    return 'not-running'
  },
}))
let tmpDir: string
beforeEach(async () => {
  ;({ tmpDir } = await resetDb())
  _setSettingsPath(path.join(tmpDir, 'settings.json'))
})
afterEach(() => {
  closeDb()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

it.each(['rename-branch', 'resync-branch'])(
  'rejects %s while a confirmed deletion waits for agent closure',
  async (operation) => {
    const repo = path.join(tmpDir, 'repo')
    fs.mkdirSync(repo)
    const git = (args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: 'pipe' })
    git(['init', '-b', 'main'])
    git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'init'])
    const tree = path.join(repo, '.worktrees', 'feature', 'original')
    git(['worktree', 'add', '-b', 'feature/original', tree])
    const workspace = createWorkspace({
      name: 'race fixture',
      projectPath: repo,
      sourceBranch: 'main',
      workingBranch: 'feature/original',
      worktreePath: tree,
    })
    let release!: () => void
    gate.stop = new Promise<void>((resolve) => {
      release = resolve
    })
    const waiting = new Promise<void>((resolve) => {
      gate.reached = resolve
    })
    const dispatch = async (url: string, init: RequestInit) =>
      routes.request(`http://local${url.slice('/api/workspaces'.length)}`, init)
    const deletion = executeWorkspaceLifecycleTool(
      'delete_workspace',
      {
        workspace_id: workspace.id,
        confirm_delete: true,
        confirmation_branch: 'feature/original',
      },
      dispatch,
    )
    await waiting
    try {
      expect(isWorkspaceLifecycleBusy(workspace.id)).toBe(true)
      const response = await routes.request(`http://local/${workspace.id}/${operation}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newName: 'feature/replaced' }),
      })
      expect(response.status).toBe(409)
      expect(await response.json()).toMatchObject({ code: 'workspace-busy' })
      expect(getWorkspace(workspace.id)?.workingBranch).toBe('feature/original')
      expect(fs.existsSync(tree)).toBe(true)
    } finally {
      release()
      await deletion
    }
    expect(getWorkspace(workspace.id)).toBeNull()
    expect(fs.existsSync(tree)).toBe(false)
    expect(isWorkspaceLifecycleBusy(workspace.id)).toBe(false)
  },
)
