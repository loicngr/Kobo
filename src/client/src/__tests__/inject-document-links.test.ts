import { describe, expect, it } from 'vitest'
import { injectDocumentLinks } from '../utils/inject-document-links'

describe('injectDocumentLinks()', () => {
  it('returns input unchanged when no paths supplied', () => {
    expect(injectDocumentLinks('<p>hello docs/plans/x.md</p>', [])).toBe('<p>hello docs/plans/x.md</p>')
  })

  it('wraps a bare path in a plain paragraph', () => {
    const out = injectDocumentLinks('<p>See docs/plans/x.md here</p>', ['docs/plans/x.md'])
    expect(out).toContain('<a class="document-link" data-document-path="docs/plans/x.md" href="#">docs/plans/x.md</a>')
    expect(out).toContain('See ')
    expect(out).toContain(' here')
  })

  it('wraps a path inside inline <code> too', () => {
    const out = injectDocumentLinks('<p>Open <code>docs/plans/x.md</code> now</p>', ['docs/plans/x.md'])
    expect(out).toContain('<code><a class="document-link"')
    expect(out).toContain('data-document-path="docs/plans/x.md"')
  })

  it('does not double-wrap inside an existing <a>', () => {
    const html = '<p><a href="https://example.com">docs/plans/x.md</a></p>'
    expect(injectDocumentLinks(html, ['docs/plans/x.md'])).toBe(html)
  })

  it('handles multiple occurrences in the same text node', () => {
    const out = injectDocumentLinks('<p>Files: docs/a.md and docs/b.md both updated.</p>', ['docs/a.md', 'docs/b.md'])
    expect(out.match(/document-link/g)?.length).toBe(2)
  })

  it('prefers the longer match when two paths start at the same index', () => {
    const out = injectDocumentLinks('<p>docs/plans/a.md</p>', ['docs/plans', 'docs/plans/a.md'])
    // The longer path should win
    expect(out).toContain('data-document-path="docs/plans/a.md"')
    expect(out).not.toContain('data-document-path="docs/plans"')
  })

  it('leaves unrelated text untouched', () => {
    const html = '<p>Hello world.</p>'
    expect(injectDocumentLinks(html, ['docs/plans/x.md'])).toBe(html)
  })

  it('handles paths across multiple text nodes', () => {
    const out = injectDocumentLinks('<p>First <em>docs/a.md</em> then <em>docs/b.md</em></p>', [
      'docs/a.md',
      'docs/b.md',
    ])
    expect(out.match(/document-link/g)?.length).toBe(2)
  })
})
