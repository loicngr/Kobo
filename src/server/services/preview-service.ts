import { createHash, randomBytes } from 'node:crypto'
import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { Socket } from 'node:net'
import { getStatus } from './dev-server-service.js'
import { resolveProxyOrigin } from './network-access-service.js'
import { type BrowserSession, getBrowserSession } from './network-session-service.js'
import { getGlobalSettings } from './settings-service.js'
import { getWorkspace } from './workspace-service.js'

const COOKIE = '__Host-kobo-preview'
const TICKET_PATH = '/.kobo-preview/open'
const tickets = new Map<string, Grant>()
const grants = new Map<string, Grant>()
const connections = new Map<Socket, Grant>()
let server: ReturnType<typeof createServer> | undefined
let timer: ReturnType<typeof setInterval> | undefined
interface Grant {
  workspaceId: string
  origin: string
  parentOrigin: string
  entryUrl: string
  target: string
  redirectOrigins: string[]
  policy: string
  session: BrowserSession
  expires: number
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const policyKey = () => {
  const p = getGlobalSettings()
  return hash(
    JSON.stringify([
      p.networkAccessEnabled,
      p.networkAccessBehindProxy,
      p.networkAccessToken,
      resolveProxyOrigin(),
      process.env.KOBO_PREVIEW_DOMAIN,
    ]),
  )
}

export function previewOrigin(workspaceId: string, domain: string): string {
  if (domain.length > 200 || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(domain))
    throw new Error('KOBO_PREVIEW_DOMAIN must be a DNS domain without scheme, port or path')
  return `https://${hash(workspaceId).slice(0, 32)}.${domain.toLowerCase()}`
}

/** Targets come from the dev-server resolver, never a URL supplied by a browser. */
export function previewTarget(value: string): URL {
  const target = new URL(value)
  const dockerHost = process.env.KOBO_DEV_SERVER_DOCKER_HOST || 'localhost'
  if (
    !['http:', 'https:'].includes(target.protocol) ||
    target.username ||
    target.password ||
    !['localhost', '127.0.0.1', '[::1]', dockerHost].includes(target.hostname)
  )
    throw new Error('Unsupported dev-server preview target')
  return target
}

function valid(grant: Grant): boolean {
  try {
    const workspace = getWorkspace(grant.workspaceId)
    return (
      !!workspace &&
      !workspace.archivedAt &&
      !workspace.worktreePurgedAt &&
      grant.expires > Date.now() &&
      grant.policy === policyKey() &&
      !!getBrowserSession(grant.session.token, getGlobalSettings())
    )
  } catch {
    return false
  }
}
function prune() {
  for (const [key, value] of tickets) if (!valid(value)) tickets.delete(key)
  for (const [key, value] of grants) if (!valid(value)) grants.delete(key)
}

export async function openPreview(workspaceId: string, session?: BrowserSession) {
  const workspace = getWorkspace(workspaceId)
  if (!workspace || workspace.archivedAt || workspace.worktreePurgedAt) throw new Error('Workspace unavailable')
  const status = await getStatus(workspace.projectPath, workspace.workingBranch, workspaceId)
  if (status.status !== 'running' || !status.url) throw new Error('Dev server is not running')
  const domain = process.env.KOBO_PREVIEW_DOMAIN
  if (!domain) return { url: status.url, publicUrl: status.url, remote: false }
  if (!server?.listening) throw new Error('Preview gateway is unavailable')
  const policy = getGlobalSettings()
  if (
    !session ||
    !policy.networkAccessEnabled ||
    !policy.networkAccessBehindProxy ||
    !getBrowserSession(session.token, policy)
  )
    throw new Error('Sign in to Kōbō before opening a remote preview')
  const parentOrigin = resolveProxyOrigin()
  if (!parentOrigin?.startsWith('https://')) throw new Error('Remote previews require a public HTTPS Kōbō origin')
  const origin = previewOrigin(workspaceId, domain)
  if (origin === parentOrigin) throw new Error('Preview and Kōbō must have different origins')
  const upstreamUrl = previewTarget(status.agentUrl || status.url)
  const target = upstreamUrl.origin
  const entryUrl = origin + upstreamUrl.pathname + upstreamUrl.search + upstreamUrl.hash
  prune()
  if (tickets.size >= 256 || grants.size >= 256) throw new Error('Preview session capacity reached')
  const ticket = randomBytes(32).toString('base64url')
  tickets.set(hash(ticket), {
    workspaceId,
    origin,
    parentOrigin,
    entryUrl,
    target,
    redirectOrigins: [target, previewTarget(status.url).origin],
    policy: policyKey(),
    session,
    expires: Date.now() + 60000,
  })
  return { url: `${origin}${TICKET_PATH}?ticket=${ticket}`, publicUrl: entryUrl, remote: true }
}

const hopHeaders = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]
export function previewRequestHeaders(headers: IncomingHttpHeaders, target: URL, origin: string): IncomingHttpHeaders {
  const clean = { ...headers }
  for (const name of [...hopHeaders, ...(headers.connection?.split(',').map((x) => x.trim().toLowerCase()) || [])])
    delete clean[name]
  for (const name of Object.keys(clean))
    if (name.startsWith('x-forwarded-') || name.startsWith('x-kobo-')) delete clean[name]
  delete clean.forwarded
  const cookies = (headers.cookie || '')
    .split(';')
    .filter((x) => !/^(?:__Host-)?kobo(?:-|=)/i.test(x.trim()))
    .join(';')
  if (cookies.trim()) clean.cookie = cookies
  else delete clean.cookie
  clean.host = target.host
  clean['x-forwarded-host'] = new URL(origin).host
  clean['x-forwarded-proto'] = 'https'
  return clean
}
function responseHeaders(headers: IncomingHttpHeaders, grant: Grant): IncomingHttpHeaders {
  const clean = { ...headers }
  for (const name of hopHeaders) delete clean[name]
  delete clean['x-frame-options']
  // Only framing is changed; the application's other CSP directives remain intact.
  const csp = String(clean['content-security-policy'] || '')
    .split(';')
    .filter((x) => !/^\s*frame-ancestors\b/i.test(x))
  csp.push(`frame-ancestors ${grant.parentOrigin}`)
  clean['content-security-policy'] = csp.filter((x) => x.trim()).join('; ')
  clean['referrer-policy'] = 'no-referrer'
  clean['cache-control'] = 'no-store'
  if (clean.location) {
    try {
      const location = new URL(clean.location, grant.target)
      if (grant.redirectOrigins.includes(location.origin))
        clean.location = grant.origin + location.pathname + location.search + location.hash
    } catch {
      delete clean.location
    }
  }
  if (clean['set-cookie'])
    clean['set-cookie'] = clean['set-cookie']
      .filter((x) => !/^(?:__Host-)?kobo(?:-|=)/i.test(x))
      .map((x) => x.replace(/;\s*domain=[^;]*/gi, ''))
  return clean
}

function grantFor(req: IncomingMessage): Grant | undefined {
  const cookie = (req.headers.cookie || '')
    .split(';')
    .map((x) => x.trim())
    .find((x) => x.startsWith(`${COOKIE}=`))
    ?.slice(COOKIE.length + 1)
  const grant = cookie && grants.get(hash(cookie))
  if (!grant || !valid(grant) || req.headers.host !== new URL(grant.origin).host) return
  if (req.headers.origin && req.headers.origin !== grant.origin) return
  if (req.headers['sec-fetch-site'] === 'cross-site') return
  return grant
}

export function startPreviewGateway() {
  const domain = process.env.KOBO_PREVIEW_DOMAIN
  if (!domain) return
  previewOrigin('validate', domain)
  const port = Number(process.env.KOBO_PREVIEW_PORT || 3001)
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid KOBO_PREVIEW_PORT')
  server = createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    let pathname: string
    try {
      pathname = new URL(req.url || '/', 'http://preview.invalid').pathname
    } catch {
      res.writeHead(400).end()
      return
    }
    if (pathname === TICKET_PATH) {
      const ticket = new URL(req.url!, 'http://preview.invalid').searchParams.get('ticket') || ''
      const key = hash(ticket)
      const grant = tickets.get(key)
      if (!grant || !valid(grant) || req.method !== 'GET' || req.headers.host !== new URL(grant.origin).host) {
        res.writeHead(403).end('Preview link expired. Reopen it from Kōbō.')
        return
      }
      tickets.delete(key)
      prune()
      if (grants.size >= 256) {
        res.writeHead(429).end()
        return
      }
      const token = randomBytes(32).toString('base64url')
      const authorized = { ...grant, expires: Math.min(grant.session.expiresAt, Date.now() + 3600000) }
      grants.set(hash(token), authorized)
      res.setHeader(
        'Set-Cookie',
        `${COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${Math.floor((authorized.expires - Date.now()) / 1000)}`,
      )
      res.writeHead(303, { Location: grant.entryUrl }).end()
      return
    }
    const grant = grantFor(req)
    if (!grant) {
      res.writeHead(403).end('Open this preview from your signed-in Kōbō workspace.')
      return
    }
    if (connections.size >= 128) {
      res.writeHead(429).end()
      return
    }
    connections.set(req.socket, grant)
    res.on('close', () => {
      if (connections.get(req.socket) === grant) connections.delete(req.socket)
    })
    const target = previewTarget(grant.target)
    const upstream = (target.protocol === 'https:' ? httpsRequest : httpRequest)(
      {
        protocol: target.protocol,
        hostname: target.hostname.replace(/^\[|\]$/g, ''),
        port: target.port,
        method: req.method,
        path: req.url,
        headers: previewRequestHeaders(req.headers, target, grant.origin),
      },
      (response) => {
        res.writeHead(response.statusCode || 502, responseHeaders(response.headers, grant))
        response.on('error', () => res.destroy())
        response.pipe(res)
      },
    )
    upstream.setTimeout(30000, () => upstream.destroy(new Error('Preview timeout')))
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502).end('Dev server unavailable')
      else res.destroy()
    })
    let bytes = 0
    req.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > 50 * 1024 * 1024) {
        upstream.destroy()
        res.destroy()
      }
    })
    req.on('error', () => upstream.destroy())
    res.on('close', () => upstream.destroy())
    req.pipe(upstream)
  })
  server.on('upgrade', (req, client, head) => {
    const grant = grantFor(req)
    if (!grant || req.headers.origin !== grant.origin || connections.size >= 128) {
      client.destroy()
      return
    }
    const target = previewTarget(grant.target)
    const headers = previewRequestHeaders(req.headers, target, grant.origin)
    headers.connection = 'Upgrade'
    headers.upgrade = 'websocket'
    const upstream = (target.protocol === 'https:' ? httpsRequest : httpRequest)({
      protocol: target.protocol,
      hostname: target.hostname.replace(/^\[|\]$/g, ''),
      port: target.port,
      path: req.url,
      headers,
    })
    upstream.setTimeout(10000, () => upstream.destroy())
    upstream.on('error', () => client.destroy())
    upstream.on('response', () => {
      upstream.destroy()
      client.destroy()
    })
    client.on('error', () => upstream.destroy())
    client.on('close', () => upstream.destroy())
    upstream.on('upgrade', (response, peer, upstreamHead) => {
      peer.setTimeout(0)
      if (!valid(grant)) {
        peer.destroy()
        client.destroy()
        return
      }
      connections.set(client as Socket, grant)
      const responseLines = Object.entries(response.headers)
        .filter(([name]) => !['set-cookie', 'server'].includes(name))
        .flatMap(([name, value]) => (Array.isArray(value) ? value.map((v) => `${name}: ${v}`) : [`${name}: ${value}`]))
      client.write(`HTTP/1.1 101 Switching Protocols\r\n${responseLines.join('\r\n')}\r\n\r\n`)
      if (upstreamHead.length) client.write(upstreamHead)
      if (head.length) peer.write(head)
      client.on('close', () => {
        connections.delete(client as Socket)
        peer.destroy()
      })
      peer.on('error', () => client.destroy())
      peer.on('close', () => client.destroy())
      client.pipe(peer)
      peer.pipe(client)
    })
    upstream.end()
  })
  server.on('error', (err) => console.error('[preview] Gateway unavailable:', err.message))
  server.listen(port, process.env.KOBO_PREVIEW_BIND_HOST || '127.0.0.1')
  let checking = false
  timer = setInterval(async () => {
    if (checking) return
    checking = true
    try {
      prune()
      const targets = new Map<string, string>()
      for (const grant of grants.values()) targets.set(grant.workspaceId, grant.target)
      for (const [id, target] of targets) {
        if (!server) return
        const w = getWorkspace(id)
        let running = false
        if (w)
          try {
            const status = await getStatus(w.projectPath, w.workingBranch, id)
            running = status.status === 'running' && previewTarget(status.agentUrl || status.url).origin === target
          } catch {
            /* Fail closed when the target cannot be verified. */
          }
        if (!running) for (const [key, grant] of grants) if (grant.workspaceId === id) grants.delete(key)
      }
      const active = new Set(grants.values())
      for (const [socket, grant] of connections) if (!active.has(grant) || !valid(grant)) socket.destroy()
    } catch (err) {
      console.error('[preview] Target check failed:', err instanceof Error ? err.message : String(err))
      grants.clear()
      for (const socket of connections.keys()) socket.destroy()
    } finally {
      checking = false
    }
  }, 5000)
  timer.unref()
  return server
}

export function stopPreviewGateway(): void {
  if (timer) clearInterval(timer)
  timer = undefined
  tickets.clear()
  grants.clear()
  for (const socket of connections.keys()) socket.destroy()
  connections.clear()
  server?.closeAllConnections()
  server?.close()
  server = undefined
}
