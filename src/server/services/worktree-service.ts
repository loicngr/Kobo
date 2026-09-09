import { execFile, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { isGitBranchExistsError } from '../utils/git-ops.js'
import { withGitRepoLock } from '../utils/git-repo-lock.js'
import { resolveWorkspaceWorktreePath, resolveWorktreesRoot } from '../utils/worktree-paths.js'

/** Parsed information about a single git worktree. */
export interface WorktreeInfo {
  path: string
  branch: string
  head: string
}

/** A worktree that's not yet attached to any Kōbō workspace, with a server-side suggestion for sourceBranch. */
export interface OrphanWorktreeInfo {
  path: string
  branch: string
  head: string
  suggestedSourceBranch: string
}

function git(repoPath: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repoPath,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    // Force the C locale so git (and libc strerror) emit English error messages.
    // Without this, a French host reports "Permission non accordée" instead of
    // "Permission denied", and permission-failure detection silently misses it.
    env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
  }).trim()
}

/** True when an exec/git error message indicates a filesystem permission failure.
 * git runs under LC_ALL=C (English), but we also match common localized phrasings
 * (e.g. French) as a safety net in case the locale override doesn't take effect. */
export function isPermissionError(message: string): boolean {
  return /EACCES|EPERM|permission denied|operation not permitted|permission non accordée|opération non permise/i.test(
    message,
  )
}

/** argv for `docker run` that chowns a bind-mounted worktree back to the host user. */
export function buildDockerChownArgs(worktreePath: string, uid: number, gid: number, image: string): string[] {
  return ['run', '--rm', '-v', `${worktreePath}:/w`, image, 'chown', '-R', `${uid}:${gid}`, '/w']
}

const DEFAULT_CLEANUP_IMAGE = 'alpine'

function isDockerAvailable(): boolean {
  try {
    execFileSync('docker', ['version'], { stdio: ['ignore', 'ignore', 'ignore'] })
    return true
  } catch {
    return false
  }
}

function reclaimWorktreeOwnershipViaDocker(worktreePath: string, uid: number, gid: number, image: string): void {
  execFileSync('docker', buildDockerChownArgs(worktreePath, uid, gid, image), {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  })
}

function getExcludeFilePath(projectPath: string): string {
  return path.join(projectPath, '.git', 'info', 'exclude')
}

function projectRelativeWorktreePath(projectPath: string, worktreePath: string): string | null {
  const relativePath = path.relative(projectPath, worktreePath)
  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) return null
  return relativePath
}

function addToExclude(projectPath: string, worktreePath: string, excludeFile = getExcludeFilePath(projectPath)): void {
  const relativePath = projectRelativeWorktreePath(projectPath, worktreePath)
  if (!relativePath) return

  // Ensure the .git/info directory exists
  const infoDir = path.dirname(excludeFile)
  if (!fs.existsSync(infoDir)) {
    fs.mkdirSync(infoDir, { recursive: true })
  }

  const entry = `/${relativePath}`

  let current = ''
  if (fs.existsSync(excludeFile)) {
    current = fs.readFileSync(excludeFile, 'utf-8')
  }

  if (!current.split('\n').includes(entry)) {
    const newContent = current.endsWith('\n') || current === '' ? `${current}${entry}\n` : `${current}\n${entry}\n`
    fs.writeFileSync(excludeFile, newContent, 'utf-8')
  }
}

function removeFromExclude(projectPath: string, worktreePath: string): void {
  const relativePath = projectRelativeWorktreePath(projectPath, worktreePath)
  if (!relativePath) return

  const excludeFile = getExcludeFilePath(projectPath)
  if (!fs.existsSync(excludeFile)) return

  const entry = `/${relativePath}`

  const lines = fs.readFileSync(excludeFile, 'utf-8').split('\n')
  const filtered = lines.filter((line) => line !== entry)
  const trimmed = filtered.join('\n').replace(/\n+$/, '')
  fs.writeFileSync(excludeFile, trimmed ? `${trimmed}\n` : '', 'utf-8')
}

/** Create a git worktree for the given branch, based on `baseRef`.
 * `baseRef` is passed explicitly by the caller: `origin/<sourceBranch>` in the
 * nominal path, or the local `<sourceBranch>` when origin is unreachable.
 * Returns the worktree path and which base was used. */
export function createWorktree(
  projectPath: string,
  branchName: string,
  baseRef: string,
  worktreesPath?: string | null,
  projectSlug?: string,
  explicitPath?: string | null,
): { worktreePath: string; base: 'origin' | 'local'; branchCreated: boolean } {
  const worktreesDir = resolveWorktreesRoot(projectPath, worktreesPath)
  if (!fs.existsSync(worktreesDir)) {
    fs.mkdirSync(worktreesDir, { recursive: true })
  }

  const worktreePath = explicitPath || resolveWorkspaceWorktreePath(projectPath, branchName, worktreesPath, projectSlug)
  const base: 'origin' | 'local' = baseRef.startsWith('origin/') ? 'origin' : 'local'

  // Tracks which of the two git commands below actually ran. Callers use it to
  // decide whether a rollback may delete the branch: deleting one we merely
  // attached to would destroy commits Kobo never created.
  let branchCreated = true

  try {
    git(projectPath, ['worktree', 'add', '-b', branchName, worktreePath, baseRef])
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)

    // If branch already exists, add worktree without creating the branch
    if (isGitBranchExistsError(message)) {
      git(projectPath, ['worktree', 'add', worktreePath, branchName])
      branchCreated = false
    } else {
      throw new Error(`Failed to create worktree for branch '${branchName}': ${message}`)
    }
  }

  addToExclude(projectPath, worktreePath)

  return { worktreePath, base, branchCreated }
}

/** `git worktree remove` drops the administrative entry even when it fails to
 *  delete the directory, and the prune only ever ran in the Docker fallback.
 *  Prune the stale metadata, then refuse to report success while the folder is
 *  still there — the purge feature marked workspaces as purged on that false
 *  success, telling the user the disk space was reclaimed when it wasn't.
 *
 *  Callers hold the repository lock: acquiring it again here would deadlock on
 *  the same key, since the chain is strictly sequential per common git dir. */
function assertWorktreeGone(projectPath: string, worktreePath: string): void {
  try {
    git(projectPath, ['worktree', 'prune'])
  } catch (err) {
    console.warn(`[worktree] prune after removing '${worktreePath}' failed:`, err instanceof Error ? err.message : err)
  }
  if (fs.existsSync(worktreePath)) {
    throw new Error(`Failed to remove worktree '${worktreePath}': the directory is still on disk after removal`)
  }
}

/** Remove a git worktree and clean up the .git/info/exclude entry.
 *
 * If `git worktree remove` fails on a permission error (Docker dev servers leave
 * root-owned files in node_modules / vendor), and Docker is available, reclaim
 * ownership with a throwaway container (`chown -R <uid>:<gid>`) and retry once.
 * Otherwise rethrow so the caller's recovery toast (sudo rm -rf …) fires. */
export function removeWorktree(projectPath: string, worktreePath: string): Promise<void> {
  // `git worktree remove` and `git worktree prune` both rewrite the worktree
  // administrative files of the COMMON git dir — the very state a concurrent
  // source-branch change (fetch / reset / cherry-pick) is manipulating under
  // the same lock. The whole removal sequence is held, Docker chown included:
  // it sits between the `remove` and the `prune` that repairs its metadata, so
  // releasing in the middle would expose a half-removed repository.
  return withGitRepoLock(projectPath, () => removeWorktreeUnlocked(projectPath, worktreePath))
}

/** Remove a worktree. Call ONLY while already holding the repository lock. */
export function removeWorktreeUnlocked(projectPath: string, worktreePath: string): void {
  try {
    git(projectPath, ['worktree', 'remove', worktreePath, '--force'])
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const uid = typeof process.getuid === 'function' ? process.getuid() : null
    const gid = typeof process.getgid === 'function' ? process.getgid() : null

    if (isPermissionError(message) && uid != null && gid != null && isDockerAvailable()) {
      const image = process.env.KOBO_WORKTREE_CLEANUP_IMAGE || DEFAULT_CLEANUP_IMAGE
      console.warn(
        `[worktree] '${worktreePath}' has root-owned files (permission denied); reclaiming ownership via Docker (${image})…`,
      )
      try {
        reclaimWorktreeOwnershipViaDocker(worktreePath, uid, gid, image)
        // The first `git worktree remove` already de-registered this worktree (it
        // drops the admin entry even when the directory rm fails on permission), so
        // retrying it errors with "is not a working tree". Now that we own the files,
        // delete the directory directly and prune any dangling worktree metadata.
        fs.rmSync(worktreePath, { recursive: true, force: true })
        git(projectPath, ['worktree', 'prune'])
        console.log(`[worktree] Docker cleanup succeeded; removed '${worktreePath}'`)
        removeFromExclude(projectPath, worktreePath)
        assertWorktreeGone(projectPath, worktreePath)
        return
      } catch (retryErr) {
        const retryMessage = retryErr instanceof Error ? retryErr.message : String(retryErr)
        console.error(`[worktree] Docker cleanup failed for '${worktreePath}': ${retryMessage}`)
        throw new Error(`Failed to remove worktree '${worktreePath}': ${retryMessage}`)
      }
    }

    throw new Error(`Failed to remove worktree '${worktreePath}': ${message}`)
  }

  removeFromExclude(projectPath, worktreePath)
  assertWorktreeGone(projectPath, worktreePath)
}

/** List all git worktrees for a repository by parsing `git worktree list --porcelain`. */
export function listWorktrees(projectPath: string): WorktreeInfo[] {
  const output = git(projectPath, ['worktree', 'list', '--porcelain'])

  const worktrees: WorktreeInfo[] = []
  const blocks = output.split('\n\n').filter(Boolean)

  for (const block of blocks) {
    const lines = block.split('\n')
    const worktree: Partial<WorktreeInfo> = {}

    for (const line of lines) {
      if (line.startsWith('worktree ')) {
        worktree.path = line.slice('worktree '.length).trim()
      } else if (line.startsWith('HEAD ')) {
        worktree.head = line.slice('HEAD '.length).trim()
      } else if (line.startsWith('branch ')) {
        // branch refs/heads/<name>
        const ref = line.slice('branch '.length).trim()
        worktree.branch = ref.replace(/^refs\/heads\//, '')
      } else if (line === 'detached') {
        worktree.branch = '(detached HEAD)'
      }
    }

    if (worktree.path) {
      worktrees.push({
        path: worktree.path,
        branch: worktree.branch ?? '',
        head: worktree.head ?? '',
      })
    }
  }

  return worktrees
}

/** Check whether a worktree for the given branch already exists. */
export function worktreeExists(projectPath: string, branchName: string): boolean {
  try {
    const worktrees = listWorktrees(projectPath)
    return worktrees.some((wt) => wt.branch === branchName)
  } catch {
    return false
  }
}

function canonicalize(p: string): string {
  try {
    return fs.realpathSync(p)
  } catch {
    return p
  }
}

function detectSourceBranch(projectPath: string, worktreePath: string, branch: string): string {
  // 1. Branch's tracked upstream (configured locally)
  try {
    const upstream = git(worktreePath, ['config', '--get', `branch.${branch}.merge`])
    if (upstream) return upstream.replace(/^refs\/heads\//, '')
  } catch {
    /* no upstream configured */
  }
  // 2. Repo's default branch (origin/HEAD)
  try {
    const head = git(projectPath, ['symbolic-ref', 'refs/remotes/origin/HEAD'])
    if (head) return head.replace(/^refs\/remotes\/origin\//, '')
  } catch {
    /* no origin/HEAD */
  }
  // 3. Final fallback
  return 'main'
}

/**
 * List worktrees of a project that are NOT yet attached to a Kōbō workspace.
 * The main worktree is excluded. Detached HEAD worktrees are excluded (no
 * branch to anchor a workspace to). Both sides of the path comparison are
 * canonicalized to defeat symlinks / trailing-slash variants.
 */
export function listOrphanWorktrees(projectPath: string, attachedPaths: Set<string>): OrphanWorktreeInfo[] {
  const canonAttached = new Set(Array.from(attachedPaths).map(canonicalize))
  const canonProject = canonicalize(projectPath)

  return listWorktrees(projectPath)
    .filter((wt) => canonicalize(wt.path) !== canonProject)
    .filter((wt) => !!wt.branch && wt.branch !== '(detached HEAD)')
    .filter((wt) => !canonAttached.has(canonicalize(wt.path)))
    .map((wt) => ({
      path: wt.path,
      branch: wt.branch,
      head: wt.head,
      suggestedSourceBranch: detectSourceBranch(projectPath, wt.path, wt.branch),
    }))
}

export interface RestoreCheckoutInput {
  projectPath: string
  worktreePath: string
  workingBranch: string
  headCommitSha?: string | null
}

export type RestoreCheckoutSource = 'existing-worktree' | 'local-branch' | 'saved-commit' | 'remote-branch'
export type WorktreeCheckoutErrorCode =
  | 'path-conflict'
  | 'branch-in-use'
  | 'recovery-source-unavailable'
  | 'project-unavailable'
  | 'git-failed'

export class WorktreeCheckoutError extends Error {
  constructor(
    public readonly code: WorktreeCheckoutErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'WorktreeCheckoutError'
  }
}

const restoreGitEnv = () => ({ ...process.env, LC_ALL: 'C', LANG: 'C', GIT_TERMINAL_PROMPT: '0' })

function restoreGit(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
    env: restoreGitEnv(),
  }).replace(/\n$/, '')
}

/** NUL delimiters preserve quoted, whitespace and newline-containing worktree paths. */
function restoreRegistrations(projectPath: string): { path: string; branch: string }[] {
  return restoreGit(projectPath, ['worktree', 'list', '--porcelain', '-z'])
    .split('\0\0')
    .filter(Boolean)
    .map((block) => {
      const fields = block.split('\0')
      return {
        path: fields.find((field) => field.startsWith('worktree '))?.slice(9) ?? '',
        branch: fields.find((field) => field.startsWith('branch '))?.slice(7) ?? '',
      }
    })
}

function commonGitDirectory(cwd: string): string {
  return fs.realpathSync(restoreGit(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']))
}

/** Accept only the exact registered root in the same repository on the expected branch. */
export function isMatchingWorkspaceWorktree(input: RestoreCheckoutInput): boolean {
  try {
    if (!fs.lstatSync(input.worktreePath).isDirectory()) return false
    const target = fs.realpathSync(input.worktreePath)
    if (fs.realpathSync(restoreGit(input.worktreePath, ['rev-parse', '--show-toplevel'])) !== target) return false
    if (commonGitDirectory(input.projectPath) !== commonGitDirectory(input.worktreePath)) return false
    const ref = `refs/heads/${input.workingBranch}`
    if (restoreGit(input.worktreePath, ['symbolic-ref', 'HEAD']) !== ref) return false
    return restoreRegistrations(input.projectPath).some(
      (entry) => canonicalize(entry.path) === target && entry.branch === ref,
    )
  } catch {
    return false
  }
}

function restorePathExists(target: string): boolean {
  try {
    fs.lstatSync(target)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw err
  }
}

function resolveRestoreCommit(projectPath: string, ref: string): string | null {
  try {
    return restoreGit(projectPath, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`])
  } catch {
    return null
  }
}

/** Caller must already hold withGitRepoLock(projectPath). Never resets or replaces a checkout. */
export async function restoreWorktreeCheckoutUnlocked(
  input: RestoreCheckoutInput,
): Promise<{ source: RestoreCheckoutSource; headCommitSha: string }> {
  const { projectPath, workingBranch } = input
  const worktreePath = path.resolve(input.worktreePath)
  try {
    commonGitDirectory(projectPath)
  } catch {
    throw new WorktreeCheckoutError(
      'project-unavailable',
      'The project Git repository is unavailable. Restore its location first.',
    )
  }
  try {
    if (workingBranch.startsWith('-')) throw new Error('Branch names cannot start with a dash')
    restoreGit(projectPath, ['check-ref-format', `refs/heads/${workingBranch}`])
    if (restorePathExists(worktreePath)) {
      if (!isMatchingWorkspaceWorktree(input)) {
        throw new WorktreeCheckoutError(
          'path-conflict',
          'The destination is occupied by a different checkout or directory. Move it before retrying.',
        )
      }
      return { source: 'existing-worktree', headCommitSha: restoreGit(worktreePath, ['rev-parse', '--verify', 'HEAD']) }
    }

    const registrations = restoreRegistrations(projectPath)
    // Do not globally prune: another missing checkout may still need its registration.
    if (registrations.some((entry) => path.resolve(entry.path) === worktreePath)) {
      throw new WorktreeCheckoutError(
        'path-conflict',
        'Git still registers the missing destination. Repair that worktree registration before retrying.',
      )
    }
    if (registrations.some((entry) => entry.branch === `refs/heads/${workingBranch}`)) {
      throw new WorktreeCheckoutError(
        'branch-in-use',
        'The working branch is already checked out elsewhere. Free that checkout before retrying.',
      )
    }

    let source: RestoreCheckoutSource = 'local-branch'
    const localCommit = resolveRestoreCommit(projectPath, `refs/heads/${workingBranch}`)
    let commit = localCommit
    if (!commit) {
      source = 'saved-commit'
      commit =
        input.headCommitSha && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(input.headCommitSha)
          ? resolveRestoreCommit(projectPath, input.headCommitSha)
          : null
      if (!commit) {
        source = 'remote-branch'
        try {
          await new Promise<void>((resolve, reject) => {
            execFile(
              'git',
              ['-c', 'core.hooksPath=/dev/null', 'fetch', '--no-tags', 'origin', `refs/heads/${workingBranch}`],
              {
                cwd: projectPath,
                timeout: 60_000,
                env: restoreGitEnv(),
              },
              (error) => (error ? reject(error) : resolve()),
            )
          })
          commit = resolveRestoreCommit(projectPath, 'FETCH_HEAD')
        } catch {
          // Avoid exposing remote credentials embedded in Git error output.
        }
        if (!commit) {
          throw new WorktreeCheckoutError(
            'recovery-source-unavailable',
            'No local branch, saved commit or reachable origin branch is available. Check origin access or recover the branch manually.',
          )
        }
      }
    }
    // Recheck after the asynchronous fetch, including empty directories and dangling links.
    if (restorePathExists(worktreePath)) {
      throw new WorktreeCheckoutError(
        'path-conflict',
        'The destination appeared during recovery. Move the conflicting directory before retrying.',
      )
    }
    if (localCommit) restoreGit(projectPath, ['worktree', 'add', '--', worktreePath, workingBranch])
    else restoreGit(projectPath, ['worktree', 'add', '-b', workingBranch, '--', worktreePath, commit])
    if (!isMatchingWorkspaceWorktree(input)) {
      throw new WorktreeCheckoutError(
        'git-failed',
        'The restored checkout could not be verified. Inspect the checkout before retrying.',
      )
    }
    addToExclude(projectPath, worktreePath, path.join(commonGitDirectory(projectPath), 'info', 'exclude'))
    return { source, headCommitSha: restoreGit(worktreePath, ['rev-parse', '--verify', 'HEAD']) }
  } catch (err) {
    if (err instanceof WorktreeCheckoutError) throw err
    throw new WorktreeCheckoutError(
      'git-failed',
      'Git could not restore the worktree. Check the branch name, repository permissions and worktree registrations.',
    )
  }
}
