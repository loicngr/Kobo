import type { ForgeId } from '../services/forge/types.js'

export function commitWebUrl(remote: string, forge: ForgeId, sha: string): string | null {
  if (!/^[a-f0-9]{40}$/i.test(sha) || forge === 'none') return null
  try {
    const normalized = remote.replace(/^[^/@:]+@([^/:]+):(.+)$/, 'https://$1/$2')
    const url = new URL(normalized)
    if (!['https:', 'http:', 'ssh:'].includes(url.protocol)) return null
    const path = url.pathname.replace(/\.git\/?$/, '').replace(/\/$/, '')
    if (!path || path === '/') return null
    // Never copy remote credentials into a browser URL.
    return `${url.protocol === 'ssh:' ? 'https:' : url.protocol}//${url.protocol === 'ssh:' ? url.hostname : url.host}${path}/${forge === 'gitlab' ? '-/commit' : forge === 'bitbucket-community' ? 'commits' : 'commit'}/${sha}`
  } catch {
    return null
  }
}
