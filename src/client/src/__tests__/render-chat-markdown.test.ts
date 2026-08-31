// @vitest-environment jsdom
//
// DOMPurify 3.4.9 relies on DOM APIs that happy-dom (our default test env)
// implements incompletely — under happy-dom it silently strips block tags
// (e.g. <p>) and never fires `afterSanitizeAttributes` hooks, producing false
// negatives for the sanitization assertions below. jsdom is the reference DOM
// DOMPurify is built against and matches real-browser behaviour, so this one
// file opts into it. Production is unaffected (real browser DOM).
import { beforeEach, describe, expect, it, vi } from 'vitest'

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

describe('renderChatMarkdownCached', () => {
  beforeEach(async () => {
    const { resetChatMarkdownCache } = await import('../utils/render-chat-markdown')
    resetChatMarkdownCache()
  })

  it('renders a frozen message only once, however many times it is asked for', async () => {
    const { renderChatMarkdownCached } = await import('../utils/render-chat-markdown')
    const render = vi.fn((raw: string) => `<p>${raw}</p>`)

    const first = renderChatMarkdownCached('msg-1', 'hello world', render)
    const second = renderChatMarkdownCached('msg-1', 'hello world', render)
    const third = renderChatMarkdownCached('msg-1', 'hello world', render)

    expect(first).toBe('<p>hello world</p>')
    expect(second).toBe(first)
    expect(third).toBe(first)
    // The whole point: folding recreates the item object on every token, but
    // the conversion must not run again for a message that has not changed.
    expect(render).toHaveBeenCalledTimes(1)
  })

  it('re-renders when the message grows by one token', async () => {
    const { renderChatMarkdownCached } = await import('../utils/render-chat-markdown')
    const render = vi.fn((raw: string) => `<p>${raw}</p>`)

    renderChatMarkdownCached('msg-1', 'hel', render)
    const grown = renderChatMarkdownCached('msg-1', 'hello', render)

    expect(grown).toBe('<p>hello</p>')
    expect(render).toHaveBeenCalledTimes(2)
  })

  it('never returns one message content for another of the same length', async () => {
    const { renderChatMarkdownCached } = await import('../utils/render-chat-markdown')
    const render = vi.fn((raw: string) => `<p>${raw}</p>`)

    const a = renderChatMarkdownCached('msg-a', 'aaaaa', render)
    const b = renderChatMarkdownCached('msg-b', 'bbbbb', render)

    expect(a).toBe('<p>aaaaa</p>')
    expect(b).toBe('<p>bbbbb</p>')
    expect(render).toHaveBeenCalledTimes(2)
  })

  it('keeps the cache bounded by evicting the oldest entry', async () => {
    const { RENDER_CACHE_LIMIT, renderChatMarkdownCached } = await import('../utils/render-chat-markdown')
    const render = vi.fn((raw: string) => `<p>${raw}</p>`)

    for (let i = 0; i < RENDER_CACHE_LIMIT + 1; i++) {
      renderChatMarkdownCached(`msg-${i}`, `body-${i}`, render)
    }
    const callsAfterFill = render.mock.calls.length

    // The very first key must have been evicted → it renders again.
    renderChatMarkdownCached('msg-0', 'body-0', render)
    expect(render.mock.calls.length).toBe(callsAfterFill + 1)

    // The most recent key is still cached → it does not render again.
    renderChatMarkdownCached(`msg-${RENDER_CACHE_LIMIT}`, `body-${RENDER_CACHE_LIMIT}`, render)
    expect(render.mock.calls.length).toBe(callsAfterFill + 1)
  })

  it('falls back to the real markdown renderer when no renderer is supplied', async () => {
    const { renderChatMarkdownCached } = await import('../utils/render-chat-markdown')
    const html = renderChatMarkdownCached('msg-default', '**bold**')
    expect(html).toContain('<strong>bold</strong>')
  })
})

describe('escapeStreamingText', () => {
  it('escapes HTML so a half-written message can never inject markup', async () => {
    const { escapeStreamingText } = await import('../utils/render-chat-markdown')
    expect(escapeStreamingText('<img src=x onerror=alert(1)>')).toBe('&lt;img src=x onerror=alert(1)&gt;')
  })

  it('escapes ampersands before anything else', async () => {
    const { escapeStreamingText } = await import('../utils/render-chat-markdown')
    expect(escapeStreamingText('a & <b>')).toBe('a &amp; &lt;b&gt;')
  })

  it('turns newlines into line breaks', async () => {
    const { escapeStreamingText } = await import('../utils/render-chat-markdown')
    expect(escapeStreamingText('one\ntwo')).toBe('one<br>two')
  })

  it('leaves an unterminated code fence alone instead of parsing it', async () => {
    const { escapeStreamingText } = await import('../utils/render-chat-markdown')
    expect(escapeStreamingText('```ts\nconst a = 1')).toBe('```ts<br>const a = 1')
  })
})
