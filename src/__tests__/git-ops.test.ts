import { execFileSync, execSync } from 'node:child_process'
import fs, { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os, { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  BranchAlreadyExistsError,
  commitAllChanges,
  commitExists,
  createBranch,
  DirtyWorktreeError,
  deleteLocalBranch,
  deleteRemoteBranch,
  discardWorkingTreeChanges,
  EMPTY_TREE_SHA,
  fetchSourceBranch,
  fetchSourceBranchAsync,
  getChangedFiles,
  getChangedFilesBetween,
  getCommitCount,
  getCommitsBehind,
  getCommitsBetween,
  getCurrentBranch,
  getDiffStats,
  getDiffStatsBetween,
  getStructuredDiffStatsBetween,
  getWorkingTreeDiffStats,
  getWorkingTreeFiles,
  getWorkingTreeStatus,
  isGitWorktree,
  listBranchCommits,
  listBranches,
  listCommitsBehind,
  listRemoteBranches,
  mergeBranch,
  pullBranch,
  pushBranch,
  rebaseBranch,
  rollbackFile,
  slugifyBranchSegment,
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

describe('getWorkingTreeDiffStats', () => {
  it('returns empty string when working tree is clean', () => {
    const repo = mkdtempSync(path.join(tmpdir(), 'at-git-wt-'))
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo })
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repo })
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo })
    writeFileSync(path.join(repo, 'README.md'), 'initial\n')
    execFileSync('git', ['add', '.'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: repo })

    const result = getWorkingTreeDiffStats(repo)
    expect(result.trim()).toBe('')

    rmSync(repo, { recursive: true, force: true })
  })

  it('returns stat lines mentioning modified files', () => {
    const repo = mkdtempSync(path.join(tmpdir(), 'at-git-wt-'))
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo })
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repo })
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo })
    writeFileSync(path.join(repo, 'README.md'), 'initial\n')
    execFileSync('git', ['add', '.'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: repo })

    writeFileSync(path.join(repo, 'README.md'), 'changed content\nwith more lines\n')

    const result = getWorkingTreeDiffStats(repo)
    expect(result).toContain('README.md')
    expect(result).toMatch(/\d+ file.*changed/)

    rmSync(repo, { recursive: true, force: true })
  })

  it('returns empty string when the path is not a git repository', () => {
    const notARepo = mkdtempSync(path.join(tmpdir(), 'at-git-wt-norepo-'))
    const result = getWorkingTreeDiffStats(notARepo)
    expect(result).toBe('')
    rmSync(notARepo, { recursive: true, force: true })
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

describe('getChangedFiles — untracked file handling', () => {
  function setupRepo(prefix: string): string {
    const repo = mkdtempSync(path.join(tmpdir(), prefix))
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo })
    execFileSync('git', ['config', 'user.email', 't@t.t'], { cwd: repo })
    execFileSync('git', ['config', 'user.name', 'T'], { cwd: repo })
    writeFileSync(path.join(repo, 'a.txt'), 'original')
    execFileSync('git', ['add', '.'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repo })
    return repo
  }

  it('does NOT include pure untracked files (never `git add`-ed)', () => {
    const repo = setupRepo('at-changed-untracked-')
    // Move off main and add a real committed change — that's the realistic
    // diff-viewer scenario (feature branch vs base).
    execFileSync('git', ['checkout', '-b', 'feature'], { cwd: repo })
    writeFileSync(path.join(repo, 'tracked.ts'), 'export {}')
    execFileSync('git', ['add', 'tracked.ts'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'add tracked'], { cwd: repo })
    // Drop a brand-new untracked file alongside.
    writeFileSync(path.join(repo, 'untracked.cjs'), 'console.log("never added")')

    const files = getChangedFiles(repo, 'main')
    expect(files.find((f) => f.path === 'tracked.ts')?.status).toBe('added')
    // The untracked file must not leak into the diff viewer — it would not
    // ship in the PR anyway since it was never `git add`-ed.
    expect(files.find((f) => f.path === 'untracked.cjs')).toBeUndefined()

    rmSync(repo, { recursive: true, force: true })
  })

  it('still includes files staged with `git add` but not yet committed (status A)', () => {
    const repo = setupRepo('at-changed-staged-')
    execFileSync('git', ['checkout', '-b', 'feature'], { cwd: repo })
    writeFileSync(path.join(repo, 'staged.ts'), 'export {}')
    execFileSync('git', ['add', 'staged.ts'], { cwd: repo })
    // Note: file is staged but not committed — this exercises the working-tree
    // branch of getChangedFiles (`git status --porcelain -uno`).

    const files = getChangedFiles(repo, 'main')
    const staged = files.find((f) => f.path === 'staged.ts')
    expect(staged).toBeDefined()
    expect(staged?.status).toBe('added')

    rmSync(repo, { recursive: true, force: true })
  })

  it('includes untracked files when includeUntracked=true (opt-in flag)', () => {
    const repo = setupRepo('at-changed-untracked-optin-')
    execFileSync('git', ['checkout', '-b', 'feature'], { cwd: repo })
    writeFileSync(path.join(repo, 'untracked.cjs'), 'console.log("opt-in")')

    const filesDefault = getChangedFiles(repo, 'main')
    expect(filesDefault.find((f) => f.path === 'untracked.cjs')).toBeUndefined()

    const filesOptIn = getChangedFiles(repo, 'main', true)
    const untracked = filesOptIn.find((f) => f.path === 'untracked.cjs')
    expect(untracked).toBeDefined()
    // Distinct status from `added` (= staged with `git add`) so the front
    // can offer "Delete" instead of "Rollback to remote" in the context menu.
    expect(untracked?.status).toBe('untracked')

    rmSync(repo, { recursive: true, force: true })
  })
})

describe('rollbackFile(repoPath, branchName, filePath)', () => {
  function setupRepoWithRemote(prefix: string): { repo: string; bare: string } {
    const bare = mkdtempSync(path.join(tmpdir(), `${prefix}-bare-`))
    execFileSync('git', ['init', '--bare', '-b', 'main'], { cwd: bare })
    const repo = mkdtempSync(path.join(tmpdir(), prefix))
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo })
    execFileSync('git', ['config', 'user.email', 't@t.t'], { cwd: repo })
    execFileSync('git', ['config', 'user.name', 'T'], { cwd: repo })
    execFileSync('git', ['remote', 'add', 'origin', bare], { cwd: repo })
    writeFileSync(path.join(repo, 'a.txt'), 'committed-and-pushed')
    execFileSync('git', ['add', '.'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repo })
    execFileSync('git', ['push', '-u', 'origin', 'main'], { cwd: repo })
    return { repo, bare }
  }

  function setupRepoNoRemote(prefix: string): string {
    const repo = mkdtempSync(path.join(tmpdir(), prefix))
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo })
    execFileSync('git', ['config', 'user.email', 't@t.t'], { cwd: repo })
    execFileSync('git', ['config', 'user.name', 'T'], { cwd: repo })
    writeFileSync(path.join(repo, 'a.txt'), 'committed-locally')
    execFileSync('git', ['add', '.'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repo })
    return repo
  }

  it('returns "remote" and overwrites a locally-modified file with its origin/<branch> version', () => {
    const { repo, bare } = setupRepoWithRemote('at-rollback-remote-')
    writeFileSync(path.join(repo, 'a.txt'), 'local-changes-to-discard')

    const target = rollbackFile(repo, 'main', 'a.txt')

    expect(target).toBe('remote')
    expect(fs.readFileSync(path.join(repo, 'a.txt'), 'utf-8')).toBe('committed-and-pushed')
    rmSync(repo, { recursive: true, force: true })
    rmSync(bare, { recursive: true, force: true })
  })

  it('falls back to "head" when the branch has never been pushed', () => {
    const repo = setupRepoNoRemote('at-rollback-fallback-head-')
    writeFileSync(path.join(repo, 'a.txt'), 'uncommitted-edits')

    const target = rollbackFile(repo, 'main', 'a.txt')

    expect(target).toBe('head')
    expect(fs.readFileSync(path.join(repo, 'a.txt'), 'utf-8')).toBe('committed-locally')
    rmSync(repo, { recursive: true, force: true })
  })

  it('falls back to "head" when the file exists locally but not on the remote yet', () => {
    const { repo, bare } = setupRepoWithRemote('at-rollback-file-not-on-remote-')
    // New file, committed locally, NOT pushed.
    writeFileSync(path.join(repo, 'new.ts'), 'committed-but-not-pushed')
    execFileSync('git', ['add', 'new.ts'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'add new'], { cwd: repo })
    // Now modify it locally (uncommitted edits to discard).
    writeFileSync(path.join(repo, 'new.ts'), 'uncommitted-edits-on-top')

    const target = rollbackFile(repo, 'main', 'new.ts')

    expect(target).toBe('head')
    expect(fs.readFileSync(path.join(repo, 'new.ts'), 'utf-8')).toBe('committed-but-not-pushed')
    rmSync(repo, { recursive: true, force: true })
    rmSync(bare, { recursive: true, force: true })
  })

  it('returns "deleted" and removes the file from disk when it is untracked', () => {
    const repo = setupRepoNoRemote('at-rollback-untracked-')
    const untrackedPath = path.join(repo, 'untracked.cjs')
    writeFileSync(untrackedPath, 'never-added')
    expect(fs.existsSync(untrackedPath)).toBe(true)

    const target = rollbackFile(repo, 'main', 'untracked.cjs')

    expect(target).toBe('deleted')
    expect(fs.existsSync(untrackedPath)).toBe(false)
    rmSync(repo, { recursive: true, force: true })
  })

  it('is idempotent: returns "deleted" silently when the file is already gone', () => {
    // Stale UI list, race with a previous rollback, or manual rm — the
    // user's intent is "make this file go away", so rolling back a file
    // that is already absent should succeed quietly.
    const repo = setupRepoNoRemote('at-rollback-ghost-')
    const target = rollbackFile(repo, 'main', 'ghost.cjs')
    expect(target).toBe('deleted')
    rmSync(repo, { recursive: true, force: true })
  })
})

describe('getCommitsBehind', () => {
  it('returns 0 when working branch is up-to-date with source', () => {
    const repo = mkdtempSync(path.join(tmpdir(), 'at-behind-uptodate-'))
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo })
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repo })
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo })
    writeFileSync(path.join(repo, 'a.txt'), 'a')
    execFileSync('git', ['add', '.'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: repo })
    execFileSync('git', ['checkout', '-b', 'feature'], { cwd: repo })

    const count = getCommitsBehind(repo, 'main', 'feature')
    expect(count).toBe(0)

    rmSync(repo, { recursive: true, force: true })
  })

  it('returns N when source branch has N commits ahead of working', () => {
    const repo = mkdtempSync(path.join(tmpdir(), 'at-behind-n-'))
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo })
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repo })
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo })
    writeFileSync(path.join(repo, 'a.txt'), 'a')
    execFileSync('git', ['add', '.'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: repo })

    // Branch off; feature stays at the initial commit.
    execFileSync('git', ['checkout', '-b', 'feature'], { cwd: repo })

    // Advance main by 3 commits.
    execFileSync('git', ['checkout', 'main'], { cwd: repo })
    writeFileSync(path.join(repo, 'b.txt'), 'b')
    execFileSync('git', ['add', '.'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'main: b'], { cwd: repo })
    writeFileSync(path.join(repo, 'c.txt'), 'c')
    execFileSync('git', ['add', '.'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'main: c'], { cwd: repo })
    writeFileSync(path.join(repo, 'd.txt'), 'd')
    execFileSync('git', ['add', '.'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'main: d'], { cwd: repo })

    const count = getCommitsBehind(repo, 'main', 'feature')
    expect(count).toBe(3)

    rmSync(repo, { recursive: true, force: true })
  })

  it('returns 0 when working branch == source branch', () => {
    const repo = mkdtempSync(path.join(tmpdir(), 'at-behind-same-'))
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo })
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repo })
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo })
    writeFileSync(path.join(repo, 'a.txt'), 'a')
    execFileSync('git', ['add', '.'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: repo })

    const count = getCommitsBehind(repo, 'main', 'main')
    expect(count).toBe(0)

    rmSync(repo, { recursive: true, force: true })
  })

  it('falls back to local source ref when origin/<source> is absent', () => {
    // No remote configured at all — resolveBase falls back to the local ref.
    const repo = mkdtempSync(path.join(tmpdir(), 'at-behind-local-fallback-'))
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo })
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repo })
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo })
    writeFileSync(path.join(repo, 'a.txt'), 'a')
    execFileSync('git', ['add', '.'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: repo })
    execFileSync('git', ['checkout', '-b', 'feature'], { cwd: repo })

    // Advance main by 2 commits while standing on feature.
    execFileSync('git', ['checkout', 'main'], { cwd: repo })
    writeFileSync(path.join(repo, 'b.txt'), 'b')
    execFileSync('git', ['add', '.'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'main: b'], { cwd: repo })
    writeFileSync(path.join(repo, 'c.txt'), 'c')
    execFileSync('git', ['add', '.'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'main: c'], { cwd: repo })

    // origin/main does NOT exist (no remote) — must fall back to local main.
    const count = getCommitsBehind(repo, 'main', 'feature')
    expect(count).toBe(2)

    rmSync(repo, { recursive: true, force: true })
  })
})

describe('listCommitsBehind', () => {
  it('lists commits on source not present on working branch (most recent first)', () => {
    const repo = mkdtempSync(path.join(tmpdir(), 'at-list-behind-'))
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo })
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repo })
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo })
    writeFileSync(path.join(repo, 'a.txt'), 'a')
    execFileSync('git', ['add', '.'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: repo })

    execFileSync('git', ['checkout', '-b', 'feature'], { cwd: repo })

    // Advance main by 3 commits while feature stays put.
    execFileSync('git', ['checkout', 'main'], { cwd: repo })
    writeFileSync(path.join(repo, 'b.txt'), 'b')
    execFileSync('git', ['add', '.'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'main: first'], { cwd: repo })
    writeFileSync(path.join(repo, 'c.txt'), 'c')
    execFileSync('git', ['add', '.'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'main: second'], { cwd: repo })
    writeFileSync(path.join(repo, 'd.txt'), 'd')
    execFileSync('git', ['add', '.'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'main: third'], { cwd: repo })

    const commits = listCommitsBehind(repo, 'main', 'feature')
    expect(commits).toHaveLength(3)
    // Most recent first: third, second, first.
    expect(commits[0].subject).toBe('main: third')
    expect(commits[1].subject).toBe('main: second')
    expect(commits[2].subject).toBe('main: first')
    // Sanity: each row carries the expected fields.
    for (const c of commits) {
      expect(c.sha).toMatch(/^[0-9a-f]{40}$/)
      expect(c.shortSha.length).toBeGreaterThan(0)
      expect(c.author).toBe('test')
      expect(c.date).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    }

    rmSync(repo, { recursive: true, force: true })
  })

  it('returns empty list when working branch is up-to-date', () => {
    const repo = mkdtempSync(path.join(tmpdir(), 'at-list-behind-empty-'))
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo })
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repo })
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo })
    writeFileSync(path.join(repo, 'a.txt'), 'a')
    execFileSync('git', ['add', '.'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: repo })
    execFileSync('git', ['checkout', '-b', 'feature'], { cwd: repo })

    const commits = listCommitsBehind(repo, 'main', 'feature')
    expect(commits).toEqual([])

    rmSync(repo, { recursive: true, force: true })
  })

  it('respects the limit param', () => {
    const repo = mkdtempSync(path.join(tmpdir(), 'at-list-behind-limit-'))
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo })
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repo })
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo })
    writeFileSync(path.join(repo, 'a.txt'), 'a')
    execFileSync('git', ['add', '.'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: repo })

    execFileSync('git', ['checkout', '-b', 'feature'], { cwd: repo })

    // Advance main by 10 commits while feature stays put.
    execFileSync('git', ['checkout', 'main'], { cwd: repo })
    for (let i = 0; i < 10; i++) {
      writeFileSync(path.join(repo, `f${i}.txt`), String(i))
      execFileSync('git', ['add', '.'], { cwd: repo })
      execFileSync('git', ['commit', '-m', `main: c${i}`], { cwd: repo })
    }

    const limited = listCommitsBehind(repo, 'main', 'feature', 5)
    expect(limited).toHaveLength(5)

    rmSync(repo, { recursive: true, force: true })
  })
})

describe('fetchSourceBranchAsync', () => {
  it('resolves silently on success', async () => {
    const bare = mkdtempSync(path.join(tmpdir(), 'at-async-fetch-bare-'))
    execFileSync('git', ['init', '--bare', '-b', 'main'], { cwd: bare })

    const repo = mkdtempSync(path.join(tmpdir(), 'at-async-fetch-repo-'))
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo })
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repo })
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo })
    writeFileSync(path.join(repo, 'f.txt'), 'hello')
    execFileSync('git', ['add', '.'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repo })
    execFileSync('git', ['remote', 'add', 'origin', bare], { cwd: repo })
    execFileSync('git', ['push', 'origin', 'main'], { cwd: repo })

    await expect(fetchSourceBranchAsync(repo, 'main')).resolves.toBeUndefined()

    rmSync(repo, { recursive: true, force: true })
    rmSync(bare, { recursive: true, force: true })
  })

  it('does not throw when the remote is unreachable', async () => {
    const repo = mkdtempSync(path.join(tmpdir(), 'at-async-fetch-no-remote-'))
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo })
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repo })
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo })
    writeFileSync(path.join(repo, 'f.txt'), 'hello')
    execFileSync('git', ['add', '.'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repo })
    // No remote configured — fetch must fail under the hood, but the helper
    // must swallow it and resolve cleanly.

    await expect(fetchSourceBranchAsync(repo, 'main')).resolves.toBeUndefined()

    rmSync(repo, { recursive: true, force: true })
  })

  it('does not throw when the branch does not exist on origin', async () => {
    const bare = mkdtempSync(path.join(tmpdir(), 'at-async-fetch-bare2-'))
    execFileSync('git', ['init', '--bare', '-b', 'main'], { cwd: bare })

    const repo = mkdtempSync(path.join(tmpdir(), 'at-async-fetch-repo2-'))
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo })
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repo })
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo })
    writeFileSync(path.join(repo, 'f.txt'), 'hello')
    execFileSync('git', ['add', '.'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repo })
    execFileSync('git', ['remote', 'add', 'origin', bare], { cwd: repo })
    execFileSync('git', ['push', 'origin', 'main'], { cwd: repo })

    await expect(fetchSourceBranchAsync(repo, 'feature/does-not-exist')).resolves.toBeUndefined()

    rmSync(repo, { recursive: true, force: true })
    rmSync(bare, { recursive: true, force: true })
  })
})

describe('rebaseBranch dirty-worktree handling', () => {
  // Single repo + bare origin, origin/main == HEAD. git refuses a rebase on a
  // dirty tree even when there is nothing to rebase, which is exactly the block
  // we want to detect.
  function setupRepoWithOrigin(): { repo: string; bare: string } {
    const repo = mkdtempSync(path.join(tmpdir(), 'at-dirty-rebase-'))
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo })
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repo })
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo })
    writeFileSync(path.join(repo, 'file.txt'), 'committed\n')
    execFileSync('git', ['add', '.'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repo })
    const bare = mkdtempSync(path.join(tmpdir(), 'at-dirty-rebase-bare-'))
    execFileSync('git', ['init', '--bare'], { cwd: bare })
    execFileSync('git', ['remote', 'add', 'origin', bare], { cwd: repo })
    execFileSync('git', ['push', '-u', 'origin', 'main'], { cwd: repo })
    return { repo, bare }
  }

  it('throws DirtyWorktreeError (not a generic error) when the tree is dirty', () => {
    const { repo, bare } = setupRepoWithOrigin()
    writeFileSync(path.join(repo, 'file.txt'), 'uncommitted edit\n') // dirty tracked file
    let caught: unknown
    try {
      rebaseBranch(repo, 'main')
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(DirtyWorktreeError)
    expect((caught as DirtyWorktreeError).operation).toBe('rebase')
    expect((caught as DirtyWorktreeError).status.modified).toBe(1)
    rmSync(repo, { recursive: true, force: true })
    rmSync(bare, { recursive: true, force: true })
  })

  it('succeeds with autostash on a dirty tree and re-applies the changes', () => {
    const { repo, bare } = setupRepoWithOrigin()
    writeFileSync(path.join(repo, 'file.txt'), 'uncommitted edit\n')
    expect(() => rebaseBranch(repo, 'main', { autostash: true })).not.toThrow()
    // autostash stashed → no-op rebase → popped: the edit is back on disk
    expect(readFileSync(path.join(repo, 'file.txt'), 'utf-8')).toBe('uncommitted edit\n')
    rmSync(repo, { recursive: true, force: true })
    rmSync(bare, { recursive: true, force: true })
  })
})

describe('mergeBranch dirty-worktree handling', () => {
  // origin/main must be AHEAD and touch the same file, otherwise an up-to-date
  // merge no-ops without checking the tree. We commit C2 on origin, then reset
  // the local branch back to C1 so origin/main is genuinely ahead.
  function setupDivergedOrigin(): { repo: string; bare: string } {
    const repo = mkdtempSync(path.join(tmpdir(), 'at-dirty-merge-'))
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo })
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repo })
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo })
    writeFileSync(path.join(repo, 'file.txt'), 'v1\n')
    execFileSync('git', ['add', '.'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'C1'], { cwd: repo })
    const c1 = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf-8' }).trim()
    writeFileSync(path.join(repo, 'file.txt'), 'v2\n')
    execFileSync('git', ['commit', '-am', 'C2'], { cwd: repo })
    const bare = mkdtempSync(path.join(tmpdir(), 'at-dirty-merge-bare-'))
    execFileSync('git', ['init', '--bare'], { cwd: bare })
    execFileSync('git', ['remote', 'add', 'origin', bare], { cwd: repo })
    execFileSync('git', ['push', '-u', 'origin', 'main'], { cwd: repo }) // origin/main = C2
    execFileSync('git', ['reset', '--hard', c1], { cwd: repo }) // local main = C1, file = v1
    return { repo, bare }
  }

  it('throws DirtyWorktreeError when local changes would be overwritten by merge', () => {
    const { repo, bare } = setupDivergedOrigin()
    writeFileSync(path.join(repo, 'file.txt'), 'local edit\n') // dirty, conflicts with C2
    let caught: unknown
    try {
      mergeBranch(repo, 'main')
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(DirtyWorktreeError)
    expect((caught as DirtyWorktreeError).operation).toBe('merge')
    expect((caught as DirtyWorktreeError).status.modified).toBe(1)
    rmSync(repo, { recursive: true, force: true })
    rmSync(bare, { recursive: true, force: true })
  })
})

describe('pullBranch dirty-worktree handling', () => {
  // origin/main == HEAD, so a bare `git pull --ff-only` is a no-op that would
  // succeed even on a dirty tree. The block we want is therefore a pre-check on
  // the working-tree status — same recovery path rebase/merge already offer.
  function setupRepoWithOrigin(): { repo: string; bare: string } {
    const repo = mkdtempSync(path.join(tmpdir(), 'at-dirty-pull-'))
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo })
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repo })
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo })
    writeFileSync(path.join(repo, 'file.txt'), 'committed\n')
    execFileSync('git', ['add', '.'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repo })
    const bare = mkdtempSync(path.join(tmpdir(), 'at-dirty-pull-bare-'))
    execFileSync('git', ['init', '--bare'], { cwd: bare })
    execFileSync('git', ['remote', 'add', 'origin', bare], { cwd: repo })
    execFileSync('git', ['push', '-u', 'origin', 'main'], { cwd: repo })
    return { repo, bare }
  }

  it('throws DirtyWorktreeError with operation "pull" when the tree is dirty', () => {
    const { repo, bare } = setupRepoWithOrigin()
    writeFileSync(path.join(repo, 'file.txt'), 'uncommitted edit\n') // dirty tracked file
    let caught: unknown
    try {
      pullBranch(repo, 'main')
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(DirtyWorktreeError)
    expect((caught as DirtyWorktreeError).operation).toBe('pull')
    expect((caught as DirtyWorktreeError).status.modified).toBe(1)
    rmSync(repo, { recursive: true, force: true })
    rmSync(bare, { recursive: true, force: true })
  })

  it('does not block on a clean tree with only untracked files', () => {
    const { repo, bare } = setupRepoWithOrigin()
    writeFileSync(path.join(repo, 'untracked.txt'), 'new\n') // untracked, never added
    expect(() => pullBranch(repo, 'main')).not.toThrow()
    rmSync(repo, { recursive: true, force: true })
    rmSync(bare, { recursive: true, force: true })
  })
})

describe('commitAllChanges', () => {
  it('stages everything and commits, leaving a clean tree', () => {
    const repo = mkdtempSync(path.join(tmpdir(), 'at-commit-all-'))
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo })
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repo })
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo })
    writeFileSync(path.join(repo, 'a.txt'), '1\n')
    execFileSync('git', ['add', '.'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repo })
    writeFileSync(path.join(repo, 'a.txt'), '2\n') // modify tracked
    writeFileSync(path.join(repo, 'b.txt'), 'new\n') // new untracked

    commitAllChanges(repo, 'chore: snapshot')

    const status = getWorkingTreeStatus(repo)
    expect(status.modified).toBe(0)
    expect(status.staged).toBe(0)
    expect(status.untracked).toBe(0)
    const log = execFileSync('git', ['log', '--oneline'], { cwd: repo, encoding: 'utf-8' })
    expect(log).toContain('chore: snapshot')
    rmSync(repo, { recursive: true, force: true })
  })
})

describe('discardWorkingTreeChanges', () => {
  it('reverts tracked modifications but preserves untracked files', () => {
    const repo = mkdtempSync(path.join(tmpdir(), 'at-discard-'))
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo })
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repo })
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo })
    writeFileSync(path.join(repo, 'a.txt'), 'committed\n')
    execFileSync('git', ['add', '.'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repo })
    writeFileSync(path.join(repo, 'a.txt'), 'dirty\n') // tracked modification
    writeFileSync(path.join(repo, 'untracked.txt'), 'keep me\n') // untracked

    discardWorkingTreeChanges(repo)

    expect(readFileSync(path.join(repo, 'a.txt'), 'utf-8')).toBe('committed\n') // reverted
    expect(readFileSync(path.join(repo, 'untracked.txt'), 'utf-8')).toBe('keep me\n') // preserved
    rmSync(repo, { recursive: true, force: true })
  })
})

describe('getChangedFilesBetween + commitExists', () => {
  // repo with 3 commits: A=add a.txt; B=modify a.txt + add b.txt; C=delete b.txt
  function buildRepo(): { repo: string; a: string; b: string; c: string } {
    const repo = mkdtempSync(path.join(tmpdir(), 'at-between-'))
    const g = (args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf-8' })
    g(['init', '-b', 'main'])
    g(['config', 'user.email', 'test@test.com'])
    g(['config', 'user.name', 'test'])
    writeFileSync(path.join(repo, 'a.txt'), 'v1\n')
    g(['add', '.'])
    g(['commit', '-m', 'A'])
    const a = g(['rev-parse', 'HEAD']).trim()
    writeFileSync(path.join(repo, 'a.txt'), 'v2\n')
    writeFileSync(path.join(repo, 'b.txt'), 'b\n')
    g(['add', '.'])
    g(['commit', '-m', 'B'])
    const b = g(['rev-parse', 'HEAD']).trim()
    g(['rm', 'b.txt'])
    g(['commit', '-m', 'C'])
    const c = g(['rev-parse', 'HEAD']).trim()
    return { repo, a, b, c }
  }

  it('reports added + modified between A and B (two-dot)', () => {
    const { repo, a, b } = buildRepo()
    const files = getChangedFilesBetween(repo, a, b)
    expect(files.find((f) => f.path === 'a.txt')?.status).toBe('modified')
    expect(files.find((f) => f.path === 'b.txt')?.status).toBe('added')
    rmSync(repo, { recursive: true, force: true })
  })

  it('reports deleted between B and C', () => {
    const { repo, b, c } = buildRepo()
    const files = getChangedFilesBetween(repo, b, c)
    expect(files.find((f) => f.path === 'b.txt')?.status).toBe('deleted')
    rmSync(repo, { recursive: true, force: true })
  })

  it('A..C nets out the added-then-deleted file (two-dot semantics)', () => {
    const { repo, a, c } = buildRepo()
    const files = getChangedFilesBetween(repo, a, c)
    expect(files.find((f) => f.path === 'a.txt')?.status).toBe('modified')
    expect(files.find((f) => f.path === 'b.txt')).toBeUndefined()
    rmSync(repo, { recursive: true, force: true })
  })

  it('commitExists resolves SHAs and parents, rejects bogus refs', () => {
    const { repo, a, b } = buildRepo()
    expect(commitExists(repo, b)).toBe(true)
    expect(commitExists(repo, `${b}^`)).toBe(true) // parent of B = A
    expect(commitExists(repo, 'deadbeefdeadbeef')).toBe(false)
    expect(commitExists(repo, `${a}^`)).toBe(false) // A is the root, no parent
    rmSync(repo, { recursive: true, force: true })
  })

  it('EMPTY_TREE_SHA diffs a root commit as all-added', () => {
    const { repo, a } = buildRepo()
    const files = getChangedFilesBetween(repo, EMPTY_TREE_SHA, a)
    expect(files.find((f) => f.path === 'a.txt')?.status).toBe('added')
    rmSync(repo, { recursive: true, force: true })
  })
})

describe('getWorkingTreeFiles', () => {
  it('lists staged-only, modified-only, both (MM), and untracked with correct flags', () => {
    const repo = mkdtempSync(path.join(tmpdir(), 'at-wt-files-'))
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo })
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repo })
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo })
    writeFileSync(path.join(repo, 'a.txt'), 'a1\n')
    writeFileSync(path.join(repo, 'b.txt'), 'b1\n')
    writeFileSync(path.join(repo, 'c.txt'), 'c1\n')
    execFileSync('git', ['add', '.'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repo })

    writeFileSync(path.join(repo, 'a.txt'), 'a2\n')
    execFileSync('git', ['add', 'a.txt'], { cwd: repo })
    writeFileSync(path.join(repo, 'b.txt'), 'b2\n')
    writeFileSync(path.join(repo, 'c.txt'), 'c2\n')
    execFileSync('git', ['add', 'c.txt'], { cwd: repo })
    writeFileSync(path.join(repo, 'c.txt'), 'c3\n')
    writeFileSync(path.join(repo, 'd.txt'), 'd1\n')

    const files = getWorkingTreeFiles(repo)
    const byPath = Object.fromEntries(files.map((f) => [f.path, f]))
    expect(byPath['a.txt']).toEqual({ path: 'a.txt', staged: true, modified: false, untracked: false })
    expect(byPath['b.txt']).toEqual({ path: 'b.txt', staged: false, modified: true, untracked: false })
    expect(byPath['c.txt']).toEqual({ path: 'c.txt', staged: true, modified: true, untracked: false })
    expect(byPath['d.txt']).toEqual({ path: 'd.txt', staged: false, modified: false, untracked: true })

    rmSync(repo, { recursive: true, force: true })
  })

  it('returns the NEW path for a renamed file', () => {
    const repo = mkdtempSync(path.join(tmpdir(), 'at-wt-rename-'))
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo })
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repo })
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo })
    writeFileSync(path.join(repo, 'old.txt'), 'content\n')
    execFileSync('git', ['add', '.'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repo })
    execFileSync('git', ['mv', 'old.txt', 'new.txt'], { cwd: repo })

    const paths = getWorkingTreeFiles(repo).map((f) => f.path)
    expect(paths).toContain('new.txt')
    expect(paths.some((p) => p.includes(' -> '))).toBe(false)

    rmSync(repo, { recursive: true, force: true })
  })

  it('returns [] for a clean tree', () => {
    const repo = mkdtempSync(path.join(tmpdir(), 'at-wt-clean-'))
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo })
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repo })
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo })
    writeFileSync(path.join(repo, 'a.txt'), 'a\n')
    execFileSync('git', ['add', '.'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repo })
    expect(getWorkingTreeFiles(repo)).toEqual([])
    rmSync(repo, { recursive: true, force: true })
  })
})

describe('isGitWorktree', () => {
  it('returns true for a real git repo', () => {
    const repo = mkdtempSync(path.join(tmpdir(), 'at-isgit-repo-'))
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo })
    expect(isGitWorktree(repo)).toBe(true)
    rmSync(repo, { recursive: true, force: true })
  })

  it('returns true for a linked worktree (manual recreation case)', () => {
    const main = mkdtempSync(path.join(tmpdir(), 'at-isgit-main-'))
    execFileSync('git', ['init', '-b', 'main'], { cwd: main })
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: main })
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: main })
    writeFileSync(path.join(main, 'f.txt'), 'x\n')
    execFileSync('git', ['add', '.'], { cwd: main })
    execFileSync('git', ['commit', '-m', 'init'], { cwd: main })
    const wt = path.join(mkdtempSync(path.join(tmpdir(), 'at-isgit-wt-')), 'linked')
    execFileSync('git', ['worktree', 'add', '--detach', wt, 'main'], { cwd: main })
    expect(isGitWorktree(wt)).toBe(true)
    rmSync(wt, { recursive: true, force: true })
    rmSync(main, { recursive: true, force: true })
  })

  it('returns false for an existing non-git directory (purge leftover)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'at-isgit-leftover-'))
    writeFileSync(path.join(dir, 'leftover.txt'), 'residual\n')
    expect(isGitWorktree(dir)).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns false for a leftover dir nested inside a parent git repo (no own .git)', () => {
    const parent = mkdtempSync(path.join(tmpdir(), 'at-isgit-parent-'))
    execFileSync('git', ['init', '-b', 'main'], { cwd: parent })
    const nested = path.join(parent, 'leftover-worktree')
    fs.mkdirSync(nested)
    writeFileSync(path.join(nested, 'residual.txt'), 'x\n')
    expect(isGitWorktree(nested)).toBe(false)
    rmSync(parent, { recursive: true, force: true })
  })

  it('returns false for a non-existent path', () => {
    expect(isGitWorktree(path.join(tmpdir(), 'at-isgit-nope-does-not-exist'))).toBe(false)
  })
})

describe('slugifyBranchSegment', () => {
  it('keeps an already-safe identifier intact', () => {
    expect(slugifyBranchSegment('SEKUR-API-ED', 40)).toBe('SEKUR-API-ED')
  })

  it('replaces backslashes, colons and spaces with single hyphens', () => {
    expect(slugifyBranchSegment('App\\Controller\\Foo::bar baz', 40)).toBe('App-Controller-Foo-bar-baz')
  })

  it('transliterates accents (é→e)', () => {
    expect(slugifyBranchSegment('Créé', 40)).toBe('Cree')
  })

  it('caps the length to maxLen', () => {
    expect(slugifyBranchSegment('a'.repeat(100), 40).length).toBe(40)
  })

  it('trims leading/trailing hyphens, including one produced by the length cap', () => {
    expect(slugifyBranchSegment('--foo--', 40)).toBe('foo')
    // 'abcde-fghij'.slice(0,6) === 'abcde-' → trailing hyphen re-trimmed
    expect(slugifyBranchSegment('abcde-fghij', 6)).toBe('abcde')
  })

  it('returns empty string when nothing safe remains', () => {
    expect(slugifyBranchSegment('::\\::', 40)).toBe('')
  })
})
