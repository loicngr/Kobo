import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as git from '../server/utils/git-ops.js'
import { createTempRepo, type TempRepo } from './helpers/temp-git-repo.js'

let repo: TempRepo
beforeEach(() => {
  repo = createTempRepo()
})
afterEach(() => repo.cleanup())

describe('asynchronous interactive history reads', () => {
  it('discovers local/remote branches and tracked/untracked files within the requested limit', async () => {
    fs.writeFileSync(path.join(repo.path, 'extra.txt'), 'extra\n')
    expect(await git.listBranchesAsync(repo.path)).toContain('main')
    expect(await git.listRemoteBranchesAsync(repo.path)).toContain('origin/main')
    expect(await git.localBranchExistsAsync(repo.path, 'main')).toBe(true)
    expect(await git.localBranchExistsAsync(repo.path, 'absent')).toBe(false)
    expect(await git.listWorktreeFilesAsync(repo.path)).toEqual(['extra.txt', 'README.md'])
    expect(await git.listWorktreeFilesAsync(repo.path, 1)).toEqual(['extra.txt'])
    expect(await git.getIndexLockPathAsync(repo.path)).toBeNull()
    expect(await git.getOngoingGitOperationAsync(repo.path)).toBeNull()
    const lock = path.join(repo.path, '.git', 'index.lock')
    fs.writeFileSync(lock, 'stale lock')
    expect(await git.getIndexLockPathAsync(repo.path)).toBe(lock)
    fs.writeFileSync(path.join(repo.path, '.git', 'MERGE_HEAD'), 'fake')
    expect(await git.getOngoingGitOperationAsync(repo.path)).toBe('merge')
  })

  it('reports pushed and unpushed commits, behind commits, and review summaries', async () => {
    repo.git(['checkout', '-b', 'feature/a'])
    repo.commit('first.txt', 'one\n', 'feature one')
    repo.git(['push', 'origin', 'feature/a'])
    repo.commit('second.txt', 'two\n', 'feature two')
    repo.git(['checkout', 'main'])
    repo.commit('main.txt', 'main\n', 'main advanced')
    repo.git(['push', 'origin', 'main'])
    repo.git(['checkout', 'feature/a'])
    const commits = await git.listBranchCommitsAsync(repo.path, 'main', 'feature/a')
    expect(commits.map(({ subject, isPushed }) => ({ subject, isPushed }))).toEqual([
      { subject: 'feature two', isPushed: false },
      { subject: 'feature one', isPushed: true },
    ])
    expect((await git.listBranchCommitsAsync(repo.path, 'main', 'feature/a', 1)).map((c) => c.subject)).toEqual([
      'feature two',
    ])
    expect((await git.listCommitsBehindAsync(repo.path, 'main', 'feature/a')).map((c) => c.subject)).toEqual([
      'main advanced',
    ])
    expect(await git.getCommitsBetweenAsync(repo.path, 'main', 'feature/a')).toContain('feature one')
    expect(await git.getDiffStatsBetweenAsync(repo.path, 'main', 'feature/a')).toContain('2 files changed')
  })

  it('preserves dirty, staged, and untracked filenames including spaces', async () => {
    fs.appendFileSync(path.join(repo.path, 'README.md'), 'dirty\n')
    fs.writeFileSync(path.join(repo.path, 'staged space.txt'), 'staged\n')
    repo.git(['add', 'staged space.txt'])
    fs.writeFileSync(path.join(repo.path, 'untracked\nline.txt'), 'new\n')
    expect(await git.getWorkingTreeFilesAsync(repo.path)).toEqual([
      { path: 'README.md', staged: false, modified: true, untracked: false },
      { path: 'staged space.txt', staged: true, modified: false, untracked: false },
      { path: 'untracked\nline.txt', staged: false, modified: false, untracked: true },
    ])
  })

  it('retains best-effort empty results outside a repository', async () => {
    const absent = path.join(repo.path, 'absent')
    expect(await git.listBranchCommitsAsync(absent, 'main', 'feature/a')).toEqual([])
    expect(await git.listCommitsBehindAsync(absent, 'main', 'feature/a')).toEqual([])
    expect(await git.getWorkingTreeFilesAsync(absent)).toEqual([])
    expect(await git.getCommitsBetweenAsync(absent, 'main', 'feature/a')).toBe('')
    expect(await git.getDiffStatsBetweenAsync(absent, 'main', 'feature/a')).toBe('')
  })
})

describe('asynchronous branch deletion', () => {
  it('keeps the event loop available while a remote receive hook waits', async () => {
    repo.git(['branch', 'feature/delete'])
    repo.git(['push', 'origin', 'feature/delete'])
    const hook = path.join(repo.originPath, 'hooks', 'pre-receive')
    fs.writeFileSync(hook, '#!/bin/sh\nsleep 0.2\nexit 0\n', { mode: 0o755 })
    let yielded = false
    const timer = setTimeout(() => {
      yielded = true
    }, 10)
    try {
      await git.deleteRemoteBranchAsync(repo.path, 'feature/delete')
      expect(yielded).toBe(true)
      expect(repo.git(['branch', '-r'])).not.toContain('origin/feature/delete')
      await git.deleteLocalBranchAsync(repo.path, 'feature/delete')
      expect(repo.git(['branch'])).not.toContain('feature/delete')
    } finally {
      clearTimeout(timer)
    }
  })

  it('propagates deletion failures with the same contextual errors', async () => {
    await expect(git.deleteLocalBranchAsync(repo.path, 'absent')).rejects.toThrow(
      "Failed to delete local branch 'absent'",
    )
    await expect(git.deleteRemoteBranchAsync(repo.path, 'absent')).rejects.toThrow(
      "Failed to delete remote branch 'origin/absent'",
    )
  })
})
