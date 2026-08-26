import fs from 'node:fs'
import path from 'node:path'

export function isPathInside(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(rootPath, candidatePath)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

/** Reject an absolute or traversal path without requiring it to exist on disk. */
export function assertPathInside(rootPath: string, relativePath: string): void {
  const root = path.resolve(rootPath)
  const candidate = path.resolve(root, relativePath)
  if (!isPathInside(root, candidate)) throw new Error(`Path '${relativePath}' escapes allowed root`)
}

/** Resolve two existing paths and reject candidates that escape through a symlinked parent. */
export function resolveExistingPathInside(rootPath: string, candidatePath: string): string {
  const realRoot = fs.realpathSync(rootPath)
  const realCandidate = fs.realpathSync(candidatePath)
  if (!isPathInside(realRoot, realCandidate)) throw new Error('Path escapes allowed root')
  return realCandidate
}

/**
 * Resolve a worktree path, including its parent symlinks, while allowing a
 * missing leaf (needed when removing an untracked file).
 */
export function resolvePathInside(rootPath: string, relativePath: string): string {
  assertPathInside(rootPath, relativePath)
  const root = fs.realpathSync(rootPath)
  const candidate = path.resolve(rootPath, relativePath)
  let parent: string
  try {
    parent = fs.realpathSync(path.dirname(candidate))
  } catch {
    throw new Error(`Path '${relativePath}' is invalid (parent directory does not exist)`)
  }
  if (!isPathInside(root, parent)) throw new Error('Path escapes allowed root')

  const resolved = path.join(parent, path.basename(candidate))
  try {
    return resolveExistingPathInside(root, resolved)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return resolved
    throw err
  }
}
