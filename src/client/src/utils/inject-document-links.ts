/**
 * Walks a parsed HTML fragment and wraps every literal occurrence of one
 * of the supplied paths in an anchor with class `document-link` and a
 * `data-document-path` attribute. Consumers attach a delegated click
 * handler that reads the attribute and opens the matching document in
 * the Documents panel.
 *
 * Safer than string `replace` because it doesn't double-wrap inside
 * existing anchors, it skips `<a>` sub-trees, and it keeps the full HTML
 * structure (paragraphs, lists, inline code, …) intact.
 */
export function injectDocumentLinks(html: string, docPaths: readonly string[]): string {
  if (docPaths.length === 0 || html.length === 0) return html
  // Sort longer paths first so a file nested under a folder whose name is
  // also a shorter path never gets eaten by the shorter match.
  const paths = [...docPaths].sort((a, b) => b.length - a.length)

  const parser = new DOMParser()
  const doc = parser.parseFromString(`<div>${html}</div>`, 'text/html')
  const root = doc.body.firstChild as HTMLElement | null
  if (!root) return html

  function walk(node: Node): void {
    if (node.nodeType === Node.TEXT_NODE) {
      replaceInTextNode(node as Text, paths, doc)
      return
    }
    if (node.nodeName === 'A') return // already a link — leave it alone
    const children = Array.from(node.childNodes)
    for (const child of children) walk(child)
  }
  walk(root)
  return root.innerHTML
}

function replaceInTextNode(node: Text, paths: readonly string[], doc: Document): void {
  const text = node.textContent ?? ''
  // Quick reject — avoid the fragment-building path when no match.
  if (!paths.some((p) => text.includes(p))) return

  const frag = doc.createDocumentFragment()
  let cursor = 0
  while (cursor < text.length) {
    const match = findEarliestMatch(text, cursor, paths)
    if (!match) {
      frag.appendChild(doc.createTextNode(text.slice(cursor)))
      break
    }
    if (match.index > cursor) {
      frag.appendChild(doc.createTextNode(text.slice(cursor, match.index)))
    }
    const link = doc.createElement('a')
    link.className = 'document-link'
    link.setAttribute('data-document-path', match.path)
    link.setAttribute('href', '#')
    link.textContent = match.path
    frag.appendChild(link)
    cursor = match.index + match.path.length
  }
  node.parentNode?.replaceChild(frag, node)
}

function findEarliestMatch(
  text: string,
  from: number,
  paths: readonly string[],
): { index: number; path: string } | null {
  let best: { index: number; path: string } | null = null
  for (const p of paths) {
    const idx = text.indexOf(p, from)
    if (idx < 0) continue
    if (!best || idx < best.index || (idx === best.index && p.length > best.path.length)) {
      best = { index: idx, path: p }
    }
  }
  return best
}
