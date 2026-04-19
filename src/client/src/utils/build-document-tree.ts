import type { DocumentFile } from 'src/stores/documents'

export interface DocumentTreeNode {
  label: string
  nodeKey: string
  /** Only set on folder nodes. */
  isFolder?: true
  /** Only set on leaf nodes. */
  file?: DocumentFile
  children?: DocumentTreeNode[]
}

/**
 * Turn a flat list of document paths into a nested tree ready for q-tree.
 * Folders come before files at every level; both sets are sorted alphabetically.
 *
 * Example:
 *   [{ path: 'docs/plans/x.md' }, { path: 'docs/superpowers/y.md' }]
 *   →
 *   [{ label: 'docs', children: [
 *       { label: 'plans', children: [{ label: 'x.md', file: … }] },
 *       { label: 'superpowers', children: [{ label: 'y.md', file: … }] },
 *     ] }]
 */
export function buildDocumentTree(files: DocumentFile[]): DocumentTreeNode[] {
  const root: DocumentTreeNode[] = []

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
      level = node.children as DocumentTreeNode[]
    }
    level.push({
      label: parts[parts.length - 1],
      nodeKey: `file:${file.path}`,
      file,
    })
  }

  function sortLevel(nodes: DocumentTreeNode[]): void {
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
