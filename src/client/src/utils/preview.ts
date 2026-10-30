import type { RouteLocationNormalized } from 'vue-router'

export function readPreviewPercent(value: string | null): number {
  const number = value === null ? 45 : Number(value)
  return Number.isFinite(number) ? Math.max(20, Math.min(80, number)) : 45
}

/** Never send a remote browser to its own loopback or a Docker-only hostname. */
export function previewBrowserUrl(value: string, page: string, remote: boolean): string {
  const url = new URL(value)
  const current = new URL(page)
  const local = (host: string) => ['localhost', '127.0.0.1', '[::1]'].includes(host)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.origin === current.origin)
    throw new Error('Invalid preview origin')
  if (!remote && (!local(current.hostname) || !local(url.hostname)))
    throw new Error('Configure HTTPS preview access for this remote instance')
  // A dedicated loopback hostname keeps Kōbō cookies off the project's HTTP server.
  if (!remote) url.hostname = 'kobo-preview.localhost'
  else if (url.hostname === current.hostname) throw new Error('Preview and Kōbō must use different hosts')
  if (current.protocol === 'https:' && url.protocol !== 'https:') throw new Error('The preview must use HTTPS')
  return url.href
}

/** Layout-only navigation keeps the same mounted chat and its unsaved draft. */
export function isWorkspacePreviewNavigation(
  to: Pick<RouteLocationNormalized, 'name' | 'params' | 'query' | 'hash'>,
  from: Pick<RouteLocationNormalized, 'name' | 'params' | 'query' | 'hash'>,
): boolean {
  if (
    to.name !== 'workspace' ||
    from.name !== 'workspace' ||
    typeof to.params.id !== 'string' ||
    !to.params.id ||
    to.params.id !== from.params.id ||
    to.hash !== from.hash
  )
    return false
  for (const route of [to, from]) {
    if (route.params.view && route.params.view !== 'preview') return false
    if (route.query.preview !== undefined && route.query.preview !== 'split') return false
  }
  const rest = (query: typeof to.query) =>
    JSON.stringify(
      Object.entries(query)
        .filter(([key]) => key !== 'preview')
        .sort(([a], [b]) => a.localeCompare(b)),
    )
  return rest(to.query) === rest(from.query)
}
