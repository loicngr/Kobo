import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'

/**
 * One promise chain per shared git directory. Same mechanism as the per-worktree
 * lock in `image-service.ts`, keyed differently: remote refs, packed-refs and
 * the object database live in the COMMON git dir, so two worktrees of the same
 * project contend on the same file locks even though their working directories
 * are disjoint.
 */
const locks = new Map<string, Promise<unknown>>()
const execFileAsync = promisify(execFile)
// Register operations in invocation order even when common-dir lookups finish
// out of order. This queue covers resolution only, never the locked operation.
let registrations: Promise<void> = Promise.resolve()

/**
 * Absolute path of the git directory shared by every worktree of a repository.
 *
 * Falls back to the resolved input path when git cannot answer (not a
 * repository, git missing): a wrong key only costs parallelism, never
 * correctness, whereas throwing here would break every caller.
 */
export async function resolveGitCommonDir(repoPath: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--git-common-dir'], {
      cwd: repoPath,
      encoding: 'utf-8',
      timeout: 10_000,
      killSignal: 'SIGKILL',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    })
    return path.resolve(repoPath, stdout.replace(/\n$/, ''))
  } catch {
    return path.resolve(repoPath)
  }
}

/** Run `fn` with exclusive access to `repoPath`'s shared git directory. */
export function withGitRepoLock<T>(repoPath: string, fn: () => T | Promise<T>): Promise<T> {
  let next: Promise<T>
  const registered = registrations.then(async () => {
    const key = await resolveGitCommonDir(repoPath)
    const previous = locks.get(key) ?? Promise.resolve()
    next = previous.then(fn, fn)
    const settled = next.then(
      () => {},
      () => {},
    )
    locks.set(key, settled)
    void settled.then(() => {
      if (locks.get(key) === settled) locks.delete(key)
    })
  })
  registrations = registered.catch(() => {})
  return registered.then(() => next)
}

/** Test-only: drop every queued chain so tests don't inherit each other's state. */
export function _resetGitRepoLocksForTest(): void {
  locks.clear()
  registrations = Promise.resolve()
}
