import { createHash, randomBytes } from 'node:crypto'
import type { WebSocket } from 'ws'
import { isLoopbackAddress, resolveProxyOrigin } from './network-access-service.js'

export interface NetworkPolicy {
  networkAccessEnabled: boolean
  networkAccessBehindProxy?: boolean
  networkAccessToken?: string | null
}
export interface BrowserSession {
  token: string
  expiresAt: number
  policy: string
}
interface Ticket {
  path: string
  expiresAt: number
  policy: string
  session?: BrowserSession
}
interface SocketGrant {
  address: string
  policy: string
  current: () => NetworkPolicy
  session?: BrowserSession
  expiresAt: number
  revoked: boolean
  timer: ReturnType<typeof setTimeout>
  count: number
  window: number
}
const sessions = new Map<string, Omit<BrowserSession, 'token'>>()
const tickets = new Map<string, Ticket>()
const sockets = new Map<WebSocket, SocketGrant>()
const revokedSockets = new WeakSet<WebSocket>()
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const fingerprint = (p: NetworkPolicy) =>
  hash(JSON.stringify([p.networkAccessEnabled, !!p.networkAccessBehindProxy, p.networkAccessToken]))
const lifetime = 12 * 60 * 60 * 1000
export function isNetworkTransportAllowed(address: string | undefined, policy: NetworkPolicy): boolean {
  return policy.networkAccessEnabled || (!policy.networkAccessBehindProxy && isLoopbackAddress(address))
}
function prune() {
  const now = Date.now()
  for (const [id, session] of sessions) if (session.expiresAt <= now) sessions.delete(id)
  for (const [id, ticket] of tickets) if (ticket.expiresAt <= now) tickets.delete(id)
}
export function createBrowserSession(policy: NetworkPolicy): BrowserSession {
  prune()
  if (sessions.size >= 256) throw new Error('Session capacity reached')
  const session = {
    token: randomBytes(32).toString('base64url'),
    expiresAt: Date.now() + lifetime,
    policy: fingerprint(policy),
  }
  const { token, ...record } = session
  sessions.set(hash(token), record)
  return session
}
export function getBrowserSession(token: string | undefined, policy: NetworkPolicy): BrowserSession | undefined {
  if (!token || token.length > 128) return undefined
  const record = sessions.get(hash(token))
  if (!record || record.expiresAt <= Date.now() || record.policy !== fingerprint(policy)) return undefined
  return { ...record, token }
}
function sessionValid(session: BrowserSession | undefined, policy: NetworkPolicy) {
  return !session || !!getBrowserSession(session.token, policy)
}
export function createWebSocketTicket(path: string, policy: NetworkPolicy, session?: BrowserSession): string {
  if (!/^\/ws(?:\/terminal\/[A-Za-z0-9_-]{1,200})?$/.test(path)) throw new Error('Invalid WebSocket path')
  prune()
  if (tickets.size >= 1024) throw new Error('Ticket capacity reached')
  if (!sessionValid(session, policy)) throw new Error('Session expired')
  const token = randomBytes(32).toString('base64url')
  tickets.set(hash(token), { path, policy: fingerprint(policy), expiresAt: Date.now() + 60_000, session })
  return token
}
export function consumeWebSocketTicket(token: string | null, path: string, policy: NetworkPolicy): Ticket | undefined {
  if (!token || token.length > 128) return undefined
  const id = hash(token)
  const ticket = tickets.get(id)
  tickets.delete(id)
  if (
    !ticket ||
    ticket.path !== path ||
    ticket.expiresAt <= Date.now() ||
    ticket.policy !== fingerprint(policy) ||
    !sessionValid(ticket.session, policy)
  )
    return undefined
  return ticket
}
function terminate(ws: WebSocket) {
  const grant = sockets.get(ws)
  if (grant) {
    grant.revoked = true
    clearTimeout(grant.timer)
    sockets.delete(ws)
  }
  if (!revokedSockets.has(ws)) {
    revokedSockets.add(ws)
    ws.terminate()
  }
}
export function registerNetworkSocket(
  ws: WebSocket,
  address: string,
  policy: NetworkPolicy,
  current: () => NetworkPolicy,
  session?: BrowserSession,
): boolean {
  let currentPolicy: NetworkPolicy
  try {
    currentPolicy = current()
  } catch {
    terminate(ws)
    return false
  }
  if (
    !isNetworkTransportAllowed(address, currentPolicy) ||
    sockets.size >= 256 ||
    [...sockets.values()].filter((g) => g.address === address).length >= 64 ||
    !sessionValid(session, currentPolicy) ||
    fingerprint(policy) !== fingerprint(currentPolicy)
  ) {
    terminate(ws)
    return false
  }
  const expiresAt = session?.expiresAt ?? Date.now() + lifetime
  const timer = setTimeout(() => terminate(ws), Math.max(0, expiresAt - Date.now()))
  timer.unref?.()
  sockets.set(ws, {
    address,
    policy: fingerprint(policy),
    current,
    session,
    expiresAt,
    revoked: false,
    timer,
    count: 0,
    window: Date.now(),
  })
  ws.once('close', () => {
    clearTimeout(timer)
    sockets.delete(ws)
    revokedSockets.add(ws)
  })
  return true
}
export function isNetworkSocketAuthorized(ws: WebSocket): boolean {
  if (revokedSockets.has(ws)) return false
  const grant = sockets.get(ws)
  if (!grant) return true // Unregistered service-level sockets do not participate in network authentication.
  let policy: NetworkPolicy
  try {
    policy = grant.current()
  } catch {
    terminate(ws)
    return false
  }
  if (
    grant.revoked ||
    grant.expiresAt <= Date.now() ||
    !isNetworkTransportAllowed(grant.address, policy) ||
    grant.policy !== fingerprint(policy) ||
    !sessionValid(grant.session, policy)
  ) {
    terminate(ws)
    return false
  }
  return true
}
export function acceptNetworkSocketMessage(ws: WebSocket): boolean {
  if (!isNetworkSocketAuthorized(ws)) return false
  const grant = sockets.get(ws)
  if (!grant) return true
  if (Date.now() - grant.window >= 1000) {
    grant.window = Date.now()
    grant.count = 0
  }
  if (++grant.count > 240) {
    terminate(ws)
    return false
  }
  return true
}
export function revokeBrowserSession(token: string) {
  sessions.delete(hash(token))
  for (const [id, ticket] of tickets) if (ticket.session?.token === token) tickets.delete(id)
  for (const [ws, grant] of sockets) if (grant.session?.token === token) terminate(ws)
}
export function revokeNetworkSessions() {
  sessions.clear()
  tickets.clear()
  for (const ws of sockets.keys()) terminate(ws)
}

export function browserCookieName(policy: NetworkPolicy): string {
  return secureBrowserCookie(policy) ? '__Host-kobo-session' : 'kobo-session'
}

export function secureBrowserCookie(policy: NetworkPolicy): boolean {
  return !!policy.networkAccessBehindProxy && !resolveProxyOrigin()?.startsWith('http:')
}
