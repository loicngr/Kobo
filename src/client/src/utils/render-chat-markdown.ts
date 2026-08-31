import DOMPurify from 'dompurify'
import { marked } from 'marked'

let hookRegistered = false

function ensureHook(): void {
  if (hookRegistered) return
  DOMPurify.addHook('afterSanitizeAttributes', (node: Element) => {
    if (node.nodeName === 'A') {
      const href = node.getAttribute('href') ?? ''
      if (/^https?:\/\//i.test(href)) {
        node.setAttribute('target', '_blank')
        node.setAttribute('rel', 'noopener noreferrer nofollow')
      }
    }
  })
  hookRegistered = true
}

ensureHook()

export interface RenderChatMarkdownOptions {
  /** Extra attributes to allow through DOMPurify (e.g. `data-document-path`). */
  addAttr?: string[]
}

/**
 * Render markdown to sanitized HTML for chat-stream components. External
 * http(s) links are rewritten to open in a new tab with safe rel attributes
 * via a DOMPurify hook registered once at module import time.
 */
export function renderChatMarkdown(raw: string, options: RenderChatMarkdownOptions = {}): string {
  ensureHook()
  const html = marked.parse(raw, { async: false, breaks: true, gfm: true }) as string
  return DOMPurify.sanitize(html, options.addAttr ? { ADD_ATTR: options.addAttr } : undefined)
}

/**
 * Sanitize an already-rendered HTML string for chat-stream components.
 * Use this when an intermediate transform is needed between marked.parse and
 * DOMPurify.sanitize (e.g. injectDocumentLinks in TextMessageItem).
 * The same DOMPurify hook that adds target=_blank on http(s) links applies.
 */
export function sanitizeChatHtml(html: string, options: RenderChatMarkdownOptions = {}): string {
  ensureHook()
  return DOMPurify.sanitize(html, options.addAttr ? { ADD_ATTR: options.addAttr } : undefined)
}

/** Upper bound on memoised message renders. A feed shows a few hundred
 *  messages at most; past that, the oldest entry is evicted. */
export const RENDER_CACHE_LIMIT = 400

const renderCache = new Map<string, string>()

/**
 * Memoised markdown → HTML conversion for chat messages.
 *
 * Folding the event stream recreates a fresh ConversationItem object per token,
 * so every message on screen looked "new" on every delta and the whole
 * parse → link-injection → sanitize pipeline re-ran for messages frozen minutes
 * ago. Forty messages × one hundred fifty deltas is roughly six thousand
 * sanitize passes for ONE agent message, each instantiating a DOM.
 *
 * The cache key is `${cacheKey}::${raw.length}`: a chat message only ever grows
 * by appending, so its length is a sound content fingerprint and a frozen
 * message hits the cache forever. `cacheKey` must therefore carry everything
 * else the render depends on (the message id AND the known document paths).
 */
export function renderChatMarkdownCached(
  cacheKey: string,
  raw: string,
  render: (raw: string) => string = (text) => renderChatMarkdown(text),
): string {
  const key = `${cacheKey}::${raw.length}`
  const hit = renderCache.get(key)
  if (hit !== undefined) return hit
  const html = render(raw)
  renderCache.set(key, html)
  if (renderCache.size > RENDER_CACHE_LIMIT) {
    // Map preserves insertion order, so the first key is the oldest one.
    const oldest = renderCache.keys().next().value
    if (oldest !== undefined) renderCache.delete(oldest)
  }
  return html
}

/** Empty the memo. Tests only — production never needs to invalidate. */
export function resetChatMarkdownCache(): void {
  renderCache.clear()
}

/**
 * Escape a still-streaming message for direct display. While the engine types,
 * the text is a truncated markdown fragment anyway (an unterminated code fence,
 * half a table row), so parsing it is both wasted work and visually unstable.
 * Escaped plain text with <br> line breaks is what the reader actually wants
 * until the message closes and the full pipeline runs once.
 */
export function escapeStreamingText(raw: string): string {
  return raw.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')
}
