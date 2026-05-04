import { execFile as execFileCb, execFileSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFileCb)

function git(repoPath: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repoPath, encoding: 'utf-8' }).trim()
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

/** Pull the current branch from the remote using fast-forward only. */
export function pullBranch(repoPath: string, branchName: string, remote = 'origin'): void {
  try {
    git(repoPath, ['pull', '--ff-only', remote, branchName])
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`Failed to pull branch '${branchName}' from '${remote}': ${message}`)
  }
}

/** Thrown when a rebase or merge produces conflicts. Leaves the repo in the mid-operation state
 *  so the caller can decide between abort and agent-assisted resolution. */
export class GitConflictError extends Error {
  readonly operation: 'rebase' | 'merge'
  readonly files: string[]
  constructor(operation: 'rebase' | 'merge', files: string[]) {
    super(`${operation} produced ${files.length} conflicted file(s)`)
    this.name = 'GitConflictError'
    this.operation = operation
    this.files = files
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

/** Detect whether a merge or rebase is currently in progress in the worktree. */
export function getOngoingGitOperation(repoPath: string): 'merge' | 'rebase' | null {
  try {
    const gitDir = git(repoPath, ['rev-parse', '--git-dir'])
    const dir = gitDir.startsWith('/') ? gitDir : join(repoPath, gitDir)
    if (existsSync(join(dir, 'MERGE_HEAD'))) return 'merge'
    if (existsSync(join(dir, 'rebase-merge')) || existsSync(join(dir, 'rebase-apply'))) return 'rebase'
    return null
  } catch {
    return null
  }
}

/** Rebase the current branch onto the given base branch. Fetches origin first. Leaves conflicts in place. */
export function rebaseBranch(repoPath: string, baseBranch: string): void {
  try {
    git(repoPath, ['fetch', 'origin', baseBranch])
  } catch {
    // fetch may fail if offline — continue with local ref
  }
  try {
    git(repoPath, ['rebase', `origin/${baseBranch}`])
  } catch (err) {
    const conflicted = getConflictedFiles(repoPath)
    if (conflicted.length > 0 || getOngoingGitOperation(repoPath) === 'rebase') {
      // Leave the rebase in progress so the caller can abort or request agent-assisted resolution.
      throw new GitConflictError('rebase', conflicted)
    }
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`Rebase onto '${baseBranch}' failed: ${message}`)
  }
}

/** Merge `origin/<baseBranch>` into the current branch. Fetches first. Leaves conflicts in place. */
export function mergeBranch(repoPath: string, baseBranch: string): void {
  try {
    git(repoPath, ['fetch', 'origin', baseBranch])
  } catch {
    // offline — continue with local ref
  }
  try {
    git(repoPath, ['merge', '--no-ff', '--no-edit', `origin/${baseBranch}`])
  } catch (err) {
    const conflicted = getConflictedFiles(repoPath)
    if (conflicted.length > 0 || getOngoingGitOperation(repoPath) === 'merge') {
      throw new GitConflictError('merge', conflicted)
    }
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`Merge of 'origin/${baseBranch}' failed: ${message}`)
  }
}

/** Abort an in-progress merge or rebase. No-op if nothing is in progress. */
export function abortOngoingGitOperation(repoPath: string): 'merge' | 'rebase' | null {
  const op = getOngoingGitOperation(repoPath)
  if (op === 'merge') {
    git(repoPath, ['merge', '--abort'])
  } else if (op === 'rebase') {
    git(repoPath, ['rebase', '--abort'])
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

/** Get the GitHub PR URL for a branch using `gh pr view`. Returns null if no PR exists. */
export function getPrUrl(repoPath: string, branchName: string): string | null {
  try {
    return (
      execFileSync('gh', ['pr', 'view', branchName, '--json', 'url', '--jq', '.url'], {
        cwd: repoPath,
        encoding: 'utf-8',
      }).trim() || null
    )
  } catch {
    return null
  }
}

/** State and URL of a GitHub pull request. */
export interface PrStatus {
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  url: string
  /** Base branch of the PR (`baseRefName` from `gh pr view`). Optional so
   *  callers that don't care about the base (drawer indicator, chat template)
   *  keep working with partial mocks. */
  base?: string
}

/** Get the state and URL of the PR for a branch. Returns null if no PR exists. */
export function getPrStatus(repoPath: string, branchName: string): PrStatus | null {
  try {
    const raw = execFileSync('gh', ['pr', 'view', branchName, '--json', 'state,url,baseRefName'], {
      cwd: repoPath,
      encoding: 'utf-8',
    }).trim()
    if (!raw) return null
    const parsed = JSON.parse(raw) as { state: string; url: string; baseRefName?: string }
    return {
      state: parsed.state as PrStatus['state'],
      url: parsed.url,
      base: parsed.baseRefName || undefined,
    }
  } catch {
    return null
  }
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
    return git(repoPath, ['show', `${resolvedRef}:${filePath}`])
  } catch {
    return null
  }
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

/** Count commits ahead of upstream. Returns -1 if no upstream is set. */
export function getUnpushedCount(repoPath: string): number {
  try {
    const output = execFileSync('git', ['rev-list', '@{u}..HEAD', '--count'], {
      cwd: repoPath,
      encoding: 'utf-8',
    }).trim()
    return parseInt(output, 10) || 0
  } catch {
    return -1 // no upstream
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

// ── Async versions ───────────────────────────────────────────────────────────
// Non-blocking alternatives for hot paths (pr-watcher, route handlers).

/** Async version of getPrUrl. Returns null if no PR exists. */
export async function getPrUrlAsync(repoPath: string, branchName: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('gh', ['pr', 'view', branchName, '--json', 'url', '--jq', '.url'], {
      cwd: repoPath,
      encoding: 'utf-8',
    })
    return stdout.trim() || null
  } catch {
    return null
  }
}

/** Async version of getPrStatus. Returns null if no PR exists. */
export async function getPrStatusAsync(repoPath: string, branchName: string): Promise<PrStatus | null> {
  try {
    const { stdout } = await execFileAsync('gh', ['pr', 'view', branchName, '--json', 'state,url,baseRefName'], {
      cwd: repoPath,
      encoding: 'utf-8',
    })
    const raw = stdout.trim()
    if (!raw) return null
    const parsed = JSON.parse(raw) as { state: string; url: string; baseRefName?: string }
    return {
      state: parsed.state as PrStatus['state'],
      url: parsed.url,
      base: parsed.baseRefName || undefined,
    }
  } catch {
    return null
  }
}

/** Async version of getUnpushedCount. Returns -1 if no upstream is set. */
export async function getUnpushedCountAsync(repoPath: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-list', '@{u}..HEAD', '--count'], {
      cwd: repoPath,
      encoding: 'utf-8',
    })
    return parseInt(stdout.trim(), 10) || 0
  } catch {
    return -1 // no upstream
  }
}
