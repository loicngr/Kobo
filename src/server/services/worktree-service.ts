import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { runBoundedProcess } from '../utils/bounded-process.js'
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

const READ_TIMEOUT_MS = 10_000
const MUTATION_TIMEOUT_MS = 5 * 60_000

async function git(repoPath: string, args: string[], timeoutMs = READ_TIMEOUT_MS): Promise<string> {
  return (
    await runBoundedProcess('git', args, {
      cwd: repoPath,
      timeoutMs,
      stdoutLimit: 64 * 1024 * 1024,
      env: { ...process.env, LC_ALL: 'C', LANG: 'C', GIT_TERMINAL_PROMPT: '0' },
    })
  ).replace(/\n$/, '')
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

async function isDockerAvailable(): Promise<boolean> {
  try {
    await runBoundedProcess('docker', ['version'], { timeoutMs: READ_TIMEOUT_MS })
    return true
  } catch {
    return false
  }
}

async function reclaimWorktreeOwnershipViaDocker(
  worktreePath: string,
  uid: number,
  gid: number,
  image: string,
): Promise<void> {
  const containerName = `kobo-cleanup-${randomUUID()}`
  const args = buildDockerChownArgs(worktreePath, uid, gid, image)
  args.splice(1, 0, '--name', containerName)
  let failure: unknown
  try {
    await runBoundedProcess('docker', args, { timeoutMs: MUTATION_TIMEOUT_MS })
  } catch (err) {
    failure = err
  }
  // Docker containers belong to the daemon, not the CLI's process group.
  // A killed/disconnected `docker run` cannot prove that chown has stopped.
  let stopRequested = false
  let warned = false
  for (;;) {
    try {
      const state = await runBoundedProcess(
        'docker',
        ['ps', '-a', '--filter', `name=^/${containerName}$`, '--format', '{{.ID}} {{.State}}'],
        { timeoutMs: READ_TIMEOUT_MS, stdoutLimit: 8192 },
      )
      const active = state
        .trim()
        .split('\n')
        .filter(Boolean)
        .some((line) => !/ (?:exited|dead|created)$/.test(line))
      if (!active) break
      try {
        await runBoundedProcess(
          'docker',
          stopRequested ? ['kill', containerName] : ['stop', '--time', '5', containerName],
          { timeoutMs: READ_TIMEOUT_MS },
        )
      } finally {
        stopRequested = true
      }
    } catch (err) {
      if (!warned) {
        warned = true
        console.error(
          `[worktree] Cannot yet confirm cleanup container '${containerName}' stopped; retaining ownership:`,
          err,
        )
      }
    }
    await delay(1000)
  }
  if (failure) throw failure
}

function getExcludeFilePath(projectPath: string): string {
  return path.join(projectPath, '.git', 'info', 'exclude')
}

function projectRelativeWorktreePath(projectPath: string, worktreePath: string): string | null {
  const relativePath = path.relative(projectPath, worktreePath)
  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) return null
  return relativePath
}

async function addToExclude(
  projectPath: string,
  worktreePath: string,
  excludeFile = getExcludeFilePath(projectPath),
): Promise<void> {
  const relativePath = projectRelativeWorktreePath(projectPath, worktreePath)
  if (!relativePath) return

  // Ensure the .git/info directory exists
  const infoDir = path.dirname(excludeFile)
  if (!(await restorePathExists(infoDir))) {
    await fs.mkdir(infoDir, { recursive: true })
  }

  const entry = `/${relativePath}`

  let current = ''
  if (await restorePathExists(excludeFile)) {
    current = await fs.readFile(excludeFile, 'utf-8')
  }

  if (!current.split('\n').includes(entry)) {
    const newContent = current.endsWith('\n') || current === '' ? `${current}${entry}\n` : `${current}\n${entry}\n`
    await fs.writeFile(excludeFile, newContent, 'utf-8')
  }
}

async function removeFromExclude(projectPath: string, worktreePath: string): Promise<void> {
  const relativePath = projectRelativeWorktreePath(projectPath, worktreePath)
  if (!relativePath) return

  const excludeFile = getExcludeFilePath(projectPath)
  if (!(await restorePathExists(excludeFile))) return

  const entry = `/${relativePath}`

  const lines = (await fs.readFile(excludeFile, 'utf-8')).split('\n')
  const filtered = lines.filter((line) => line !== entry)
  const trimmed = filtered.join('\n').replace(/\n+$/, '')
  await fs.writeFile(excludeFile, trimmed ? `${trimmed}\n` : '', 'utf-8')
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
): Promise<{ worktreePath: string; base: 'origin' | 'local'; branchCreated: boolean }> {
  return withGitRepoLock(projectPath, () =>
    createWorktreeUnlocked(projectPath, branchName, baseRef, worktreesPath, projectSlug, explicitPath),
  )
}

/** A checkout was created even though a Git hook or subsequent bookkeeping failed. */
export class WorktreeCreationError extends Error {
  constructor(
    readonly worktreePath: string,
    readonly branchCreated: boolean,
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
    this.name = 'WorktreeCreationError'
  }
}

/** Create a worktree while the caller already owns the shared repository lock. */
export async function createWorktreeUnlocked(
  projectPath: string,
  branchName: string,
  baseRef: string,
  worktreesPath?: string | null,
  projectSlug?: string,
  explicitPath?: string | null,
): Promise<{ worktreePath: string; base: 'origin' | 'local'; branchCreated: boolean }> {
  const worktreesDir = resolveWorktreesRoot(projectPath, worktreesPath)
  if (!(await restorePathExists(worktreesDir))) {
    await fs.mkdir(worktreesDir, { recursive: true })
  }

  const worktreePath = explicitPath || resolveWorkspaceWorktreePath(projectPath, branchName, worktreesPath, projectSlug)
  const base: 'origin' | 'local' = baseRef.startsWith('origin/') ? 'origin' : 'local'

  // Capture ownership evidence before Git runs: a failing post-checkout hook
  // can leave a fully registered checkout even though `git worktree add` fails.
  const pathExisted = await restorePathExists(worktreePath)
  const registeredBefore = (await listWorktrees(projectPath)).some(
    (entry) => path.resolve(entry.path) === path.resolve(worktreePath),
  )
  const branchRef = `refs/heads/${branchName}`
  const branchExisted = (await git(projectPath, ['for-each-ref', '--format=%(refname)', branchRef]))
    .split('\n')
    .includes(branchRef)
  let branchCreated = true

  try {
    try {
      await git(projectPath, ['worktree', 'add', '-b', branchName, worktreePath, baseRef], MUTATION_TIMEOUT_MS)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (!isGitBranchExistsError(message)) throw err
      branchCreated = false
      await git(projectPath, ['worktree', 'add', worktreePath, branchName], MUTATION_TIMEOUT_MS)
    }
  } catch (err) {
    if (
      !pathExisted &&
      !registeredBefore &&
      (await isMatchingWorkspaceWorktree({ projectPath, worktreePath, workingBranch: branchName }))
    ) {
      throw new WorktreeCreationError(worktreePath, branchCreated && !branchExisted, err)
    }
    throw new Error(
      `Failed to create worktree for branch '${branchName}': ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    )
  }

  try {
    await addToExclude(projectPath, worktreePath)
  } catch (err) {
    throw new WorktreeCreationError(worktreePath, branchCreated, err)
  }

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
async function assertWorktreeGone(projectPath: string, worktreePath: string): Promise<void> {
  try {
    await git(projectPath, ['worktree', 'prune'])
  } catch (err) {
    console.warn(`[worktree] prune after removing '${worktreePath}' failed:`, err instanceof Error ? err.message : err)
  }
  if (await restorePathExists(worktreePath)) {
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
export async function removeWorktreeUnlocked(projectPath: string, worktreePath: string): Promise<void> {
  try {
    await git(projectPath, ['worktree', 'remove', worktreePath, '--force'], MUTATION_TIMEOUT_MS)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const uid = typeof process.getuid === 'function' ? process.getuid() : null
    const gid = typeof process.getgid === 'function' ? process.getgid() : null

    if (isPermissionError(message) && uid != null && gid != null && (await isDockerAvailable())) {
      const image = process.env.KOBO_WORKTREE_CLEANUP_IMAGE || DEFAULT_CLEANUP_IMAGE
      console.warn(
        `[worktree] '${worktreePath}' has root-owned files (permission denied); reclaiming ownership via Docker (${image})…`,
      )
      try {
        await reclaimWorktreeOwnershipViaDocker(worktreePath, uid, gid, image)
        // The first `git worktree remove` already de-registered this worktree (it
        // drops the admin entry even when the directory rm fails on permission), so
        // retrying it errors with "is not a working tree". Now that we own the files,
        // delete the directory directly and prune any dangling worktree metadata.
        await fs.rm(worktreePath, { recursive: true, force: true })
        await git(projectPath, ['worktree', 'prune'])
        console.log(`[worktree] Docker cleanup succeeded; removed '${worktreePath}'`)
        await removeFromExclude(projectPath, worktreePath)
        await assertWorktreeGone(projectPath, worktreePath)
        return
      } catch (retryErr) {
        const retryMessage = retryErr instanceof Error ? retryErr.message : String(retryErr)
        console.error(`[worktree] Docker cleanup failed for '${worktreePath}': ${retryMessage}`)
        throw new Error(`Failed to remove worktree '${worktreePath}': ${retryMessage}`)
      }
    }

    throw new Error(`Failed to remove worktree '${worktreePath}': ${message}`)
  }

  await removeFromExclude(projectPath, worktreePath)
  await assertWorktreeGone(projectPath, worktreePath)
}

/** List all git worktrees for a repository by parsing `git worktree list --porcelain`. */
export async function listWorktrees(projectPath: string): Promise<WorktreeInfo[]> {
  const output = await git(projectPath, ['worktree', 'list', '--porcelain', '-z'])

  const worktrees: WorktreeInfo[] = []
  const blocks = output.split('\0\0').filter(Boolean)

  for (const block of blocks) {
    const lines = block.split('\0')
    const worktree: Partial<WorktreeInfo> = {}

    for (const line of lines) {
      if (line.startsWith('worktree ')) {
        worktree.path = line.slice('worktree '.length)
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
export async function worktreeExists(projectPath: string, branchName: string): Promise<boolean> {
  try {
    const worktrees = await listWorktrees(projectPath)
    return worktrees.some((wt) => wt.branch === branchName)
  } catch {
    return false
  }
}

async function canonicalize(p: string): Promise<string> {
  try {
    return await fs.realpath(p)
  } catch {
    return p
  }
}

async function detectSourceBranch(projectPath: string, worktreePath: string, branch: string): Promise<string> {
  // 1. Branch's tracked upstream (configured locally)
  try {
    const upstream = await git(worktreePath, ['config', '--get', `branch.${branch}.merge`])
    if (upstream) return upstream.replace(/^refs\/heads\//, '')
  } catch {
    /* no upstream configured */
  }
  // 2. Repo's default branch (origin/HEAD)
  try {
    const head = await git(projectPath, ['symbolic-ref', 'refs/remotes/origin/HEAD'])
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
export async function listOrphanWorktrees(
  projectPath: string,
  attachedPaths: Set<string>,
): Promise<OrphanWorktreeInfo[]> {
  const canonAttached = new Set(await Promise.all(Array.from(attachedPaths).map(canonicalize)))
  const canonProject = await canonicalize(projectPath)

  const orphans: OrphanWorktreeInfo[] = []
  for (const worktree of await listWorktrees(projectPath)) {
    const canonicalPath = await canonicalize(worktree.path)
    if (
      canonicalPath === canonProject ||
      canonAttached.has(canonicalPath) ||
      !worktree.branch ||
      worktree.branch === '(detached HEAD)'
    )
      continue
    orphans.push({
      ...worktree,
      suggestedSourceBranch: await detectSourceBranch(projectPath, worktree.path, worktree.branch),
    })
  }
  return orphans
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

async function restoreGit(cwd: string, args: string[]): Promise<string> {
  return (
    await runBoundedProcess('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
      cwd,
      timeoutMs:
        args[0] === 'fetch' || (args[0] === 'worktree' && args[1] === 'add') ? MUTATION_TIMEOUT_MS : READ_TIMEOUT_MS,
      stdoutLimit: 64 * 1024 * 1024,
      env: restoreGitEnv(),
    })
  ).replace(/\n$/, '')
}

/** NUL delimiters preserve quoted, whitespace and newline-containing worktree paths. */
async function restoreRegistrations(projectPath: string): Promise<{ path: string; branch: string }[]> {
  return (await restoreGit(projectPath, ['worktree', 'list', '--porcelain', '-z']))
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

async function commonGitDirectory(cwd: string): Promise<string> {
  return await fs.realpath(await restoreGit(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']))
}

/** Accept only the exact registered root in the same repository on the expected branch. */
export async function isMatchingWorkspaceWorktree(input: RestoreCheckoutInput): Promise<boolean> {
  try {
    if (!(await fs.lstat(input.worktreePath)).isDirectory()) return false
    const target = await fs.realpath(input.worktreePath)
    if ((await fs.realpath(await restoreGit(input.worktreePath, ['rev-parse', '--show-toplevel']))) !== target)
      return false
    if ((await commonGitDirectory(input.projectPath)) !== (await commonGitDirectory(input.worktreePath))) return false
    const ref = `refs/heads/${input.workingBranch}`
    if ((await restoreGit(input.worktreePath, ['symbolic-ref', 'HEAD'])) !== ref) return false
    for (const entry of await restoreRegistrations(input.projectPath)) {
      if ((await canonicalize(entry.path)) === target && entry.branch === ref) return true
    }
    return false
  } catch {
    return false
  }
}

async function restorePathExists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw err
  }
}

async function resolveRestoreCommit(projectPath: string, ref: string): Promise<string | null> {
  try {
    return await restoreGit(projectPath, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`])
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
    await commonGitDirectory(projectPath)
  } catch {
    throw new WorktreeCheckoutError(
      'project-unavailable',
      'The project Git repository is unavailable. Restore its location first.',
    )
  }
  try {
    if (workingBranch.startsWith('-')) throw new Error('Branch names cannot start with a dash')
    await restoreGit(projectPath, ['check-ref-format', `refs/heads/${workingBranch}`])
    if (await restorePathExists(worktreePath)) {
      if (!(await isMatchingWorkspaceWorktree(input))) {
        throw new WorktreeCheckoutError(
          'path-conflict',
          'The destination is occupied by a different checkout or directory. Move it before retrying.',
        )
      }
      return {
        source: 'existing-worktree',
        headCommitSha: await restoreGit(worktreePath, ['rev-parse', '--verify', 'HEAD']),
      }
    }

    const registrations = await restoreRegistrations(projectPath)
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
    const localCommit = await resolveRestoreCommit(projectPath, `refs/heads/${workingBranch}`)
    let commit = localCommit
    if (!commit) {
      source = 'saved-commit'
      commit =
        input.headCommitSha && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(input.headCommitSha)
          ? await resolveRestoreCommit(projectPath, input.headCommitSha)
          : null
      if (!commit) {
        source = 'remote-branch'
        try {
          await restoreGit(projectPath, ['fetch', '--no-tags', 'origin', `refs/heads/${workingBranch}`])
          commit = await resolveRestoreCommit(projectPath, 'FETCH_HEAD')
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
    if (await restorePathExists(worktreePath)) {
      throw new WorktreeCheckoutError(
        'path-conflict',
        'The destination appeared during recovery. Move the conflicting directory before retrying.',
      )
    }
    if (localCommit) await restoreGit(projectPath, ['worktree', 'add', '--', worktreePath, workingBranch])
    else await restoreGit(projectPath, ['worktree', 'add', '-b', workingBranch, '--', worktreePath, commit])
    if (!(await isMatchingWorkspaceWorktree(input))) {
      throw new WorktreeCheckoutError(
        'git-failed',
        'The restored checkout could not be verified. Inspect the checkout before retrying.',
      )
    }
    await addToExclude(projectPath, worktreePath, path.join(await commonGitDirectory(projectPath), 'info', 'exclude'))
    return { source, headCommitSha: await restoreGit(worktreePath, ['rev-parse', '--verify', 'HEAD']) }
  } catch (err) {
    if (err instanceof WorktreeCheckoutError) throw err
    throw new WorktreeCheckoutError(
      'git-failed',
      'Git could not restore the worktree. Check the branch name, repository permissions and worktree registrations.',
    )
  }
}
