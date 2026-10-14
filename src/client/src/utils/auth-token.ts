import { openNetworkLogin } from './network-login-bus'

// A request started with an earlier cookie must not reopen login after a
// successful session exchange. Responses remain unchanged; writes are never replayed.
let authenticationEpoch = 0

export function getAuthenticationEpoch(): number {
  return authenticationEpoch
}

export function openNetworkLoginForEpoch(epoch: number): void {
  if (epoch === authenticationEpoch) openNetworkLogin()
}

/** Consume and erase a pre-session credential before any application request. */
export function consumeBootstrapToken(): string | null {
  const params = new URLSearchParams(window.location.search)
  const fragment = new URLSearchParams(window.location.hash.slice(1))
  let legacy: string | null = null
  try {
    legacy = localStorage.getItem('kobo:network-token')
    localStorage.removeItem('kobo:network-token')
  } catch {
    /* Storage may be unavailable. */
  }
  const token = fragment.get('token') ?? params.get('token') ?? legacy
  if (params.has('token') || fragment.has('token')) {
    params.delete('token')
    const query = params.toString()
    window.history.replaceState(
      {},
      '',
      window.location.pathname + (query ? `?${query}` : '') + (fragment.has('token') ? '' : window.location.hash),
    )
  }
  return token
}

export function isSameOriginApi(url: string): boolean {
  try {
    const parsed = new URL(url, window.location.origin)
    return parsed.origin === window.location.origin && parsed.pathname.startsWith('/api/')
  } catch {
    return false
  }
}

export async function authenticateBrowser(token: string): Promise<Response> {
  const response = await window.fetch('/api/auth/session', {
    method: 'POST',
    headers: { 'X-Kobo-Token': token },
    credentials: 'same-origin',
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  })
  if (response.ok) {
    authenticationEpoch++
    window.dispatchEvent(new Event('kobo:auth-token-changed'))
  }
  return response
}

/** A ticket is scoped to one upgrade, expires in 60 seconds and is never stored. */
export async function authenticatedWebSocketUrl(path: string): Promise<string> {
  if (!/^\/ws(?:\/terminal\/[A-Za-z0-9_-]{1,200})?$/.test(path)) throw new Error('Invalid WebSocket path')
  const epoch = getAuthenticationEpoch()
  const response = await window.fetch('/api/auth/ws-ticket', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
    credentials: 'same-origin',
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) {
    if (response.status === 401) openNetworkLoginForEpoch(epoch)
    throw new Error(`WebSocket authentication failed (${response.status})`)
  }
  const body = (await response.json()) as { ticket?: unknown }
  if (typeof body.ticket !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(body.ticket))
    throw new Error('Invalid WebSocket ticket')
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${window.location.host}${path}?ticket=${encodeURIComponent(body.ticket)}`
}
