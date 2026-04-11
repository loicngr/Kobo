import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { Hono } from 'hono'
import * as workspaceService from '../services/workspace-service.js'

/** Hono sub-router for workspace plan file browsing (read-only). */
const app = new Hono()

/** Directories inside the worktree where plan files may live. */
const PLAN_DIRS = ['docs/plans', 'docs/superpowers/plans']

/** Only .md files are listed. */
const MD_EXT = '.md'

interface PlanFile {
  path: string
  name: string
  modifiedAt: string
}

// GET /:id/plans — list plan files in the workspace worktree
app.get('/:id/plans', (c) => {
  try {
    const id = c.req.param('id')
    const workspace = workspaceService.getWorkspace(id)
    if (!workspace) {
      return c.json({ error: `Workspace '${id}' not found` }, 404)
    }

    const worktreePath = path.join(workspace.projectPath, '.worktrees', workspace.workingBranch)
    const plans: PlanFile[] = []

    for (const dir of PLAN_DIRS) {
      const absDir = path.join(worktreePath, dir)
      if (!existsSync(absDir)) continue
      try {
        const entries = readdirSync(absDir)
        for (const entry of entries) {
          if (!entry.endsWith(MD_EXT)) continue
          try {
            const absFile = path.join(absDir, entry)
            const stat = statSync(absFile)
            if (!stat.isFile()) continue
            plans.push({
              path: `${dir}/${entry}`,
              name: entry,
              modifiedAt: stat.mtime.toISOString(),
            })
          } catch {
            // Skip files we can't stat
          }
        }
      } catch {
        // Skip directories we can't read
      }
    }

    // Sort by modifiedAt descending (most recent first)
    plans.sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime())

    return c.json({ plans })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 500)
  }
})

// GET /:id/plan-file?path=<relative> — read a single plan file
app.get('/:id/plan-file', (c) => {
  try {
    const id = c.req.param('id')
    const filePath = c.req.query('path')

    if (!filePath) {
      return c.json({ error: 'Missing path query parameter' }, 400)
    }

    const workspace = workspaceService.getWorkspace(id)
    if (!workspace) {
      return c.json({ error: `Workspace '${id}' not found` }, 404)
    }

    // Security: normalize the path and verify it stays within allowed directories
    const normalized = path.normalize(filePath)
    if (normalized.includes('..') || !PLAN_DIRS.some((dir) => normalized.startsWith(dir))) {
      return c.json({ error: 'Invalid path: must be under docs/plans/ or docs/superpowers/plans/' }, 400)
    }

    const worktreePath = path.join(workspace.projectPath, '.worktrees', workspace.workingBranch)
    const absPath = path.join(worktreePath, normalized)

    if (!existsSync(absPath)) {
      return c.json({ error: `Plan file not found: ${normalized}` }, 404)
    }

    const content = readFileSync(absPath, 'utf-8')
    return c.json({ content, path: normalized })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 500)
  }
})

export default app
