import { createHash } from 'node:crypto'
import { getFileContent, writeFileInWorktree } from '../utils/git-ops.js'
import { resolvePathInside } from '../utils/safe-path.js'

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
  const absPath = resolvePathInside(worktreePath, relativePath)
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
