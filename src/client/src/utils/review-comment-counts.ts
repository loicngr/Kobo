export interface CommentPath {
  filePath: string
}

/**
 * Count review comments per file AND per ancestor folder in one pass.
 *
 * The previous per-folder count re-scanned the whole comment list for every
 * folder node of the tree, and the template asked for it twice per node — so a
 * two-hundred-file diff with fifty comments did twenty thousand string
 * comparisons per render, and it re-rendered on every scroll frame.
 */
export function countCommentsByPath(comments: readonly CommentPath[]): {
  byFile: Map<string, number>
  byFolder: Map<string, number>
} {
  const byFile = new Map<string, number>()
  const byFolder = new Map<string, number>()

  for (const comment of comments) {
    const path = comment.filePath
    byFile.set(path, (byFile.get(path) ?? 0) + 1)

    const parts = path.split('/')
    let current = ''
    // The last segment is the file itself — never a folder.
    for (let i = 0; i < parts.length - 1; i++) {
      current = current === '' ? parts[i] : `${current}/${parts[i]}`
      byFolder.set(current, (byFolder.get(current) ?? 0) + 1)
    }
  }

  return { byFile, byFolder }
}
