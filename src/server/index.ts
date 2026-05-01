#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import WebSocket, { WebSocketServer } from 'ws'
import { closeDb, getDb } from './db/index.js'
import { runMigrations } from './db/migrations.js'
import devServerRouter from './routes/dev-server.js'
import documentsRouter from './routes/documents.js'
import { enginesRouter } from './routes/engines.js'
import gitRouter from './routes/git.js'
import healthRouter from './routes/health.js'
import imagesRouter from './routes/images.js'
import { migrationRouter } from './routes/migration.js'
import notionRouter from './routes/notion.js'
import searchRouter from './routes/search.js'
import sentryRouter from './routes/sentry.js'
import settingsRouter from './routes/settings.js'
import templatesRouter from './routes/templates.js'
import usageRoutes from './routes/usage.js'
import workspacesRouter from './routes/workspaces.js'
import {
  getAvailableSkills,
  reconcileOrphanSessions,
  sendMessage,
  setBackendPort,
  startAgent,
  startWatchdog,
  stopAgent,
  stopWatchdog,
} from './services/agent/orchestrator.js'
import * as autoLoopService from './services/auto-loop-service.js'
import { runContentMigrationIfNeeded } from './services/content-migration-service.js'
import { createDailyDbBackupIfNeeded } from './services/db-backup-service.js'
import { startDevServer, stopDevServer } from './services/dev-server-service.js'
import { startPrWatcher, stopPrWatcher } from './services/pr-watcher-service.js'
import { createTerminal, destroyAllTerminals, getTerminal } from './services/terminal-service.js'
import { startUsagePoller, stopUsagePoller } from './services/usage/index.js'
import * as wakeupService from './services/wakeup-service.js'
import { emit, emitEphemeral, handleConnection, setMessageHandler } from './services/websocket-service.js'
import { getActiveSession, getWorkspace, updateWorkspaceStatus } from './services/workspace-service.js'
import { getClientSpaPath, getDbPath, getKoboHome, getPackageVersion } from './utils/paths.js'
import { initProcessCleanup, killAll as killAllTrackedProcesses } from './utils/process-tracker.js'

console.log(`[kobo] Kōbō home: ${getKoboHome()}`)

// Initialize DB + run migrations
const db = getDb()
runMigrations(db)

// Daily DB backup (best-effort, fire-and-forget — never blocks boot).
// Creates a WAL-safe snapshot alongside kobo.db if no backup exists in the
// last 24h, and rotates out older backups beyond the retention window.
void createDailyDbBackupIfNeeded(db, getDbPath()).then((r) => {
  if (r.created) {
    console.log(`[kobo] Daily DB backup: ${r.created}`)
    if (r.deleted.length > 0) {
      console.log(`[kobo] Rotated ${r.deleted.length} old DB backup(s)`)
    }
  }
})

// Initialize process cleanup, agent watchdog, PR watcher, and wakeup rehydration
initProcessCleanup()
reconcileOrphanSessions()
startWatchdog()
wakeupService.rehydrate()
autoLoopService.rehydrate()
startPrWatcher()
startUsagePoller()

// Create Hono app
const app = new Hono()

// Health check (root / is handled by the SPA catch-all below)
app.get('/api/health', (c) => c.json({ status: 'ok', version: getPackageVersion() }))

// Mount route sub-routers
app.route('/api/workspaces', workspacesRouter)
app.route('/api/workspaces', imagesRouter)
app.route('/api/notion', notionRouter)
app.route('/api/sentry', sentryRouter)
app.route('/api/git', gitRouter)
app.route('/api/settings', settingsRouter)
app.route('/api/dev-server', devServerRouter)
app.route('/api/templates', templatesRouter)
app.route('/api/usage', usageRoutes)
app.route('/api/workspaces', documentsRouter)
app.route('/api/search', searchRouter)
app.route('/api/health', healthRouter)
app.route('/api/engines', enginesRouter)
app.route('/api/migration', migrationRouter)

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
    let filePath = path.join(clientDistPath, url.pathname)
    // Prevent path traversal
    if (!path.resolve(filePath).startsWith(clientDistPath)) {
      return c.notFound()
    }

    // Serve index.html for non-asset routes (SPA fallback)
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.join(clientDistPath, 'index.html')
    }

    if (!fs.existsSync(filePath)) {
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
const server = serve(
  {
    fetch: app.fetch,
    port: PORT,
  },
  (info) => {
    setBackendPort(info.port)
    console.log(`Server running at http://localhost:${info.port}`)
    // Content migration runs AFTER the HTTP listener is up so the frontend
    // can observe progress via WS broadcasts + GET /api/migration/status.
    // Not awaited — the callback returns quickly, the migration runs in the
    // background.
    void runContentMigrationIfNeeded(getDb(), getDbPath()).catch((err) => {
      console.error('[boot] content migration failed:', err)
    })
  },
)

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
setMessageHandler((type, payload) => {
  const p = payload as {
    workspaceId?: string
    content?: string
    prompt?: string
    sessionId?: string
    agentPermissionModeOverride?: 'plan' | 'bypass' | 'strict' | 'interactive'
  } | null

  if (type === 'chat:message' && p?.workspaceId && p?.content) {
    // Auto-loop owns the agent's turns — a stray user message would land in
    // the middle of an iteration (or in a freshly spawned next one) and break
    // the deterministic loop contract. Reject server-side so direct WS clients
    // can't bypass the frontend's input lock. Grooming phase (ready=0) is
    // skipped — the user must stay free to answer the agent's questions.
    const autoLoopStatus = autoLoopService.getStatus(p.workspaceId)
    if (autoLoopStatus.auto_loop && autoLoopStatus.auto_loop_ready) {
      emitEphemeral(p.workspaceId, 'chat:rejected', {
        reason: 'auto-loop-active',
        message: 'Auto-loop is running — disable it before sending a message',
      })
      return
    }

    // Reject chat input while paused on canUseTool — sending here would spawn
    // a parallel session and orphan the pending callback.
    const wsRow = getWorkspace(p.workspaceId)
    if (wsRow?.status === 'awaiting-user') {
      emitEphemeral(p.workspaceId, 'chat:rejected', {
        reason: 'awaiting-user',
        message: 'Answer via the question panel — typing in chat would orphan the pending callback',
      })
      return
    }

    // Prefer the session explicitly selected by the client (sessionId hint),
    // falling back to the running/most-recent non-idle session so idle sessions
    // never steal the tagging.
    const activeSession = getActiveSession(p.workspaceId)
    const sessionTag = p.sessionId ?? activeSession?.id ?? undefined
    // Persist user message so it survives page refresh
    emit(p.workspaceId, 'user:message', { content: p.content, sender: 'user' }, sessionTag)

    try {
      sendMessage(p.workspaceId, p.content)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // Only resume on the specific "No agent running" path. Other errors
      // (stdin closed, process dead mid-write, etc.) should surface to the
      // logs instead of silently respawning a fresh agent.
      if (!msg.includes('No agent running')) {
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
          startAgent(
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
        }
      } catch (restartErr) {
        console.error('[ws] Failed to resume agent:', restartErr instanceof Error ? restartErr.message : restartErr)
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
      stopAgent(p.workspaceId)
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
    try {
      stopDevServer(p.workspaceId)
    } catch (err) {
      console.error('[ws] Failed to stop dev-server:', err)
    }
  }
})

// Handle WebSocket upgrade requests on /ws path
server.on('upgrade', (request, socket, head) => {
  const { pathname } = new URL(request.url ?? '/', `http://localhost:${PORT}`)

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

function gracefulShutdown(signal: string): void {
  if (isShuttingDown) return
  isShuttingDown = true

  console.log(`\n[kobo] Received ${signal}, shutting down gracefully…`)

  // Stop accepting new connections
  wss.close(() => {
    console.log('[kobo] WebSocket server closed')
  })
  terminalWss.close()

  try {
    destroyAllTerminals()
    console.log('[kobo] Terminals killed')
  } catch {
    // Best-effort
  }

  server.close(() => {
    console.log('[kobo] HTTP server closed')
  })

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

  // Kill all tracked child processes (agents, dev servers)
  try {
    killAllTrackedProcesses()
    console.log('[kobo] Tracked processes killed')
  } catch {
    // Best-effort
  }

  // Close database
  try {
    closeDb()
    console.log('[kobo] Database closed')
  } catch {
    // Best-effort
  }

  // Give a short grace period for in-flight requests, then exit
  setTimeout(() => {
    console.log('[kobo] Shutdown complete')
    process.exit(0)
  }, 2000).unref()
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
process.on('SIGINT', () => gracefulShutdown('SIGINT'))
