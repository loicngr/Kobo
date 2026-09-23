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

  it('fast-forwards a branch that is only behind', async () => {
    branchBehindOrigin()
    applyBranchStrategy(repo.path, 'feat/s', 'fast-forward')
    expect(repo.git(['rev-parse', 'feat/s'])).toBe(repo.git(['rev-parse', 'origin/feat/s']))
  })

  it('leaves the branch alone on keep', async () => {
    branchBehindOrigin()
    const before = repo.git(['rev-parse', 'feat/s'])
    applyBranchStrategy(repo.path, 'feat/s', 'keep')
    expect(repo.git(['rev-parse', 'feat/s'])).toBe(before)
  })

  it('creates a backup branch before discarding local commits', async () => {
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

  it('replays local commits on top of origin when rebasing', async () => {
    branchBehindOrigin()
    repo.git(['checkout', 'feat/s'])
    repo.commit('d.txt', 'd\n', 'feat: mine')
    repo.git(['checkout', 'main'])
    applyBranchStrategy(repo.path, 'feat/s', 'rebase')
    expect(repo.git(['log', '--oneline', 'feat/s'])).toContain('feat: mine')
    expect(() => repo.git(['merge-base', '--is-ancestor', 'origin/feat/s', 'feat/s'])).not.toThrow()
  })

  it('restores the original checkout after a clean rebase', async () => {
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
    const report = await diagnoseLocalState(repo.path, 'feat/r', null)
    const result = await resolvePrCheckout({
      projectPath: repo.path,
      headBranch: 'feat/r',
      baseBranch: 'main',
      worktreesPath: null,
      decisions: {},
      fingerprint: await computeFingerprint(report),
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
    const report = await diagnoseLocalState(repo.path, 'feat/r', null)
    expect(report.worktree.state).toBe('orphan')
    const result = await resolvePrCheckout({
      projectPath: repo.path,
      headBranch: 'feat/r',
      baseBranch: 'main',
      worktreesPath: null,
      decisions: { orphanWorktree: 'attach' },
      fingerprint: await computeFingerprint(report),
    })
    expect(result.worktreePath).toBe(wt)
    expect(result.applied.map((a) => a.kind)).toContain('attach-worktree')
  })

  it.each(['keep', undefined] as const)(
    'rejects hard reset with %s local edits without changing files or refs',
    async (localChanges) => {
      remoteOnlyBranch()
      const wt = path.join(repo.path, '.worktrees', 'feat-r')
      repo.git(['worktree', 'add', '-b', 'feat/r', wt, 'origin/feat/r'])
      fs.writeFileSync(path.join(wt, 'a.txt'), 'staged work\n')
      repo.git(['add', 'a.txt'], wt)
      fs.writeFileSync(path.join(wt, 'a.txt'), 'unstaged work\n')
      const report = await diagnoseLocalState(repo.path, 'feat/r', null)
      const before = repo.git(['show-ref'])
      await expect(
        resolvePrCheckout({
          projectPath: repo.path,
          headBranch: 'feat/r',
          baseBranch: 'main',
          worktreesPath: null,
          decisions: { localChanges, divergence: 'reset-hard' },
          fingerprint: await computeFingerprint(report),
        }),
      ).rejects.toThrow(/preserve local changes/i)
      expect(repo.git(['show-ref'])).toBe(before)
      expect(fs.readFileSync(path.join(wt, 'a.txt'), 'utf8')).toBe('unstaged work\n')
      expect(repo.git(['show', ':a.txt'], wt)).toBe('staged work')
      expect(repo.git(['stash', 'list'])).toBe('')
    },
  )

  it('rejects an impossible duplicate checkout before branch mutations', async () => {
    remoteOnlyBranch()
    const wt = path.join(repo.path, '.worktrees', 'feat-r')
    repo.git(['worktree', 'add', '-b', 'feat/r', wt, 'origin/feat/r'])
    const destination = path.join(repo.path, '.worktrees', 'elsewhere')
    const report = await diagnoseLocalState(repo.path, 'feat/r', null)
    const refs = repo.git(['show-ref'])
    await expect(
      resolvePrCheckout({
        projectPath: repo.path,
        headBranch: 'feat/r',
        baseBranch: 'main',
        worktreesPath: null,
        decisions: {
          orphanWorktree: 'create-elsewhere',
          pathCollision: { worktreePath: destination },
          divergence: 'reset-hard',
        },
        fingerprint: await computeFingerprint(report),
      }),
    ).rejects.toThrow(/already checked out/)
    expect(repo.git(['show-ref'])).toBe(refs)
    expect(fs.existsSync(destination)).toBe(false)
  })

  it.each(['unstaged', 'staged', 'untracked', 'symlink'])('invalidates same-count %s content changes', async (kind) => {
    remoteOnlyBranch()
    const wt = path.join(repo.path, '.worktrees', 'feat-r')
    repo.git(['worktree', 'add', '-b', 'feat/r', wt, 'origin/feat/r'])
    const file = path.join(wt, kind === 'untracked' || kind === 'symlink' ? 'new' : 'a.txt')
    if (kind === 'symlink') fs.symlinkSync('target1', file)
    else fs.writeFileSync(file, 'v1\n')
    if (kind === 'staged') repo.git(['add', '.'], wt)
    const report = await diagnoseLocalState(repo.path, 'feat/r', null)
    const fingerprint = await computeFingerprint(report)
    if (kind === 'symlink') {
      fs.unlinkSync(file)
      fs.symlinkSync('target2', file)
    } else fs.writeFileSync(file, 'v2\n')
    if (kind === 'staged') repo.git(['add', '.'], wt)
    const fresh = await diagnoseLocalState(repo.path, 'feat/r', null)
    expect(fresh.localChanges).toEqual(report.localChanges)
    expect(await computeFingerprint(fresh)).not.toBe(fingerprint)
    await expect(
      resolvePrCheckout({
        projectPath: repo.path,
        headBranch: 'feat/r',
        baseBranch: 'main',
        worktreesPath: null,
        decisions: { localChanges: 'stash' },
        fingerprint,
      }),
    ).rejects.toBeInstanceOf(StaleDiagnosisError)
  })

  it('stashes uncommitted changes when asked to', async () => {
    remoteOnlyBranch()
    const wt = path.join(repo.path, '.worktrees', 'feat-r')
    repo.git(['worktree', 'add', '-b', 'feat/r', wt, 'origin/feat/r'])
    fs.writeFileSync(path.join(wt, 'a.txt'), 'dirty\n')
    const report = await diagnoseLocalState(repo.path, 'feat/r', null)
    await resolvePrCheckout({
      projectPath: repo.path,
      headBranch: 'feat/r',
      baseBranch: 'main',
      worktreesPath: null,
      decisions: { orphanWorktree: 'attach', localChanges: 'stash' },
      fingerprint: await computeFingerprint(report),
    })
    expect(fs.readFileSync(path.join(wt, 'a.txt'), 'utf-8')).toBe('a\n')
    expect(repo.git(['stash', 'list'], wt)).toContain('kobo-pr-checkout')
  })

  it('rejects a plan built on a stale fingerprint', async () => {
    remoteOnlyBranch()
    const stale = await computeFingerprint(await diagnoseLocalState(repo.path, 'feat/r', null))
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
        fingerprint: await computeFingerprint(await diagnoseLocalState(repo.path, 'feat/r', null)),
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
    const report = await diagnoseLocalState(repo.path, 'feat/r', null)
    await expect(
      resolvePrCheckout({
        projectPath: repo.path,
        headBranch: 'feat/r',
        baseBranch: 'main',
        worktreesPath: null,
        decisions: { orphanWorktree: 'attach' },
        fingerprint: await computeFingerprint(report),
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

    const report = await diagnoseLocalState(repo.path, 'feat/r', null)
    expect(report.worktree.state).toBe('orphan')
    expect(report.branch.state).toBe('behind')

    const result = await resolvePrCheckout({
      projectPath: repo.path,
      headBranch: 'feat/r',
      baseBranch: 'main',
      worktreesPath: null,
      decisions: { orphanWorktree: 'attach', divergence: 'fast-forward' },
      fingerprint: await computeFingerprint(report),
    })

    expect(result.worktreePath).toBe(wt)
    expect(repo.git(['rev-parse', 'HEAD'], wt)).toBe(repo.git(['rev-parse', 'origin/feat/r']))
    expect(result.applied.map((a) => a.kind)).toContain('align-branch')
  })
})
