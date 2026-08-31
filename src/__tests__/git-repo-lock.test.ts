import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { _resetGitRepoLocksForTest, resolveGitCommonDir, withGitRepoLock } from '../server/utils/git-repo-lock.js'

function g(repo: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf-8' }).trimEnd()
}

let repo: string
let worktreeA: string
let otherRepo: string

beforeEach(() => {
  _resetGitRepoLocksForTest()
  repo = mkdtempSync(join(tmpdir(), 'kobo-lock-'))
  g(repo, ['init', '-q', '-b', 'main'])
  g(repo, ['config', 'user.email', 't@t.t'])
  g(repo, ['config', 'user.name', 'T'])
  writeFileSync(join(repo, 'f.txt'), 'base\n')
  g(repo, ['add', '.'])
  g(repo, ['commit', '-q', '-m', 'base'])
  worktreeA = join(mkdtempSync(join(tmpdir(), 'kobo-lock-wt-')), 'a')
  g(repo, ['worktree', 'add', '-q', '-b', 'feature/a', worktreeA])

  otherRepo = mkdtempSync(join(tmpdir(), 'kobo-lock-other-'))
  g(otherRepo, ['init', '-q', '-b', 'main'])
})

afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
  rmSync(worktreeA, { recursive: true, force: true })
  rmSync(otherRepo, { recursive: true, force: true })
})

describe('resolveGitCommonDir()', () => {
  it('maps a worktree and its main repository to the same directory', () => {
    expect(resolveGitCommonDir(worktreeA)).toBe(resolveGitCommonDir(repo))
  })

  it('maps two unrelated repositories to different directories', () => {
    expect(resolveGitCommonDir(otherRepo)).not.toBe(resolveGitCommonDir(repo))
  })

  it('never throws outside a git repository', () => {
    const plain = mkdtempSync(join(tmpdir(), 'kobo-lock-plain-'))
    expect(() => resolveGitCommonDir(plain)).not.toThrow()
    rmSync(plain, { recursive: true, force: true })
  })
})

describe('withGitRepoLock()', () => {
  it('never interleaves two operations on worktrees of the same repository', async () => {
    const trace: string[] = []
    const slow = async (tag: string) => {
      trace.push(`${tag}:start`)
      await new Promise((resolve) => setTimeout(resolve, 20))
      trace.push(`${tag}:end`)
    }

    await Promise.all([withGitRepoLock(repo, () => slow('main')), withGitRepoLock(worktreeA, () => slow('worktree'))])

    expect(trace).toEqual(['main:start', 'main:end', 'worktree:start', 'worktree:end'])
  })

  it('lets unrelated repositories run concurrently', async () => {
    const trace: string[] = []
    const slow = async (tag: string) => {
      trace.push(`${tag}:start`)
      await new Promise((resolve) => setTimeout(resolve, 20))
      trace.push(`${tag}:end`)
    }

    await Promise.all([withGitRepoLock(repo, () => slow('one')), withGitRepoLock(otherRepo, () => slow('two'))])

    expect(trace).toEqual(['one:start', 'two:start', 'one:end', 'two:end'])
  })

  it('does not let a failed operation block the queue', async () => {
    const failing = withGitRepoLock(repo, () => Promise.reject(new Error('boom')))
    await expect(failing).rejects.toThrow('boom')
    await expect(withGitRepoLock(repo, () => 'ok')).resolves.toBe('ok')
  })
})
