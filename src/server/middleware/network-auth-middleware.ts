import { getConnInfo } from '@hono/node-server/conninfo'
import type { MiddlewareHandler } from 'hono'
import { evaluateNetworkAccess } from '../services/network-access-service.js'
import { getGlobalSettings } from '../services/settings-service.js'

/**
 * Gates non-loopback requests behind the network-access token.
 *
 * Loopback requests always pass (the host machine's own usage is frictionless).
 * The client IP comes only from the OS socket via getConnInfo, never from
 * X-Forwarded-For, so a remote client cannot spoof a loopback address.
 */
export const networkAuthMiddleware: MiddlewareHandler = async (c, next) => {
  const address = getConnInfo(c).remote.address
  const global = getGlobalSettings()
  const decision = evaluateNetworkAccess({
    address,
    enabled: global.networkAccessEnabled,
    expectedToken: global.networkAccessToken,
    providedToken: c.req.header('X-Kobo-Token'),
  })
  if (decision.allow) return next()
  // Surface denied requests so "my device can't connect" is debuggable.
  // Never log the token itself, only the reason and the remote address.
  const reason = decision.status === 403 ? 'network access disabled' : 'missing/invalid token'
  console.warn(
    `[network-auth] HTTP ${decision.status} (${reason}) from ${address ?? 'unknown'} ${c.req.method} ${c.req.path}`,
  )
  return c.json({ error: 'unauthorized' }, decision.status as 401 | 403)
}
