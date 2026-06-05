import { execFile as execFileCb, execFileSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFileCb)

function git(repoPath: string, args: string[]): string {
  // `trimEnd` (not `trim`): some git outputs are column-aligned and the LEADING
  // space carries information. The classic case is `git status --porcelain`,
  // where each line is `XY filename` and X is " " when the index has no
  // change. Stripping that leading space silently shifts every column by one
  // and makes `line.substring(3)` chop the first character of the filename
  // (e.g. `front/foo` → `ront/foo`). Trailing whitespace (the final `\n` git
  // always appends) still goes — that's what every caller expects.
  return execFileSync('git', args, { cwd: repoPath, encoding: 'utf-8' }).trimEnd()
}

/** Return the name of the currently checked-out branch. */
export function getCurrentBranch(repoPath: string): string {
  return git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD'])
}

/** List all local branch names in the repository. */
export function listBranches(repoPath: string): string[] {
  const output = git(repoPath, ['branch', '--format=%(refname:short)'])
  return output
    .split('\n')
    .map((b) => b.trim())
    .filter(Boolean)
}

/** Thrown when attempting to create a branch that already exists. */
export class BranchAlreadyExistsError extends Error {
  constructor(branchName: string) {
    super(`Branch '${branchName}' already exists`)
    this.name = 'BranchAlreadyExistsError'
  }
}

/** Detect "branch already exists" git error messages across locales (EN, FR, RU). */
export function isGitBranchExistsError(message: string): boolean {
  const lower = message.toLowerCase()
  return lower.includes('already exists') || lower.includes('existe') || lower.includes('существует')
}

/** Create a new local branch from the given source branch. */
export function createBranch(repoPath: string, branchName: string, sourceBranch: string): void {
  try {
    git(repoPath, ['branch', branchName, sourceBranch])
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (isGitBranchExistsError(message)) {
      throw new BranchAlreadyExistsError(branchName)
    }
    throw new Error(`Failed to create branch '${branchName}' from '${sourceBranch}': ${message}`)
  }
}

/** Return shortstat diff stats for staged (cached) changes. */
export function getDiffStats(repoPath: string): {
  filesChanged: number
  insertions: number
  deletions: number
} {
  try {
    const output = git(repoPath, ['diff', '--cached', '--shortstat'])
    return parseDiffShortstat(output)
  } catch {
    return { filesChanged: 0, insertions: 0, deletions: 0 }
  }
}

function parseDiffShortstat(output: string): {
  filesChanged: number
  insertions: number
  deletions: number
} {
  if (!output.trim()) {
    return { filesChanged: 0, insertions: 0, deletions: 0 }
  }

  const filesMatch = output.match(/(\d+) file/)
  const insertMatch = output.match(/(\d+) insertion/)
  const deleteMatch = output.match(/(\d+) deletion/)

  return {
    filesChanged: filesMatch ? parseInt(filesMatch[1], 10) : 0,
    insertions: insertMatch ? parseInt(insertMatch[1], 10) : 0,
    deletions: deleteMatch ? parseInt(deleteMatch[1], 10) : 0,
  }
}

/** List remote-tracking branch names. Returns empty array on failure. */
export function listRemoteBranches(repoPath: string): string[] {
  try {
    const output = git(repoPath, ['branch', '-r', '--format=%(refname:short)'])
    return output
      .split('\n')
      .map((b) => b.trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

/** Force-delete a local branch (`git branch -D`). */
export function deleteLocalBranch(repoPath: string, branchName: string): void {
  try {
    git(repoPath, ['branch', '-D', branchName])
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`Failed to delete local branch '${branchName}': ${message}`)
  }
}

/** Delete a branch on the remote (`git push --delete`). */
export function deleteRemoteBranch(repoPath: string, branchName: string, remote = 'origin'): void {
  try {
    git(repoPath, ['push', remote, '--delete', branchName])
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`Failed to delete remote branch '${remote}/${branchName}': ${message}`)
  }
}

/**
 * Push a branch to the remote with upstream tracking (`git push -u`).
 * When `options.force` is true, adds `--force-with-lease` (safer than `--force`:
 * the push is rejected if the remote has commits the local copy hasn't seen).
 */
export function pushBranch(
  repoPath: string,
  branchName: string,
  options: { remote?: string; force?: boolean } = {},
): void {
  const remote = options.remote ?? 'origin'
  const args = ['push', '-u']
  if (options.force) args.push('--force-with-lease')
  args.push(remote, branchName)
  try {
    git(repoPath, args)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`Failed to push branch '${branchName}' to '${remote}': ${message}`)
  }
}

/**
 * Fetch a single branch from the remote. Throws if the fetch fails (no remote,
 * branch absent on remote, network error, etc.). Call this before creating a
 * worktree to ensure `origin/<sourceBranch>` is up to date.
 */
export function fetchSourceBranch(repoPath: string, sourceBranch: string, remote = 'origin'): void {
  try {
    git(repoPath, ['fetch', remote, sourceBranch])
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`Failed to fetch '${sourceBranch}' from '${remote}': ${message}`)
  }
}

/**
 * Fetch every branch from the remote (`git fetch <remote>` with no refspec).
 * Throws if the fetch fails. Call this before computing branch divergence so
 * all `origin/*` refs are current.
 */
export function fetchAllBranches(repoPath: string, remote = 'origin'): void {
  try {
    git(repoPath, ['fetch', remote])
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`Failed to fetch from '${remote}': ${message}`)
  }
}

/** Pull the current branch from the remote using fast-forward only.
 *  With `opts.autostash`, dirty changes are stashed/re-applied automatically.
 *  Without it, a dirty tree (staged or modified tracked files) is refused up-front
 *  with a `DirtyWorktreeError` — same recovery path rebase/merge offer — instead of
 *  letting git fail with a localized message. Detected locale-independently. */
export function pullBranch(
  repoPath: string,
  branchName: string,
  remote = 'origin',
  opts?: { autostash?: boolean },
): void {
  if (!opts?.autostash) {
    const status = getWorkingTreeStatus(repoPath)
    if (status.staged > 0 || status.modified > 0) {
      throw new DirtyWorktreeError('pull', status)
    }
  }
  try {
    const args = ['pull', '--ff-only']
    if (opts?.autostash) args.push('--autostash')
    args.push(remote, branchName)
    git(repoPath, args)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`Failed to pull branch '${branchName}' from '${remote}': ${message}`)
  }
}

/** Thrown when a rebase, merge or cherry-pick produces conflicts. Leaves the repo in the
 *  mid-operation state so the caller can decide between abort and agent-assisted resolution. */
export class GitConflictError extends Error {
  readonly operation: 'rebase' | 'merge' | 'cherry-pick'
  readonly files: string[]
  constructor(operation: 'rebase' | 'merge' | 'cherry-pick', files: string[]) {
    super(`${operation} produced ${files.length} conflicted file(s)`)
    this.name = 'GitConflictError'
    this.operation = operation
    this.files = files
  }
}

/** Thrown when a rebase or merge is refused because the working tree has
 *  uncommitted changes (staged or modified tracked files). Detected
 *  locale-independently from the working-tree status, never from git's
 *  localized error text. */
export class DirtyWorktreeError extends Error {
  readonly operation: 'rebase' | 'merge' | 'pull'
  readonly status: WorkingTreeStatus
  constructor(operation: 'rebase' | 'merge' | 'pull', status: WorkingTreeStatus) {
    super(`${operation} blocked by uncommitted changes`)
    this.name = 'DirtyWorktreeError'
    this.operation = operation
    this.status = status
  }
}

/** List files currently in a conflicted state (unmerged paths). */
export function getConflictedFiles(repoPath: string): string[] {
  try {
    const output = git(repoPath, ['diff', '--name-only', '--diff-filter=U'])
    return output
      .split('\n')
      .map((f) => f.trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

/** Detect whether a merge, rebase or cherry-pick is currently in progress in the worktree. */
export function getOngoingGitOperation(repoPath: string): 'merge' | 'rebase' | 'cherry-pick' | null {
  try {
    const gitDir = git(repoPath, ['rev-parse', '--git-dir'])
    const dir = gitDir.startsWith('/') ? gitDir : join(repoPath, gitDir)
    if (existsSync(join(dir, 'MERGE_HEAD'))) return 'merge'
    if (existsSync(join(dir, 'rebase-merge')) || existsSync(join(dir, 'rebase-apply'))) return 'rebase'
    if (existsSync(join(dir, 'CHERRY_PICK_HEAD')) || existsSync(join(dir, 'sequencer'))) return 'cherry-pick'
    return null
  } catch {
    return null
  }
}

/** Rebase the current branch onto the given base branch. Fetches origin first.
 *  With `opts.autostash`, dirty changes are stashed/re-applied automatically.
 *  Leaves conflicts in place. */
export function rebaseBranch(repoPath: string, baseBranch: string, opts?: { autostash?: boolean }): void {
  try {
    git(repoPath, ['fetch', 'origin', baseBranch])
  } catch {
    // fetch may fail if offline — continue with local ref
  }
  try {
    const args = ['rebase']
    if (opts?.autostash) args.push('--autostash')
    args.push(`origin/${baseBranch}`)
    git(repoPath, args)
  } catch (err) {
    const conflicted = getConflictedFiles(repoPath)
    if (conflicted.length > 0 || getOngoingGitOperation(repoPath) === 'rebase') {
      // Leave the rebase in progress so the caller can abort or request agent-assisted resolution.
      throw new GitConflictError('rebase', conflicted)
    }
    const status = getWorkingTreeStatus(repoPath)
    if (status.staged > 0 || status.modified > 0) {
      // git refused before touching anything because the tree is dirty.
      throw new DirtyWorktreeError('rebase', status)
    }
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`Rebase onto '${baseBranch}' failed: ${message}`)
  }
}

/** Merge `origin/<baseBranch>` into the current branch. Fetches first.
 *  With `opts.autostash`, dirty changes are stashed/re-applied automatically.
 *  Leaves conflicts in place. */
export function mergeBranch(repoPath: string, baseBranch: string, opts?: { autostash?: boolean }): void {
  try {
    git(repoPath, ['fetch', 'origin', baseBranch])
  } catch {
    // offline — continue with local ref
  }
  try {
    const args = ['merge', '--no-ff', '--no-edit']
    if (opts?.autostash) args.push('--autostash')
    args.push(`origin/${baseBranch}`)
    git(repoPath, args)
  } catch (err) {
    const conflicted = getConflictedFiles(repoPath)
    if (conflicted.length > 0 || getOngoingGitOperation(repoPath) === 'merge') {
      throw new GitConflictError('merge', conflicted)
    }
    const status = getWorkingTreeStatus(repoPath)
    if (status.staged > 0 || status.modified > 0) {
      throw new DirtyWorktreeError('merge', status)
    }
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`Merge of 'origin/${baseBranch}' failed: ${message}`)
  }
}

/** Abort an in-progress merge, rebase or cherry-pick. No-op if nothing is in progress. */
export function abortOngoingGitOperation(repoPath: string): 'merge' | 'rebase' | 'cherry-pick' | null {
  const op = getOngoingGitOperation(repoPath)
  if (op === 'merge') {
    git(repoPath, ['merge', '--abort'])
  } else if (op === 'rebase') {
    git(repoPath, ['rebase', '--abort'])
  } else if (op === 'cherry-pick') {
    git(repoPath, ['cherry-pick', '--abort'])
  }
  return op
}

/** Try a git command with `base`, falling back to `origin/base` if the local ref is missing. */
function resolveBase(repoPath: string, base: string): string {
  // Prefer `origin/<base>` when it exists: local <base> can lag behind origin
  // (e.g. a squash-merge happened upstream that the user hasn't pulled), and
  // worktrees are created off `origin/<sourceBranch>` anyway — so comparing
  // against stale local <base> would surface upstream commits as "on this
  // branch". Fall back to local only when the remote ref isn't reachable
  // (offline, no remote configured, etc.).
  try {
    git(repoPath, ['rev-parse', '--verify', `origin/${base}`])
    return `origin/${base}`
  } catch {
    try {
      git(repoPath, ['rev-parse', '--verify', base])
      return base
    } catch {
      return base
    }
  }
}

/** Count commits between base and head (`git rev-list --count`). Returns 0 on failure. */
export function getCommitCount(repoPath: string, base: string, head: string): number {
  try {
    const ref = resolveBase(repoPath, base)
    const output = git(repoPath, ['rev-list', '--count', `${ref}..${head}`])
    return parseInt(output, 10) || 0
  } catch {
    return 0
  }
}

/**
 * Count commits in `base` that are not in `head` — i.e. how far `head` lags
 * behind `base`. Mirrors `getCommitCount` but in reverse direction.
 * Returns 0 on failure.
 */
export function getCommitsBehind(repoPath: string, base: string, head: string): number {
  try {
    const ref = resolveBase(repoPath, base)
    const output = git(repoPath, ['rev-list', '--count', `${head}..${ref}`])
    const n = parseInt(output.trim(), 10)
    return Number.isFinite(n) ? n : 0
  } catch {
    return 0
  }
}

/**
 * List the commits that belong to `workingBranch` itself — reachable from it
 * but present in neither `newBase` nor `oldBase`. This is the set to replay
 * onto the new base. Returned oldest-first (ready for sequential cherry-pick).
 *
 * Both `origin/<base>` and the bare `<base>` are excluded when they exist, so
 * the result is correct whether the caller fetched the base or not.
 */
export function listProperCommits(repoPath: string, workingBranch: string, newBase: string, oldBase: string): string[] {
  const excludes: string[] = []
  for (const base of [newBase, oldBase]) {
    for (const ref of [`origin/${base}`, base]) {
      try {
        git(repoPath, ['rev-parse', '--verify', '--quiet', ref])
        excludes.push(`^${ref}`)
      } catch {
        // ref absent — skip
      }
    }
  }
  const output = git(repoPath, ['log', '--reverse', '--format=%H', workingBranch, ...excludes])
  return output
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * Rebuild `workingBranch` on top of the new base by cherry-picking the given
 * commits (oldest-first). Creates a backup branch at the current tip first and
 * returns its name. On a cherry-pick conflict, leaves the operation in progress
 * and throws `GitConflictError`.
 *
 * The base is resolved as `origin/<newBase>` when that ref exists, else the
 * bare `<newBase>` (so it works both with a fetched remote and a local-only
 * base). The caller must ensure the worktree is clean for the conflict path.
 * An empty `commits` array performs the reset only — the "already aligned"
 * fast path.
 *
 * IMPORTANT: this function resets the branch CURRENTLY checked out in
 * `repoPath`. The caller (and the Kōbō worktree orchestrator) must ensure
 * `workingBranch` is the active branch — do NOT add a `git checkout` here.
 */
export function reconstructBranchOnto(
  repoPath: string,
  workingBranch: string,
  newBase: string,
  commits: readonly string[],
): string {
  const baseRef = resolveBase(repoPath, newBase)
  const backupBranch = `kobo-backup/${workingBranch}-${Date.now()}`
  git(repoPath, ['branch', backupBranch, workingBranch])
  git(repoPath, ['reset', '--hard', baseRef])
  if (commits.length > 0) {
    try {
      git(repoPath, ['cherry-pick', ...commits])
    } catch (err) {
      const conflicted = getConflictedFiles(repoPath)
      if (conflicted.length > 0 || getOngoingGitOperation(repoPath) === 'cherry-pick') {
        throw new GitConflictError('cherry-pick', conflicted)
      }
      const message = err instanceof Error ? err.message : String(err)
      throw new Error(`Cherry-pick onto '${newBase}' failed: ${message}`)
    }
  }
  return backupBranch
}

/** List `kobo-backup/<workingBranch>-<ts>` branches, newest timestamp first. */
export function listBackupBranches(repoPath: string, workingBranch: string): string[] {
  try {
    const prefix = `kobo-backup/${workingBranch}-`
    const out = git(repoPath, ['branch', '--list', `${prefix}*`, '--format=%(refname:short)'])
    return out
      .split('\n')
      .map((s) => s.trim())
      .filter((b) => b.startsWith(prefix) && /^\d+$/.test(b.slice(prefix.length)))
      .sort((a, b) => Number(b.slice(prefix.length)) - Number(a.slice(prefix.length)))
  } catch {
    return []
  }
}

/** Abort any in-progress operation, then hard-reset `workingBranch` to a backup branch. */
export function restoreBranchFromBackup(repoPath: string, workingBranch: string, backupBranch: string): void {
  abortOngoingGitOperation(repoPath)
  git(repoPath, ['checkout', '-q', workingBranch])
  git(repoPath, ['reset', '--hard', backupBranch])
}

/** Return structured diff shortstat between two refs (three-dot merge base). */
export function getStructuredDiffStatsBetween(
  repoPath: string,
  base: string,
  head: string,
): { filesChanged: number; insertions: number; deletions: number } {
  try {
    const ref = resolveBase(repoPath, base)
    const output = git(repoPath, ['diff', '--shortstat', `${ref}...${head}`])
    return parseDiffShortstat(output)
  } catch {
    return { filesChanged: 0, insertions: 0, deletions: 0 }
  }
}

/** Return a formatted list of commit subjects between base and head. */
export function getCommitsBetween(repoPath: string, base: string, head: string): string {
  try {
    const ref = resolveBase(repoPath, base)
    return git(repoPath, ['log', `${ref}..${head}`, '--pretty=format:- %s (%h)', '--no-merges'])
  } catch {
    return ''
  }
}

/** A single commit on the working branch, with its push state. */
export interface BranchCommit {
  sha: string
  shortSha: string
  subject: string
  author: string
  date: string
  isPushed: boolean
}

/**
 * A bare commit row — same shape as `BranchCommit` minus the `isPushed`
 * flag. Declared as a sibling type (not a parent of `BranchCommit`) to keep
 * the blast radius small: existing callers of `BranchCommit` are unaffected.
 */
export interface Commit {
  sha: string
  shortSha: string
  subject: string
  author: string
  date: string
}

/**
 * List commits between the source branch and HEAD, each flagged with whether
 * it's already present on `origin/<workingBranch>`. Used by the Git panel
 * to surface "commits waiting to be pushed" vs "commits already pushed".
 * Up to `limit` commits (most recent first).
 */
export function listBranchCommits(
  repoPath: string,
  sourceBranch: string,
  workingBranch: string,
  limit = 50,
  remote = 'origin',
): BranchCommit[] {
  const sourceRef = resolveBase(repoPath, sourceBranch)
  const remoteRef = `${remote}/${workingBranch}`

  // NUL-delimited format: sha \0 shortSha \0 subject \0 author \0 iso date \n
  const FORMAT = '--pretty=format:%H%x00%h%x00%s%x00%an%x00%aI'

  let raw: string
  try {
    raw = git(repoPath, ['log', `${sourceRef}..HEAD`, `--max-count=${limit}`, FORMAT])
  } catch {
    return []
  }
  if (!raw) return []

  // Figure out which commits are already on the remote — bail out quietly if
  // the remote ref doesn't exist (branch never pushed → every commit is unpushed).
  const pushedShas = new Set<string>()
  try {
    git(repoPath, ['rev-parse', '--verify', remoteRef])
    const pushedRaw = git(repoPath, ['log', `${sourceRef}..${remoteRef}`, '--pretty=format:%H'])
    for (const line of pushedRaw.split('\n')) {
      if (line) pushedShas.add(line.trim())
    }
  } catch {
    // remote ref unknown → leave pushedShas empty
  }

  const commits: BranchCommit[] = []
  for (const line of raw.split('\n')) {
    if (!line) continue
    const [sha, shortSha, subject, author, date] = line.split('\x00')
    if (!sha) continue
    commits.push({
      sha,
      shortSha: shortSha ?? '',
      subject: subject ?? '',
      author: author ?? '',
      date: date ?? '',
      isPushed: pushedShas.has(sha),
    })
  }
  return commits
}

/**
 * List commits on `sourceBranch` that are NOT yet on `workingBranch` —
 * i.e. commits the working branch is "behind" by. Mirror of `listBranchCommits`
 * in the opposite direction. Up to `limit` commits, most recent first.
 */
export function listCommitsBehind(repoPath: string, sourceBranch: string, workingBranch: string, limit = 50): Commit[] {
  const sourceRef = resolveBase(repoPath, sourceBranch)
  const FORMAT = '--pretty=format:%H%x00%h%x00%s%x00%an%x00%aI'

  let raw: string
  try {
    raw = git(repoPath, ['log', `${workingBranch}..${sourceRef}`, `--max-count=${limit}`, FORMAT])
  } catch {
    return []
  }
  if (!raw) return []

  const commits: Commit[] = []
  for (const line of raw.split('\n')) {
    if (!line) continue
    const [sha, shortSha, subject, author, date] = line.split('\x00')
    if (!sha) continue
    commits.push({
      sha,
      shortSha: shortSha ?? '',
      subject: subject ?? '',
      author: author ?? '',
      date: date ?? '',
    })
  }
  return commits
}

/**
 * Rename a branch in-place (`git branch -m <old> <new>`). Must be run inside
 * the worktree (or any directory tracking the repo) — the new name replaces
 * the old one locally. The remote still has the old name; the caller is
 * responsible for pushing the renamed branch if needed.
 */
export function renameBranch(repoPath: string, oldName: string, newName: string): void {
  git(repoPath, ['branch', '-m', oldName, newName])
}

/**
 * Check whether a branch name is already in use — either as a local branch
 * or a remote tracking branch on the given remote. Used before renaming a
 * branch to fail early with a clear error instead of letting git throw a
 * generic "already exists" message.
 */
export function branchExists(repoPath: string, name: string, remote = 'origin'): boolean {
  try {
    git(repoPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`])
    return true
  } catch {
    // not a local branch
  }
  try {
    git(repoPath, ['rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/${name}`])
    return true
  } catch {
    // not a remote branch either
  }
  return false
}

/**
 * Move a worktree directory on disk via `git worktree move`. Both the
 * filesystem layout and the `worktrees` metadata file are updated atomically.
 * Throws if the destination exists, the worktree is dirty, or the source
 * is the main working tree.
 */
export function moveWorktree(projectPath: string, oldPath: string, newPath: string): void {
  git(projectPath, ['worktree', 'move', oldPath, newPath])
}

/** A file entry in a diff with its path and change status. */
export interface DiffFile {
  path: string
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked'
}

/** List files changed between base and HEAD (committed), plus working tree changes. */
/**
 * List the worktree's files — tracked plus untracked-but-not-git-ignored.
 * Excludes `.git`, `node_modules`, and anything covered by `.gitignore`.
 * Capped at `limit` entries to stay responsive on large monorepos.
 * Returns [] on error (e.g. not a git repo).
 */
export function listWorktreeFiles(worktreePath: string, limit = 5000): string[] {
  try {
    const out = git(worktreePath, ['ls-files', '--cached', '--others', '--exclude-standard'])
    if (!out) return []
    const files = out.split('\n').filter((line) => line.length > 0)
    return files.length > limit ? files.slice(0, limit) : files
  } catch {
    return []
  }
}

/**
 * True when the worktree has any uncommitted change — modified, added, deleted
 * or untracked files. Returns false on error (e.g. not a git repo).
 */
export function worktreeHasChanges(worktreePath: string): boolean {
  try {
    return git(worktreePath, ['status', '--porcelain']).length > 0
  } catch {
    return false
  }
}

export function getChangedFiles(repoPath: string, base: string, includeUntracked = false): DiffFile[] {
  const ref = resolveBase(repoPath, base)
  const files: DiffFile[] = []
  const seen = new Set<string>()

  // Committed changes (base..HEAD)
  try {
    const output = git(repoPath, ['diff', '--name-status', `${ref}...HEAD`])
    for (const line of output.split('\n')) {
      if (!line) continue
      const [statusCode, ...pathParts] = line.split('\t')
      if (!statusCode || pathParts.length === 0) continue
      // For renames/copies (R100 old new), use the new path (last element)
      const filePath =
        (statusCode.startsWith('R') || statusCode.startsWith('C')
          ? pathParts[pathParts.length - 1]
          : pathParts[0]
        )?.replace(/\/$/, '') ?? ''
      if (!filePath) continue
      let status: DiffFile['status'] = 'modified'
      if (statusCode.startsWith('A')) status = 'added'
      else if (statusCode.startsWith('D')) status = 'deleted'
      else if (statusCode.startsWith('R')) status = 'renamed'
      files.push({ path: filePath, status })
      seen.add(filePath)
    }
  } catch {
    // No commits yet
  }

  // Working tree changes (uncommitted). Default to `-uno` to skip pure
  // untracked files: they have never been `git add`-ed and won't ship in
  // the next commit/PR, so showing them in the diff viewer is misleading.
  // When `includeUntracked` is true (user opt-in via the diff viewer toggle)
  // we use `-uall` and surface them with status='added'.
  try {
    const flag = includeUntracked ? '-uall' : '-uno'
    const output = git(repoPath, ['status', '--porcelain', flag])
    for (const line of output.split('\n')) {
      if (!line) continue
      const filePath = line.substring(3).replace(/\/$/, '')
      if (!filePath || seen.has(filePath)) continue
      const x = line[0]
      const y = line[1]
      let status: DiffFile['status'] = 'modified'
      if (x === '?' && y === '?') status = 'untracked'
      else if (x === 'A' || y === 'A') status = 'added'
      else if (x === 'D' || y === 'D') status = 'deleted'
      files.push({ path: filePath, status })
    }
  } catch {
    // Ignore
  }

  return files
}

/**
 * List committed files between `origin/<branch>` and local HEAD — the set
 * of files the next `git push` would send. Working tree changes are NOT
 * included: uncommitted edits aren't about to be pushed. Returns an empty
 * list if there is no remote tracking branch yet.
 */
export function getUnpushedChangedFiles(repoPath: string, branchName: string, remote = 'origin'): DiffFile[] {
  const remoteRef = `${remote}/${branchName}`
  // Bail out cleanly if the remote branch doesn't exist (branch never pushed).
  try {
    git(repoPath, ['rev-parse', '--verify', remoteRef])
  } catch {
    return []
  }

  const files: DiffFile[] = []
  try {
    const output = git(repoPath, ['diff', '--name-status', `${remoteRef}..HEAD`])
    for (const line of output.split('\n')) {
      if (!line) continue
      const [statusCode, ...pathParts] = line.split('\t')
      if (!statusCode || pathParts.length === 0) continue
      const filePath =
        (statusCode.startsWith('R') || statusCode.startsWith('C')
          ? pathParts[pathParts.length - 1]
          : pathParts[0]
        )?.replace(/\/$/, '') ?? ''
      if (!filePath) continue
      let status: DiffFile['status'] = 'modified'
      if (statusCode.startsWith('A')) status = 'added'
      else if (statusCode.startsWith('D')) status = 'deleted'
      else if (statusCode.startsWith('R')) status = 'renamed'
      files.push({ path: filePath, status })
    }
  } catch {
    // Unlikely after the rev-parse check, but keep the happy path robust.
  }

  return files
}

/** Get the original content of a file at a given ref. Returns null if the file didn't exist. */
export function getFileAtRef(repoPath: string, ref: string, filePath: string): string | null {
  const resolvedRef = resolveBase(repoPath, ref)
  try {
    // Bypass the `git()` helper here: it `.trimEnd()`s the output, which would
    // strip trailing newlines from the original file content and produce a
    // false diff against `getFileContent`'s untrimmed `readFileSync` output
    // (last line marked added/removed even when identical).
    return execFileSync('git', ['show', `${resolvedRef}:${filePath}`], {
      cwd: repoPath,
      encoding: 'utf-8',
    })
  } catch {
    return null
  }
}

/** Git's canonical empty-tree object. Used as the diff base for a root commit
 *  (no parent), so it renders as all-added rather than erroring. */
export const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

/** True if `ref` resolves to a commit in the repo (SHA, `<sha>^`, `origin/<branch>`…). */
export function commitExists(repoPath: string, ref: string): boolean {
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
      cwd: repoPath,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return true
  } catch {
    return false
  }
}

/**
 * List files changed between two commits, two-dot `fromRef..toRef` (the patch
 * that turns `fromRef` into `toRef`). Committed history only — no working-tree
 * or untracked entries (this is a historical diff). Same `DiffFile` shape as
 * `getChangedFiles`. Refs are used verbatim (caller resolves/validates them).
 */
export function getChangedFilesBetween(repoPath: string, fromRef: string, toRef: string): DiffFile[] {
  const files: DiffFile[] = []
  try {
    const output = git(repoPath, ['diff', '--name-status', `${fromRef}..${toRef}`])
    for (const line of output.split('\n')) {
      if (!line) continue
      const [statusCode, ...pathParts] = line.split('\t')
      if (!statusCode || pathParts.length === 0) continue
      const filePath =
        (statusCode.startsWith('R') || statusCode.startsWith('C')
          ? pathParts[pathParts.length - 1]
          : pathParts[0]
        )?.replace(/\/$/, '') ?? ''
      if (!filePath) continue
      let status: DiffFile['status'] = 'modified'
      if (statusCode.startsWith('A')) status = 'added'
      else if (statusCode.startsWith('D')) status = 'deleted'
      else if (statusCode.startsWith('R')) status = 'renamed'
      files.push({ path: filePath, status })
    }
  } catch {
    // invalid refs / no diff → empty list
  }
  return files
}

/** Which baseline a `rollbackFile` operation reset the file to. */
export type RollbackTarget = 'remote' | 'head' | 'deleted'

/**
 * Reset a single file in the worktree to a sensible baseline. Cascade:
 *  1. `origin/<branchName>` if the remote ref AND the file exist there
 *     (typical: branch is pushed, user wants to undo all local changes).
 *  2. `HEAD` if the file exists at the last local commit (typical: branch
 *     not yet pushed, or file was added in commits that aren't on remote
 *     yet — discards just the uncommitted edits, keeps the commits).
 *  3. **Delete** the file from disk when it's untracked (not on remote AND
 *     not in HEAD): there's nothing to "rollback to", so the only sensible
 *     undo is to remove the local-only file. Caller MUST surface this to
 *     the user with an explicit confirmation message — the action is
 *     permanent.
 *
 * Throws on filesystem errors (permission denied, etc.). Returns the
 * target that was actually used so the caller can surface the right
 * feedback in the UI.
 */
export function rollbackFile(
  repoPath: string,
  branchName: string,
  filePath: string,
  remote = 'origin',
): RollbackTarget {
  const remoteRef = `${remote}/${branchName}`
  let remoteRefExists = false
  try {
    git(repoPath, ['rev-parse', '--verify', remoteRef])
    remoteRefExists = true
  } catch {
    // Branch never pushed — fall through to HEAD.
  }
  if (remoteRefExists) {
    try {
      git(repoPath, ['cat-file', '-e', `${remoteRef}:${filePath}`])
      git(repoPath, ['checkout', remoteRef, '--', filePath])
      return 'remote'
    } catch {
      // File doesn't exist at origin/<branch> (added locally) — fall through.
    }
  }
  try {
    git(repoPath, ['cat-file', '-e', `HEAD:${filePath}`])
    git(repoPath, ['checkout', 'HEAD', '--', filePath])
    return 'head'
  } catch {
    // File is untracked OR has already been rolled back — delete it from
    // disk if still present. Idempotent: if the file is already gone (race
    // with a previous rollback, stale UI list, manual rm), we still return
    // 'deleted' since the end state matches the user's intent. `rmSync`
    // over `git clean -f` keeps the action narrow to one file.
    const absPath = join(repoPath, filePath)
    if (existsSync(absPath)) {
      rmSync(absPath, { force: true })
    }
    return 'deleted'
  }
}

/** @deprecated kept for backwards-compat with older imports — use `rollbackFile`. */
export const rollbackFileToRemote = rollbackFile

/** Get the current content of a file in the worktree. Returns null if the file doesn't exist. */
export function getFileContent(repoPath: string, filePath: string): string | null {
  try {
    return readFileSync(join(repoPath, filePath), 'utf-8')
  } catch {
    return null
  }
}

/** Write content to an absolute path inside a worktree. Caller validates the path. */
export function writeFileInWorktree(absPath: string, content: string): void {
  writeFileSync(absPath, content, 'utf-8')
}

/** Summary counts of staged, modified, and untracked files in a working tree. */
export interface WorkingTreeStatus {
  staged: number
  modified: number
  untracked: number
}

/** Parse `git status --porcelain` into counts of staged, modified, and untracked files. */
export function getWorkingTreeStatus(repoPath: string): WorkingTreeStatus {
  try {
    const output = git(repoPath, ['status', '--porcelain'])
    let staged = 0
    let modified = 0
    let untracked = 0
    for (const line of output.split('\n')) {
      if (!line) continue
      const x = line[0] // index status
      const y = line[1] // worktree status
      if (x === '?' && y === '?') {
        untracked++
      } else {
        if (x !== ' ' && x !== '?') staged++
        if (y !== ' ' && y !== '?') modified++
      }
    }
    return { staged, modified, untracked }
  } catch {
    return { staged: 0, modified: 0, untracked: 0 }
  }
}

/** A single uncommitted working-tree entry. `staged`/`modified` can both be true (porcelain `MM`). */
export interface WorkingTreeFile {
  path: string
  staged: boolean
  modified: boolean
  untracked: boolean
}

/**
 * List uncommitted working-tree files with their status, parsed from
 * `git status --porcelain`. Same classification rule as getWorkingTreeStatus.
 * For renames (porcelain `old -> new`) the NEW path is kept. Best-effort: [] on error.
 */
export function getWorkingTreeFiles(repoPath: string): WorkingTreeFile[] {
  try {
    const output = git(repoPath, ['status', '--porcelain'])
    const files: WorkingTreeFile[] = []
    for (const line of output.split('\n')) {
      if (!line) continue
      const x = line[0]
      const y = line[1]
      let filePath = line.slice(3)
      const arrowIdx = filePath.indexOf(' -> ')
      if (arrowIdx !== -1) filePath = filePath.slice(arrowIdx + 4)
      const untracked = x === '?' && y === '?'
      files.push({
        path: filePath,
        staged: !untracked && x !== ' ' && x !== '?',
        modified: !untracked && y !== ' ' && y !== '?',
        untracked,
      })
    }
    return files
  } catch {
    return []
  }
}

/**
 * Count commits ahead of `origin/<workingBranch>`. Returns `-1` when the remote
 * ref does not exist (i.e. the branch has never been pushed).
 *
 * We deliberately use `origin/<workingBranch>` instead of the local `@{u}`
 * upstream pointer: Kōbō creates worktrees with `git worktree add -b <new>
 * <path> origin/<sourceBranch>`, so `@{u}` points at `origin/<sourceBranch>`,
 * NOT at the working branch's remote sibling. Comparing HEAD with that wrong
 * upstream silently reported "0 unpushed" for never-pushed branches that
 * happened to be aligned with their source — surfacing as a false "Pushé"
 * label in the GitPanel.
 */
export function getUnpushedCount(repoPath: string, workingBranch: string): number {
  const remoteRef = `origin/${workingBranch}`
  try {
    execFileSync('git', ['rev-parse', '--verify', remoteRef], {
      cwd: repoPath,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  } catch {
    return -1 // branch never pushed (no remote ref)
  }
  try {
    const output = execFileSync('git', ['rev-list', `${remoteRef}..HEAD`, '--count'], {
      cwd: repoPath,
      encoding: 'utf-8',
    }).trim()
    return parseInt(output, 10) || 0
  } catch {
    return -1
  }
}

/** Return raw `git diff --shortstat` output between two refs (three-dot). */
export function getDiffStatsBetween(repoPath: string, base: string, head: string): string {
  try {
    return git(repoPath, ['diff', '--shortstat', `${base}...${head}`])
  } catch {
    return ''
  }
}

/**
 * Return `git diff --stat HEAD` output (working tree vs HEAD) as a single string.
 * Empty string if the working tree is clean or the command fails. Best-effort: never throws.
 */
export function getWorkingTreeDiffStats(repoPath: string): string {
  try {
    return execFileSync('git', ['diff', '--stat', 'HEAD'], {
      cwd: repoPath,
      encoding: 'utf-8',
    })
  } catch {
    return ''
  }
}

// ── Async versions ───────────────────────────────────────────────────────────
// Non-blocking alternatives for hot paths (route handlers).

/**
 * Async version of `getUnpushedCount`. Same `origin/<workingBranch>` semantic:
 * returns `-1` when the remote ref does not exist (never pushed), `0` when
 * pushed and aligned, `>0` when pushed but ahead.
 */
export async function getUnpushedCountAsync(repoPath: string, workingBranch: string): Promise<number> {
  const remoteRef = `origin/${workingBranch}`
  try {
    await execFileAsync('git', ['rev-parse', '--verify', remoteRef], { cwd: repoPath })
  } catch {
    return -1 // branch never pushed (no remote ref)
  }
  try {
    const { stdout } = await execFileAsync('git', ['rev-list', `${remoteRef}..HEAD`, '--count'], {
      cwd: repoPath,
      encoding: 'utf-8',
    })
    return parseInt(stdout.trim(), 10) || 0
  } catch {
    return -1
  }
}

/**
 * Best-effort async `git fetch <remote> <branch>`. Never throws — by contract,
 * suitable for both fire-and-forget and `await` use without try/catch at the
 * call site. Logs a warning on failure but resolves cleanly.
 *
 * Mirrors the sync `fetchSourceBranch` sibling, including the optional `remote`
 * parameter (defaults to `'origin'`).
 */
export async function fetchSourceBranchAsync(repoPath: string, branch: string, remote = 'origin'): Promise<void> {
  try {
    await execFileAsync('git', ['fetch', remote, branch], { cwd: repoPath })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`[git-ops] fetchSourceBranchAsync(${remote}/${branch}) failed: ${msg}`)
  }
}

/** Stash all changes (including untracked). */
export function stashPush(repoPath: string, label: string): void {
  git(repoPath, ['stash', 'push', '--include-untracked', '-m', label])
}

/** Pop the most recent stash entry. */
export function stashPop(repoPath: string): void {
  git(repoPath, ['stash', 'pop'])
}

/** Stage every change (tracked + untracked) and commit it. Hooks run normally
 *  (no --no-verify), per the project's commit conventions. */
export function commitAllChanges(repoPath: string, message: string): void {
  git(repoPath, ['add', '-A'])
  git(repoPath, ['commit', '-m', message])
}

/** Discard staged + modified TRACKED changes (`git reset --hard HEAD`).
 *  Untracked files are intentionally preserved — they don't block a
 *  rebase/merge, and cleaning them would risk nuking .env / build artefacts. */
export function discardWorkingTreeChanges(repoPath: string): void {
  git(repoPath, ['reset', '--hard', 'HEAD'])
}
