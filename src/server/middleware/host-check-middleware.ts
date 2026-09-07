import type { MiddlewareHandler } from 'hono'
import {
  getLanHostnames,
  isAllowedOrigin,
  isAllowedRequestHost,
  isLocalRequestHost,
  resolveDevClientOrigin,
  resolveProxyHostname,
} from '../services/network-access-service.js'
import { getGlobalSettings } from '../services/settings-service.js'

/**
 * Rejects requests addressed to a hostname this server is not legitimately
 * reachable at — the defense against DNS rebinding.
 *
 * A page on `evil.com` can make the domain re-resolve to 127.0.0.1 after it
 * loads. Every later request then reaches Kōbō with `Host: evil.com`, and the
 * browser treats the responses as same-origin, so the page can read them. The
 * loopback address the connection arrives from is genuine, which is why the
 * network-access gate lets it through: only the Host header distinguishes this
 * from the user's own tab.
 *
 * `/api/health` is exempt, mirroring the network-access gate: it returns only
 * `{ status, version }`, and a container healthcheck reaches it through the
 * service name rather than localhost.
 *
 * The host comes from `c.req.url`, which the Node adapter builds from the Host
 * header itself, so this reads the client-supplied value without depending on
 * header casing.
 */
export const hostCheckMiddleware: MiddlewareHandler = async (c, next) => {
  if (c.req.path === '/api/health') return next()

  let host: string | undefined
  try {
    host = new URL(c.req.url).host
  } catch {
    host = undefined
  }
  const origin = c.req.header('origin')

  // Fast path. This middleware runs on every request, static assets included,
  // and the calls below are a synchronous settings read plus an interface
  // enumeration. A request addressed to loopback and carrying no Origin (a
  // static asset, a direct navigation, a CLI call) is the common case and is
  // allowed whatever the settings say, so settle it here.
  if (origin === undefined && isLocalRequestHost(host)) return next()

  const devOrigin = resolveDevClientOrigin()

  // A page we served ourselves, talking to us: still no settings needed.
  if (isLocalRequestHost(host) && isAllowedOrigin({ origin, requestHost: host, devOrigin })) {
    return next()
  }

  let global: { networkAccessEnabled: boolean; networkAccessBehindProxy: boolean }
  let lanHostnames: string[]
  try {
    global = getGlobalSettings()
    lanHostnames = getLanHostnames()
  } catch (err) {
    // An unreadable settings file must not take the whole app down. Loopback
    // was already answered above, so anything reaching here is remote and
    // fails closed.
    console.error('[host-check] Could not resolve the allowed hosts — refusing:', err)
    return c.json({ error: 'forbidden host' }, 403)
  }

  if (
    !isAllowedRequestHost({
      host,
      enabled: global.networkAccessEnabled,
      lanHostnames,
      behindProxy: global.networkAccessBehindProxy,
      proxyHostname: resolveProxyHostname(),
    })
  ) {
    // Surface it: "the page just stopped loading" is otherwise undebuggable.
    console.warn(`[host-check] 403 (forbidden host '${host ?? 'unknown'}') ${c.req.method} ${c.req.path}`)
    return c.json({ error: 'forbidden host' }, 403)
  }

  if (
    !isAllowedOrigin({
      origin,
      requestHost: host,
      behindProxy: global.networkAccessBehindProxy,
      proxyHostname: resolveProxyHostname(),
      devOrigin,
    })
  ) {
    console.warn(`[origin-check] 403 (forbidden origin '${origin}') ${c.req.method} ${c.req.path}`)
    return c.json({ error: 'forbidden origin' }, 403)
  }

  return next()
}
