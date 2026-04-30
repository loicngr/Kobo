import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { Hono } from 'hono'
import * as workspaceService from '../services/workspace-service.js'

/** Hono sub-router for workspace document browsing (read-only). */
const app = new Hono()

/**
 * Directories (relative to the worktree root) where AI-generated documents
 * may live. Scanned recursively — any `.md` file found below one of these
 * roots is surfaced in the documents panel.
 *
 * Kept intentionally narrow to avoid leaking unrelated project docs
 * (README, product specs, …) into the panel.
 */
const DOCUMENT_DIRS = ['docs/plans', 'docs/superpowers', '.ai/thoughts']

/** Only .md files are listed. */
const MD_EXT = '.md'

/** Depth cap to keep recursion bounded even on pathological symlink loops. */
const MAX_DEPTH = 8

interface DocumentFile {
  path: string
  name: string
  modifiedAt: string
}

function walkMarkdownFiles(rootAbs: string, rootRel: string, out: DocumentFile[], depth = 0): void {
  if (depth > MAX_DEPTH) return
  let entries: string[]
  try {
    entries = readdirSync(rootAbs)
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.startsWith('.') && entry !== '.ai') continue // skip hidden except `.ai`
    const absEntry = path.join(rootAbs, entry)
    const relEntry = `${rootRel}/${entry}`
    let stat: ReturnType<typeof statSync>
    try {
      stat = statSync(absEntry)
    } catch {
      continue
    }
    if (stat.isDirectory()) {
      walkMarkdownFiles(absEntry, relEntry, out, depth + 1)
    } else if (stat.isFile() && entry.endsWith(MD_EXT)) {
      out.push({
        path: relEntry,
        name: entry,
        modifiedAt: stat.mtime.toISOString(),
      })
    }
  }
}

// GET /:id/documents — list every .md file under DOCUMENT_DIRS in the workspace worktree
app.get('/:id/documents', (c) => {
  try {
    const id = c.req.param('id')
    const workspace = workspaceService.getWorkspace(id)
    if (!workspace) {
      return c.json({ error: `Workspace '${id}' not found` }, 404)
    }

    const worktreePath = workspace.worktreePath
    const documents: DocumentFile[] = []

    for (const dir of DOCUMENT_DIRS) {
      const absDir = path.join(worktreePath, dir)
      if (!existsSync(absDir)) continue
      walkMarkdownFiles(absDir, dir, documents)
    }

    // Sort by modifiedAt descending (most recent first)
    documents.sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime())

    return c.json({ documents })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 500)
  }
})

// GET /:id/document?path=<relative> — read a single document
app.get('/:id/document', (c) => {
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

    // Security: normalize the path and verify it stays within allowed roots.
    const normalized = path.normalize(filePath)
    if (
      normalized.includes('..') ||
      !DOCUMENT_DIRS.some((dir) => normalized.startsWith(`${dir}/`) || normalized === dir)
    ) {
      return c.json({ error: `Invalid path: must be under ${DOCUMENT_DIRS.map((d) => `${d}/`).join(', ')}` }, 400)
    }
    if (!normalized.endsWith(MD_EXT)) {
      return c.json({ error: 'Only .md files can be read' }, 400)
    }

    const worktreePath = workspace.worktreePath
    const absPath = path.join(worktreePath, normalized)

    if (!existsSync(absPath)) {
      return c.json({ error: `Document not found: ${normalized}` }, 404)
    }

    const content = readFileSync(absPath, 'utf-8')
    return c.json({ content, path: normalized })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 500)
  }
})

export default app
