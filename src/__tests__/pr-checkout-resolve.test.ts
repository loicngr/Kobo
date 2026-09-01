import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  applyBranchStrategy,
  computeFingerprint,
  diagnoseLocalState,
  resolvePrCheckout,
  StaleDiagnosisError,
} from '../server/services/pr-checkout-service.js'
import { createTempRepo, type TempRepo } from './helpers/temp-git-repo.js'

describe('applyBranchStrategy', () => {
  let repo: TempRepo
  beforeEach(() => {
    repo = createTempRepo()
  })
  afterEach(() => repo.cleanup())

  /** Leaves `feat/s` one commit behind `origin/feat/s`, with main checked out. */
  function branchBehindOrigin(): void {
    repo.git(['checkout', '-b', 'feat/s'])
    repo.commit('a.txt', 'a\n', 'feat: a')
    repo.git(['push', '-u', 'origin', 'feat/s'])
    repo.commit('b.txt', 'b\n', 'feat: b')
    repo.git(['push', 'origin', 'feat/s'])
    repo.git(['reset', '--hard', 'HEAD~1'])
    repo.git(['checkout', 'main'])
  }

  it('fast-forwards a branch that is only behind', () => {
    branchBehindOrigin()
    applyBranchStrategy(repo.path, 'feat/s', 'fast-forward')
    expect(repo.git(['rev-parse', 'feat/s'])).toBe(repo.git(['rev-parse', 'origin/feat/s']))
  })

  it('leaves the branch alone on keep', () => {
    branchBehindOrigin()
    const before = repo.git(['rev-parse', 'feat/s'])
    applyBranchStrategy(repo.path, 'feat/s', 'keep')
    expect(repo.git(['rev-parse', 'feat/s'])).toBe(before)
  })

  it('creates a backup branch before discarding local commits', () => {
    branchBehindOrigin()
    repo.git(['checkout', 'feat/s'])
    repo.commit('c.txt', 'c\n', 'feat: local only')
    repo.git(['checkout', 'main'])
    const lost = repo.git(['rev-parse', 'feat/s'])
    const result = applyBranchStrategy(repo.path, 'feat/s', 'reset-hard')
    expect(result.backupBranch).toMatch(/^kobo-backup\/feat\/s-\d+$/)
    expect(repo.git(['rev-parse', result.backupBranch as string])).toBe(lost)
    expect(repo.git(['rev-parse', 'feat/s'])).toBe(repo.git(['rev-parse', 'origin/feat/s']))
  })

  it('replays local commits on top of origin when rebasing', () => {
    branchBehindOrigin()
    repo.git(['checkout', 'feat/s'])
    repo.commit('d.txt', 'd\n', 'feat: mine')
    repo.git(['checkout', 'main'])
    applyBranchStrategy(repo.path, 'feat/s', 'rebase')
    expect(repo.git(['log', '--oneline', 'feat/s'])).toContain('feat: mine')
    expect(() => repo.git(['merge-base', '--is-ancestor', 'origin/feat/s', 'feat/s'])).not.toThrow()
  })

  it('restores the original checkout after a clean rebase', () => {
    branchBehindOrigin()
    repo.git(['checkout', 'feat/s'])
    repo.commit('e.txt', 'e\n', 'feat: mine again')
    repo.git(['checkout', 'main'])
    applyBranchStrategy(repo.path, 'feat/s', 'rebase')
    expect(repo.git(['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main')
  })
})

describe('resolvePrCheckout', () => {
  let repo: TempRepo
  beforeEach(() => {
    repo = createTempRepo()
  })
  afterEach(() => repo.cleanup())

  /** Push `feat/r` to origin, then drop the local branch entirely. */
  function remoteOnlyBranch(): void {
    repo.git(['checkout', '-b', 'feat/r'])
    repo.commit('a.txt', 'a\n', 'feat: a')
    repo.git(['push', '-u', 'origin', 'feat/r'])
    repo.git(['checkout', 'main'])
    repo.git(['branch', '-D', 'feat/r'])
  }

  it('creates the worktree from origin when nothing exists locally', async () => {
    remoteOnlyBranch()
    const report = diagnoseLocalState(repo.path, 'feat/r', null)
    const result = await resolvePrCheckout({
      projectPath: repo.path,
      headBranch: 'feat/r',
      baseBranch: 'main',
      worktreesPath: null,
      decisions: {},
      fingerprint: computeFingerprint(report),
    })
    expect(fs.existsSync(result.worktreePath)).toBe(true)
    expect(result.workingBranch).toBe('feat/r')
    expect(result.sourceBranch).toBe('main')
    expect(repo.git(['rev-parse', 'HEAD'], result.worktreePath)).toBe(repo.git(['rev-parse', 'origin/feat/r']))
  })

  it('attaches an orphan worktree instead of creating a second one', async () => {
    remoteOnlyBranch()
    const wt = path.join(repo.path, '.worktrees', 'feat-r')
    repo.git(['worktree', 'add', '-b', 'feat/r', wt, 'origin/feat/r'])
    const report = diagnoseLocalState(repo.path, 'feat/r', null)
    expect(report.worktree.state).toBe('orphan')
    const result = await resolvePrCheckout({
      projectPath: repo.path,
      headBranch: 'feat/r',
      baseBranch: 'main',
      worktreesPath: null,
      decisions: { orphanWorktree: 'attach' },
      fingerprint: computeFingerprint(report),
    })
    expect(result.worktreePath).toBe(wt)
    expect(result.applied.map((a) => a.kind)).toContain('attach-worktree')
  })

  it('stashes uncommitted changes when asked to', async () => {
    remoteOnlyBranch()
    const wt = path.join(repo.path, '.worktrees', 'feat-r')
    repo.git(['worktree', 'add', '-b', 'feat/r', wt, 'origin/feat/r'])
    fs.writeFileSync(path.join(wt, 'a.txt'), 'dirty\n')
    const report = diagnoseLocalState(repo.path, 'feat/r', null)
    await resolvePrCheckout({
      projectPath: repo.path,
      headBranch: 'feat/r',
      baseBranch: 'main',
      worktreesPath: null,
      decisions: { orphanWorktree: 'attach', localChanges: 'stash' },
      fingerprint: computeFingerprint(report),
    })
    expect(fs.readFileSync(path.join(wt, 'a.txt'), 'utf-8')).toBe('a\n')
    expect(repo.git(['stash', 'list'], wt)).toContain('kobo-pr-checkout')
  })

  it('rejects a plan built on a stale fingerprint', async () => {
    remoteOnlyBranch()
    const stale = computeFingerprint(diagnoseLocalState(repo.path, 'feat/r', null))
    repo.git(['checkout', '-b', 'feat/r', 'origin/feat/r'])
    repo.commit('drift.txt', 'x\n', 'feat: drift')
    repo.git(['checkout', 'main'])
    await expect(
      resolvePrCheckout({
        projectPath: repo.path,
        headBranch: 'feat/r',
        baseBranch: 'main',
        worktreesPath: null,
        decisions: {},
        fingerprint: stale,
      }),
    ).rejects.toBeInstanceOf(StaleDiagnosisError)
  })

  it('removes a worktree it created when a later step fails', async () => {
    remoteOnlyBranch()
    await expect(
      resolvePrCheckout({
        projectPath: repo.path,
        headBranch: 'feat/r',
        baseBranch: 'main',
        worktreesPath: null,
        decisions: {},
        fingerprint: computeFingerprint(diagnoseLocalState(repo.path, 'feat/r', null)),
        afterWorktreeHook: () => {
          throw new Error('boom')
        },
      }),
    ).rejects.toThrow('boom')
    expect(fs.existsSync(path.join(repo.path, '.worktrees', 'feat-r'))).toBe(false)
  })

  it('does not remove a reused worktree when a later step fails', async () => {
    remoteOnlyBranch()
    const wt = path.join(repo.path, '.worktrees', 'feat-r')
    repo.git(['worktree', 'add', '-b', 'feat/r', wt, 'origin/feat/r'])
    const report = diagnoseLocalState(repo.path, 'feat/r', null)
    await expect(
      resolvePrCheckout({
        projectPath: repo.path,
        headBranch: 'feat/r',
        baseBranch: 'main',
        worktreesPath: null,
        decisions: { orphanWorktree: 'attach' },
        fingerprint: computeFingerprint(report),
        afterWorktreeHook: () => {
          throw new Error('boom')
        },
      }),
    ).rejects.toThrow('boom')
    expect(fs.existsSync(wt)).toBe(true)
  })

  it('fast-forwards a reused worktree that is behind origin', async () => {
    repo.git(['checkout', '-b', 'feat/r'])
    repo.commit('a.txt', 'a\n', 'feat: a')
    repo.git(['push', '-u', 'origin', 'feat/r'])
    repo.git(['checkout', 'main'])
    const wt = path.join(repo.path, '.worktrees', 'feat-r')
    repo.git(['worktree', 'add', wt, 'feat/r'])

    // Advance origin/feat/r without moving the local feat/r branch (it's
    // checked out in `wt`, so it can't be checked out again here): branch off
    // it under a throwaway name, commit, and push that ref straight to the
    // remote's feat/r via refspec.
    repo.git(['checkout', '-b', 'tmp/push', 'feat/r'])
    repo.commit('c.txt', 'c\n', 'feat: c pushed to origin only')
    repo.git(['push', 'origin', 'tmp/push:feat/r'])
    repo.git(['checkout', 'main'])
    repo.git(['branch', '-D', 'tmp/push'])

    const report = diagnoseLocalState(repo.path, 'feat/r', null)
    expect(report.worktree.state).toBe('orphan')
    expect(report.branch.state).toBe('behind')

    const result = await resolvePrCheckout({
      projectPath: repo.path,
      headBranch: 'feat/r',
      baseBranch: 'main',
      worktreesPath: null,
      decisions: { orphanWorktree: 'attach', divergence: 'fast-forward' },
      fingerprint: computeFingerprint(report),
    })

    expect(result.worktreePath).toBe(wt)
    expect(repo.git(['rev-parse', 'HEAD'], wt)).toBe(repo.git(['rev-parse', 'origin/feat/r']))
    expect(result.applied.map((a) => a.kind)).toContain('align-branch')
  })
})
