import { execFileSync } from 'node:child_process'

function git(repoPath: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repoPath, encoding: 'utf-8' }).trim()
}

export function getCurrentBranch(repoPath: string): string {
  return git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD'])
}

export function listBranches(repoPath: string): string[] {
  const output = git(repoPath, ['branch', '--format=%(refname:short)'])
  return output
    .split('\n')
    .map((b) => b.trim())
    .filter(Boolean)
}

export class BranchAlreadyExistsError extends Error {
  constructor(branchName: string) {
    super(`Branch '${branchName}' already exists`)
    this.name = 'BranchAlreadyExistsError'
  }
}

/**
 * M3: Shared utility to detect "branch already exists" git error messages
 * across different locales (English, French, Russian).
 */
export function isGitBranchExistsError(message: string): boolean {
  const lower = message.toLowerCase()
  return lower.includes('already exists') || lower.includes('existe') || lower.includes('существует')
}

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

export function deleteLocalBranch(repoPath: string, branchName: string): void {
  try {
    git(repoPath, ['branch', '-D', branchName])
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`Failed to delete local branch '${branchName}': ${message}`)
  }
}

export function deleteRemoteBranch(repoPath: string, branchName: string, remote = 'origin'): void {
  try {
    git(repoPath, ['push', remote, '--delete', branchName])
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`Failed to delete remote branch '${remote}/${branchName}': ${message}`)
  }
}

export function pushBranch(repoPath: string, branchName: string, remote = 'origin'): void {
  try {
    git(repoPath, ['push', '-u', remote, branchName])
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`Failed to push branch '${branchName}' to '${remote}': ${message}`)
  }
}

export function getCommitsBetween(repoPath: string, base: string, head: string): string {
  try {
    return git(repoPath, ['log', `${base}..${head}`, '--pretty=format:- %s (%h)', '--no-merges'])
  } catch {
    return ''
  }
}

export function getDiffStatsBetween(repoPath: string, base: string, head: string): string {
  try {
    return git(repoPath, ['diff', '--shortstat', `${base}...${head}`])
  } catch {
    return ''
  }
}
