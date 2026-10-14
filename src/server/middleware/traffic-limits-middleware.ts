import { getConnInfo } from '@hono/node-server/conninfo'
import type { MiddlewareHandler } from 'hono'
import { bodyLimit } from 'hono/body-limit'

/** Bounded process-local limits, keyed by OS peers, never attacker-controlled forwarded IPs. */
export function trafficLimitsMiddleware(): MiddlewareHandler {
  const peers = new Map<string, { reset: number; requests: number; logins: number }>()
  let activeMcp = 0
  let activeLargeMcp = 0
  return async (c, next) => {
    if (c.req.path === '/api/health') return next()
    const now = Date.now()
    const address = getConnInfo(c).remote.address ?? 'unknown'
    let peer = peers.get(address)
    if (!peer || peer.reset <= now) {
      for (const [key, value] of peers) if (value.reset <= now) peers.delete(key)
      if (peers.size >= 4096 && !peers.has(address)) return c.json({ error: 'Too many clients' }, 429)
      peer = { reset: now + 60_000, requests: 0, logins: 0 }
      peers.set(address, peer)
    }
    if (
      ++peer.requests > 3000 ||
      (c.req.path === '/api/auth/session' && c.req.method === 'POST' && ++peer.logins > 20)
    ) {
      c.header('Retry-After', String(Math.max(1, Math.ceil((peer.reset - now) / 1000))))
      return c.json({ error: 'Too many requests' }, 429)
    }
    const mcp = /^\/api\/(?:internal-)?mcp\/?$/.test(c.req.path)
    // Node rejects mismatched Content-Length framing. Unknown/chunked lengths
    // reserve a large-body slot until completion without reading any bytes.
    const length = c.req.header('Content-Length')
    const largeMcp =
      mcp && c.req.raw.body !== null && (length === undefined || !/^\d+$/.test(length) || Number(length) > 1024 * 1024)
    if (mcp && (activeMcp >= 32 || (largeMcp && activeLargeMcp >= 4)))
      return c.json({ error: 'Too many active MCP requests' }, 429)
    if (mcp) activeMcp++
    if (largeMcp) activeLargeMcp++
    // Do not buffer bodies here: authentication must finish first.
    try {
      return await next()
    } finally {
      if (mcp) activeMcp--
      if (largeMcp) activeLargeMcp--
    }
  }
}

/** Mount after operator authentication. MCP routes authenticate and bound their own bodies. */
export function requestBodyLimitsMiddleware(): MiddlewareHandler {
  const small = bodyLimit({ maxSize: 1024 * 1024 })
  const large = bodyLimit({ maxSize: 72 * 1024 * 1024 })
  let activeUploads = 0
  return async (c, next) => {
    if (/^\/api\/(?:internal-)?mcp\/?$/.test(c.req.path)) return next()
    const attachments =
      c.req.path === '/api/workspaces' ||
      /^\/api\/workspaces\/[^/]+\/(images|attachments|messages)(?:\/|$)/.test(c.req.path) ||
      c.req.path.startsWith('/api/voice/')
    if (!attachments) return small(c, next)
    if (activeUploads >= 4) return c.json({ error: 'Too many active uploads' }, 429)
    activeUploads++
    try {
      return await large(c, next)
    } finally {
      activeUploads--
    }
  }
}
