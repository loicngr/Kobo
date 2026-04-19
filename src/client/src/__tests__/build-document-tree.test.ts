import { describe, expect, it } from 'vitest'
import { buildDocumentTree } from '../utils/build-document-tree'

describe('buildDocumentTree()', () => {
  it('returns empty tree for empty input', () => {
    expect(buildDocumentTree([])).toEqual([])
  })

  it('groups files by folder and nests them', () => {
    const tree = buildDocumentTree([
      { path: 'docs/plans/a.md', name: 'a.md', modifiedAt: '' },
      { path: 'docs/plans/b.md', name: 'b.md', modifiedAt: '' },
    ])
    expect(tree).toHaveLength(1)
    expect(tree[0].label).toBe('docs')
    expect(tree[0].children?.[0].label).toBe('plans')
    const files = tree[0].children?.[0].children ?? []
    expect(files.map((f) => f.label)).toEqual(['a.md', 'b.md'])
    expect(files[0].file?.path).toBe('docs/plans/a.md')
  })

  it('interleaves multiple roots', () => {
    const tree = buildDocumentTree([
      { path: '.ai/thoughts/SENTRY-42.md', name: 'SENTRY-42.md', modifiedAt: '' },
      { path: 'docs/plans/x.md', name: 'x.md', modifiedAt: '' },
    ])
    const roots = tree.map((n) => n.label).sort()
    expect(roots).toEqual(['.ai', 'docs'])
  })

  it('sorts folders before files at each level', () => {
    const tree = buildDocumentTree([
      { path: 'docs/a.md', name: 'a.md', modifiedAt: '' },
      { path: 'docs/plans/b.md', name: 'b.md', modifiedAt: '' },
    ])
    const docs = tree[0]
    expect(docs.children?.[0].label).toBe('plans') // folder first
    expect(docs.children?.[1].label).toBe('a.md')
  })

  it('sorts siblings alphabetically', () => {
    const tree = buildDocumentTree([
      { path: 'docs/z.md', name: 'z.md', modifiedAt: '' },
      { path: 'docs/a.md', name: 'a.md', modifiedAt: '' },
      { path: 'docs/m.md', name: 'm.md', modifiedAt: '' },
    ])
    expect(tree[0].children?.map((n) => n.label)).toEqual(['a.md', 'm.md', 'z.md'])
  })

  it('generates stable unique node keys', () => {
    const tree = buildDocumentTree([
      { path: 'docs/plans/a.md', name: 'a.md', modifiedAt: '' },
      { path: 'docs/superpowers/plans/a.md', name: 'a.md', modifiedAt: '' },
    ])
    const keys: string[] = []
    function collect(nodes: ReturnType<typeof buildDocumentTree>) {
      for (const n of nodes) {
        keys.push(n.nodeKey)
        if (n.children) collect(n.children)
      }
    }
    collect(tree)
    expect(new Set(keys).size).toBe(keys.length)
  })
})
