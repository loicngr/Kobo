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
  fetchSourceBranch,
  getCommitCount,
  getCommitsBetween,
  getCurrentBranch,
  getDiffStats,
  getDiffStatsBetween,
  getStructuredDiffStatsBetween,
  listBranchCommits,
  listBranches,
  listRemoteBranches,
  pullBranch,
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

describe('pullBranch', () => {
  it('pulls fast-forward changes from origin successfully', () => {
    const bare = mkdtempSync(path.join(tmpdir(), 'at-pull-bare-'))
    execFileSync('git', ['init', '--bare'], { cwd: bare })

    // First clone: produce an initial commit and push it
    const repoA = mkdtempSync(path.join(tmpdir(), 'at-pull-a-'))
    execFileSync('git', ['init', '-b', 'main'], { cwd: repoA })
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repoA })
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: repoA })
    writeFileSync(path.join(repoA, 'f.txt'), 'v1')
    execFileSync('git', ['add', '.'], { cwd: repoA })
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repoA })
    execFileSync('git', ['remote', 'add', 'origin', bare], { cwd: repoA })
    execFileSync('git', ['push', '-u', 'origin', 'main'], { cwd: repoA })

    // Second clone: will receive changes via pull
    const repoB = mkdtempSync(path.join(tmpdir(), 'at-pull-b-'))
    execFileSync('git', ['clone', bare, repoB])
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repoB })
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: repoB })

    // Produce a new commit on repoA and push it
    writeFileSync(path.join(repoA, 'f.txt'), 'v2')
    execFileSync('git', ['commit', '-am', 'update'], { cwd: repoA })
    execFileSync('git', ['push'], { cwd: repoA })

    // pullBranch on repoB should fast-forward
    expect(() => pullBranch(repoB, 'main')).not.toThrow()

    const content = fs.readFileSync(path.join(repoB, 'f.txt'), 'utf-8')
    expect(content).toBe('v2')

    rmSync(repoA, { recursive: true, force: true })
    rmSync(repoB, { recursive: true, force: true })
    rmSync(bare, { recursive: true, force: true })
  })

  it('throws with wrapped message when the remote branch does not exist', () => {
    const repo = mkdtempSync(path.join(tmpdir(), 'at-pull-no-remote-'))
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo })
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repo })
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo })
    writeFileSync(path.join(repo, 'f.txt'), 'hello')
    execFileSync('git', ['add', '.'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repo })

    // No remote configured — pull must fail with our wrapped message
    expect(() => pullBranch(repo, 'main')).toThrow(/Failed to pull branch 'main' from 'origin'/)

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

// Regression: local <base> ref may be stale relative to origin/<base> (e.g.,
// a squash-merge happened upstream that local hasn't pulled). Feature branches
// are created off origin/<base> by the worktree service, so their HEAD already
// contains the upstream commits. Comparing against local <base> would falsely
// report those upstream commits as "on the feature branch".
describe('listBranchCommits — stale local base regression', () => {
  function setupStaleLocalBase(): { local: string; remote: string } {
    const remote = mkdtempSync(path.join(tmpdir(), 'at-stale-remote-'))
    execFileSync('git', ['init', '--bare', '-b', 'main'], { cwd: remote })

    const local = mkdtempSync(path.join(tmpdir(), 'at-stale-local-'))
    execFileSync('git', ['clone', remote, local])
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: local })
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: local })
    writeFileSync(path.join(local, 'a.txt'), 'a')
    execFileSync('git', ['add', '.'], { cwd: local })
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: local })
    execFileSync('git', ['push', 'origin', 'main'], { cwd: local })

    // Second clone to advance origin/main (simulates another dev's squash-merge).
    const other = mkdtempSync(path.join(tmpdir(), 'at-stale-other-'))
    execFileSync('git', ['clone', remote, other])
    execFileSync('git', ['config', 'user.email', 'other@test.com'], { cwd: other })
    execFileSync('git', ['config', 'user.name', 'other'], { cwd: other })
    writeFileSync(path.join(other, 'b.txt'), 'b')
    execFileSync('git', ['add', '.'], { cwd: other })
    execFileSync('git', ['commit', '-m', 'squash: fix/TK-1150 merged'], { cwd: other })
    execFileSync('git', ['push', 'origin', 'main'], { cwd: other })
    rmSync(other, { recursive: true, force: true })

    // Fetch so origin/main in local is up-to-date, but local main stays behind.
    execFileSync('git', ['fetch', 'origin'], { cwd: local })

    // Mimic worktree-service: branch feature FROM origin/main, not local main.
    execFileSync('git', ['checkout', '-b', 'feature', 'origin/main'], { cwd: local })

    return { local, remote }
  }

  it('returns [] when the feature branch has no own commits beyond origin/main', () => {
    const { local, remote } = setupStaleLocalBase()
    try {
      const result = listBranchCommits(local, 'main', 'feature')
      expect(result).toEqual([])
    } finally {
      rmSync(local, { recursive: true, force: true })
      rmSync(remote, { recursive: true, force: true })
    }
  })

  it("returns only the feature branch's own commits, ignoring upstream commits on origin/main", () => {
    const { local, remote } = setupStaleLocalBase()
    try {
      writeFileSync(path.join(local, 'c.txt'), 'c')
      execFileSync('git', ['add', '.'], { cwd: local })
      execFileSync('git', ['commit', '-m', 'feat: add c'], { cwd: local })

      const result = listBranchCommits(local, 'main', 'feature')
      expect(result).toHaveLength(1)
      expect(result[0].subject).toBe('feat: add c')
    } finally {
      rmSync(local, { recursive: true, force: true })
      rmSync(remote, { recursive: true, force: true })
    }
  })

  it('getCommitCount is symmetrically safe against stale local base', () => {
    const { local, remote } = setupStaleLocalBase()
    try {
      expect(getCommitCount(local, 'main', 'feature')).toBe(0)

      writeFileSync(path.join(local, 'c.txt'), 'c')
      execFileSync('git', ['add', '.'], { cwd: local })
      execFileSync('git', ['commit', '-m', 'feat: add c'], { cwd: local })
      expect(getCommitCount(local, 'main', 'feature')).toBe(1)
    } finally {
      rmSync(local, { recursive: true, force: true })
      rmSync(remote, { recursive: true, force: true })
    }
  })

  it('getCommitsBetween is symmetrically safe against stale local base', () => {
    const { local, remote } = setupStaleLocalBase()
    try {
      expect(getCommitsBetween(local, 'main', 'feature')).toBe('')

      writeFileSync(path.join(local, 'c.txt'), 'c')
      execFileSync('git', ['add', '.'], { cwd: local })
      execFileSync('git', ['commit', '-m', 'feat: add c'], { cwd: local })

      const out = getCommitsBetween(local, 'main', 'feature')
      expect(out).toContain('feat: add c')
      expect(out).not.toContain('squash: fix/TK-1150 merged')
    } finally {
      rmSync(local, { recursive: true, force: true })
      rmSync(remote, { recursive: true, force: true })
    }
  })
})

describe('fetchSourceBranch(repoPath, sourceBranch)', () => {
  it('fetches a branch from origin successfully', () => {
    const bare = mkdtempSync(path.join(tmpdir(), 'at-fetch-bare-'))
    execFileSync('git', ['init', '--bare', '-b', 'main'], { cwd: bare })

    const repo = mkdtempSync(path.join(tmpdir(), 'at-fetch-repo-'))
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo })
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repo })
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo })
    writeFileSync(path.join(repo, 'f.txt'), 'hello')
    execFileSync('git', ['add', '.'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repo })
    execFileSync('git', ['remote', 'add', 'origin', bare], { cwd: repo })
    execFileSync('git', ['push', 'origin', 'main'], { cwd: repo })

    expect(() => fetchSourceBranch(repo, 'main')).not.toThrow()

    rmSync(repo, { recursive: true, force: true })
    rmSync(bare, { recursive: true, force: true })
  })

  it('throws with wrapped message when remote does not exist', () => {
    const repo = mkdtempSync(path.join(tmpdir(), 'at-fetch-no-remote-'))
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo })
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repo })
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo })
    writeFileSync(path.join(repo, 'f.txt'), 'hello')
    execFileSync('git', ['add', '.'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repo })
    // No remote configured — fetch must fail

    expect(() => fetchSourceBranch(repo, 'main')).toThrow(/Failed to fetch 'main' from 'origin'/)

    rmSync(repo, { recursive: true, force: true })
  })

  it('throws with wrapped message when branch does not exist on remote', () => {
    const bare = mkdtempSync(path.join(tmpdir(), 'at-fetch-bare2-'))
    execFileSync('git', ['init', '--bare', '-b', 'main'], { cwd: bare })

    const repo = mkdtempSync(path.join(tmpdir(), 'at-fetch-repo2-'))
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo })
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repo })
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo })
    writeFileSync(path.join(repo, 'f.txt'), 'hello')
    execFileSync('git', ['add', '.'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repo })
    execFileSync('git', ['remote', 'add', 'origin', bare], { cwd: repo })
    execFileSync('git', ['push', 'origin', 'main'], { cwd: repo })

    expect(() => fetchSourceBranch(repo, 'feature/does-not-exist')).toThrow(
      /Failed to fetch 'feature\/does-not-exist' from 'origin'/,
    )

    rmSync(repo, { recursive: true, force: true })
    rmSync(bare, { recursive: true, force: true })
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
