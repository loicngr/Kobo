import { Hono } from 'hono'
import { getDb } from '../db/index.js'
import { listOrphanWorktrees } from '../services/worktree-service.js'
import { listBranches, listRemoteBranches } from '../utils/git-ops.js'

/** Hono sub-router for git-related endpoints (branch listing). */
const app = new Hono()

// GET /api/git/branches?path=<repoPath> — list branches for a repo
app.get('/branches', (c) => {
  try {
    const repoPath = c.req.query('path')

    if (!repoPath) {
      return c.json({ error: 'Missing required query parameter: path' }, 400)
    }

    const local = listBranches(repoPath)
    const remote = listRemoteBranches(repoPath)

    return c.json({ local, remote })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 500)
  }
})

// GET /api/git/orphan-worktrees?projectPath=<path> — list worktrees of a
// project that are NOT attached to any Kōbō workspace yet.
app.get('/orphan-worktrees', (c) => {
  try {
    const projectPath = c.req.query('projectPath')
    if (!projectPath) {
      return c.json({ error: 'Missing required query parameter: projectPath' }, 400)
    }

    const db = getDb()
    const rows = db.prepare('SELECT worktree_path FROM workspaces WHERE project_path = ?').all(projectPath) as Array<{
      worktree_path: string | null
    }>
    const attachedPaths = new Set(rows.map((r) => r.worktree_path).filter((p): p is string => !!p))

    const orphans = listOrphanWorktrees(projectPath, attachedPaths)
    return c.json(orphans)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 500)
  }
})

export default app
