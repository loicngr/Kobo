import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { isGitBranchExistsError } from '../utils/git-ops.js'

export interface WorktreeInfo {
  path: string
  branch: string
  head: string
}

function git(repoPath: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repoPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
}

function getExcludeFilePath(projectPath: string): string {
  return path.join(projectPath, '.git', 'info', 'exclude')
}

function addToExclude(projectPath: string, worktreePath: string): void {
  const excludeFile = getExcludeFilePath(projectPath)
  // Ensure the .git/info directory exists
  const infoDir = path.dirname(excludeFile)
  if (!fs.existsSync(infoDir)) {
    fs.mkdirSync(infoDir, { recursive: true })
  }

  // Make the path relative to projectPath for cleaner exclude entries
  const relativePath = path.relative(projectPath, worktreePath)
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
  const excludeFile = getExcludeFilePath(projectPath)
  if (!fs.existsSync(excludeFile)) return

  const relativePath = path.relative(projectPath, worktreePath)
  const entry = `/${relativePath}`

  const lines = fs.readFileSync(excludeFile, 'utf-8').split('\n')
  const filtered = lines.filter((line) => line !== entry)
  // I3: ensure the file ends with exactly one newline and has no trailing empty lines
  const trimmed = filtered.join('\n').replace(/\n+$/, '')
  fs.writeFileSync(excludeFile, trimmed ? `${trimmed}\n` : '', 'utf-8')
}

export function createWorktree(projectPath: string, branchName: string, sourceBranch: string): string {
  const worktreesDir = path.join(projectPath, '.worktrees')
  if (!fs.existsSync(worktreesDir)) {
    fs.mkdirSync(worktreesDir, { recursive: true })
  }

  const worktreePath = path.join(worktreesDir, branchName)

  try {
    // Try creating a new branch + worktree
    git(projectPath, ['worktree', 'add', '-b', branchName, worktreePath, sourceBranch])
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)

    // M3: use shared utility for branch-exists detection
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

export function removeWorktree(projectPath: string, worktreePath: string): void {
  try {
    git(projectPath, ['worktree', 'remove', worktreePath, '--force'])
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`Failed to remove worktree '${worktreePath}': ${message}`)
  }

  removeFromExclude(projectPath, worktreePath)
}

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

export function worktreeExists(projectPath: string, branchName: string): boolean {
  try {
    const worktrees = listWorktrees(projectPath)
    return worktrees.some((wt) => wt.branch === branchName)
  } catch {
    return false
  }
}
