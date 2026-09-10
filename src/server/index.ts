#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import WebSocket, { WebSocketServer } from 'ws'
import { closeDb, getDb } from './db/index.js'
import { getPendingMigrations, runMigrations } from './db/migrations.js'
import { hostCheckMiddleware } from './middleware/host-check-middleware.js'
import { networkAuthMiddleware } from './middleware/network-auth-middleware.js'
import activityRouter from './routes/activity.js'
import changelogRouter from './routes/changelog.js'
import devServerRouter from './routes/dev-server.js'
import documentsRouter from './routes/documents.js'
import { enginesRouter } from './routes/engines.js'
import exportRouter from './routes/export.js'
import fsRouter from './routes/fs.js'
import gitRouter from './routes/git.js'
import healthRouter from './routes/health.js'
import imagesRouter from './routes/images.js'
import { migrationRouter } from './routes/migration.js'
import notionRouter from './routes/notion.js'
import pullRequestsRouter from './routes/pull-requests.js'
import searchRouter from './routes/search.js'
import sentryRouter from './routes/sentry.js'
import settingsRouter from './routes/settings.js'
import templatesRouter from './routes/templates.js'
import usageRoutes from './routes/usage.js'
import voiceRouter from './routes/voice.js'
import workspaceTemplatesRouter from './routes/workspace-templates.js'
import workspacesRouter from './routes/workspaces.js'
import {
  getAvailableSkills,
  isAgentUnavailableError,
  reconcileOrphanSessions,
  restoreRetryCountsFromDb,
  sendMessage,
  setBackendPort,
  startAgent,
  startWatchdog,
  stopAgentAndWait,
  stopAllAgents,
  stopWatchdog,
} from './services/agent/orchestrator.js'
import * as autoLoopService from './services/auto-loop-service.js'
import { startAwaitingUserReminder, stopAwaitingUserReminder } from './services/awaiting-user-reminder-service.js'
import { runContentMigrationIfNeeded } from './services/content-migration-service.js'
import * as cronService from './services/cron-service.js'
import {
  createDailyDbBackupIfNeeded,
  createPreMigrationBackup,
  startDailyDbBackupScheduler,
} from './services/db-backup-service.js'
import { startDevServer, stopAllDevServers, stopDevServer } from './services/dev-server-service.js'
import {
  authorizeWsUpgrade,
  generateToken,
  getLanHostnames,
  getLanUrls,
  isAllowedOrigin,
  isAllowedRequestHost,
  resolveBindHost,
  resolveDevClientOrigin,
  resolveNetworkAccessEnvOverrides,
  resolveProxyHostname,
} from './services/network-access-service.js'
import { startPrWatcher, stopPrWatcher } from './services/pr-watcher-service.js'
import * as quotaBackoffService from './services/quota-backoff-service.js'
import { getGlobalSettings, updateNetworkAccessSettings } from './services/settings-service.js'
import { reloadDefaultTemplates } from './services/templates-service.js'
import { createTerminal, destroyAllTerminals, getTerminal } from './services/terminal-service.js'
import { startUsagePoller, stopUsagePoller } from './services/usage/index.js'
import * as wakeupService from './services/wakeup-service.js'
import { emit, emitEphemeral, handleConnection, setMessageHandler } from './services/websocket-service.js'
import { getActiveSession, getWorkspace, updateWorkspaceStatus } from './services/workspace-service.js'
import { pruneWsEvents, resolveRetentionConfig } from './services/ws-events-retention-service.js'
import {
  getChangelogPath,
  getClientSpaPath,
  getDbPath,
  getKoboHome,
  getPackageVersion,
  resolveSpaFile,
} from './utils/paths.js'
import { formatStartupBanner, readStartupNotes, startStartupSpinner, startupDebug } from './utils/startup-display.js'

startupDebug(`[kobo] Kōbō home: ${getKoboHome()}`)

// Initialize DB + run migrations
const db = getDb()

// Pre-migration backup: snapshot the DB before applying any pending schema
// migration so a botched upgrade can be rolled back manually. Best-effort —
// a backup failure must not block boot (the daily backup is a second net).
try {
  const pending = getPendingMigrations(db)
  if (pending.length > 0) {
    const result = await createPreMigrationBackup(db, getDbPath(), `v${pending[pending.length - 1]}`)
    startupDebug(`[kobo] Pre-migration backup before applying ${pending.length} migration(s): ${result.created}`)
    if (result.deleted.length > 0) {
      startupDebug(`[kobo] Rotated ${result.deleted.length} old pre-migration backup(s)`)
    }
  }
} catch (err) {
  console.error('[kobo] Pre-migration backup failed (continuing — daily backup remains as fallback):', err)
}

runMigrations(db)

// Event retention. OPT-IN: disabled by default, so this is a no-op until the
// user sets a window in Settings → Worktrees. Deliberately not enabled by
// default — turning it on for an existing install would delete months of
// conversation on the next upgrade, which is precisely why the UI shows a
// count and asks first.
// Best-effort — a failure must never block boot.
function runRetentionPass(context: string): void {
  try {
    const retentionConfig = resolveRetentionConfig(getGlobalSettings())
    if (retentionConfig.retentionDays <= 0) return
    const retentionStartedAt = Date.now()
    const retention = pruneWsEvents(db, retentionConfig)
    if (retention.deleted > 0 || retention.vacuumed) {
      console.log(
        `[kobo] Event retention ${context} (${retentionConfig.retentionDays} d, keeping ${retentionConfig.keepPerWorkspace}/workspace): ` +
          `${retention.deleted} agent event(s) permanently deleted, ` +
          `${retention.sessionsRecomputed} session metric(s) recomputed, ` +
          `${retention.vacuumed ? `VACUUM reclaimed ${retention.freePagesBefore - retention.freePagesAfter} page(s), ` : ''}` +
          `${Date.now() - retentionStartedAt} ms`,
      )
    }
  } catch (err) {
    console.error('[kobo] Event retention failed (continuing):', err)
  }
}

runRetentionPass('at boot')

// Kōbō is a daemon people leave running for weeks, and `emit` writes a row per
// agent event. Running the pass only at boot meant a window the user enabled
// was not applied again until the next restart.
const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000
const retentionTimer = setInterval(() => runRetentionPass('daily'), RETENTION_INTERVAL_MS)
retentionTimer.unref?.()

// Check on boot and hourly so servers running longer than a day keep backing up.
const dailyBackupScheduler = startDailyDbBackupScheduler(async () => {
  const result = await createDailyDbBackupIfNeeded(db, getDbPath())
  if (result.created) startupDebug(`[kobo] Daily DB backup: ${result.created}`)
})

// Initialize process cleanup, agent watchdog, PR watcher, and wakeup rehydration
reconcileOrphanSessions()
startWatchdog()
wakeupService.rehydrate()
autoLoopService.rehydrate()
// Restore in-memory retry counts BEFORE re-arming the persisted backoff timers,
// otherwise the next arm() after restart would compute the next ladder rung
// from retryCount=0 and undo the progression.
restoreRetryCountsFromDb()
quotaBackoffService.restoreOnBoot((workspaceId, pending) => autoLoopService.onQuotaBackoffExpired(workspaceId, pending))
cronService.restoreOnBoot()
// Deliver any new default prompt templates to existing installs (seed-once via the
// seededDefaultSlugs watermark; never overwrites or re-adds deleted defaults).
try {
  const { added } = reloadDefaultTemplates()
  if (added.length > 0) {
    console.log(`[templates] Added ${added.length} new default template(s): ${added.join(', ')}`)
  }
} catch (err) {
  console.error('[templates] reloadDefaultTemplates on boot failed:', err)
}
startPrWatcher()
startUsagePoller()
startAwaitingUserReminder()

// Create Hono app
const app = new Hono()

// Refuse requests addressed to a hostname we are not reachable at, so a page
// that re-resolves its own domain to 127.0.0.1 cannot read our responses as
// same-origin. Mounted on every path, ahead of the token gate: the SPA shell
// is served outside /api/*, and rebinding targets the browser, not the socket.
app.use('*', hostCheckMiddleware)

// Gate non-loopback requests behind the network-access token (loopback exempt).
app.use('/api/*', networkAuthMiddleware)

// Health check (root / is handled by the SPA catch-all below)
app.get('/api/health', (c) => c.json({ status: 'ok', version: getPackageVersion() }))

// Mount route sub-routers
app.route('/api/workspaces', workspacesRouter)
app.route('/api/pull-requests', pullRequestsRouter)
app.route('/api/workspaces', imagesRouter)
app.route('/api/notion', notionRouter)
app.route('/api/sentry', sentryRouter)
app.route('/api/git', gitRouter)
app.route('/api/fs', fsRouter)
app.route('/api/changelog', changelogRouter)
app.route('/api/activity', activityRouter)
app.route('/api/settings', settingsRouter)
app.route('/api/dev-server', devServerRouter)
app.route('/api/templates', templatesRouter)
app.route('/api/workspace-templates', workspaceTemplatesRouter)
app.route('/api/usage', usageRoutes)
app.route('/api/workspaces', documentsRouter)
app.route('/api/workspaces', exportRouter)
app.route('/api/search', searchRouter)
app.route('/api/health', healthRouter)
app.route('/api/engines', enginesRouter)
app.route('/api/migration', migrationRouter)
app.route('/api/voice', voiceRouter)

// Skills endpoint
app.get('/api/skills', (c) => c.json(getAvailableSkills()))

const PORT = parseInt(process.env.SERVER_PORT || process.env.PORT || '3000', 10)

// Serve static files from the built SPA if present (production mode).
// The path is resolved relative to the package install directory, so this
// works both in dev (tsx running from src/) and when installed via npm / npx
// (node running from dist/).
const clientDistPath = getClientSpaPath()

if (clientDistPath) {
  app.get('*', async (c) => {
    const url = new URL(c.req.url)
    // Traversal guard + SPA fallback live in one tested function: the inline
    // version once rejected `/` itself and shipped a 404 on the home page.
    const filePath = resolveSpaFile(clientDistPath, url.pathname)
    if (!filePath) {
      return c.notFound()
    }

    const content = fs.readFileSync(filePath)
    const ext = path.extname(filePath)
    const mimeTypes: Record<string, string> = {
      '.html': 'text/html',
      '.js': 'application/javascript',
      '.css': 'text/css',
      '.json': 'application/json',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon',
      '.woff': 'font/woff',
      '.woff2': 'font/woff2',
    }
    const contentType = mimeTypes[ext] ?? 'application/octet-stream'

    return new Response(content, {
      headers: { 'Content-Type': contentType },
    })
  })
}

// Create HTTP server via @hono/node-server
const networkAccessEnvOverrides = resolveNetworkAccessEnvOverrides(process.env)
if (Object.keys(networkAccessEnvOverrides).length > 0) {
  const patch: typeof networkAccessEnvOverrides & { networkAccessToken?: string } = {
    ...networkAccessEnvOverrides,
  }
  if (networkAccessEnvOverrides.networkAccessEnabled && !getGlobalSettings().networkAccessToken) {
    patch.networkAccessToken = generateToken()
  }
  updateNetworkAccessSettings(patch)
}
const bindHost = resolveBindHost(getGlobalSettings().networkAccessEnabled)
const stopStartupSpinner = startStartupSpinner()
const server = serve(
  {
    fetch: app.fetch,
    port: PORT,
    hostname: bindHost,
  },
  (info) => {
    setBackendPort(info.port)
    stopStartupSpinner()
    const settings = getGlobalSettings()
    console.log(
      formatStartupBanner({
        version: getPackageVersion(),
        port: info.port,
        devClientOrigin: resolveDevClientOrigin(),
        networkEnabled: settings.networkAccessEnabled,
        lanUrls: settings.networkAccessEnabled ? getLanUrls(info.port) : [],
        token: settings.networkAccessToken,
        changelog: readStartupNotes(getChangelogPath()),
        color: Boolean(process.stdout.isTTY && process.env.TERM !== 'dumb' && !('NO_COLOR' in process.env)),
      }),
    )
    // Content migration runs AFTER the HTTP listener is up so the frontend
    // can observe progress via WS broadcasts + GET /api/migration/status.
    // Not awaited — the callback returns quickly, the migration runs in the
    // background.
    void runContentMigrationIfNeeded(getDb(), getDbPath()).catch((err) => {
      console.error('[boot] content migration failed:', err)
    })
  },
)

server.on('error', (err: NodeJS.ErrnoException) => {
  stopStartupSpinner()
  if (err.code === 'EADDRINUSE') {
    console.error(`[kobo] Port ${PORT} is already in use. Stop the other server or choose another SERVER_PORT.`)
  } else {
    console.error('[kobo] Unable to start the server:', err)
  }
  void gracefulShutdown('server error', 1)
})

// Create WebSocketServer attached to the HTTP server
const wss = new WebSocketServer({ noServer: true })
const terminalWss = new WebSocketServer({ noServer: true })

// Wire WebSocket connections to websocket-service.handleConnection()
wss.on('connection', (ws) => {
  handleConnection(ws)
})

// Wire terminal WebSocket connections
terminalWss.on('connection', (ws: WebSocket, workspaceId: string) => {
  let currentPty = getTerminal(workspaceId)
  let dataDisposable: { dispose(): void } | null = null
  let exitDisposable: { dispose(): void } | null = null

  function attachListeners(ptyInstance: import('node-pty').IPty) {
    // Dispose previous listeners to avoid stacking on reconnect
    dataDisposable?.dispose()
    exitDisposable?.dispose()

    dataDisposable = ptyInstance.onData((output: string) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(Buffer.from(output), { binary: true })
      }
    })

    exitDisposable = ptyInstance.onExit(({ exitCode }) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'exited', code: exitCode }))
        ws.close()
      }
    })
  }

  ws.on('close', () => {
    dataDisposable?.dispose()
    exitDisposable?.dispose()
    dataDisposable = null
    exitDisposable = null
  })

  ws.on('error', (err) => {
    console.error(`[terminal] WebSocket error for workspace ${workspaceId}:`, err)
  })

  ws.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
    if (isBinary) {
      if (currentPty) {
        currentPty.write(data.toString())
      }
      return
    }

    let msg: { type: string; cols?: number; rows?: number }
    try {
      msg = JSON.parse(data.toString())
    } catch {
      return // Invalid JSON — ignore
    }

    if (msg.type === 'create') {
      if (!currentPty) {
        const workspace = getWorkspace(workspaceId)
        if (!workspace) {
          ws.send(JSON.stringify({ type: 'error', message: 'Workspace not found' }))
          return
        }
        if (workspace.archivedAt) {
          ws.send(JSON.stringify({ type: 'error', message: 'Workspace is archived' }))
          return
        }
        const cwd = workspace.worktreePath
        try {
          currentPty = createTerminal(workspaceId, cwd)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          ws.send(JSON.stringify({ type: 'error', message }))
          return
        }
      }

      attachListeners(currentPty)
      ws.send(JSON.stringify({ type: 'ready' }))
      return
    }

    if (msg.type === 'resize' && msg.cols && msg.rows) {
      if (currentPty) {
        const cols = Math.max(1, Math.floor(msg.cols))
        const rows = Math.max(1, Math.floor(msg.rows))
        try {
          currentPty.resize(cols, rows)
        } catch (err) {
          console.error(`[terminal] resize failed for workspace ${workspaceId}:`, err)
        }
      }
      return
    }
  })
})

// Wire websocket-service message handler to the agent orchestrator
setMessageHandler(async (type, payload) => {
  const p = payload as {
    workspaceId?: string
    content?: string
    prompt?: string
    sessionId?: string
    agentPermissionModeOverride?: 'plan' | 'bypass' | 'strict' | 'interactive'
    force?: boolean
  } | null

  if (type === 'chat:message' && p?.workspaceId && p?.content) {
    if (getWorkspace(p.workspaceId)?.status === 'compacting') {
      emitEphemeral(p.workspaceId, 'chat:rejected', {
        reason: 'compacting',
        sessionId: p.sessionId,
        content: p.content,
        message: 'Workspace is compacting its context; wait until compaction finishes before sending a message',
      })
      return
    }
    // Auto-loop owns the agent's turns. A user message means the user wants
    // to redirect the conversation, so disable the loop (idempotent — the
    // `autoloop:disabled` event is emitted with reason='user-action' so the
    // frontend chip updates) and let the message through to the running
    // session. The user can re-enable auto-loop manually once their
    // intervention is done. Grooming phase (ready=0) is skipped — the loop
    // hasn't started yet, so chat messages during grooming pass through
    // untouched (the user can still answer the agent's questions).
    const autoLoopStatus = autoLoopService.getStatus(p.workspaceId)
    if (autoLoopStatus.auto_loop && autoLoopStatus.auto_loop_ready) {
      autoLoopService.disable(p.workspaceId, 'user-action')
    }

    // Reject chat input while paused on canUseTool — sending here would spawn
    // a parallel session and orphan the pending callback.
    const wsRow = getWorkspace(p.workspaceId)
    if (wsRow?.status === 'awaiting-user') {
      emitEphemeral(p.workspaceId, 'chat:rejected', {
        reason: 'awaiting-user',
        sessionId: p.sessionId,
        content: p.content,
        message: 'Answer via the question panel — typing in chat would orphan the pending callback',
      })
      return
    }

    // Prefer the session explicitly selected by the client (sessionId hint),
    // falling back to the running/most-recent non-idle session so idle sessions
    // never steal the tagging.
    const activeSession = getActiveSession(p.workspaceId)
    const sessionTag = p.sessionId ?? activeSession?.id ?? undefined
    try {
      await sendMessage(p.workspaceId, p.content, p.sessionId)
      emit(p.workspaceId, 'user:message', { content: p.content, sender: 'user' }, sessionTag)
      if (p.force) emitEphemeral(p.workspaceId, 'chat:accepted', { sessionId: p.sessionId })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // Resume on every shape that means "no agent can receive this message"
      // — the closed-stdin case included. Anything else (queue full, disk
      // error, a stop in progress) surfaces to the user instead of silently
      // respawning a fresh agent.
      if (!isAgentUnavailableError(msg)) {
        emitEphemeral(p.workspaceId, 'chat:rejected', { sessionId: p.sessionId, content: p.content, message: msg })
        console.error(`[ws] chat:message failed for workspace ${p.workspaceId}:`, err)
        return
      }
      // Agent not running — resume the session hinted by the client if any,
      // otherwise the most-recent active session.
      try {
        const workspace = getWorkspace(p.workspaceId)
        if (workspace) {
          const worktreePath = workspace.worktreePath
          // Plan mode blocks MCP tools — when the caller knows the message
          // requires them (e.g. grooming), it sets the override to bypass the
          // workspace default for this spawn only.
          const effectiveMode = p.agentPermissionModeOverride ?? workspace.agentPermissionMode
          const started = startAgent(
            p.workspaceId,
            worktreePath,
            p.content,
            workspace.model,
            true,
            effectiveMode,
            p.sessionId,
            workspace.reasoningEffort,
          )
          updateWorkspaceStatus(p.workspaceId, 'executing')
          const resumedSessionId = p.sessionId ?? started.agentSessionId
          emit(p.workspaceId, 'user:message', { content: p.content, sender: 'user' }, resumedSessionId)
          if (p.force) emitEphemeral(p.workspaceId, 'chat:accepted', { sessionId: resumedSessionId })
        } else {
          emitEphemeral(p.workspaceId, 'chat:rejected', {
            sessionId: p.sessionId,
            content: p.content,
            message: `Workspace '${p.workspaceId}' not found`,
          })
        }
      } catch (restartErr) {
        const message = restartErr instanceof Error ? restartErr.message : String(restartErr)
        emitEphemeral(p.workspaceId, 'chat:rejected', { sessionId: p.sessionId, content: p.content, message })
        console.error('[ws] Failed to resume agent:', message)
      }
    }
  }

  if (type === 'workspace:start' && p?.workspaceId) {
    try {
      const workspace = getWorkspace(p.workspaceId)
      if (!workspace) {
        console.error(`[ws] workspace:start — workspace '${p.workspaceId}' not found`)
        return
      }
      const worktreePath = workspace.worktreePath
      const prompt = p.prompt ?? 'Continue the previous task where you left off.'
      startAgent(
        p.workspaceId,
        worktreePath,
        prompt,
        workspace.model,
        false,
        workspace.agentPermissionMode,
        undefined,
        workspace.reasoningEffort,
      )
    } catch (err) {
      console.error('[ws] Failed to start agent:', err)
    }
  }

  if (type === 'workspace:stop' && p?.workspaceId) {
    try {
      // Share the HTTP stop contract, including loops waiting without an agent.
      await stopAgentAndWait(p.workspaceId)
    } catch (err) {
      console.error('[ws] Failed to stop agent:', err)
    }
  }

  if (type === 'devserver:start' && p?.workspaceId) {
    try {
      startDevServer(p.workspaceId)
    } catch (err) {
      console.error('[ws] Failed to start dev-server:', err)
    }
  }

  if (type === 'devserver:stop' && p?.workspaceId) {
    void stopDevServer(p.workspaceId).catch((err) => {
      console.error('[ws] Failed to stop dev-server:', err)
    })
  }
})

// Handle WebSocket upgrade requests on /ws path
server.on('upgrade', (request, socket, head) => {
  const { pathname } = new URL(request.url ?? '/', `http://localhost:${PORT}`)

  const wsGlobal = getGlobalSettings()

  // WebSockets are exempt from the same-origin policy and send no preflight,
  // so without these two any page the user visits could open /ws/terminal/<id>
  // and drive a real shell here. Checked before the token gate: on loopback the
  // token gate lets everything through, which is exactly the case a malicious
  // page exploits. The HTTP side gets the same pair from hostCheckMiddleware,
  // which does not see upgrade requests.
  const wsHost = request.headers.host
  if (
    !isAllowedRequestHost({
      host: wsHost,
      enabled: wsGlobal.networkAccessEnabled,
      lanHostnames: getLanHostnames(),
      behindProxy: wsGlobal.networkAccessBehindProxy,
      proxyHostname: resolveProxyHostname(),
    })
  ) {
    console.warn(`[host-check] WS 403 (forbidden host '${wsHost ?? 'unknown'}') ${pathname}`)
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
    socket.destroy()
    return
  }

  if (
    !isAllowedOrigin({
      origin: request.headers.origin,
      requestHost: wsHost,
      behindProxy: wsGlobal.networkAccessBehindProxy,
      proxyHostname: resolveProxyHostname(),
      devOrigin: resolveDevClientOrigin(),
    })
  ) {
    console.warn(`[origin-check] WS 403 (forbidden origin '${request.headers.origin ?? 'unknown'}') ${pathname}`)
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
    socket.destroy()
    return
  }

  if (
    !authorizeWsUpgrade({
      address: request.socket.remoteAddress,
      rawUrl: request.url,
      enabled: wsGlobal.networkAccessEnabled,
      expectedToken: wsGlobal.networkAccessToken,
      trustLoopback: !wsGlobal.networkAccessBehindProxy,
    })
  ) {
    console.warn(
      `[network-auth] WS 401 (missing/invalid token) from ${request.socket.remoteAddress ?? 'unknown'} ${pathname}`,
    )
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
    socket.destroy()
    return
  }

  if (pathname === '/ws') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request)
    })
  } else if (pathname.startsWith('/ws/terminal/')) {
    const workspaceId = pathname.slice('/ws/terminal/'.length)
    if (!workspaceId) {
      socket.destroy()
      return
    }
    terminalWss.handleUpgrade(request, socket, head, (ws) => {
      terminalWss.emit('connection', ws, workspaceId)
    })
  } else {
    socket.destroy()
  }
})

// Graceful shutdown handler
let isShuttingDown = false

async function gracefulShutdown(signal: string, exitCode = 0): Promise<void> {
  if (isShuttingDown) return
  isShuttingDown = true

  console.log(`\n[kobo] Received ${signal}, shutting down gracefully…`)

  const forceExitTimer = setTimeout(() => {
    console.error('[kobo] Graceful shutdown timed out; forcing exit')
    process.exit(1)
  }, 5_000)
  forceExitTimer.unref()

  // Ask WebSocket clients to leave so their upgraded HTTP connections do not
  // keep server.close() waiting indefinitely.
  for (const client of wss.clients) client.close(1001, 'Server shutting down')
  for (const client of terminalWss.clients) client.close(1001, 'Server shutting down')

  try {
    destroyAllTerminals()
    console.log('[kobo] Terminals killed')
  } catch {
    // Best-effort
  }

  // Stop background services
  try {
    stopWatchdog()
  } catch {
    // Best-effort
  }

  try {
    stopPrWatcher()
  } catch {
    // Best-effort
  }

  try {
    stopUsagePoller()
  } catch {
    // Best-effort
  }

  try {
    stopAwaitingUserReminder()
  } catch {
    // Best-effort
  }

  clearInterval(retentionTimer)

  // Stop managed agents and both direct/Docker dev servers before closing DB.
  try {
    await Promise.all([stopAllAgents(), stopAllDevServers()])
    console.log('[kobo] Agents and dev servers stopped')
  } catch {
    // Best-effort
  }

  // Stop accepting new HTTP/WS work, then let in-flight handlers finish before
  // closing SQLite. Closing the DB earlier makes those handlers fail midway.
  try {
    await Promise.all([
      new Promise<void>((resolve) => server.close(() => resolve())),
      new Promise<void>((resolve) => wss.close(() => resolve())),
      new Promise<void>((resolve) => terminalWss.close(() => resolve())),
    ])
    console.log('[kobo] HTTP and WebSocket servers closed')
  } finally {
    try {
      await dailyBackupScheduler.stop()
      closeDb()
      console.log('[kobo] Database closed')
    } catch {
      // Best-effort
    }
  }

  clearTimeout(forceExitTimer)
  console.log('[kobo] Shutdown complete')
  process.exit(exitCode)
}

process.on('SIGTERM', () => void gracefulShutdown('SIGTERM'))
process.on('SIGINT', () => void gracefulShutdown('SIGINT'))
// Fermeture du terminal parent : sans ce gestionnaire, Node termine le
// process sans passer par l'arrêt propre, donc sans fermer la base.
process.on('SIGHUP', () => void gracefulShutdown('SIGHUP'))

// Un `EPIPE` sur stdout/stderr — typiquement quand la sortie est redirigée
// vers un lecteur qui s'est fermé — est émis de façon asynchrone et tue le
// process. On l'ignore : perdre une ligne de journal ne doit jamais arrêter
// le serveur.
process.stdout.on('error', () => {})
process.stderr.on('error', () => {})

// Filets de dernier recours. On ne poursuit PAS l'exécution après une
// exception non capturée : l'état du process est indéterminé. On garantit
// seulement une trace exploitable et une fermeture propre de la base et des
// WebSockets — ce que la terminaison implicite de Node ne fait pas.
process.on('uncaughtException', (err) => {
  console.error('[kobo] Uncaught exception — shutting down:', err)
  void gracefulShutdown('uncaughtException', 1)
})

process.on('unhandledRejection', (reason) => {
  console.error('[kobo] Unhandled promise rejection — shutting down:', reason)
  void gracefulShutdown('unhandledRejection', 1)
})
