import { getConnInfo } from '@hono/node-server/conninfo'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { evaluateNetworkAccess, tokenMatches } from '../services/network-access-service.js'
import {
  browserCookieName,
  createBrowserSession,
  createWebSocketTicket,
  getBrowserSession,
  revokeBrowserSession,
  secureBrowserCookie,
} from '../services/network-session-service.js'
import { getGlobalSettings } from '../services/settings-service.js'

const router = new Hono()
router.use('*', bodyLimit({ maxSize: 1024 }))
router.post('/session', async (c) => {
  let body: unknown
  try {
    const text = await c.req.text()
    body = text ? JSON.parse(text) : {}
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400)
  }
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    ('remember' in body && typeof body.remember !== 'boolean')
  )
    return c.json({ error: 'remember must be a boolean' }, 400)
  const remember = 'remember' in body && body.remember === true
  // Recheck policy after reading the body; authentication may have changed meanwhile.
  const policy = getGlobalSettings()
  const decision = evaluateNetworkAccess({
    address: getConnInfo(c).remote.address,
    enabled: policy.networkAccessEnabled,
    expectedToken: policy.networkAccessToken,
    providedToken: c.req.header('X-Kobo-Token'),
    trustLoopback: !policy.networkAccessBehindProxy,
  })
  if (!decision.allow) return c.json({ error: 'unauthorized' }, decision.status as 401 | 403)
  // Even a local unauthenticated caller cannot mint an authenticated session.
  if (!policy.networkAccessToken || !tokenMatches(c.req.header('X-Kobo-Token') ?? '', policy.networkAccessToken))
    return c.json({ error: 'unauthorized' }, 401)
  try {
    const session = createBrowserSession(policy, remember)
    const previous = getCookie(c, browserCookieName(policy))
    if (previous) revokeBrowserSession(previous)
    setCookie(c, browserCookieName(policy), session.token, {
      httpOnly: true,
      secure: secureBrowserCookie(policy),
      sameSite: 'Strict',
      path: '/',
      maxAge: Math.max(0, Math.floor((session.expiresAt - Date.now()) / 1000)),
    })
    return c.json({ ok: true })
  } catch (error) {
    if (error instanceof Error && error.message === 'Session capacity reached')
      return c.json({ error: 'Session capacity reached' }, 429)
    return c.json({ error: 'Session storage unavailable' }, 503)
  }
})
router.delete('/session', (c) => {
  const policy = getGlobalSettings()
  const token = getCookie(c, browserCookieName(policy))
  if (token) revokeBrowserSession(token)
  deleteCookie(c, browserCookieName(policy), { path: '/', secure: secureBrowserCookie(policy) })
  return c.json({ ok: true })
})
router.post('/ws-ticket', async (c) => {
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400)
  }
  if (
    !body ||
    typeof body !== 'object' ||
    !('path' in body) ||
    typeof body.path !== 'string' ||
    !/^\/ws(?:\/terminal\/[A-Za-z0-9_-]{1,200})?$/.test(body.path)
  )
    return c.json({ error: 'Invalid WebSocket path' }, 400)
  const policy = getGlobalSettings()
  const cookie = getCookie(c, browserCookieName(policy))
  const session = getBrowserSession(cookie, policy)
  // Stale cookies must not override a valid operator header or trusted local access.
  // Remote callers still need a current session or token in the policy check below.
  const decision = evaluateNetworkAccess({
    address: getConnInfo(c).remote.address,
    enabled: policy.networkAccessEnabled,
    expectedToken: policy.networkAccessToken,
    providedToken: session ? policy.networkAccessToken : c.req.header('X-Kobo-Token'),
    trustLoopback: !policy.networkAccessBehindProxy,
  })
  if (!decision.allow) return c.json({ error: 'unauthorized' }, decision.status as 401 | 403)
  try {
    return c.json({ ticket: createWebSocketTicket(body.path, policy, session) })
  } catch {
    return c.json({ error: 'Ticket capacity reached' }, 429)
  }
})
export default router
