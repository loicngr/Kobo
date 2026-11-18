// End to end across the real modules: purge (keep `.ai`) -> read root -> restore (put back) -> purge -> delete cleanup.
// Only what cannot run in a test is mocked: agent stop, dev server, terminal, forge lookup, websocket, PR caches.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeDb } from '../server/db/index.js'
import { resetDb } from './helpers/reset-db.js'

vi.mock('../server/services/agent/orchestrator.js', () => ({ stopAgentAndWait: vi.fn(async () => 'not-running') }))
vi.mock('../server/services/dev-server-service.js', () => ({ stopDevServer: vi.fn(async () => {}) }))
vi.mock('../server/services/terminal-service.js', () => ({ destroyTerminal: vi.fn(async () => {}) }))
vi.mock('../server/services/forge/resolve.js', () => ({ resolveForge: vi.fn(() => 'none') }))
vi.mock('../server/services/forge/registry.js', () => ({ getForgeProvider: vi.fn() }))
vi.mock('../server/services/websocket-service.js', () => ({ emitEphemeral: vi.fn(), broadcastAll: vi.fn() }))
// Only the removal can be made to fail on demand (root-owned files cannot be created in CI): everything else is real.
const failRemoval = vi.hoisted(() => ({ on: false }))
vi.mock('../server/services/worktree-service.js', async () => {
  const actual = await vi.importActual<typeof import('../server/services/worktree-service.js')>(
    '../server/services/worktree-service.js',
  )
  return {
    ...actual,
    removeWorktree: async (projectPath: string, worktreePath: string) => {
      if (!failRemoval.on) return actual.removeWorktree(projectPath, worktreePath)
      // What a permission failure leaves: git de-registered the worktree, a folder with leftovers survives.
      await actual.removeWorktree(projectPath, worktreePath)
      fs.mkdirSync(path.join(worktreePath, 'node_modules'), { recursive: true })
      fs.writeFileSync(path.join(worktreePath, 'node_modules', 'root-owned'), 'x')
      throw new Error('EACCES: permission denied')
    },
  }
})
vi.mock('../server/services/pr-watcher-service.js', () => ({ invalidateWorkspacePrCaches: vi.fn() }))

import { getDb } from '../server/db/index.js'
import { removeKeptAiFor, workspaceFilesRoot } from '../server/services/kept-ai-service.js'
import { _setSettingsPath } from '../server/services/settings-service.js'
import * as workspaces from '../server/services/workspace-service.js'
import { purgeWorktree } from '../server/services/worktree-purge-service.js'
import { restorePurgedWorktree } from '../server/services/worktree-restore-service.js'
import { createWorktree } from '../server/services/worktree-service.js'

const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim()

let tmpDir: string
let root: string
let repo: string
let worktree: string
let id: string

function seedAi() {
  fs.mkdirSync(path.join(worktree, '.ai', 'thoughts'), { recursive: true })
  fs.mkdirSync(path.join(worktree, '.ai', 'images'), { recursive: true })
  fs.mkdirSync(path.join(worktree, '.ai', '.script-abc'), { recursive: true })
  fs.writeFileSync(path.join(worktree, '.ai', 'thoughts', 'note.md'), '# Note\n')
  fs.writeFileSync(path.join(worktree, '.ai', 'images', 'index.json'), '{"p.png":"first"}')
  fs.writeFileSync(path.join(worktree, '.ai', 'images', 'p.png'), 'png-bytes')
  fs.writeFileSync(path.join(worktree, '.ai', '.script-abc', 'tmp'), 'scratch')
}

beforeEach(async () => {
  ;({ tmpDir } = await resetDb())
  _setSettingsPath(path.join(tmpDir, 'settings.json'))
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kobo-kept-integration-'))
  repo = path.join(root, 'repo')
  fs.mkdirSync(repo, { recursive: true })
  git(repo, ['init', '-b', 'main'])
  git(repo, ['config', 'user.email', 'test@kobo.local'])
  git(repo, ['config', 'user.name', 'Test'])
  git(repo, ['commit', '--allow-empty', '-m', 'Initial'])
  const created = await createWorktree(repo, 'feature/kept', 'main')
  worktree = created.worktreePath
  const ws = workspaces.createWorkspace({
    name: 'kept',
    projectPath: repo,
    sourceBranch: 'main',
    workingBranch: 'feature/kept',
    worktreePath: worktree,
  })
  id = ws.id
  seedAi()
})

afterEach(() => {
  closeDb()
  fs.rmSync(tmpDir, { recursive: true, force: true })
  fs.rmSync(root, { recursive: true, force: true })
})

describe('keep .ai across purge and restore (real git repository)', () => {
  it('purge keeps .ai readable, restore puts it back, and delete removes the kept root', async () => {
    const keptRoot = path.join(repo, '.worktrees', '.kobo-kept', id)

    // Purge
    const purged = await purgeWorktree(id)
    expect(purged.outcome).toBe('purged')
    expect(purged.warnings).toEqual([])
    expect(fs.existsSync(worktree)).toBe(false)
    expect(fs.readFileSync(path.join(keptRoot, '.ai', 'thoughts', 'note.md'), 'utf8')).toBe('# Note\n')
    expect(fs.readFileSync(path.join(keptRoot, '.ai', 'images', 'p.png'), 'utf8')).toBe('png-bytes')
    expect(fs.existsSync(path.join(keptRoot, '.ai', '.script-abc'))).toBe(false)
    const row = workspaces.getWorkspace(id)!
    expect(row.worktreePurgedAt).toBeTruthy()
    expect(JSON.parse(row.worktreePurgeRestoreData!).keptAiPath).toBe(keptRoot)
    expect(git(repo, ['status', '--porcelain'])).not.toContain('.kobo-kept')
    expect(workspaceFilesRoot(row)).toBe(keptRoot)

    // Restore
    const restored = await restorePurgedWorktree(id)
    expect(restored.outcome).toBe('restored')
    expect(restored.warnings).toEqual([])
    expect(fs.readFileSync(path.join(worktree, '.ai', 'thoughts', 'note.md'), 'utf8')).toBe('# Note\n')
    expect(fs.readFileSync(path.join(worktree, '.ai', 'images', 'index.json'), 'utf8')).toBe('{"p.png":"first"}')
    expect(fs.existsSync(keptRoot)).toBe(false)
    const after = workspaces.getWorkspace(id)!
    expect(after.worktreePurgedAt).toBeNull()
    expect(after.worktreePurgeRestoreData).toBeNull()
    expect(workspaceFilesRoot(after)).toBe(worktree)

    // Second purge, then the delete path's cleanup
    getDb().prepare('UPDATE workspaces SET archived_at = NULL WHERE id = ?').run(id)
    expect((await purgeWorktree(id)).outcome).toBe('purged')
    expect(fs.existsSync(path.join(keptRoot, '.ai', 'thoughts', 'note.md'))).toBe(true)
    expect(await removeKeptAiFor(workspaces.getWorkspace(id)!)).toEqual([])
    expect(fs.existsSync(keptRoot)).toBe(false)
    expect(fs.existsSync(path.join(repo, '.worktrees', '.kobo-kept'))).toBe(false)
  })

  it('after a failed removal that de-registered the worktree, .ai stays kept and the next purge records it', async () => {
    const keptRoot = path.join(repo, '.worktrees', '.kobo-kept', id)
    failRemoval.on = true
    try {
      const first = await purgeWorktree(id)
      expect(first.outcome).toBe('removal-failed')
      expect(first.warnings.join('\n')).toContain(`The .ai folder was kept in '${keptRoot}'`)
      expect(fs.readFileSync(path.join(keptRoot, '.ai', 'thoughts', 'note.md'), 'utf8')).toBe('# Note\n')
      expect(fs.existsSync(path.join(worktree, '.ai'))).toBe(false)
      expect(workspaces.getWorkspace(id)!.worktreePurgedAt).toBeNull()

      fs.rmSync(worktree, { recursive: true, force: true }) // the operator follows the recovery steps
      const second = await purgeWorktree(id)
      expect(second.outcome).toBe('purged')
      expect(JSON.parse(workspaces.getWorkspace(id)!.worktreePurgeRestoreData!).keptAiPath).toBe(keptRoot)
      expect(fs.readFileSync(path.join(keptRoot, '.ai', 'images', 'p.png'), 'utf8')).toBe('png-bytes')
    } finally {
      failRemoval.on = false
    }
  })
})
