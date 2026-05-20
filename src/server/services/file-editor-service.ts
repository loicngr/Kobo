import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import * as path from 'node:path'
import { getFileContent, writeFileInWorktree } from '../utils/git-ops.js'

const MAX_FILE_BYTES = 1024 * 1024

export function shaOf(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

export type SaveResult = { status: 'saved' } | { status: 'conflict'; currentSha: string }

/**
 * Persist `content` to `relativePath` inside `worktreePath`. Refuses when the
 * current file's sha differs from `baseSha` (412 semantics), when the path
 * escapes the worktree (including via symlinks), or when content exceeds 1 MB.
 */
export function saveWorkspaceFile(
  worktreePath: string,
  relativePath: string,
  content: string,
  baseSha: string,
): SaveResult {
  const absPath = resolveSafe(worktreePath, relativePath)
  if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) {
    throw new Error(`File too large (max ${MAX_FILE_BYTES / 1024 / 1024} MB)`)
  }
  const current = getFileContent(worktreePath, relativePath) ?? ''
  const currentSha = shaOf(current)
  if (currentSha !== baseSha) {
    return { status: 'conflict', currentSha }
  }
  writeFileInWorktree(absPath, content)
  return { status: 'saved' }
}

function resolveSafe(worktreePath: string, relativePath: string): string {
  const abs = path.resolve(worktreePath, relativePath)
  const root = realpathSync(path.resolve(worktreePath))
  const rootWithSep = root + path.sep
  // Resolve the parent's realpath (parent must exist; if it doesn't, the path
  // is invalid anyway and we surface that). Then join the lexical basename so
  // a non-existent leaf doesn't trigger ENOENT.
  let realParent: string
  try {
    realParent = realpathSync(path.dirname(abs))
  } catch {
    throw new Error(`Path '${relativePath}' is invalid (parent directory does not exist)`)
  }
  const realAbs = path.join(realParent, path.basename(abs))
  if (realAbs !== root && !realAbs.startsWith(rootWithSep)) {
    throw new Error(`Path '${relativePath}' escapes the worktree`)
  }
  // If the leaf exists and is itself a symlink, follow it and re-check
  // containment so we never write through a symlink that escapes the worktree.
  try {
    const leafReal = realpathSync(realAbs)
    if (leafReal !== root && !leafReal.startsWith(rootWithSep)) {
      throw new Error(`Path '${relativePath}' escapes the worktree`)
    }
    return leafReal
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return realAbs
    throw err
  }
}
