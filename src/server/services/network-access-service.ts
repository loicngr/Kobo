import crypto from 'node:crypto'
import os from 'node:os'

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/** True for loopback remote addresses. Undefined → false (deny-safe). */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false
  return LOOPBACK_ADDRESSES.has(address)
}

/** Bind host for `serve()`: localhost-only when disabled, all interfaces when enabled. */
export function resolveBindHost(enabled: boolean): string | undefined {
  return enabled ? undefined : '127.0.0.1'
}

/**
 * Non-internal addresses of the running server, one per LAN interface. Both
 * families: with network access on, the server binds every interface, so an
 * IPv6 address is as legitimate a way to reach it as an IPv4 one. A scoped
 * link-local address (`fe80::1%eth0`) loses its zone, which is the form a URL
 * carries.
 */
export function getLanHostnames(): string[] {
  return collectLanAddresses(null)
}

/**
 * Non-internal IPv4 URLs for the running server, for display + QR. IPv4 only:
 * these are meant to be read off a screen or scanned from a phone, and an IPv6
 * literal is neither.
 */
export function getLanUrls(port: number): string[] {
  return collectLanAddresses('IPv4').map((address) => `http://${address}:${port}`)
}

function collectLanAddresses(family: 'IPv4' | null): string[] {
  const addresses: string[] = []
  for (const infos of Object.values(os.networkInterfaces())) {
    if (!infos) continue
    for (const info of infos) {
      if (info.internal) continue
      if (family !== null && info.family !== family) continue
      // A scoped link-local address (`fe80::1%eth0`) loses its zone, which is
      // the form a URL carries.
      addresses.push(info.address.split('%')[0])
    }
  }
  return addresses
}

/**
 * Hostnames that always designate the host machine itself. A request or a page
 * carrying one of these is, by construction, already running on the user's own
 * machine, whatever port it came from — which is what keeps the Quasar dev
 * server (localhost:8080 proxying to localhost:3000) working.
 */
// `::ffff:7f00:1` is what the URL parser normalises `::ffff:127.0.0.1` into,
// so both spellings of the IPv4-mapped loopback land here.
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1'])

/**
 * Hostname carried by a raw `Host` or `Origin` header, or null when the value
 * cannot be parsed. `Host` arrives bare (`127.0.0.1:3000`), `Origin` with a
 * scheme (`http://127.0.0.1:3000`); adding a scheme when none is present runs
 * both through the same URL rules, including the bracketed IPv6 form.
 */
function headerHostname(value: string): string | null {
  try {
    const hostname = new URL(value.includes('://') ? value : `http://${value}`).hostname
    if (!hostname) return null
    // The URL parser keeps IPv6 hostnames bracketed; compare on the bare address.
    return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
  } catch {
    return null
  }
}

/**
 * True when a raw `Host`/`Origin` value names the machine itself. Always
 * allowed, whatever the settings say, which lets a caller settle the common
 * case without reading the settings file or listing the network interfaces —
 * both synchronous, and this runs on every request.
 */
export function isLocalRequestHost(value: string | undefined): boolean {
  if (!value) return false
  const hostname = headerHostname(value)
  return hostname !== null && LOCAL_HOSTNAMES.has(hostname)
}

function isAllowedHostname(hostname: string | null, enabled: boolean, lanHostnames: string[]): boolean {
  if (!hostname) return false
  if (LOCAL_HOSTNAMES.has(hostname)) return true
  return enabled && lanHostnames.includes(hostname)
}

/**
 * Guards against DNS rebinding: a page on `evil.com` whose domain re-resolves
 * to 127.0.0.1 reaches this server with `Host: evil.com`, and the browser then
 * treats every response as same-origin. Only the names by which the machine is
 * legitimately reachable are accepted — its own loopback names, plus its LAN
 * addresses once network access is enabled.
 *
 * Behind a reverse proxy the Host is whatever domain the operator chose, and we
 * have no way to know it, so the check is skipped there. That mode also turns
 * off the loopback exemption, so every `/api/*` request has to carry the token,
 * which a rebinding page cannot obtain.
 *
 * Known residual risk in that mode: the SPA shell itself is served outside
 * `/api/*` and therefore behind no token at all, so a rebinding page can get
 * the real interface served on its own origin and ask the user to paste their
 * token into it. Closing that needs the operator to declare the expected
 * hostname; until then, proxy deployments must authenticate at the proxy.
 */
export function isAllowedRequestHost(params: {
  host: string | undefined
  enabled: boolean
  lanHostnames: string[]
  behindProxy?: boolean
  /** Hostname the operator's proxy serves Kōbō under, when declared. */
  proxyHostname?: string | null
}): boolean {
  if (!params.host) return false
  const hostname = headerHostname(params.host)
  if (params.behindProxy) {
    // No declared hostname means we cannot tell the operator's domain from an
    // attacker's, so anything goes — the historical behaviour.
    if (!params.proxyHostname) return true
    return hostname === params.proxyHostname || (hostname !== null && LOCAL_HOSTNAMES.has(hostname))
  }
  return isAllowedHostname(hostname, params.enabled, params.lanHostnames)
}

/**
 * Hostname declared via `KOBO_NETWORK_ACCESS_PROXY_HOST`, or null when unset.
 *
 * Behind a reverse proxy we otherwise have to accept any Host, which leaves the
 * door open to a rebinding page being served the real interface and asking the
 * user to paste their token into it. Declaring the domain the proxy serves
 * closes that, and costs one environment variable in the compose file where
 * the other network-access settings already live.
 */
export function resolveProxyHostname(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.KOBO_NETWORK_ACCESS_PROXY_HOST?.trim()
  if (!raw) return null
  return headerHostname(raw)
}

/**
 * Names the site a request was driven from. Guards two things.
 *
 * The WebSocket upgrade: WebSockets are exempt from the same-origin policy and
 * send no preflight, so without this any page the user visits could open
 * `/ws/terminal/<id>` and drive a real shell on the host.
 *
 * And cross-site writes: a page on another site reaching `http://localhost:3000`
 * sends a perfectly legitimate `Host: localhost:3000` — the browser puts it
 * there — so the Host check cannot see it. Reading the reply is already blocked
 * (we send no CORS headers), but the write would still land, because Hono parses
 * a JSON body whatever the Content-Type: a `text/plain` POST is a CORS simple
 * request and needs no preflight.
 *
 * A missing Origin is allowed. Browsers attach one to every WebSocket handshake
 * and every state-changing request, so its absence means a non-browser caller —
 * curl, or Kōbō's own MCP server calling back into the API. Such a caller on
 * loopback already has the machine, and over the LAN still needs the token.
 *
 * Note this is per-host, not per-port: any page served from a loopback port
 * counts as local, including the dev servers Kōbō itself spawns.
 */
export function isAllowedOrigin(params: {
  origin: string | undefined
  enabled: boolean
  lanHostnames: string[]
  behindProxy?: boolean
  /**
   * Ports a page may be served from and still be trusted. Omitted means any
   * port, which is only right where the port carries no meaning.
   */
  allowedPorts?: number[]
}): boolean {
  if (params.behindProxy) return true
  if (params.origin === undefined) return true
  if (params.allowedPorts) {
    const port = originPort(params.origin)
    if (port === null || !params.allowedPorts.includes(port)) return false
  }
  return isAllowedHostname(headerHostname(params.origin), params.enabled, params.lanHostnames)
}

/** Port an origin resolves to, falling back to the scheme's implicit one. */
function originPort(origin: string): number | null {
  try {
    const url = new URL(origin)
    if (url.port) return Number(url.port)
    return url.protocol === 'https:' ? 443 : 80
  } catch {
    return null
  }
}

/** Ports the Quasar dev server binds; it proxies /api and /ws to the backend. */
const QUASAR_DEV_PORTS = [8080, 9000]

/**
 * Ports a local page may be served from and still count as Kōbō's own UI.
 *
 * Being on loopback is not enough on its own: Kōbō starts a dev server per
 * workspace, on a loopback port, serving whatever code an agent just wrote.
 * Without this, such a page would be as trusted as the real interface and could
 * open a terminal WebSocket or drive a cross-site write.
 *
 * In development the browser sits on the Quasar port and proxies through to the
 * backend, so that is the origin we see — trusted only when `npm run dev` set
 * `KOBO_ENFORCE_LOCAL_HOME`, never in a published build.
 */
export function trustedLocalOriginPorts(backendPort: number): number[] {
  return process.env.KOBO_ENFORCE_LOCAL_HOME === '1' ? [backendPort, ...QUASAR_DEV_PORTS] : [backendPort]
}

/** ~32-char url-safe random token. */
export function generateToken(): string {
  return crypto.randomBytes(24).toString('base64url')
}

/** Constant-time token comparison; false on empty/length mismatch (never throws). */
export function tokenMatches(provided: string | undefined, expected: string): boolean {
  if (!provided || !expected) return false
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

export interface NetworkAccessDecision {
  allow: boolean
  status: 200 | 401 | 403
}

/** Core gate decision shared by the HTTP middleware and the WS upgrade guard. */
export function evaluateNetworkAccess(params: {
  address: string | undefined
  enabled: boolean
  expectedToken: string
  providedToken: string | undefined
  /**
   * When false, loopback addresses are NOT automatically trusted — they fall
   * through to the normal enabled/token checks like any other address.
   * Defaults to true (today's behavior) so every caller that omits it is
   * unaffected. Set to false when Kōbō runs behind a reverse proxy, where a
   * proxied request can appear to originate from loopback.
   */
  trustLoopback?: boolean
}): NetworkAccessDecision {
  const trustLoopback = params.trustLoopback ?? true
  if (trustLoopback && isLoopbackAddress(params.address)) return { allow: true, status: 200 }
  if (!params.enabled) return { allow: false, status: 403 }
  if (tokenMatches(params.providedToken, params.expectedToken)) return { allow: true, status: 200 }
  return { allow: false, status: 401 }
}

/** WS upgrade authorization: parses `?token=` from the raw URL. */
export function authorizeWsUpgrade(params: {
  address: string | undefined
  rawUrl: string | undefined
  enabled: boolean
  expectedToken: string
  trustLoopback?: boolean
}): boolean {
  let providedToken: string | undefined
  try {
    providedToken = new URL(params.rawUrl ?? '/', 'http://localhost').searchParams.get('token') ?? undefined
  } catch {
    providedToken = undefined
  }
  return evaluateNetworkAccess({
    address: params.address,
    enabled: params.enabled,
    expectedToken: params.expectedToken,
    providedToken,
    trustLoopback: params.trustLoopback,
  }).allow
}

/**
 * Reads KOBO_NETWORK_ACCESS_ENABLED / KOBO_NETWORK_ACCESS_BEHIND_PROXY and
 * returns only the fields an env var actually specifies — an unset env var
 * means "leave current settings alone" (key omitted from the result); a SET
 * env var always produces a decisive true/false, even for a value that isn't
 * literally "true"/"1" (an explicit non-true value is a deliberate "off",
 * not "don't touch"). Re-applied on every server boot — see index.ts.
 */
export function resolveNetworkAccessEnvOverrides(env: NodeJS.ProcessEnv): {
  networkAccessEnabled?: boolean
  networkAccessBehindProxy?: boolean
} {
  const overrides: { networkAccessEnabled?: boolean; networkAccessBehindProxy?: boolean } = {}
  if (env.KOBO_NETWORK_ACCESS_ENABLED !== undefined) {
    overrides.networkAccessEnabled =
      env.KOBO_NETWORK_ACCESS_ENABLED === 'true' || env.KOBO_NETWORK_ACCESS_ENABLED === '1'
  }
  if (env.KOBO_NETWORK_ACCESS_BEHIND_PROXY !== undefined) {
    overrides.networkAccessBehindProxy =
      env.KOBO_NETWORK_ACCESS_BEHIND_PROXY === 'true' || env.KOBO_NETWORK_ACCESS_BEHIND_PROXY === '1'
  }
  return overrides
}
