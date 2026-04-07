#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { WebSocketServer } from 'ws'
import { closeDb, getDb } from './db/index.js'
import { runMigrations } from './db/migrations.js'
import devServerRouter from './routes/dev-server.js'
import gitRouter from './routes/git.js'
import imagesRouter from './routes/images.js'
import notionRouter from './routes/notion.js'
import settingsRouter from './routes/settings.js'
import workspacesRouter from './routes/workspaces.js'
import {
  getAvailableSkills,
  sendMessage,
  setBackendPort,
  startAgent,
  startWatchdog,
  stopAgent,
  stopWatchdog,
} from './services/agent-manager.js'
import { startDevServer, stopDevServer } from './services/dev-server-service.js'
import { startPrWatcher, stopPrWatcher } from './services/pr-watcher-service.js'
import { emit, handleConnection, setMessageHandler } from './services/websocket-service.js'
import { getLatestSession, getWorkspace, updateWorkspaceStatus } from './services/workspace-service.js'
import { getClientSpaPath, getKoboHome, getPackageVersion } from './utils/paths.js'
import { initProcessCleanup, killAll as killAllTrackedProcesses } from './utils/process-tracker.js'

// 0. Runtime prerequisite check — warn if claude CLI is missing. Don't block
// startup: the user may still want to configure settings or browse workspaces
// before installing Claude Code.
{
  const check = spawnSync('claude', ['--version'], { stdio: 'ignore' })
  if (check.error && (check.error as NodeJS.ErrnoException).code === 'ENOENT') {
    console.warn(
      "[kobo] WARNING: 'claude' CLI not found on PATH. Kōbō will fail to spawn agents until Claude Code is installed. See https://claude.com/claude-code",
    )
  }
}

console.log(`[kobo] Kōbō home: ${getKoboHome()}`)

// 1. Initialize DB + run migrations
const db = getDb()
runMigrations(db)

// 2. Initialize process cleanup, agent watchdog, and PR watcher
initProcessCleanup()
startWatchdog()
startPrWatcher()

// 3. Create Hono app
const app = new Hono()

// Health check (root / is handled by the SPA catch-all below)
app.get('/api/health', (c) => c.json({ status: 'ok', version: getPackageVersion() }))

// 4. Mount route sub-routers
app.route('/api/workspaces', workspacesRouter)
app.route('/api/workspaces', imagesRouter)
app.route('/api/notion', notionRouter)
app.route('/api/git', gitRouter)
app.route('/api/settings', settingsRouter)
app.route('/api/dev-server', devServerRouter)

// Skills endpoint
app.get('/api/skills', (c) => c.json(getAvailableSkills()))

const PORT = parseInt(process.env.SERVER_PORT || process.env.PORT || '3000', 10)

// 9. Serve static files from the built SPA if present (production mode).
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

// 5. Create HTTP server via @hono/node-server
const server = serve(
  {
    fetch: app.fetch,
    port: PORT,
  },
  (info) => {
    setBackendPort(info.port)
    console.log(`Server running at http://localhost:${info.port}`)
  },
)

// 6. Create WebSocketServer attached to the HTTP server
const wss = new WebSocketServer({ noServer: true })

// 7. Wire WebSocket connections to websocket-service.handleConnection()
wss.on('connection', (ws) => {
  handleConnection(ws)
})

// 8. Wire websocket-service message handler to agent-manager
setMessageHandler((type, payload) => {
  const p = payload as { workspaceId?: string; content?: string; prompt?: string } | null

  if (type === 'chat:message' && p?.workspaceId && p?.content) {
    // Persist user message so it survives page refresh
    const latestSession = getLatestSession(p.workspaceId)
    emit(
      p.workspaceId,
      'user:message',
      { content: p.content, sender: 'user' },
      latestSession?.claudeSessionId ?? undefined,
    )

    try {
      sendMessage(p.workspaceId, p.content)
    } catch {
      // Agent not running — resume the existing session
      try {
        const workspace = getWorkspace(p.workspaceId)
        if (workspace) {
          const worktreePath = `${workspace.projectPath}/.worktrees/${workspace.workingBranch}`
          startAgent(p.workspaceId, worktreePath, p.content, workspace.model, true, workspace.permissionMode)
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
      const worktreePath = `${workspace.projectPath}/.worktrees/${workspace.workingBranch}`
      const prompt = p.prompt ?? 'Continue the previous task where you left off.'
      startAgent(p.workspaceId, worktreePath, prompt, workspace.model, false, workspace.permissionMode)
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
  } else {
    socket.destroy()
  }
})

// 9. Graceful shutdown handler
let isShuttingDown = false

function gracefulShutdown(signal: string): void {
  if (isShuttingDown) return
  isShuttingDown = true

  console.log(`\n[kobo] Received ${signal}, shutting down gracefully…`)

  // 1. Stop accepting new connections
  wss.close(() => {
    console.log('[kobo] WebSocket server closed')
  })

  server.close(() => {
    console.log('[kobo] HTTP server closed')
  })

  // 2. Stop background services
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

  // 3. Kill all tracked child processes (agents, dev servers)
  try {
    killAllTrackedProcesses()
    console.log('[kobo] Tracked processes killed')
  } catch {
    // Best-effort
  }

  // 4. Close database
  try {
    closeDb()
    console.log('[kobo] Database closed')
  } catch {
    // Best-effort
  }

  // 4. Give a short grace period for in-flight requests, then exit
  setTimeout(() => {
    console.log('[kobo] Shutdown complete')
    process.exit(0)
  }, 2000).unref()
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
process.on('SIGINT', () => gracefulShutdown('SIGINT'))
