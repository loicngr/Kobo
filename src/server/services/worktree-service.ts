import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { isGitBranchExistsError } from '../utils/git-ops.js'
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
  return execFileSync('git', args, { cwd: repoPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
}

function getExcludeFilePath(projectPath: string): string {
  return path.join(projectPath, '.git', 'info', 'exclude')
}

function projectRelativeWorktreePath(projectPath: string, worktreePath: string): string | null {
  const relativePath = path.relative(projectPath, worktreePath)
  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) return null
  return relativePath
}

function addToExclude(projectPath: string, worktreePath: string): void {
  const relativePath = projectRelativeWorktreePath(projectPath, worktreePath)
  if (!relativePath) return

  const excludeFile = getExcludeFilePath(projectPath)
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

/** Create a git worktree for the given branch. Returns the worktree path. */
export function createWorktree(
  projectPath: string,
  branchName: string,
  sourceBranch: string,
  worktreesPath?: string | null,
): string {
  const worktreesDir = resolveWorktreesRoot(projectPath, worktreesPath)
  if (!fs.existsSync(worktreesDir)) {
    fs.mkdirSync(worktreesDir, { recursive: true })
  }

  const worktreePath = resolveWorkspaceWorktreePath(projectPath, branchName, worktreesPath)

  try {
    // Use origin/<sourceBranch> as the base so the worktree starts from the
    // freshly-fetched remote ref (fetchSourceBranch is always called first).
    git(projectPath, ['worktree', 'add', '-b', branchName, worktreePath, `origin/${sourceBranch}`])
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)

    // If branch already exists, add worktree without creating the branch
    if (isGitBranchExistsError(message)) {
      git(projectPath, ['worktree', 'add', worktreePath, branchName])
    } else {
      throw new Error(`Failed to create worktree for branch '${branchName}': ${message}`)
    }
  }

  addToExclude(projectPath, worktreePath)

  return worktreePath
}

/** Remove a git worktree and clean up the .git/info/exclude entry. */
export function removeWorktree(projectPath: string, worktreePath: string): void {
  try {
    git(projectPath, ['worktree', 'remove', worktreePath, '--force'])
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`Failed to remove worktree '${worktreePath}': ${message}`)
  }

  removeFromExclude(projectPath, worktreePath)
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
