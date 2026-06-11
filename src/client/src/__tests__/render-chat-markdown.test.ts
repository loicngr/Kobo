// @vitest-environment jsdom
//
// DOMPurify 3.4.9 relies on DOM APIs that happy-dom (our default test env)
// implements incompletely — under happy-dom it silently strips block tags
// (e.g. <p>) and never fires `afterSanitizeAttributes` hooks, producing false
// negatives for the sanitization assertions below. jsdom is the reference DOM
// DOMPurify is built against and matches real-browser behaviour, so this one
// file opts into it. Production is unaffected (real browser DOM).
import { describe, expect, it } from 'vitest'

describe('renderChatMarkdown', () => {
  it('forces target=_blank and rel attrs on absolute http(s) links', async () => {
    const { renderChatMarkdown } = await import('../utils/render-chat-markdown')
    const html = renderChatMarkdown('See [docs](https://example.com).')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer nofollow"')
  })

  it('does not add target on internal anchors', async () => {
    const { renderChatMarkdown } = await import('../utils/render-chat-markdown')
    const html = renderChatMarkdown('Jump to [section](#anchor).')
    expect(html).not.toContain('target="_blank"')
  })

  it('does not add target on mailto links', async () => {
    const { renderChatMarkdown } = await import('../utils/render-chat-markdown')
    const html = renderChatMarkdown('Email [me](mailto:foo@bar.com).')
    expect(html).not.toContain('target="_blank"')
  })

  it('strips javascript: hrefs (XSS regression)', async () => {
    const { renderChatMarkdown } = await import('../utils/render-chat-markdown')
    const html = renderChatMarkdown('[x](javascript:alert(1))')
    expect(html).not.toContain('javascript:')
  })

  it('honors the addAttr option for data-document-path', async () => {
    const { renderChatMarkdown } = await import('../utils/render-chat-markdown')
    const html = renderChatMarkdown('<a data-document-path="docs/x.md" href="#x">x</a>', {
      addAttr: ['data-document-path'],
    })
    expect(html).toContain('data-document-path="docs/x.md"')
  })
})
