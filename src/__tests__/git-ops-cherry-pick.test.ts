// src/__tests__/git-ops-cherry-pick.test.ts
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  abortOngoingGitOperation,
  GitConflictError,
  getOngoingGitOperation,
  listBackupBranches,
  listProperCommits,
  reconstructBranchOnto,
  restoreBranchFromBackup,
} from '../server/utils/git-ops.js'

function g(repo: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf-8' }).trimEnd()
}

let repo: string

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'kobo-cp-'))
  g(repo, ['init', '-q', '-b', 'main'])
  g(repo, ['config', 'user.email', 't@t.t'])
  g(repo, ['config', 'user.name', 'T'])
  writeFileSync(join(repo, 'f.txt'), 'base\n')
  g(repo, ['add', '.'])
  g(repo, ['commit', '-q', '-m', 'base'])
})

afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
})

describe('listProperCommits', () => {
  it('returns only the commits unique to the working branch, oldest first', () => {
    // main has 'base'. develop branches from main and adds D1.
    g(repo, ['checkout', '-q', '-b', 'develop'])
    writeFileSync(join(repo, 'd.txt'), 'd1\n')
    g(repo, ['add', '.'])
    g(repo, ['commit', '-q', '-m', 'D1'])
    // feature branches from main and adds F1, F2.
    g(repo, ['checkout', '-q', 'main'])
    g(repo, ['checkout', '-q', '-b', 'feature'])
    writeFileSync(join(repo, 'f1.txt'), 'f1\n')
    g(repo, ['add', '.'])
    g(repo, ['commit', '-q', '-m', 'F1'])
    writeFileSync(join(repo, 'f2.txt'), 'f2\n')
    g(repo, ['add', '.'])
    g(repo, ['commit', '-q', '-m', 'F2'])
    // Proper commits of 'feature' excluding main and develop = F1, F2 (not base, not D1).
    const commits = listProperCommits(repo, 'feature', 'develop', 'main')
    expect(commits).toHaveLength(2)
    // oldest-first: F1 before F2
    const subjects = commits.map((sha) => g(repo, ['log', '-1', '--format=%s', sha]))
    expect(subjects).toEqual(['F1', 'F2'])
  })

  it('returns an empty array when the working branch has no proper commits', () => {
    // 'feature' sits exactly on main — no own commits.
    g(repo, ['checkout', '-q', '-b', 'feature'])
    expect(listProperCommits(repo, 'feature', 'main', 'main')).toEqual([])
  })
})

describe('cherry-pick conflict infrastructure', () => {
  it('getOngoingGitOperation detects an in-progress cherry-pick', () => {
    g(repo, ['checkout', '-q', '-b', 'feature'])
    writeFileSync(join(repo, 'f.txt'), 'feature\n')
    g(repo, ['commit', '-q', '-am', 'feature change'])
    const featureSha = g(repo, ['rev-parse', 'HEAD'])
    g(repo, ['checkout', '-q', 'main'])
    writeFileSync(join(repo, 'f.txt'), 'main\n')
    g(repo, ['commit', '-q', '-am', 'main change'])
    try {
      execFileSync('git', ['cherry-pick', featureSha], { cwd: repo })
    } catch {
      // expected to conflict
    }
    expect(getOngoingGitOperation(repo)).toBe('cherry-pick')
  })

  it('abortOngoingGitOperation aborts a cherry-pick and returns its name', () => {
    g(repo, ['checkout', '-q', '-b', 'feature'])
    writeFileSync(join(repo, 'f.txt'), 'feature\n')
    g(repo, ['commit', '-q', '-am', 'feature change'])
    const featureSha = g(repo, ['rev-parse', 'HEAD'])
    g(repo, ['checkout', '-q', 'main'])
    writeFileSync(join(repo, 'f.txt'), 'main\n')
    g(repo, ['commit', '-q', '-am', 'main change'])
    try {
      execFileSync('git', ['cherry-pick', featureSha], { cwd: repo })
    } catch {
      // expected
    }
    expect(abortOngoingGitOperation(repo)).toBe('cherry-pick')
    expect(getOngoingGitOperation(repo)).toBeNull()
  })
})

describe('backup branch restore', () => {
  it('lists backup branches for a working branch and restores from the latest', () => {
    g(repo, ['checkout', '-q', '-b', 'feature'])
    writeFileSync(join(repo, 'f1.txt'), 'f1\n')
    g(repo, ['add', '.'])
    g(repo, ['commit', '-q', '-m', 'F1'])
    const originalTip = g(repo, ['rev-parse', 'HEAD'])
    g(repo, ['branch', `kobo-backup/feature-${Date.now()}`, 'feature'])
    // Move feature forward so restore is observable.
    writeFileSync(join(repo, 'f2.txt'), 'f2\n')
    g(repo, ['add', '.'])
    g(repo, ['commit', '-q', '-m', 'F2'])

    const backups = listBackupBranches(repo, 'feature')
    expect(backups.length).toBe(1)

    restoreBranchFromBackup(repo, 'feature', backups[0])
    expect(g(repo, ['rev-parse', 'HEAD'])).toBe(originalTip)
  })
})

describe('reconstructBranchOnto', () => {
  it('replays proper commits onto the new base and creates a backup branch', () => {
    // develop branches from main, adds D1 (a separate file → no conflict).
    g(repo, ['checkout', '-q', '-b', 'develop'])
    writeFileSync(join(repo, 'd.txt'), 'd1\n')
    g(repo, ['add', '.'])
    g(repo, ['commit', '-q', '-m', 'D1'])
    // feature branches from main, adds F1.
    g(repo, ['checkout', '-q', 'main'])
    g(repo, ['checkout', '-q', '-b', 'feature'])
    writeFileSync(join(repo, 'f1.txt'), 'f1\n')
    g(repo, ['add', '.'])
    g(repo, ['commit', '-q', '-m', 'F1'])

    const commits = listProperCommits(repo, 'feature', 'develop', 'main')
    const backup = reconstructBranchOnto(repo, 'feature', 'develop', commits)

    // feature now contains develop's D1 + its own F1.
    expect(g(repo, ['log', '--format=%s', 'feature'])).toBe('F1\nD1\nbase')
    // backup branch points at the pre-reconstruction tip (still has no D1).
    expect(g(repo, ['log', '--format=%s', backup])).toBe('F1\nbase')
  })

  it('throws GitConflictError and leaves the cherry-pick in progress on conflict', () => {
    // develop changes f.txt one way; feature changes it another → conflict.
    g(repo, ['checkout', '-q', '-b', 'develop'])
    writeFileSync(join(repo, 'f.txt'), 'develop\n')
    g(repo, ['commit', '-q', '-am', 'D1'])
    g(repo, ['checkout', '-q', 'main'])
    g(repo, ['checkout', '-q', '-b', 'feature'])
    writeFileSync(join(repo, 'f.txt'), 'feature\n')
    g(repo, ['commit', '-q', '-am', 'F1'])

    const commits = listProperCommits(repo, 'feature', 'develop', 'main')
    let err: unknown
    try {
      reconstructBranchOnto(repo, 'feature', 'develop', commits)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(GitConflictError)
    expect((err as GitConflictError).operation).toBe('cherry-pick')
    expect(getOngoingGitOperation(repo)).toBe('cherry-pick')
  })
})
