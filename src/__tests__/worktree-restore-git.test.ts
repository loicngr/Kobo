import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isMatchingWorkspaceWorktree, restoreWorktreeCheckoutUnlocked } from '../server/services/worktree-service.js'

let root: string
let projectPath: string
let worktreePath: string
const workingBranch = 'feature/restore'
const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim()
const input = () => ({ projectPath, worktreePath, workingBranch })
function init(repo: string) {
  fs.mkdirSync(repo, { recursive: true })
  git(repo, ['init', '-b', 'main'])
  git(repo, ['config', 'user.email', 'test@kobo.local'])
  git(repo, ['config', 'user.name', 'Test'])
  git(repo, ['commit', '--allow-empty', '-m', 'Initial'])
}
function purge() {
  git(projectPath, ['worktree', 'add', '-b', workingBranch, worktreePath])
  fs.writeFileSync(path.join(worktreePath, 'committed.txt'), 'saved work')
  git(worktreePath, ['add', '.'])
  git(worktreePath, ['commit', '-m', 'Workspace work'])
  const sha = git(worktreePath, ['rev-parse', 'HEAD'])
  git(projectPath, ['worktree', 'remove', worktreePath])
  return sha
}
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kobo-restore-git-'))
  projectPath = path.join(root, 'repo')
  worktreePath = path.join(projectPath, '.worktrees', 'restored')
  init(projectPath)
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

describe('restoreWorktreeCheckoutUnlocked', () => {
  it.each(['with trailing space ', 'with trailing newline\n'])('preserves path characters in %j', async (name) => {
    worktreePath = path.join(projectPath, '.worktrees', name)
    const headCommitSha = purge()
    expect(await restoreWorktreeCheckoutUnlocked(input())).toEqual({ source: 'local-branch', headCommitSha })
    expect(isMatchingWorkspaceWorktree(input())).toBe(true)
    expect((await restoreWorktreeCheckoutUnlocked(input())).source).toBe('existing-worktree')
  })
  it('restores the surviving local branch offline, preserving main and adding its exclude entry', async () => {
    const main = git(projectPath, ['rev-parse', 'HEAD'])
    const headCommitSha = purge()
    git(projectPath, ['remote', 'add', 'origin', path.join(root, 'offline')])
    expect(await restoreWorktreeCheckoutUnlocked(input())).toEqual({ source: 'local-branch', headCommitSha })
    expect(git(projectPath, ['rev-parse', 'HEAD'])).toBe(main)
    expect(git(projectPath, ['symbolic-ref', '--short', 'HEAD'])).toBe('main')
    expect(fs.readFileSync(path.join(worktreePath, 'committed.txt'), 'utf8')).toBe('saved work')
    expect(fs.readFileSync(path.join(projectPath, '.git/info/exclude'), 'utf8')).toContain('/.worktrees/restored')
    expect(await restoreWorktreeCheckoutUnlocked(input())).toEqual({ source: 'existing-worktree', headCommitSha })
  })
  it('prefers the surviving branch over an older saved commit', async () => {
    const old = git(projectPath, ['rev-parse', 'HEAD'])
    const headCommitSha = purge()
    expect(await restoreWorktreeCheckoutUnlocked({ ...input(), headCommitSha: old })).toEqual({
      source: 'local-branch',
      headCommitSha,
    })
  })
  it('recreates a missing branch from the saved commit without a remote', async () => {
    const headCommitSha = purge()
    git(projectPath, ['branch', '-D', workingBranch])
    expect(await restoreWorktreeCheckoutUnlocked({ ...input(), headCommitSha })).toEqual({
      source: 'saved-commit',
      headCommitSha,
    })
  })
  it('fetches the exact branch from origin when only the remote has it', async () => {
    const headCommitSha = purge()
    const origin = path.join(root, 'origin.git')
    git(root, ['init', '--bare', origin])
    git(projectPath, ['remote', 'add', 'origin', origin])
    git(projectPath, ['push', 'origin', workingBranch])
    git(projectPath, ['branch', '-D', workingBranch])
    expect(await restoreWorktreeCheckoutUnlocked({ ...input(), headCommitSha: '0'.repeat(40) })).toEqual({
      source: 'remote-branch',
      headCommitSha,
    })
  })
  it('supports a project that is itself a linked worktree', async () => {
    const linked = path.join(root, 'linked-project')
    git(projectPath, ['worktree', 'add', '-b', 'linked-project', linked])
    projectPath = linked
    worktreePath = path.join(linked, '.worktrees', 'restored')
    const headCommitSha = purge()
    expect(await restoreWorktreeCheckoutUnlocked(input())).toEqual({ source: 'local-branch', headCommitSha })
    expect(isMatchingWorkspaceWorktree(input())).toBe(true)
  })
  it('does not run a post-checkout hook during restoration', async () => {
    purge()
    const marker = path.join(root, 'hook-ran')
    fs.writeFileSync(path.join(projectPath, '.git/hooks/post-checkout'), `#!/bin/sh\ntouch '${marker}'\n`, {
      mode: 0o755,
    })
    await restoreWorktreeCheckoutUnlocked(input())
    expect(fs.existsSync(marker)).toBe(false)
  })
  it.each(['empty', 'files', 'repository', 'wrong-branch', 'symlink', 'dangling-symlink', 'nested'])(
    'rejects a conflicting %s without touching it',
    async (kind) => {
      purge()
      if (kind === 'symlink' || kind === 'dangling-symlink')
        fs.symlinkSync(kind === 'symlink' ? projectPath : path.join(root, 'missing'), worktreePath)
      else if (kind === 'wrong-branch') git(projectPath, ['worktree', 'add', '-b', 'other', worktreePath])
      else if (kind === 'repository') init(worktreePath)
      else {
        fs.mkdirSync(worktreePath, { recursive: true })
        if (kind === 'files') fs.writeFileSync(path.join(worktreePath, 'precious'), 'keep')
        if (kind === 'nested') worktreePath = path.join(projectPath, '.worktrees')
      }
      expect(isMatchingWorkspaceWorktree(input())).toBe(false)
      await expect(restoreWorktreeCheckoutUnlocked(input())).rejects.toMatchObject({ code: 'path-conflict' })
      expect(fs.lstatSync(worktreePath)).toBeDefined()
      if (kind === 'files') expect(fs.readFileSync(path.join(worktreePath, 'precious'), 'utf8')).toBe('keep')
    },
  )
  it('rejects a branch checked out elsewhere', async () => {
    purge()
    const elsewhere = path.join(root, 'elsewhere')
    git(projectPath, ['worktree', 'add', elsewhere, workingBranch])
    await expect(restoreWorktreeCheckoutUnlocked(input())).rejects.toMatchObject({ code: 'branch-in-use' })
    expect(git(elsewhere, ['symbolic-ref', '--short', 'HEAD'])).toBe(workingBranch)
  })
  it('reports stale target registration conservatively without pruning unrelated worktrees', async () => {
    git(projectPath, ['worktree', 'add', '-b', workingBranch, worktreePath])
    fs.rmSync(worktreePath, { recursive: true })
    const before = git(projectPath, ['worktree', 'list', '--porcelain'])
    await expect(restoreWorktreeCheckoutUnlocked(input())).rejects.toMatchObject({ code: 'path-conflict' })
    expect(git(projectPath, ['worktree', 'list', '--porcelain'])).toBe(before)
  })
  it('fails without falling back to main when no recovery source exists', async () => {
    await expect(restoreWorktreeCheckoutUnlocked(input())).rejects.toMatchObject({
      code: 'recovery-source-unavailable',
    })
    expect(fs.existsSync(worktreePath)).toBe(false)
  })
  it('rejects unavailable projects', async () => {
    await expect(restoreWorktreeCheckoutUnlocked({ ...input(), projectPath: root })).rejects.toMatchObject({
      code: 'project-unavailable',
    })
  })
  it.each(['--detach', '@{-1}', 'bad..branch'])('rejects invalid branch %s without creating files', async (branch) => {
    await expect(restoreWorktreeCheckoutUnlocked({ ...input(), workingBranch: branch })).rejects.toMatchObject({
      code: 'git-failed',
    })
    expect(fs.existsSync(worktreePath)).toBe(false)
  })
})
