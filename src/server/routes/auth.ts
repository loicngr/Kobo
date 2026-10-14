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
router.post('/session', (c) => {
  const policy = getGlobalSettings()
  // Even a local unauthenticated caller cannot mint an authenticated session.
  if (!policy.networkAccessToken || !tokenMatches(c.req.header('X-Kobo-Token') ?? '', policy.networkAccessToken))
    return c.json({ error: 'unauthorized' }, 401)
  try {
    const session = createBrowserSession(policy)
    setCookie(c, browserCookieName(policy), session.token, {
      httpOnly: true,
      secure: secureBrowserCookie(policy),
      sameSite: 'Strict',
      path: '/',
      maxAge: 12 * 60 * 60,
    })
    return c.json({ ok: true })
  } catch {
    return c.json({ error: 'Session capacity reached' }, 429)
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
