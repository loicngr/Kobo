import {
  authenticateBrowser,
  consumeBootstrapToken,
  getAuthenticationEpoch,
  isSameOriginApi,
  openNetworkLoginForEpoch,
} from 'src/utils/auth-token'
import { defineBoot } from '#q-app'

export default defineBoot(async () => {
  // Erase credentials from both legacy storage and the address before any I/O.
  const token = consumeBootstrapToken()
  const nativeFetch = window.fetch.bind(window)
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const epoch = getAuthenticationEpoch()
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const response = await nativeFetch(input, init)
    if (response.status === 401 && isSameOriginApi(url)) openNetworkLoginForEpoch(epoch)
    return response
  }
  if (token) {
    const epoch = getAuthenticationEpoch()
    try {
      if (!(await authenticateBrowser(token)).ok) openNetworkLoginForEpoch(epoch)
    } catch {
      openNetworkLoginForEpoch(epoch)
    }
  }
})
