/** Active previews and lightboxes share a fetch and retain the Blob until the last release. */
export interface ImageLease {
  ready: Promise<string>
  release(): void
}
interface Entry {
  references: number
  controller: AbortController
  ready: Promise<string>
  blobUrl?: string
}
const entries = new Map<string, Entry>()

export function clearAuthenticatedImages(): void {
  for (const entry of entries.values()) {
    entry.controller.abort()
    if (entry.blobUrl) URL.revokeObjectURL(entry.blobUrl)
  }
  entries.clear()
}

if (typeof window !== 'undefined') {
  window.addEventListener('kobo:auth-token-changed', clearAuthenticatedImages)
  window.addEventListener('storage', (event) => {
    if (event.key === 'kobo:network-token' || event.key === null) clearAuthenticatedImages()
  })
}

export function acquireAuthenticatedImage(path: string): ImageLease {
  if (!/^\/api\/workspaces\/[^/]+\/images\/file\?path=/.test(path)) throw new Error('Invalid workspace image URL')
  let entry = entries.get(path)
  if (!entry) {
    const controller = new AbortController()
    const current: Entry = { references: 0, controller, ready: Promise.resolve('') }
    const timeout = setTimeout(() => controller.abort(), 30_000)
    // window.fetch is wrapped by network-auth: no token in the image URL.
    current.ready = fetch(path, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const blob = await response.blob()
        if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError')
        current.blobUrl = URL.createObjectURL(blob)
        return current.blobUrl
      })
      .finally(() => clearTimeout(timeout))
    entry = current
    entries.set(path, entry)
  }
  entry.references++
  let released = false
  const owned = entry
  return {
    ready: owned.ready,
    release() {
      if (released) return
      released = true
      if (--owned.references > 0) return
      owned.controller.abort()
      if (owned.blobUrl) URL.revokeObjectURL(owned.blobUrl)
      if (entries.get(path) === owned) entries.delete(path)
    },
  }
}
