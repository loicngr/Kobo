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
}): NetworkAccessDecision {
  if (isLoopbackAddress(params.address)) return { allow: true, status: 200 }
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
  }).allow
}
