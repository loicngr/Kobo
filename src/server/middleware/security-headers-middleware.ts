import type { MiddlewareHandler } from 'hono'

/** Browser protections that also apply to denied requests and SPA responses. */
export function securityHeadersMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    // No default-src/script-src: Monaco workers and the PWA would break.
    c.header(
      'Content-Security-Policy',
      "frame-ancestors 'self'; img-src 'self' data: blob:; form-action 'self'; base-uri 'self'; object-src 'none'",
    )
    c.header('X-Frame-Options', 'SAMEORIGIN')
    c.header('X-Content-Type-Options', 'nosniff')
    c.header('Referrer-Policy', 'no-referrer')
    if (c.req.path === '/api' || c.req.path.startsWith('/api/')) {
      c.header('Cache-Control', 'no-store')
      c.header('Pragma', 'no-cache')
    }
    // HSTS belongs at the TLS terminator. Forwarded headers are client input
    // unless a proxy is explicitly trusted, and local HTTP must remain usable.
    await next()
    if (c.req.path === '/api' || c.req.path.startsWith('/api/')) {
      c.header('Cache-Control', 'no-store')
    }
  }
}
