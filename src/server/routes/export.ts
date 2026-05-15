import { Hono } from 'hono'
import { getDb } from '../db/index.js'
import * as workspaceService from '../services/workspace-service.js'

/** Hono sub-router for workspace data exports (mounted on /api/workspaces). */
const app = new Hono()

interface WsEventRow {
  session_id: string | null
  type: string
  payload: string
  created_at: string
}

/** Quote a CSV cell when it contains a delimiter, quote, or newline (RFC 4180). */
function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

function csvRow(values: string[]): string {
  return values.map(csvCell).join(',')
}

/**
 * Best-effort extraction of a human-readable text from an event payload.
 * Different event types carry their text under different keys; the full
 * payload is exported alongside, so this is a convenience column only.
 */
function extractText(payload: string): string {
  try {
    const parsed = JSON.parse(payload) as unknown
    if (!parsed || typeof parsed !== 'object') return ''
    const obj = parsed as Record<string, unknown>
    for (const key of ['text', 'content', 'message']) {
      const v = obj[key]
      if (typeof v === 'string') return v
    }
  } catch {
    /* malformed payload — leave the text column empty */
  }
  return ''
}

/** Filesystem-safe slug for the download filename. */
function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'workspace'
}

// GET /api/workspaces/:id/events.csv — export every ws_event of the workspace
// (all sessions, chronological) as a CSV file.
app.get('/:id/events.csv', (c) => {
  try {
    const id = c.req.param('id')
    const workspace = workspaceService.getWorkspace(id)
    if (!workspace) {
      return c.json({ error: `Workspace '${id}' not found` }, 404)
    }

    const rows = getDb()
      .prepare('SELECT session_id, type, payload, created_at FROM ws_events WHERE workspace_id = ? ORDER BY rowid ASC')
      .all(id) as WsEventRow[]

    const lines = [csvRow(['created_at', 'session_id', 'type', 'text', 'payload'])]
    for (const r of rows) {
      lines.push(csvRow([r.created_at, r.session_id ?? '', r.type, extractText(r.payload), r.payload]))
    }
    // Leading BOM so Excel reads UTF-8 correctly; CRLF line endings per RFC 4180.
    const csv = `﻿${lines.join('\r\n')}\r\n`

    return c.body(csv, 200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${slugify(workspace.name)}-events.csv"`,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 500)
  }
})

export default app
