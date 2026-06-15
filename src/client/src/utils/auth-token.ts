const STORAGE_KEY = 'kobo:network-token'

export function getToken(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

export function setToken(token: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, token)
  } catch {
    // best-effort
  }
}

export function clearToken(): void {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    // best-effort
  }
}

/** Whether the token header should be attached to this request URL. */
export function shouldAttachToken(url: string): boolean {
  try {
    const u = new URL(url, window.location.origin)
    return u.origin === window.location.origin && u.pathname.startsWith('/api/')
  } catch {
    return typeof url === 'string' && url.startsWith('/api/')
  }
}

/** Append the token as a query param to a WS URL (browsers can't set WS headers). */
export function appendTokenToWsUrl(wsUrl: string, token: string | null): string {
  if (!token) return wsUrl
  const sep = wsUrl.includes('?') ? '&' : '?'
  return `${wsUrl}${sep}token=${encodeURIComponent(token)}`
}
