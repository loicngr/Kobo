import { boot } from 'quasar/wrappers'
import { getToken, setToken, shouldAttachToken } from 'src/utils/auth-token'
import { openNetworkLogin } from 'src/utils/network-login-bus'

export default boot(() => {
  // 1. One-scan QR connect: a `?token=` in the URL → store it then strip it.
  const params = new URLSearchParams(window.location.search)
  const urlToken = params.get('token')
  if (urlToken) {
    setToken(urlToken)
    params.delete('token')
    const qs = params.toString()
    const clean = window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash
    window.history.replaceState({}, '', clean)
  }

  // 2. Wrap fetch: inject the token header on /api/ calls, open login on 401.
  const nativeFetch = window.fetch.bind(window)
  const wrappedFetch: typeof window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    let nextInit = init
    const token = getToken()
    if (token && shouldAttachToken(url)) {
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
      // Don't clobber a token a caller set explicitly (e.g. the login dialog
      // validating a freshly-typed candidate while a stale token is still stored).
      if (!headers.has('X-Kobo-Token')) headers.set('X-Kobo-Token', token)
      nextInit = { ...init, headers }
    }
    const res = await nativeFetch(input, nextInit)
    if (res.status === 401 && shouldAttachToken(url)) {
      openNetworkLogin()
    }
    return res
  }
  window.fetch = wrappedFetch
})
