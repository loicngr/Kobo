import path from 'node:path'

/**
 * Canonical identity for a configured repository path.
 *
 * This intentionally performs lexical normalization only: project identity
 * must not depend on whether the directory currently exists, symlink state,
 * display name, basename, or the workspace's separate worktree path.
 */
export function normalizeMemoryProjectPath(projectPath: string): string {
  if (typeof projectPath !== 'string' || !projectPath.trim()) {
    throw new TypeError('Project path must be a non-empty string')
  }

  const trimmed = projectPath.trim()
  const platformPath = path.resolve(trimmed)
  const normalized = path.normalize(platformPath)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}
