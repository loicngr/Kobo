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
