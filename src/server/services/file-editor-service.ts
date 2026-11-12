import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { writeFileInWorktree } from '../utils/git-ops.js'
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
  // Only a missing file counts as empty: an unreadable one must not be overwritten blind.
  let current = ''
  try {
    const bytes = readFileSync(absPath)
    current = bytes.toString('utf8')
    // The editor only ever saw the UTF-8 view: saving it back would destroy anything that view lost.
    if (bytes.includes(0) || !Buffer.from(current, 'utf8').equals(bytes))
      throw new Error(`'${relativePath}' is not UTF-8 text; refusing to overwrite it`)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  const currentSha = shaOf(current)
  if (currentSha !== baseSha) {
    return { status: 'conflict', currentSha }
  }
  // In place, not temp + rename: keeps owner, hard links and mode, works in a read-only directory,
  // and leaves no stray file for dev-server watchers.
  writeFileInWorktree(absPath, content)
  return { status: 'saved' }
}
