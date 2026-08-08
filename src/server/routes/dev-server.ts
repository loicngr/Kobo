import { Hono } from 'hono'
import { migrationGuard } from '../middleware/migration-guard.js'
import { getDevServerLogs, getStatus, startDevServer, stopDevServer } from '../services/dev-server-service.js'
import { getProjectSettings } from '../services/settings-service.js'
import { getWorkspace } from '../services/workspace-service.js'

/** Hono sub-router for per-workspace dev server lifecycle (start, stop, status, logs). */
const app = new Hono()

// GET /api/dev-server/:workspaceId/status
app.get('/:workspaceId/status', async (c) => {
  try {
    const workspaceId = c.req.param('workspaceId')
    const workspace = getWorkspace(workspaceId)

    if (!workspace) {
      return c.json({ error: `Workspace '${workspaceId}' not found` }, 404)
    }

    const devServer = getProjectSettings(workspace.projectPath)?.devServer
    if (!devServer?.startCommand?.trim()) {
      return c.json({
        status: 'not_configured',
        configured: false,
        message: 'No dev server is configured for this project',
        instanceName: '',
        projectName: '',
        httpPort: '',
        url: '',
        containers: [],
      })
    }

    const status = await getStatus(workspace.projectPath, workspace.workingBranch, workspaceId)
    // If runtime detection returns unknown, use persisted status from DB
    if (status.status === 'unknown' && workspace.devServerStatus && workspace.devServerStatus !== 'stopped') {
      status.status = workspace.devServerStatus as typeof status.status
    }
    return c.json(status)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 500)
  }
})

// POST /api/dev-server/:workspaceId/start
app.post('/:workspaceId/start', migrationGuard, (c) => {
  try {
    const workspaceId = c.req.param('workspaceId')
    const workspace = getWorkspace(workspaceId)

    if (!workspace) {
      return c.json({ error: `Workspace '${workspaceId}' not found` }, 404)
    }

    const status = startDevServer(workspaceId)
    return c.json(status)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const status = message.includes('already starting') ? 409 : 500
    return c.json({ error: message }, status)
  }
})

// POST /api/dev-server/:workspaceId/stop
app.post('/:workspaceId/stop', migrationGuard, async (c) => {
  try {
    const workspaceId = c.req.param('workspaceId')
    const workspace = getWorkspace(workspaceId)

    if (!workspace) {
      return c.json({ error: `Workspace '${workspaceId}' not found` }, 404)
    }

    const status = await stopDevServer(workspaceId)
    return c.json(status)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 500)
  }
})

// GET /api/dev-server/:workspaceId/logs
app.get('/:workspaceId/logs', async (c) => {
  try {
    const workspaceId = c.req.param('workspaceId')
    const workspace = getWorkspace(workspaceId)

    if (!workspace) {
      return c.json({ error: `Workspace '${workspaceId}' not found` }, 404)
    }

    const parsedTail = parseInt(c.req.query('tail') ?? '200', 10)
    const tail = Math.max(1, Math.min(Number.isFinite(parsedTail) ? parsedTail : 200, 1000))
    const logs = await getDevServerLogs(workspaceId, tail)
    return c.json({ logs })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 500)
  }
})

export default app
