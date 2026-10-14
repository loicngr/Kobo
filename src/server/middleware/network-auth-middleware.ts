import { getConnInfo } from '@hono/node-server/conninfo'
import type { MiddlewareHandler } from 'hono'
import { getCookie } from 'hono/cookie'
import { evaluateNetworkAccess, isLoopbackAddress } from '../services/network-access-service.js'
import { browserCookieName, getBrowserSession } from '../services/network-session-service.js'
import { getGlobalSettings } from '../services/settings-service.js'

/** Socket addresses are authoritative; forwarded headers never establish trust. */
export const networkAuthMiddleware: MiddlewareHandler = async (c, next) => {
  if (c.req.path === '/api/health') return next()
  const address = getConnInfo(c).remote.address
  const policy = getGlobalSettings()
  const loopback = isLoopbackAddress(address)
  // These two transports authenticate themselves, with credentials that cannot
  // authorize any other HTTP route. Internal capabilities never cross the network.
  if (/^\/api\/internal-mcp(?:\/|$)/.test(c.req.path)) {
    if (c.req.method !== 'POST' || !loopback) return c.json({ error: 'unauthorized' }, 403)
    return next()
  }
  if (c.req.path === '/api/mcp' || c.req.path === '/api/mcp/') {
    if (!policy.networkAccessEnabled && (!loopback || policy.networkAccessBehindProxy))
      return c.json({ error: 'unauthorized' }, 403)
    return next()
  }
  // Supplying an MCP credential never becomes operator authority, even where
  // unauthenticated local operator requests are normally trusted.
  if (
    /^Bearer\s+kobo_mcp_/i.test(c.req.header('Authorization') ?? '') ||
    c.req.header('X-Kobo-Token')?.startsWith('kobo_mcp_')
  ) {
    return c.json({ error: 'Operator credential required' }, 401)
  }
  const session = getBrowserSession(getCookie(c, browserCookieName(policy)), policy)
  const decision = evaluateNetworkAccess({
    address,
    enabled: policy.networkAccessEnabled,
    expectedToken: policy.networkAccessToken,
    providedToken: session ? policy.networkAccessToken : c.req.header('X-Kobo-Token'),
    trustLoopback: !policy.networkAccessBehindProxy,
  })
  if (decision.allow) return next()
  return c.json({ error: 'unauthorized' }, decision.status as 401 | 403)
}

/** Mount after the initial auth gate and body limits, before operator routes.
 * Acceptance happens only after the complete bounded request has arrived.
 * MCP transports implement their own equivalent live-credential checks.
 */
export const operatorDispatchAuthMiddleware: MiddlewareHandler = async (c, next) => {
  if (/^\/api\/(?:internal-)?mcp(?:\/|$)/.test(c.req.path)) return next()
  if (c.req.raw.body) {
    const original = c.req.raw
    let body: ArrayBuffer
    try {
      body = await original.arrayBuffer()
    } catch {
      return c.json({ error: 'Invalid request body' }, 400)
    }
    // Preserve raw consumers (multipart uploads and workspace creation), as
    // well as Hono's json/formData helpers. The initial limits ran beforehand.
    c.req.raw = new Request(original, { body })
  }
  return networkAuthMiddleware(c, next)
}
