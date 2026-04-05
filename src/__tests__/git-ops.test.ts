import { execFileSync, execSync } from 'node:child_process'
import fs, { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os, { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  BranchAlreadyExistsError,
  createBranch,
  deleteLocalBranch,
  deleteRemoteBranch,
  getCommitCount,
  getCommitsBetween,
  getCurrentBranch,
  getDiffStats,
  getDiffStatsBetween,
  getStructuredDiffStatsBetween,
  listBranches,
  listRemoteBranches,
  pushBranch,
} from '../server/utils/git-ops.js'

let repoDir: string

beforeAll(() => {
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'at-git-test-'))
  execSync('git init', { cwd: repoDir })
  execSync('git config user.email "test@test.com"', { cwd: repoDir })
  execSync('git config user.name "Test"', { cwd: repoDir })
  fs.writeFileSync(path.join(repoDir, 'readme.txt'), 'hello')
  execSync('git add .', { cwd: repoDir })
  execSync('git commit -m "init"', { cwd: repoDir })
  try {
    execSync('git branch -M main', { cwd: repoDir })
  } catch {
    // already main
  }
})

afterAll(() => {
  if (repoDir && fs.existsSync(repoDir)) {
    fs.rmSync(repoDir, { recursive: true, force: true })
  }
})

describe('getCurrentBranch(repoPath)', () => {
  it('retourne le nom de la branche courante', () => {
    const branch = getCurrentBranch(repoDir)
    expect(branch).toBe('main')
  })
})

describe('listBranches(repoPath)', () => {
  it('retourne un tableau contenant main', () => {
    const branches = listBranches(repoDir)
    expect(branches).toContain('main')
  })

  it('retourne un tableau de strings', () => {
    const branches = listBranches(repoDir)
    expect(Array.isArray(branches)).toBe(true)
    branches.forEach((b) => {
      expect(typeof b).toBe('string')
    })
  })
})

describe('createBranch(repoPath, branchName, sourceBranch)', () => {
  it('crée une nouvelle branche à partir de main', () => {
    createBranch(repoDir, 'feature/test-branch', 'main')
    const branches = listBranches(repoDir)
    expect(branches).toContain('feature/test-branch')
  })

  it('la branche courante reste sur main après la création', () => {
    createBranch(repoDir, 'feature/another-branch', 'main')
    const current = getCurrentBranch(repoDir)
    expect(current).toBe('main')
  })

  it('lève BranchAlreadyExistsError si la branche existe déjà', () => {
    createBranch(repoDir, 'feature/duplicate-branch', 'main')
    expect(() => createBranch(repoDir, 'feature/duplicate-branch', 'main')).toThrow(BranchAlreadyExistsError)
  })

  it('le message de BranchAlreadyExistsError contient le nom de la branche', () => {
    expect(() => createBranch(repoDir, 'feature/duplicate-branch', 'main')).toThrow(
      "Branch 'feature/duplicate-branch' already exists",
    )
  })
})

describe('getDiffStats(repoPath)', () => {
  it('retourne un objet avec filesChanged, insertions, deletions', () => {
    const stats = getDiffStats(repoDir)
    expect(typeof stats.filesChanged).toBe('number')
    expect(typeof stats.insertions).toBe('number')
    expect(typeof stats.deletions).toBe('number')
  })

  it('retourne 0 quand pas de changements non commités', () => {
    const stats = getDiffStats(repoDir)
    expect(stats.filesChanged).toBe(0)
    expect(stats.insertions).toBe(0)
    expect(stats.deletions).toBe(0)
  })

  it('détecte les changements non commités', () => {
    fs.writeFileSync(path.join(repoDir, 'new-file.txt'), 'line1\nline2\n')
    execSync('git add .', { cwd: repoDir })

    const stats = getDiffStats(repoDir)
    expect(stats.filesChanged).toBeGreaterThan(0)
    expect(stats.insertions).toBeGreaterThan(0)

    execSync('git reset HEAD .', { cwd: repoDir })
    fs.unlinkSync(path.join(repoDir, 'new-file.txt'))
  })
})

describe('listRemoteBranches(repoPath)', () => {
  it('retourne un tableau (vide si pas de remote)', () => {
    const branches = listRemoteBranches(repoDir)
    expect(Array.isArray(branches)).toBe(true)
  })
})

function gitSetup(repoPath: string, args: string[]): void {
  execSync(`git ${args.join(' ')}`, { cwd: repoPath })
}

describe('deleteLocalBranch(repoPath, branchName)', () => {
  it('supprime une branche locale existante', () => {
    gitSetup(repoDir, ['branch', 'feature/delete-local-test'])
    deleteLocalBranch(repoDir, 'feature/delete-local-test')
    const branches = listBranches(repoDir)
    expect(branches).not.toContain('feature/delete-local-test')
  })

  it("lève une erreur si la branche n'existe pas", () => {
    expect(() => deleteLocalBranch(repoDir, 'feature/ghost-branch-xyz')).toThrow()
  })
})

describe('deleteRemoteBranch(repoPath, branchName)', () => {
  it('lève une erreur si pas de remote configuré', () => {
    expect(() => deleteRemoteBranch(repoDir, 'feature/no-remote')).toThrow()
  })
})

describe('pushBranch', () => {
  it('pushes branch to origin successfully', () => {
    const repo = mkdtempSync(path.join(tmpdir(), 'at-git-'))
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo })
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repo })
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo })
    writeFileSync(path.join(repo, 'f.txt'), 'hello')
    execFileSync('git', ['add', '.'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repo })

    const bare = mkdtempSync(path.join(tmpdir(), 'at-remote-'))
    execFileSync('git', ['init', '--bare'], { cwd: bare })
    execFileSync('git', ['remote', 'add', 'origin', bare], { cwd: repo })

    expect(() => pushBranch(repo, 'main')).not.toThrow()

    const remoteBranches = execFileSync('git', ['branch', '-r'], { cwd: repo, encoding: 'utf-8' })
    expect(remoteBranches).toContain('origin/main')

    rmSync(repo, { recursive: true, force: true })
    rmSync(bare, { recursive: true, force: true })
  })

  it('throws with stderr when push fails', () => {
    const repo = mkdtempSync(path.join(tmpdir(), 'at-git-'))
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo })
    // No remote configured — push must fail
    expect(() => pushBranch(repo, 'main')).toThrow()
    rmSync(repo, { recursive: true, force: true })
  })
})

describe('getCommitsBetween', () => {
  it('returns formatted commit list between two branches', () => {
    const repo = mkdtempSync(path.join(tmpdir(), 'at-git-'))
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo })
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repo })
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo })
    writeFileSync(path.join(repo, 'a.txt'), 'a')
    execFileSync('git', ['add', '.'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: repo })

    execFileSync('git', ['checkout', '-b', 'feature'], { cwd: repo })
    writeFileSync(path.join(repo, 'b.txt'), 'b')
    execFileSync('git', ['add', '.'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'feat: add b'], { cwd: repo })
    writeFileSync(path.join(repo, 'c.txt'), 'c')
    execFileSync('git', ['add', '.'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'feat: add c'], { cwd: repo })

    const result = getCommitsBetween(repo, 'main', 'feature')
    expect(result).toContain('feat: add b')
    expect(result).toContain('feat: add c')
    expect(result).not.toContain('initial')

    rmSync(repo, { recursive: true, force: true })
  })

  it('returns empty string when no commits between branches', () => {
    const repo = mkdtempSync(path.join(tmpdir(), 'at-git-'))
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo })
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repo })
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo })
    writeFileSync(path.join(repo, 'a.txt'), 'a')
    execFileSync('git', ['add', '.'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: repo })
    execFileSync('git', ['checkout', '-b', 'feature'], { cwd: repo })

    const result = getCommitsBetween(repo, 'main', 'feature')
    expect(result).toBe('')

    rmSync(repo, { recursive: true, force: true })
  })
})

describe('getDiffStatsBetween', () => {
  it('returns shortstat output between two branches', () => {
    const repo = mkdtempSync(path.join(tmpdir(), 'at-git-'))
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo })
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repo })
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo })
    writeFileSync(path.join(repo, 'a.txt'), 'a\n')
    execFileSync('git', ['add', '.'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: repo })

    execFileSync('git', ['checkout', '-b', 'feature'], { cwd: repo })
    writeFileSync(path.join(repo, 'b.txt'), 'b\nb\nb\n')
    execFileSync('git', ['add', '.'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'feat'], { cwd: repo })

    const result = getDiffStatsBetween(repo, 'main', 'feature')
    expect(result).toMatch(/\d+ file.*changed/)
    expect(result).toMatch(/\d+ insertion/)

    rmSync(repo, { recursive: true, force: true })
  })

  it('returns empty string when no diff', () => {
    const repo = mkdtempSync(path.join(tmpdir(), 'at-git-'))
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo })
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repo })
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo })
    writeFileSync(path.join(repo, 'a.txt'), 'a')
    execFileSync('git', ['add', '.'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: repo })
    execFileSync('git', ['checkout', '-b', 'feature'], { cwd: repo })

    const result = getDiffStatsBetween(repo, 'main', 'feature')
    expect(result).toBe('')

    rmSync(repo, { recursive: true, force: true })
  })
})

describe('getCommitCount', () => {
  it('returns the number of commits between two branches', () => {
    const repo = mkdtempSync(path.join(tmpdir(), 'at-git-'))
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo })
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repo })
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo })
    writeFileSync(path.join(repo, 'a.txt'), 'a')
    execFileSync('git', ['add', '.'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: repo })

    execFileSync('git', ['checkout', '-b', 'feature'], { cwd: repo })
    writeFileSync(path.join(repo, 'b.txt'), 'b')
    execFileSync('git', ['add', '.'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'feat: add b'], { cwd: repo })
    writeFileSync(path.join(repo, 'c.txt'), 'c')
    execFileSync('git', ['add', '.'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'feat: add c'], { cwd: repo })

    const count = getCommitCount(repo, 'main', 'feature')
    expect(count).toBe(2)

    rmSync(repo, { recursive: true, force: true })
  })

  it('returns 0 when no commits between branches', () => {
    const repo = mkdtempSync(path.join(tmpdir(), 'at-git-'))
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo })
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repo })
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo })
    writeFileSync(path.join(repo, 'a.txt'), 'a')
    execFileSync('git', ['add', '.'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: repo })
    execFileSync('git', ['checkout', '-b', 'feature'], { cwd: repo })

    const count = getCommitCount(repo, 'main', 'feature')
    expect(count).toBe(0)

    rmSync(repo, { recursive: true, force: true })
  })
})

describe('getStructuredDiffStatsBetween', () => {
  it('returns structured diff stats between two branches', () => {
    const repo = mkdtempSync(path.join(tmpdir(), 'at-git-'))
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo })
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repo })
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo })
    writeFileSync(path.join(repo, 'a.txt'), 'a\n')
    execFileSync('git', ['add', '.'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: repo })

    execFileSync('git', ['checkout', '-b', 'feature'], { cwd: repo })
    writeFileSync(path.join(repo, 'b.txt'), 'b\nb\nb\n')
    execFileSync('git', ['add', '.'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'feat'], { cwd: repo })

    const stats = getStructuredDiffStatsBetween(repo, 'main', 'feature')
    expect(stats.filesChanged).toBe(1)
    expect(stats.insertions).toBe(3)
    expect(stats.deletions).toBe(0)

    rmSync(repo, { recursive: true, force: true })
  })

  it('returns zeros when no diff', () => {
    const repo = mkdtempSync(path.join(tmpdir(), 'at-git-'))
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo })
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repo })
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo })
    writeFileSync(path.join(repo, 'a.txt'), 'a')
    execFileSync('git', ['add', '.'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: repo })
    execFileSync('git', ['checkout', '-b', 'feature'], { cwd: repo })

    const stats = getStructuredDiffStatsBetween(repo, 'main', 'feature')
    expect(stats.filesChanged).toBe(0)
    expect(stats.insertions).toBe(0)
    expect(stats.deletions).toBe(0)

    rmSync(repo, { recursive: true, force: true })
  })
})
