export interface PathTreeNode<T> {
  label: string
  nodeKey: string
  /** Only set on folder nodes. */
  isFolder?: true
  /** Only set on leaf nodes — payload the caller attached to this path. */
  file?: T
  children?: PathTreeNode<T>[]
}

/**
 * Turn a flat list of objects with a `path` field into a nested tree ready
 * for `q-tree`. Folders come before files at every level; both sets are
 * sorted alphabetically. Node keys are stable (`dir:<partial-path>` /
 * `file:<full-path>`) so q-tree selection survives re-renders.
 *
 * Example:
 *   [{ path: 'docs/plans/x.md' }, { path: 'docs/superpowers/y.md' }]
 *   →
 *   [{ label: 'docs', children: [
 *       { label: 'plans', children: [{ label: 'x.md', file: … }] },
 *       { label: 'superpowers', children: [{ label: 'y.md', file: … }] },
 *     ] }]
 */
export function buildPathTree<T extends { path: string }>(files: readonly T[]): PathTreeNode<T>[] {
  const root: PathTreeNode<T>[] = []

  for (const file of files) {
    const parts = file.path.split('/').filter((p) => p.length > 0)
    if (parts.length === 0) continue
    let level = root
    let currentPath = ''
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i]
      currentPath = currentPath ? `${currentPath}/${part}` : part
      let node = level.find((n) => n.isFolder && n.label === part)
      if (!node) {
        node = { label: part, nodeKey: `dir:${currentPath}`, isFolder: true, children: [] }
        level.push(node)
      }
      level = node.children as PathTreeNode<T>[]
    }
    level.push({
      label: parts[parts.length - 1],
      nodeKey: `file:${file.path}`,
      file,
    })
  }

  function sortLevel(nodes: PathTreeNode<T>[]): void {
    nodes.sort((a, b) => {
      const aIsFolder = a.isFolder === true
      const bIsFolder = b.isFolder === true
      if (aIsFolder !== bIsFolder) return aIsFolder ? -1 : 1
      return a.label.localeCompare(b.label)
    })
    for (const n of nodes) if (n.children) sortLevel(n.children)
  }
  sortLevel(root)

  return root
}

/**
 * Count the number of leaf (file) nodes reachable from the given subtree.
 * Useful when rendering a folder node with a `(N files)` badge.
 */
export function countLeaves<T>(nodes: readonly PathTreeNode<T>[]): number {
  let n = 0
  for (const node of nodes) {
    if (node.file) n++
    if (node.children) n += countLeaves(node.children)
  }
  return n
}
