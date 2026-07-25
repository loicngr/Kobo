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

/** Non-internal IPv4 URLs for the running server, for display + QR. */
export function getLanUrls(port: number): string[] {
  const urls: string[] = []
  for (const infos of Object.values(os.networkInterfaces())) {
    if (!infos) continue
    for (const info of infos) {
      if (info.family === 'IPv4' && !info.internal) {
        urls.push(`http://${info.address}:${port}`)
      }
    }
  }
  return urls
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
