import { describe, expect, it } from 'vitest'
import { buildPathTree, countLeaves } from '../utils/build-path-tree'

describe('buildPathTree()', () => {
  it('returns empty tree for empty input', () => {
    expect(buildPathTree<{ path: string }>([])).toEqual([])
  })

  it('groups files by folder and nests them', () => {
    const tree = buildPathTree([
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
    const tree = buildPathTree([
      { path: '.ai/thoughts/SENTRY-42.md', name: 'SENTRY-42.md', modifiedAt: '' },
      { path: 'docs/plans/x.md', name: 'x.md', modifiedAt: '' },
    ])
    const roots = tree.map((n) => n.label).sort()
    expect(roots).toEqual(['.ai', 'docs'])
  })

  it('sorts folders before files at each level', () => {
    const tree = buildPathTree([
      { path: 'docs/a.md', name: 'a.md', modifiedAt: '' },
      { path: 'docs/plans/b.md', name: 'b.md', modifiedAt: '' },
    ])
    const docs = tree[0]
    expect(docs.children?.[0].label).toBe('plans') // folder first
    expect(docs.children?.[1].label).toBe('a.md')
  })

  it('sorts siblings alphabetically', () => {
    const tree = buildPathTree([
      { path: 'docs/z.md', name: 'z.md', modifiedAt: '' },
      { path: 'docs/a.md', name: 'a.md', modifiedAt: '' },
      { path: 'docs/m.md', name: 'm.md', modifiedAt: '' },
    ])
    expect(tree[0].children?.map((n) => n.label)).toEqual(['a.md', 'm.md', 'z.md'])
  })

  it('generates stable unique node keys', () => {
    const tree = buildPathTree([
      { path: 'docs/plans/a.md', name: 'a.md', modifiedAt: '' },
      { path: 'docs/superpowers/plans/a.md', name: 'a.md', modifiedAt: '' },
    ])
    const keys: string[] = []
    function collect(nodes: ReturnType<typeof buildPathTree<{ path: string }>>) {
      for (const n of nodes) {
        keys.push(n.nodeKey)
        if (n.children) collect(n.children)
      }
    }
    collect(tree)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('keeps the full payload on leaves via generic T', () => {
    const tree = buildPathTree([
      { path: 'src/App.tsx', status: 'modified' as const },
      { path: 'README.md', status: 'added' as const },
    ])
    const app = tree.find((n) => n.label === 'src')?.children?.[0]
    expect(app?.file?.status).toBe('modified')
    const readme = tree.find((n) => n.label === 'README.md')
    expect(readme?.file?.status).toBe('added')
  })
})

describe('countLeaves()', () => {
  it('returns 0 for an empty tree', () => {
    expect(countLeaves([])).toBe(0)
  })

  it('counts leaves recursively', () => {
    const tree = buildPathTree([{ path: 'a/b/c.md' }, { path: 'a/b/d.md' }, { path: 'a/e.md' }, { path: 'f.md' }])
    expect(countLeaves(tree)).toBe(4)
    // Count within a subtree
    const aFolder = tree.find((n) => n.label === 'a')
    expect(aFolder?.children ? countLeaves(aFolder.children) : 0).toBe(3)
  })
})
