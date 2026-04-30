import { getDb } from '../db/index.js'

/** A single search hit returned by `searchEvents`. */
export interface SearchResult {
  workspaceId: string
  workspaceName: string
  archived: boolean
  /** `'user:message'` or `'agent:output'`. */
  type: string
  /** ISO timestamp of the event (ws_events.created_at). */
  timestamp: string
  /** Up to ~230 chars of readable text surrounding the first match. */
  snippet: string
}

export interface SearchOptions {
  /** Max number of results to return. Default 50. */
  limit?: number
  /** Include matches from archived workspaces. Default false. */
  includeArchived?: boolean
}

/** Event types that carry user-authored or assistant-authored readable text. */
const SEARCHABLE_TYPES = ['user:message', 'agent:output'] as const

const SNIPPET_CONTEXT = 100 // chars on each side of the match

/**
 * Extract the readable text content of a ws_events payload, or `null` when
 * the event carries no natural-language content (system events, rate-limit
 * pings, etc.).
 */
function extractReadableText(type: string, payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null
  const p = payload as Record<string, unknown>

  if (type === 'user:message') {
    return typeof p.content === 'string' ? p.content : null
  }

  if (type === 'agent:output') {
    // Claude Code streams `{type: 'assistant', message: {content: [{type: 'text', text: '...'}, ...]}}`
    const msg = p.message as { content?: unknown } | undefined
    if (msg && Array.isArray(msg.content)) {
      const parts: string[] = []
      for (const block of msg.content) {
        if (block && typeof block === 'object') {
          const b = block as { type?: unknown; text?: unknown }
          if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
        }
      }
      return parts.length > 0 ? parts.join('\n') : null
    }
  }

  return null
}

function buildSnippet(text: string, matchIndex: number, query: string): string {
  const start = Math.max(0, matchIndex - SNIPPET_CONTEXT)
  const end = Math.min(text.length, matchIndex + query.length + SNIPPET_CONTEXT)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < text.length ? '…' : ''
  return `${prefix}${text.slice(start, end).trim()}${suffix}`
}

interface Row {
  workspace_id: string
  workspace_name: string
  archived_at: string | null
  type: string
  created_at: string
  payload: string
}

/**
 * Full-text-ish search across `ws_events.payload` joined with `workspaces`.
 *
 * - Trimmed empty queries return `[]` without hitting the database.
 * - SQLite does the first filter via `LIKE '%q%'` on the raw payload JSON.
 *   Results are then post-filtered in JS against the **readable** text
 *   (extracted from the JSON) to avoid false positives like matches inside
 *   field names or schema strings.
 * - Snippets are 100 chars of context on either side of the first match.
 */
export function searchEvents(query: string, options: SearchOptions = {}): SearchResult[] {
  const trimmed = query.trim()
  if (trimmed.length === 0) return []

  const { limit = 50, includeArchived = false } = options

  const db = getDb()
  const typePlaceholders = SEARCHABLE_TYPES.map(() => '?').join(', ')
  const archiveFilter = includeArchived ? '' : 'AND w.archived_at IS NULL'
  const likePattern = `%${trimmed}%`

  // Over-fetch a bit so post-filter rejects don't shrink us below `limit` on
  // realistic datasets, without scanning the entire table.
  const dbLimit = Math.max(limit * 3, 100)

  const rows = db
    .prepare(
      `SELECT e.workspace_id, e.type, e.created_at, e.payload,
              w.name AS workspace_name, w.archived_at
       FROM ws_events e
       JOIN workspaces w ON e.workspace_id = w.id
       WHERE e.type IN (${typePlaceholders})
         AND e.payload LIKE ?
         ${archiveFilter}
       ORDER BY e.created_at DESC
       LIMIT ?`,
    )
    .all(...SEARCHABLE_TYPES, likePattern, dbLimit) as Row[]

  const needle = trimmed.toLowerCase()
  const results: SearchResult[] = []

  for (const row of rows) {
    let parsed: unknown
    try {
      parsed = JSON.parse(row.payload)
    } catch {
      continue
    }
    const text = extractReadableText(row.type, parsed)
    if (!text) continue
    const idx = text.toLowerCase().indexOf(needle)
    if (idx < 0) continue

    results.push({
      workspaceId: row.workspace_id,
      workspaceName: row.workspace_name,
      archived: row.archived_at !== null,
      type: row.type,
      timestamp: row.created_at,
      snippet: buildSnippet(text, idx, trimmed),
    })

    if (results.length >= limit) break
  }

  return results
}
