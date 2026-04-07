import { execFile as execFileCb, execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFileCb)

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

/** Try a git command with `base`, falling back to `origin/base` if the local ref is missing. */
function resolveBase(repoPath: string, base: string): string {
  try {
    git(repoPath, ['rev-parse', '--verify', base])
    return base
  } catch {
    try {
      git(repoPath, ['rev-parse', '--verify', `origin/${base}`])
      return `origin/${base}`
    } catch {
      return base
    }
  }
}

export function getCommitCount(repoPath: string, base: string, head: string): number {
  try {
    const ref = resolveBase(repoPath, base)
    const output = git(repoPath, ['rev-list', '--count', `${ref}..${head}`])
    return parseInt(output, 10) || 0
  } catch {
    return 0
  }
}

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

export function getCommitsBetween(repoPath: string, base: string, head: string): string {
  try {
    const ref = resolveBase(repoPath, base)
    return git(repoPath, ['log', `${ref}..${head}`, '--pretty=format:- %s (%h)', '--no-merges'])
  } catch {
    return ''
  }
}

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

export interface PrStatus {
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  url: string
}

export function getPrStatus(repoPath: string, branchName: string): PrStatus | null {
  try {
    const raw = execFileSync('gh', ['pr', 'view', branchName, '--json', 'state,url'], {
      cwd: repoPath,
      encoding: 'utf-8',
    }).trim()
    if (!raw) return null
    const parsed = JSON.parse(raw) as { state: string; url: string }
    return { state: parsed.state as PrStatus['state'], url: parsed.url }
  } catch {
    return null
  }
}

export interface DiffFile {
  path: string
  status: 'added' | 'modified' | 'deleted' | 'renamed'
}

/** List files changed between base and HEAD (committed), plus working tree changes. */
export function getChangedFiles(repoPath: string, base: string): DiffFile[] {
  const ref = resolveBase(repoPath, base)
  const files: DiffFile[] = []
  const seen = new Set<string>()

  // Committed changes (base..HEAD)
  try {
    const output = git(repoPath, ['diff', '--name-status', `${ref}...HEAD`])
    for (const line of output.split('\n')) {
      if (!line) continue
      const [statusCode, ...pathParts] = line.split('\t')
      const filePath = pathParts.join('\t').replace(/\/$/, '')
      if (!filePath) continue
      let status: DiffFile['status'] = 'modified'
      if (statusCode?.startsWith('A')) status = 'added'
      else if (statusCode?.startsWith('D')) status = 'deleted'
      else if (statusCode?.startsWith('R')) status = 'renamed'
      files.push({ path: filePath, status })
      seen.add(filePath)
    }
  } catch {
    // No commits yet
  }

  // Working tree changes (uncommitted)
  try {
    const output = git(repoPath, ['status', '--porcelain', '-uall'])
    for (const line of output.split('\n')) {
      if (!line) continue
      const filePath = line.substring(3).replace(/\/$/, '')
      if (!filePath || seen.has(filePath)) continue
      const x = line[0]
      const y = line[1]
      let status: DiffFile['status'] = 'modified'
      if (x === '?' && y === '?') status = 'added'
      else if (x === 'A' || y === 'A') status = 'added'
      else if (x === 'D' || y === 'D') status = 'deleted'
      files.push({ path: filePath, status })
    }
  } catch {
    // Ignore
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

/** Get the current content of a file in the worktree. Returns null if the file doesn't exist. */
export function getFileContent(repoPath: string, filePath: string): string | null {
  try {
    return readFileSync(join(repoPath, filePath), 'utf-8')
  } catch {
    return null
  }
}

export interface WorkingTreeStatus {
  staged: number
  modified: number
  untracked: number
}

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

export function getDiffStatsBetween(repoPath: string, base: string, head: string): string {
  try {
    return git(repoPath, ['diff', '--shortstat', `${base}...${head}`])
  } catch {
    return ''
  }
}

// ── Async versions ───────────────────────────────────────────────────────────
// Non-blocking alternatives for hot paths (pr-watcher, route handlers).
// The sync versions above are kept for callers that haven't migrated yet.

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

export async function getPrStatusAsync(repoPath: string, branchName: string): Promise<PrStatus | null> {
  try {
    const { stdout } = await execFileAsync('gh', ['pr', 'view', branchName, '--json', 'state,url'], {
      cwd: repoPath,
      encoding: 'utf-8',
    })
    const raw = stdout.trim()
    if (!raw) return null
    const parsed = JSON.parse(raw) as { state: string; url: string }
    return { state: parsed.state as PrStatus['state'], url: parsed.url }
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
