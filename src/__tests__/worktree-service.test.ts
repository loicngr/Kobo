import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  createWorktree,
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

describe('createWorktree(projectPath, branchName, sourceBranch)', () => {
  it('crée un worktree et retourne le chemin', () => {
    const worktreePath = createWorktree(repoDir, 'feature/wt-test', 'main')
    expect(worktreePath).toBeTruthy()
    expect(fs.existsSync(worktreePath)).toBe(true)
  })

  it('le chemin du worktree est <projectPath>/.worktrees/<branchName>', () => {
    const branchName = 'feature/path-check'
    const worktreePath = createWorktree(repoDir, branchName, 'main')
    const expected = path.join(repoDir, '.worktrees', branchName)
    expect(worktreePath).toBe(expected)
    expect(fs.existsSync(worktreePath)).toBe(true)
  })

  it('accepte une racine de worktrees relative personnalisée', () => {
    const branchName = 'feature/custom-root'
    const worktreePath = createWorktree(repoDir, branchName, 'main', 'kobo-worktrees')
    const expected = path.join(repoDir, 'kobo-worktrees', branchName)
    expect(worktreePath).toBe(expected)
    expect(fs.existsSync(worktreePath)).toBe(true)
  })

  it('ajoute le worktree à .git/info/exclude', () => {
    const branchName = 'feature/exclude-test'
    const worktreePath = createWorktree(repoDir, branchName, 'main')
    const excludeFile = path.join(repoDir, '.git', 'info', 'exclude')
    const content = fs.readFileSync(excludeFile, 'utf-8')
    const relativePath = path.relative(repoDir, worktreePath)
    expect(content).toContain(`/${relativePath}`)
  })

  it("n'ajoute pas les worktrees absolus hors projet à .git/info/exclude", () => {
    const branchName = 'feature/external-root'
    const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'at-wt-external-'))
    let worktreePath = ''

    try {
      worktreePath = createWorktree(repoDir, branchName, 'main', externalRoot)
      expect(worktreePath).toBe(path.join(externalRoot, branchName))
      expect(fs.existsSync(worktreePath)).toBe(true)

      const excludeFile = path.join(repoDir, '.git', 'info', 'exclude')
      const content = fs.existsSync(excludeFile) ? fs.readFileSync(excludeFile, 'utf-8') : ''
      const relativePath = path.relative(repoDir, worktreePath)
      expect(content).not.toContain(`/${relativePath}`)
    } finally {
      if (worktreePath && fs.existsSync(worktreePath)) {
        removeWorktree(repoDir, worktreePath)
      }
      fs.rmSync(externalRoot, { recursive: true, force: true })
    }
  })

  it('fonctionne si la branche existe déjà (add sans -b)', () => {
    // Create branch first without a worktree
    gitSetup(repoDir, ['branch', 'feature/existing-branch'])
    // createWorktree should fall back to 'git worktree add <path> <branch>'
    const worktreePath = createWorktree(repoDir, 'feature/existing-branch', 'main')
    expect(fs.existsSync(worktreePath)).toBe(true)
  })
})

describe('listWorktrees(projectPath)', () => {
  it('retourne un tableau de WorktreeInfo avec au moins le worktree principal', () => {
    const worktrees = listWorktrees(repoDir)
    expect(Array.isArray(worktrees)).toBe(true)
    expect(worktrees.length).toBeGreaterThanOrEqual(1)
    expect(worktrees[0].path).toBeTruthy()
  })

  it('chaque entrée a path, branch, head', () => {
    const worktrees = listWorktrees(repoDir)
    worktrees.forEach((wt) => {
      expect(typeof wt.path).toBe('string')
      expect(typeof wt.branch).toBe('string')
      expect(typeof wt.head).toBe('string')
    })
  })

  it('inclut les worktrees créés', () => {
    const branchName = 'feature/list-check'
    createWorktree(repoDir, branchName, 'main')
    const worktrees = listWorktrees(repoDir)
    const found = worktrees.some((wt) => wt.branch === branchName)
    expect(found).toBe(true)
  })
})

describe('worktreeExists(projectPath, branchName)', () => {
  it('retourne true si le worktree existe', () => {
    const branchName = 'feature/exists-true'
    createWorktree(repoDir, branchName, 'main')
    expect(worktreeExists(repoDir, branchName)).toBe(true)
  })

  it("retourne false si le worktree n'existe pas", () => {
    expect(worktreeExists(repoDir, 'feature/does-not-exist-xyz')).toBe(false)
  })
})

describe('removeWorktree(projectPath, worktreePath)', () => {
  it('supprime le worktree et son dossier', () => {
    const branchName = 'feature/remove-test'
    const worktreePath = createWorktree(repoDir, branchName, 'main')
    expect(fs.existsSync(worktreePath)).toBe(true)

    removeWorktree(repoDir, worktreePath)
    expect(fs.existsSync(worktreePath)).toBe(false)
  })

  it("retire l'entrée de .git/info/exclude après suppression", () => {
    const branchName = 'feature/remove-exclude'
    const worktreePath = createWorktree(repoDir, branchName, 'main')
    removeWorktree(repoDir, worktreePath)

    const excludeFile = path.join(repoDir, '.git', 'info', 'exclude')
    if (fs.existsSync(excludeFile)) {
      const content = fs.readFileSync(excludeFile, 'utf-8')
      const relativePath = path.relative(repoDir, worktreePath)
      expect(content).not.toContain(`/${relativePath}`)
    }
  })

  it("le worktree n'apparaît plus dans listWorktrees après suppression", () => {
    const branchName = 'feature/remove-list-check'
    const worktreePath = createWorktree(repoDir, branchName, 'main')
    removeWorktree(repoDir, worktreePath)

    const worktrees = listWorktrees(repoDir)
    const found = worktrees.some((wt) => wt.branch === branchName)
    expect(found).toBe(false)
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

  it('returns the worktrees of a project minus the main worktree and the attached ones', () => {
    const wt1 = path.join(tmpDir, 'wt1')
    const wt2 = path.join(tmpDir, 'wt2')
    git(projectPath, ['worktree', 'add', '-b', 'feature/foo', wt1])
    git(projectPath, ['worktree', 'add', '-b', 'feature/bar', wt2])

    const attached = new Set([wt1])
    const orphans = listOrphanWorktrees(projectPath, attached)

    expect(orphans).toHaveLength(1)
    expect(orphans[0].path).toBe(wt2)
    expect(orphans[0].branch).toBe('feature/bar')
    expect(orphans[0].head).toBeTruthy()
    expect(orphans[0].suggestedSourceBranch).toBe('main') // origin/HEAD fallback
  })

  it('excludes the main worktree even when no attached paths are given', () => {
    const wt1 = path.join(tmpDir, 'wt1')
    git(projectPath, ['worktree', 'add', '-b', 'feature/foo', wt1])

    const orphans = listOrphanWorktrees(projectPath, new Set())
    expect(orphans).toHaveLength(1)
    expect(orphans[0].path).toBe(wt1)
  })

  it('excludes detached HEAD worktrees', () => {
    const wt1 = path.join(tmpDir, 'wt1')
    git(projectPath, ['worktree', 'add', '--detach', wt1])

    const orphans = listOrphanWorktrees(projectPath, new Set())
    expect(orphans).toHaveLength(0)
  })

  it('canonicalizes both sides of the attached comparison via realpathSync', () => {
    const wt1 = path.join(tmpDir, 'wt1')
    git(projectPath, ['worktree', 'add', '-b', 'feature/foo', wt1])

    const symlink = path.join(tmpDir, 'wt1-symlink')
    fs.symlinkSync(wt1, symlink)

    // Asymmetric paths between attached set (symlink) and listWorktrees output
    // (real path) — canonicalization on both sides must collapse them.
    const orphans = listOrphanWorktrees(projectPath, new Set([symlink]))
    expect(orphans).toHaveLength(0)
  })
})
