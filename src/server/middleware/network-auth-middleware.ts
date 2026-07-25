import { getConnInfo } from '@hono/node-server/conninfo'
import type { MiddlewareHandler } from 'hono'
import { evaluateNetworkAccess } from '../services/network-access-service.js'
import { getGlobalSettings } from '../services/settings-service.js'

/**
 * Gates non-loopback requests behind the network-access token.
 *
 * Loopback requests pass without a token (the host machine's own usage is
 * frictionless) — unless `networkAccessBehindProxy` is enabled, in which case
 * loopback is treated like any other address (see network-access-service.ts).
 * The client IP comes only from the OS socket via getConnInfo, never from
 * X-Forwarded-For, so a remote client cannot spoof a loopback address.
 *
 * `/api/health` is always exempt, regardless of `networkAccessBehindProxy`:
 * it exposes only `{ status, version }` (nothing sensitive), and Docker's own
 * HEALTHCHECK / a Compose healthcheck / an orchestrator's liveness probe has
 * no way to supply the runtime-generated token — without this exemption, a
 * "behind a reverse proxy" deployment's own container never reports healthy.
 */
export const networkAuthMiddleware: MiddlewareHandler = async (c, next) => {
  if (c.req.path === '/api/health') return next()
  const address = getConnInfo(c).remote.address
  const global = getGlobalSettings()
  const decision = evaluateNetworkAccess({
    address,
    enabled: global.networkAccessEnabled,
    expectedToken: global.networkAccessToken,
    providedToken: c.req.header('X-Kobo-Token'),
    trustLoopback: !global.networkAccessBehindProxy,
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
