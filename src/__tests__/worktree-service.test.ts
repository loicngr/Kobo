import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildDockerChownArgs,
  createWorktree,
  isPermissionError,
  listOrphanWorktrees,
  listWorktrees,
  removeWorktree,
  worktreeExists,
} from '../server/services/worktree-service.js'

let repoDir: string
let bareDir: string

function gitSetup(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd })
}

beforeAll(() => {
  // Bare repo acting as origin — required so createWorktree can use origin/main.
  bareDir = fs.mkdtempSync(path.join(os.tmpdir(), 'at-wt-svc-bare-'))
  gitSetup(bareDir, ['init', '--bare'])

  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'at-wt-svc-test-'))
  gitSetup(repoDir, ['init'])
  gitSetup(repoDir, ['config', 'user.email', 'test@test.com'])
  gitSetup(repoDir, ['config', 'user.name', 'Test'])
  fs.writeFileSync(path.join(repoDir, 'readme.txt'), 'hello')
  gitSetup(repoDir, ['add', '.'])
  gitSetup(repoDir, ['commit', '-m', 'init'])
  try {
    gitSetup(repoDir, ['branch', '-M', 'main'])
  } catch {
    // already on main
  }
  // Add the bare repo as origin and push so origin/main tracking ref exists.
  gitSetup(repoDir, ['remote', 'add', 'origin', bareDir])
  gitSetup(repoDir, ['push', 'origin', 'main'])
})

afterAll(() => {
  if (repoDir && fs.existsSync(repoDir)) {
    fs.rmSync(repoDir, { recursive: true, force: true })
  }
  if (bareDir && fs.existsSync(bareDir)) {
    fs.rmSync(bareDir, { recursive: true, force: true })
  }
})

describe('createWorktree(projectPath, branchName, baseRef)', () => {
  it('creates a worktree directory for the branch', async () => {
    const { worktreePath, base } = await createWorktree(repoDir, 'feature/wt-test', 'origin/main')
    expect(fs.existsSync(worktreePath)).toBe(true)
    expect(base).toBe('origin')
  })

  it('le chemin du worktree est <projectPath>/.worktrees/<branchName>', async () => {
    const branchName = 'feature/path-check'
    const { worktreePath } = await createWorktree(repoDir, branchName, 'origin/main')
    const expected = path.join(repoDir, '.worktrees', branchName)
    expect(worktreePath).toBe(expected)
    expect(fs.existsSync(worktreePath)).toBe(true)
  })

  it('accepte une racine de worktrees relative personnalisée', async () => {
    const branchName = 'feature/custom-root'
    const { worktreePath } = await createWorktree(repoDir, branchName, 'origin/main', 'kobo-worktrees')
    const expected = path.join(repoDir, 'kobo-worktrees', branchName)
    expect(worktreePath).toBe(expected)
    expect(fs.existsSync(worktreePath)).toBe(true)
  })

  it('ajoute le worktree à .git/info/exclude', async () => {
    const branchName = 'feature/exclude-test'
    const { worktreePath } = await createWorktree(repoDir, branchName, 'origin/main')
    const excludeFile = path.join(repoDir, '.git', 'info', 'exclude')
    const content = fs.readFileSync(excludeFile, 'utf-8')
    const relativePath = path.relative(repoDir, worktreePath)
    expect(content).toContain(`/${relativePath}`)
  })

  it("n'ajoute pas les worktrees absolus hors projet à .git/info/exclude", async () => {
    const branchName = 'feature/external-root'
    const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'at-wt-external-'))
    let worktreePath = ''

    try {
      ;({ worktreePath } = await createWorktree(repoDir, branchName, 'origin/main', externalRoot))
      expect(worktreePath).toBe(path.join(externalRoot, branchName))
      expect(fs.existsSync(worktreePath)).toBe(true)

      const excludeFile = path.join(repoDir, '.git', 'info', 'exclude')
      const content = fs.existsSync(excludeFile) ? fs.readFileSync(excludeFile, 'utf-8') : ''
      const relativePath = path.relative(repoDir, worktreePath)
      expect(content).not.toContain(`/${relativePath}`)
    } finally {
      if (worktreePath && fs.existsSync(worktreePath)) {
        await removeWorktree(repoDir, worktreePath)
      }
      fs.rmSync(externalRoot, { recursive: true, force: true })
    }
  })

  it('fonctionne si la branche existe déjà (add sans -b)', async () => {
    // Create branch first without a worktree
    gitSetup(repoDir, ['branch', 'feature/existing-branch'])
    // createWorktree should fall back to 'git worktree add <path> <branch>'
    const { worktreePath } = await createWorktree(repoDir, 'feature/existing-branch', 'origin/main')
    expect(fs.existsSync(worktreePath)).toBe(true)
  })

  // `branchCreated` decides whether a failed creation may `git branch -D` on
  // rollback. Reporting `true` for a branch that was already there deletes work
  // Kobo never owned, so the flag has to come from the code that knows which
  // git command actually ran — not from the caller's optimistic assumption.
  it('reports branchCreated=false when the branch already existed', async () => {
    gitSetup(repoDir, ['branch', 'feature/pre-existing'])
    const { branchCreated } = await createWorktree(repoDir, 'feature/pre-existing', 'origin/main')
    expect(branchCreated).toBe(false)
  })

  it('reports branchCreated=true when it created the branch itself', async () => {
    const { branchCreated } = await createWorktree(repoDir, 'feature/brand-new', 'origin/main')
    expect(branchCreated).toBe(true)
  })

  it('creates a worktree from a local branch when base ref has no origin/ prefix', async () => {
    // `main` exists locally in repoDir (the clone). Base directly off it.
    const { worktreePath, base } = await createWorktree(repoDir, 'feature/local-base', 'main')
    expect(fs.existsSync(worktreePath)).toBe(true)
    expect(base).toBe('local')
    // The new branch points at the same commit as local main.
    const head = execFileSync('git', ['-C', worktreePath, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim()
    const mainHead = execFileSync('git', ['-C', repoDir, 'rev-parse', 'main'], { encoding: 'utf-8' }).trim()
    expect(head).toBe(mainHead)
  })
})

describe('listWorktrees(projectPath)', () => {
  it('retourne un tableau de WorktreeInfo avec au moins le worktree principal', async () => {
    const worktrees = await listWorktrees(repoDir)
    expect(Array.isArray(worktrees)).toBe(true)
    expect(worktrees.length).toBeGreaterThanOrEqual(1)
    expect(worktrees[0].path).toBeTruthy()
  })

  it('chaque entrée a path, branch, head', async () => {
    const worktrees = await listWorktrees(repoDir)
    worktrees.forEach((wt) => {
      expect(typeof wt.path).toBe('string')
      expect(typeof wt.branch).toBe('string')
      expect(typeof wt.head).toBe('string')
    })
  })

  it('inclut les worktrees créés', async () => {
    const branchName = 'feature/list-check'
    await createWorktree(repoDir, branchName, 'origin/main')
    const worktrees = await listWorktrees(repoDir)
    const found = worktrees.some((wt) => wt.branch === branchName)
    expect(found).toBe(true)
  })
})

describe('worktreeExists(projectPath, branchName)', () => {
  it('retourne true si le worktree existe', async () => {
    const branchName = 'feature/exists-true'
    await createWorktree(repoDir, branchName, 'origin/main')
    expect(await worktreeExists(repoDir, branchName)).toBe(true)
  })

  it("retourne false si le worktree n'existe pas", async () => {
    expect(await worktreeExists(repoDir, 'feature/does-not-exist-xyz')).toBe(false)
  })
})

describe('removeWorktree(projectPath, worktreePath)', () => {
  it('supprime le worktree et son dossier', async () => {
    const branchName = 'feature/remove-test'
    const { worktreePath } = await createWorktree(repoDir, branchName, 'origin/main')
    expect(fs.existsSync(worktreePath)).toBe(true)

    await removeWorktree(repoDir, worktreePath)
    expect(fs.existsSync(worktreePath)).toBe(false)
  })

  it("retire l'entrée de .git/info/exclude après suppression", async () => {
    const branchName = 'feature/remove-exclude'
    const { worktreePath } = await createWorktree(repoDir, branchName, 'origin/main')
    await removeWorktree(repoDir, worktreePath)

    const excludeFile = path.join(repoDir, '.git', 'info', 'exclude')
    if (fs.existsSync(excludeFile)) {
      const content = fs.readFileSync(excludeFile, 'utf-8')
      const relativePath = path.relative(repoDir, worktreePath)
      expect(content).not.toContain(`/${relativePath}`)
    }
  })

  it("le worktree n'apparaît plus dans listWorktrees après suppression", async () => {
    const branchName = 'feature/remove-list-check'
    const { worktreePath } = await createWorktree(repoDir, branchName, 'origin/main')
    await removeWorktree(repoDir, worktreePath)

    const worktrees = await listWorktrees(repoDir)
    const found = worktrees.some((wt) => wt.branch === branchName)
    expect(found).toBe(false)
  })

  it('waits for the shared repository lock before touching the common git dir', async () => {
    const { withGitRepoLock, _resetGitRepoLocksForTest } = await import('../server/utils/git-repo-lock.js')
    _resetGitRepoLocksForTest()
    const { worktreePath } = await createWorktree(repoDir, 'feature/remove-under-lock', 'origin/main')

    let release: (() => void) | undefined
    const holder = withGitRepoLock(repoDir, () => new Promise<void>((resolve) => (release = resolve)))
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))

    const pending = removeWorktree(repoDir, worktreePath)
    for (let i = 0; i < 5; i++) await Promise.resolve()
    // `git worktree remove` mutates the common git dir, so it must not run
    // while another repository operation holds the lock.
    expect(fs.existsSync(worktreePath)).toBe(true)

    release!()
    await holder
    await pending
    expect(fs.existsSync(worktreePath)).toBe(false)
  })

  it('refuses to report success while the directory is still on disk', async () => {
    const wtPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'at-wt-verify-')), 'wt')
    await createWorktree(repoDir, 'feature/verify-removal', 'origin/main')
    // Simulate the failure mode: git drops the administrative entry but the
    // directory survives (root-owned files, a busy mount, an open handle).
    const realPath = (await listWorktrees(repoDir)).find((w) => w.branch === 'feature/verify-removal')?.path as string
    gitSetup(repoDir, ['worktree', 'remove', realPath, '--force'])
    fs.mkdirSync(realPath, { recursive: true })
    fs.writeFileSync(path.join(realPath, 'leftover.txt'), 'still here\n')

    await expect(removeWorktree(repoDir, realPath)).rejects.toThrow(/still on disk|Failed to remove worktree/)
    expect(fs.existsSync(realPath)).toBe(true)

    fs.rmSync(realPath, { recursive: true, force: true })
    fs.rmSync(wtPath, { recursive: true, force: true })
  })
})

describe('listOrphanWorktrees(projectPath, attachedPaths)', () => {
  let tmpDir: string
  let projectPath: string

  function git(cwd: string, args: string[]): string {
    return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-svc-orphan-'))
    projectPath = path.join(tmpDir, 'repo')
    fs.mkdirSync(projectPath, { recursive: true })
    git(projectPath, ['init', '-b', 'main'])
    git(projectPath, ['config', 'user.email', 'test@kobo.local'])
    git(projectPath, ['config', 'user.name', 'Test'])
    fs.writeFileSync(path.join(projectPath, 'README.md'), '# test\n')
    git(projectPath, ['add', '.'])
    git(projectPath, ['commit', '-m', 'init'])
  })

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('returns the worktrees of a project minus the main worktree and the attached ones', async () => {
    const wt1 = path.join(tmpDir, 'wt1')
    const wt2 = path.join(tmpDir, 'wt2')
    git(projectPath, ['worktree', 'add', '-b', 'feature/foo', wt1])
    git(projectPath, ['worktree', 'add', '-b', 'feature/bar', wt2])

    const attached = new Set([wt1])
    const orphans = await listOrphanWorktrees(projectPath, attached)

    expect(orphans).toHaveLength(1)
    expect(fs.realpathSync(orphans[0].path)).toBe(fs.realpathSync(wt2))
    expect(orphans[0].branch).toBe('feature/bar')
    expect(orphans[0].head).toBeTruthy()
    expect(orphans[0].suggestedSourceBranch).toBe('main') // origin/HEAD fallback
  })

  it('excludes the main worktree even when no attached paths are given', async () => {
    const wt1 = path.join(tmpDir, 'wt1')
    git(projectPath, ['worktree', 'add', '-b', 'feature/foo', wt1])

    const orphans = await listOrphanWorktrees(projectPath, new Set())
    expect(orphans).toHaveLength(1)
    expect(fs.realpathSync(orphans[0].path)).toBe(fs.realpathSync(wt1))
  })

  it('excludes detached HEAD worktrees', async () => {
    const wt1 = path.join(tmpDir, 'wt1')
    git(projectPath, ['worktree', 'add', '--detach', wt1])

    const orphans = await listOrphanWorktrees(projectPath, new Set())
    expect(orphans).toHaveLength(0)
  })

  it('canonicalizes both sides of the attached comparison via realpathSync', async () => {
    const wt1 = path.join(tmpDir, 'wt1')
    git(projectPath, ['worktree', 'add', '-b', 'feature/foo', wt1])

    const symlink = path.join(tmpDir, 'wt1-symlink')
    fs.symlinkSync(wt1, symlink)

    // Asymmetric paths between attached set (symlink) and listWorktrees output
    // (real path) — canonicalization on both sides must collapse them.
    const orphans = await listOrphanWorktrees(projectPath, new Set([symlink]))
    expect(orphans).toHaveLength(0)
  })
})

describe('isPermissionError', () => {
  it('is true for filesystem permission errors', async () => {
    expect(isPermissionError('rm: cannot remove: Permission denied')).toBe(true)
    expect(isPermissionError('EACCES: permission denied')).toBe(true)
    expect(isPermissionError('Error: EPERM operation not permitted')).toBe(true)
    expect(isPermissionError('operation not permitted')).toBe(true)
    // French locale (the real-world failure that revealed this): git/libc emit
    // "Permission non accordée" instead of "Permission denied".
    expect(isPermissionError("erreur : échec de la suppression de '/x': Permission non accordée")).toBe(true)
    expect(isPermissionError('opération non permise')).toBe(true)
  })
  it('is false for unrelated errors', async () => {
    expect(isPermissionError('fatal: not a git repository')).toBe(false)
    expect(isPermissionError('merge conflict')).toBe(false)
  })
})

describe('buildDockerChownArgs', () => {
  it('builds a docker run argv that chowns the bind-mounted worktree', async () => {
    expect(buildDockerChownArgs('/home/u/worktrees/ws', 1000, 1000, 'alpine')).toEqual([
      'run',
      '--rm',
      '-v',
      '/home/u/worktrees/ws:/w',
      'alpine',
      'chown',
      '-R',
      '1000:1000',
      '/w',
    ])
  })
  it('uses the provided image', async () => {
    expect(buildDockerChownArgs('/w/x', 501, 20, 'busybox')[4]).toBe('busybox')
  })
})

it('keeps timers responsive while a checkout hook is running', async () => {
  const hook = path.join(repoDir, '.git/hooks/post-checkout')
  fs.writeFileSync(hook, '#!/bin/sh\nsleep 0.2\n', { mode: 0o755 })
  let ticked = false
  const timer = setTimeout(() => {
    ticked = true
  }, 10)
  try {
    await createWorktree(repoDir, 'feature/responsive-checkout', 'main')
    expect(ticked).toBe(true)
  } finally {
    clearTimeout(timer)
    fs.rmSync(hook, { force: true })
  }
})

it('waits for repository ownership before creating a worktree', async () => {
  const { withGitRepoLock } = await import('../server/utils/git-repo-lock.js')
  let release!: () => void
  const holder = withGitRepoLock(
    repoDir,
    () =>
      new Promise<void>((resolve) => {
        release = resolve
      }),
  )
  await vi.waitFor(() => expect(release).toBeTypeOf('function'))
  const pending = createWorktree(repoDir, 'feature/serialized-create', 'main')
  try {
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(fs.existsSync(path.join(repoDir, '.worktrees/feature/serialized-create'))).toBe(false)
  } finally {
    release()
    await holder
    await pending
  }
})

it('reports checkout ownership when updating Git excludes fails after creation', async () => {
  const fsPromises = (await import('node:fs/promises')).default
  const actualWrite = fsPromises.writeFile.bind(fsPromises)
  const write = vi.spyOn(fsPromises, 'writeFile').mockImplementation((target, ...args) => {
    if (String(target).endsWith('/info/exclude')) return Promise.reject(new Error('exclude write failed'))
    return actualWrite(target, ...args)
  })
  const worktreePath = path.join(repoDir, '.worktrees/feature/exclude-failure')
  try {
    await expect(createWorktree(repoDir, 'feature/exclude-failure', 'main')).rejects.toMatchObject({
      worktreePath,
      branchCreated: true,
    })
    expect(fs.existsSync(worktreePath)).toBe(true)
  } finally {
    write.mockRestore()
  }
})

it.each([false, true])(
  'reports a checkout created before its hook fails (existing branch: %s)',
  async (existingBranch) => {
    const branchName = `feature/hook-failure-${existingBranch}`
    const hook = path.join(repoDir, '.git/hooks/post-checkout')
    const worktreePath = path.join(repoDir, '.worktrees', branchName)
    if (existingBranch) gitSetup(repoDir, ['branch', branchName, 'main'])
    fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    try {
      await expect(createWorktree(repoDir, branchName, 'main')).rejects.toMatchObject({
        name: 'WorktreeCreationError',
        worktreePath,
        branchCreated: !existingBranch,
      })
      expect(await listWorktrees(repoDir)).toContainEqual(
        expect.objectContaining({ path: worktreePath, branch: branchName }),
      )
    } finally {
      fs.rmSync(hook, { force: true })
    }
  },
)

it('does not claim a checkout already present before a failed creation attempt', async () => {
  const branchName = 'feature/pre-existing-checkout-failure'
  const existing = await createWorktree(repoDir, branchName, 'main')
  await expect(createWorktree(repoDir, branchName, 'main')).rejects.not.toMatchObject({ name: 'WorktreeCreationError' })
  expect(fs.existsSync(existing.worktreePath)).toBe(true)
})
