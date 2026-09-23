import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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

describe('resolveGitCommonDir()', async () => {
  it('maps a symlinked repository path to the same directory as its worktrees', async () => {
    // macOS temp dirs live under the /var -> /private/var symlink, and users can
    // open a project through any link: git reports worktree paths resolved.
    const alias = join(mkdtempSync(join(tmpdir(), 'kobo-lock-alias-')), 'repo')
    symlinkSync(repo, alias)
    try {
      expect(await resolveGitCommonDir(alias)).toBe(await resolveGitCommonDir(worktreeA))
    } finally {
      rmSync(dirname(alias), { recursive: true, force: true })
    }
  })

  it('maps a worktree and its main repository to the same directory', async () => {
    expect(await resolveGitCommonDir(worktreeA)).toBe(await resolveGitCommonDir(repo))
  })

  it('maps two unrelated repositories to different directories', async () => {
    expect(await resolveGitCommonDir(otherRepo)).not.toBe(await resolveGitCommonDir(repo))
  })

  it('never throws outside a git repository', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'kobo-lock-plain-'))
    await expect(resolveGitCommonDir(plain)).resolves.toBe(plain)
    rmSync(plain, { recursive: true, force: true })
  })
})

describe('withGitRepoLock()', async () => {
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
    let release!: () => void
    const bothStarted = new Promise<void>((resolve) => {
      release = resolve
    })
    let started = 0
    const operation = async (tag: string) => {
      trace.push(`${tag}:start`)
      if (++started === 2) release()
      // Git process startup can exceed 20 ms under load. Wait for overlap,
      // not a wall-clock assumption; a global operation lock would deadlock.
      await bothStarted
      trace.push(`${tag}:end`)
    }

    await Promise.all([
      withGitRepoLock(repo, () => operation('one')),
      withGitRepoLock(otherRepo, () => operation('two')),
    ])

    expect(trace.slice(0, 2)).toEqual(['one:start', 'two:start'])
    expect(trace.slice(2).sort()).toEqual(['one:end', 'two:end'])
  })

  it('does not let a failed operation block the queue', async () => {
    const failing = withGitRepoLock(repo, () => Promise.reject(new Error('boom')))
    await expect(failing).rejects.toThrow('boom')
    await expect(withGitRepoLock(repo, () => 'ok')).resolves.toBe('ok')
  })
})

it('does not block timers while resolving the common Git directory', async () => {
  const { mkdirSync } = await import('node:fs')
  const bin = join(repo, 'slow-bin')
  mkdirSync(bin)
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
  writeFileSync(join(bin, 'git'), `#!/bin/sh\nsleep 0.15\nexec ${realGit} "$@"\n`, { mode: 0o755 })
  const originalPath = process.env.PATH
  process.env.PATH = `${bin}:${originalPath}`
  let ticked = false
  const timer = setTimeout(() => {
    ticked = true
  }, 10)
  try {
    await withGitRepoLock(repo, async () => {
      expect(ticked).toBe(true)
    })
  } finally {
    process.env.PATH = originalPath
    clearTimeout(timer)
  }
})
