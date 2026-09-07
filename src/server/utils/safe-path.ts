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
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    // The leaf does not exist. That is legitimate — this is how a new file gets
    // created — unless the leaf is itself a symlink whose target is missing:
    // realpath gives up with ENOENT on those too, and returning the unresolved
    // path lets `writeFileSync` follow the link on O_CREAT and write outside the
    // root. A repository that ships `notes.md -> ~/.bashrc.d/x.sh` would get a
    // write there the next time the user saves.
    assertLeafIsNotSymlink(resolved)
    return resolved
  }
}

/** Reject a leaf that is a symlink, dangling or not. */
function assertLeafIsNotSymlink(candidate: string): void {
  try {
    if (fs.lstatSync(candidate).isSymbolicLink()) throw new Error('Path escapes allowed root')
  } catch (err) {
    // Genuinely absent: nothing to follow, nothing to reject.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
    throw err
  }
}
