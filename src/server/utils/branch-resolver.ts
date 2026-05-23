import fs from 'node:fs'
import { branchExists } from './git-ops.js'
import { resolveWorkspaceWorktreePath } from './worktree-paths.js'

const HASH_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
const HASH_LENGTH = 4
const MAX_RETRIES = 10

/** 4-char uppercase alphanumeric suffix (e.g. `A45C`). Uniform distribution. */
function shortHash(length: number = HASH_LENGTH): string {
  let out = ''
  for (let i = 0; i < length; i++) {
    out += HASH_ALPHABET[Math.floor(Math.random() * HASH_ALPHABET.length)]
  }
  return out
}

export interface ResolveUniqueResult {
  workingBranch: string
  worktreePath: string
  /** True when the requested branch / path was already in use and a hash suffix
   *  had to be appended. The frontend uses this to notify the user. */
  adjusted: boolean
}

/**
 * Resolve a unique `(branch, worktreePath)` pair for a new workspace.
 *
 * If the requested `baseBranch` is free both on git (local + remote) and on
 * disk, returns it as-is. Otherwise appends `-<HASH>` (4 uppercase alphanum
 * chars) and retries up to 10 times, then throws.
 *
 * The same suffix is applied to BOTH the branch name and the worktree path so
 * they stay aligned — `feature/foo-A45C` lives in `<root>/feature/foo-A45C/`.
 */
export function resolveUniqueBranchAndPath(args: {
  projectPath: string
  baseBranch: string
  worktreesPath?: string | null
  projectSlug?: string
}): ResolveUniqueResult {
  const { projectPath, baseBranch, worktreesPath, projectSlug } = args

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const candidate = attempt === 0 ? baseBranch : `${baseBranch}-${shortHash()}`
    const candidatePath = resolveWorkspaceWorktreePath(projectPath, candidate, worktreesPath, projectSlug)

    const pathTaken = fs.existsSync(candidatePath)
    const branchTaken = safeBranchExists(projectPath, candidate)

    if (!pathTaken && !branchTaken) {
      return { workingBranch: candidate, worktreePath: candidatePath, adjusted: attempt > 0 }
    }
  }

  throw new Error(`Failed to find a unique branch/worktree pair for '${baseBranch}' after ${MAX_RETRIES} attempts`)
}

/** `branchExists` swallows recoverable git errors; treat unexpected throws as
 *  "branch is free" so the resolver fails open rather than locking the user
 *  out (e.g. corrupt repo state shouldn't block workspace creation). */
function safeBranchExists(projectPath: string, branch: string): boolean {
  try {
    return branchExists(projectPath, branch)
  } catch {
    return false
  }
}
