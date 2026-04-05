import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createWorktree, listWorktrees, removeWorktree, worktreeExists } from '../server/services/worktree-service.js'

let repoDir: string

function gitSetup(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd })
}

beforeAll(() => {
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
})

afterAll(() => {
  if (repoDir && fs.existsSync(repoDir)) {
    fs.rmSync(repoDir, { recursive: true, force: true })
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

  it('ajoute le worktree à .git/info/exclude', () => {
    const branchName = 'feature/exclude-test'
    const worktreePath = createWorktree(repoDir, branchName, 'main')
    const excludeFile = path.join(repoDir, '.git', 'info', 'exclude')
    const content = fs.readFileSync(excludeFile, 'utf-8')
    const relativePath = path.relative(repoDir, worktreePath)
    expect(content).toContain(`/${relativePath}`)
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
