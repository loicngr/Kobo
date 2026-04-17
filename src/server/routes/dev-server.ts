import { Hono } from 'hono'
import { getDevServerLogs, getStatus, startDevServer, stopDevServer } from '../services/dev-server-service.js'
import { getWorkspace } from '../services/workspace-service.js'

/** Hono sub-router for per-workspace dev server lifecycle (start, stop, status, logs). */
const app = new Hono()

// GET /api/dev-server/:workspaceId/status
app.get('/:workspaceId/status', (c) => {
  try {
    const workspaceId = c.req.param('workspaceId')
    const workspace = getWorkspace(workspaceId)

    if (!workspace) {
      return c.json({ error: `Workspace '${workspaceId}' not found` }, 404)
    }

    const status = getStatus(workspace.projectPath, workspace.workingBranch, workspaceId)
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
app.post('/:workspaceId/start', (c) => {
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
    return c.json({ error: message }, 500)
  }
})

// POST /api/dev-server/:workspaceId/stop
app.post('/:workspaceId/stop', (c) => {
  try {
    const workspaceId = c.req.param('workspaceId')
    const workspace = getWorkspace(workspaceId)

    if (!workspace) {
      return c.json({ error: `Workspace '${workspaceId}' not found` }, 404)
    }

    const status = stopDevServer(workspaceId)
    return c.json(status)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 500)
  }
})

// GET /api/dev-server/:workspaceId/logs
app.get('/:workspaceId/logs', (c) => {
  try {
    const workspaceId = c.req.param('workspaceId')
    const workspace = getWorkspace(workspaceId)

    if (!workspace) {
      return c.json({ error: `Workspace '${workspaceId}' not found` }, 404)
    }

    const tail = parseInt(c.req.query('tail') ?? '200', 10)
    const logs = getDevServerLogs(workspaceId, tail)
    return c.json({ logs })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 500)
  }
})

export default app
