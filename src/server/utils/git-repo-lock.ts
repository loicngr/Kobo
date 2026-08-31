import { execFileSync } from 'node:child_process'
import path from 'node:path'

/**
 * One promise chain per shared git directory. Same mechanism as the per-worktree
 * lock in `image-service.ts`, keyed differently: remote refs, packed-refs and
 * the object database live in the COMMON git dir, so two worktrees of the same
 * project contend on the same file locks even though their working directories
 * are disjoint.
 */
const locks = new Map<string, Promise<unknown>>()

/**
 * Absolute path of the git directory shared by every worktree of a repository.
 *
 * Falls back to the resolved input path when git cannot answer (not a
 * repository, git missing): a wrong key only costs parallelism, never
 * correctness, whereas throwing here would break every caller.
 */
export function resolveGitCommonDir(repoPath: string): string {
  try {
    const out = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd: repoPath,
      encoding: 'utf-8',
      timeout: 15_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    }).trim()
    return path.resolve(repoPath, out)
  } catch {
    return path.resolve(repoPath)
  }
}

/** Run `fn` with exclusive access to `repoPath`'s shared git directory. */
export function withGitRepoLock<T>(repoPath: string, fn: () => T | Promise<T>): Promise<T> {
  const key = resolveGitCommonDir(repoPath)
  const previous = locks.get(key) ?? Promise.resolve()
  // The second argument to .then() means: even if the previous operation in the
  // queue rejected, still run fn — one failure must not block the whole queue.
  const next = previous.then(fn, fn)
  locks.set(
    key,
    next.then(
      () => {},
      () => {},
    ),
  )
  return next
}

/** Test-only: drop every queued chain so tests don't inherit each other's state. */
export function _resetGitRepoLocksForTest(): void {
  locks.clear()
}
