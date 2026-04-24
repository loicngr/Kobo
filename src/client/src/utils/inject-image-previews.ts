/**
 * Replace `[image: <path>]` placeholders produced by ChatInput's upload flow
 * with standard markdown image syntax (`![<path>](<url>)`) so a downstream
 * Markdown renderer (`marked`) produces an `<img>` tag.
 *
 * Inputs:
 * - `content`: raw message text, as sent by the user (mixes plain text + tokens)
 * - `workspaceId`: workspace the message belongs to — resolves the file URL
 *
 * The URL targets the backend image-serving endpoint; the path is query-encoded
 * so spaces / special chars don't break the URL. The alt text is kept as the
 * original path so screen readers and fallback renderers get something readable.
 *
 * Only paths that look like the upload output (`.ai/images/…` or `images/…`)
 * are rewritten; other `[image: …]` tokens the user might have typed by hand
 * pass through unchanged to avoid false positives.
 */
export function injectImagePreviews(content: string, workspaceId: string): string {
  if (!workspaceId) return content
  return content.replace(/\[image:\s+([^\]]+)\]/g, (match, rawPath) => {
    const trimmed = String(rawPath).trim()
    // Only rewrite paths that match the upload storage layout. Anything else
    // (e.g. a user typing `[image: my idea]`) is left as-is.
    if (!/^(\.ai\/images\/|images\/)/.test(trimmed)) return match
    const url = `/api/workspaces/${encodeURIComponent(workspaceId)}/images/file?path=${encodeURIComponent(trimmed)}`
    return `![${trimmed}](${url})`
  })
}
