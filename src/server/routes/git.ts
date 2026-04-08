import { Hono } from 'hono'
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

export default app
