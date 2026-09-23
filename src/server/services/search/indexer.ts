import type Database from 'better-sqlite3'

export interface SearchResult {
  eventId: string
  sessionId: string | null
  workspaceId: string
  workspaceName: string
  archived: boolean
  type: string
  timestamp: string
  snippet: string
}
export interface SearchOptions {
  limit?: number
  includeArchived?: boolean
  workspaceId?: string
}
export interface SearchIndexStatus {
  state: 'building' | 'ready' | 'error'
  processed: number
  total: number
  error?: string
}
interface SourceRow {
  rid: number
  id: string
  workspace_id: string
  session_id: string | null
  type: string
  created_at: string
  payload: string
}
interface Fragment {
  event_id: string
  message_key: string
  workspace_id: string
  session_id: string | null
  type: string
  created_at: string
  event_order: number
  text: string
}
interface State {
  cursor: string
  complete: number
  processed: number
  total: number
  base_order: number
}
export const normalizeSearchText = (text: string): string => text.normalize('NFC').toLowerCase()
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

function readable(row: SourceRow): { text: string; key: string } | null {
  let p: Record<string, unknown> | null
  try {
    p = JSON.parse(row.payload)
  } catch {
    return null
  }
  if (!p || typeof p !== 'object') return null
  let text: string | undefined
  let messageId = row.id
  if (row.type === 'user:message' && typeof p.content === 'string') text = p.content
  if (row.type === 'agent:event' && p.kind === 'message:text' && typeof p.text === 'string') {
    text = p.text
    if (typeof p.messageId === 'string') messageId = p.messageId
  }
  if (row.type === 'agent:output') {
    const content = (p.message as { content?: unknown } | null)?.content
    if (Array.isArray(content))
      text = content.flatMap((b) => (b?.type === 'text' && typeof b.text === 'string' ? [b.text] : [])).join('\n')
  }
  return text === undefined
    ? null
    : { text, key: JSON.stringify([row.workspace_id, row.session_id, row.type, messageId]) }
}

/** Map lowercased UTF-16 offsets back to display text (e.g. İ expands to i + dot). */
function snippet(text: string, match: number, needleLength: number): string {
  let normalizedOffset = 0
  let displayOffset = 0
  let startOffset = 0
  let endOffset = text.length
  for (const character of text) {
    if (normalizedOffset <= match) startOffset = displayOffset
    normalizedOffset += character.toLowerCase().length
    displayOffset += character.length
    if (normalizedOffset >= match + needleLength) {
      endOffset = displayOffset
      break
    }
  }
  const start = Math.max(0, startOffset - 100)
  const end = Math.min(text.length, endOffset + 100)
  return `${start ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`
}

/** Runs on a worker connection. Every batch is atomic and restartable. */
export class SearchIndexer {
  constructor(private readonly db: Database.Database) {}

  private state(): State {
    return this.db.prepare('SELECT * FROM search_index_state WHERE id = 1').get() as State
  }

  status(): SearchIndexStatus {
    const state = this.state()
    const pending = this.db.prepare('SELECT 1 FROM search_changes LIMIT 1').get()
    return {
      state: state.complete && !pending ? 'ready' : 'building',
      processed: state.processed,
      total: Math.max(state.processed, state.total, 0),
    }
  }

  private rebuild(keys: Set<string>): void {
    const fragments = this.db.prepare(
      'SELECT f.* FROM search_fragments f JOIN ws_events e ON e.id = f.event_id WHERE f.message_key = ? ORDER BY e.rowid',
    )
    const write =
      this.db.prepare(`INSERT INTO search_messages(message_key, workspace_id, session_id, event_id, type, created_at, text, normalized)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(message_key) DO UPDATE SET
      workspace_id=excluded.workspace_id, session_id=excluded.session_id, event_id=excluded.event_id,
      type=excluded.type, created_at=excluded.created_at, text=excluded.text, normalized=excluded.normalized`)
    for (const key of keys) {
      const rows = fragments.all(key) as Fragment[]
      const first = rows[0]
      if (!first) {
        this.db.prepare('DELETE FROM search_messages WHERE message_key = ?').run(key)
        continue
      }
      const text = rows
        .map((row) => row.text)
        .join('')
        .normalize('NFC')
      write.run(
        key,
        first.workspace_id,
        first.session_id,
        first.event_id,
        first.type,
        first.created_at,
        text,
        normalizeSearchText(text),
      )
    }
  }

  private consume(row: SourceRow | undefined, eventId: string, order: number, keys: Set<string>): void {
    const old = this.db
      .prepare('SELECT message_key, event_order FROM search_fragments WHERE event_id = ?')
      .get(eventId) as { message_key: string; event_order: number } | undefined
    if (old) keys.add(old.message_key)
    const value = row ? readable(row) : null
    if (!value || !row) {
      this.db.prepare('DELETE FROM search_fragments WHERE event_id = ?').run(eventId)
      return
    }
    keys.add(value.key)
    this.db
      .prepare(`INSERT INTO search_fragments(event_id, message_key, workspace_id, session_id, type, created_at, event_order, text)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(event_id) DO UPDATE SET
      message_key=excluded.message_key, workspace_id=excluded.workspace_id, session_id=excluded.session_id,
      type=excluded.type, created_at=excluded.created_at, text=excluded.text`)
      .run(
        row.id,
        value.key,
        row.workspace_id,
        row.session_id,
        row.type,
        row.created_at,
        old?.event_order ?? order,
        value.text,
      )
  }

  tick(batchSize = 500): SearchIndexStatus {
    // Acquire the writer reservation before reading: a deferred WAL snapshot
    // cannot be upgraded after another connection commits (SQLITE_BUSY_SNAPSHOT).
    this.db
      .transaction(() => {
        const state = this.state()
        if (state.total < 0)
          this.db.prepare('UPDATE search_index_state SET total = (SELECT count(*) FROM ws_events) WHERE id = 1').run()
        const keys = new Set<string>()
        const changeBudget = state.complete ? batchSize : Math.max(1, Math.floor(batchSize / 2))
        const changes = this.db.prepare('SELECT * FROM search_changes ORDER BY id LIMIT ?').all(changeBudget) as {
          id: number
          event_id: string
          operation: string
        }[]
        for (const change of changes) {
          const row = this.db.prepare('SELECT rowid AS rid, * FROM ws_events WHERE id = ?').get(change.event_id) as
            | SourceRow
            | undefined
          this.consume(
            row,
            change.event_id,
            change.operation === 'insert' ? state.base_order + change.id : (row?.rid ?? 0),
            keys,
          )
        }
        if (changes.length) this.db.prepare('DELETE FROM search_changes WHERE id <= ?').run(changes.at(-1)!.id)
        const backfillBudget = batchSize - changes.length
        if (!state.complete && backfillBudget > 0) {
          const rows = this.db
            .prepare('SELECT rowid AS rid, * FROM ws_events WHERE id > ? ORDER BY id LIMIT ?')
            .all(state.cursor, backfillBudget) as SourceRow[]
          for (const row of rows) this.consume(row, row.id, row.rid, keys)
          this.db
            .prepare('UPDATE search_index_state SET cursor = ?, processed = processed + ?, complete = ? WHERE id = 1')
            .run(rows.at(-1)?.id ?? state.cursor, rows.length, rows.length < backfillBudget ? 1 : 0)
        }
        this.rebuild(keys)
      })
      .immediate()
    return this.status()
  }

  /** Drain deletions ahead of queries, including those behind an insertion backlog. */
  removeDeleted(): void {
    this.db
      .transaction(() => {
        const rows = this.db
          .prepare(`SELECT DISTINCT f.event_id, f.message_key FROM search_changes c
        JOIN search_fragments f ON f.event_id = c.event_id
        WHERE NOT EXISTS (SELECT 1 FROM ws_events e WHERE e.id = c.event_id)`)
          .all() as { event_id: string; message_key: string }[]
        const keys = new Set<string>()
        for (const row of rows) {
          keys.add(row.message_key)
          this.db.prepare('DELETE FROM search_fragments WHERE event_id = ?').run(row.event_id)
        }
        this.rebuild(keys)
      })
      .immediate()
  }

  /** Resolve a normalized match to the original event used by history deep links. */
  private matchEventId(messageKey: string, match: number, fallback: string): string {
    const fragments = this.db
      .prepare(`SELECT f.event_id, f.text FROM search_fragments f JOIN ws_events e ON e.id = f.event_id
        WHERE f.message_key = ? ORDER BY e.rowid`)
      .all(messageKey) as { event_id: string; text: string }[]
    if (fragments.length < 2) return fragments[0]?.event_id ?? fallback

    // Normalize whole graphemes: NFC can compose characters across fragment
    // boundaries, and lowercasing can expand them (İ → i + combining dot).
    const source = fragments.map((fragment) => fragment.text).join('')
    let normalizedEnd = 0
    let sourceOffset = 0
    for (const { segment, index } of graphemes.segment(source)) {
      normalizedEnd += normalizeSearchText(segment).length
      if (normalizedEnd > match) {
        sourceOffset = index
        break
      }
    }
    let fragmentEnd = 0
    for (const fragment of fragments) {
      fragmentEnd += fragment.text.length
      if (fragmentEnd > sourceOffset) return fragment.event_id
    }
    return fallback
  }

  async search(query: string, options: SearchOptions = {}, cancelled = () => false): Promise<SearchResult[]> {
    this.removeDeleted()
    const needle = normalizeSearchText(query.trim())
    if (!needle) return []
    const trigram = [...needle].length >= 3 && !needle.includes('\0')
    const clauses = [options.includeArchived ? '1' : 'w.archived_at IS NULL']
    const args: (string | number)[] = []
    if (trigram) {
      clauses.push('search_messages_fts MATCH ?')
      args.push(`"${needle.replaceAll('"', '""')}"`)
    }
    if (options.workspaceId) {
      clauses.push('m.workspace_id = ?')
      args.push(options.workspaceId)
    }
    const statement = this.db.prepare(`SELECT m.*, w.name AS workspace_name, w.archived_at
      FROM search_messages m ${trigram ? 'JOIN search_messages_fts ON search_messages_fts.rowid = m.id' : ''}
      JOIN workspaces w ON w.id = m.workspace_id WHERE ${clauses.join(' AND ')} ORDER BY m.created_at DESC, m.event_id DESC`)
    const results: SearchResult[] = []
    let scanned = 0
    const limit = Math.min(200, Math.max(1, options.limit ?? 50))
    for (const row of statement.iterate(...args) as Iterable<{
      event_id: string
      message_key: string
      session_id: string | null
      workspace_id: string
      workspace_name: string
      archived_at: string | null
      type: string
      created_at: string
      text: string
      normalized: string
    }>) {
      if (cancelled()) throw new Error('Search cancelled')
      const index = row.normalized.indexOf(needle)
      if (index >= 0) {
        results.push({
          eventId: row.type === 'agent:event' ? this.matchEventId(row.message_key, index, row.event_id) : row.event_id,
          sessionId: row.session_id,
          workspaceId: row.workspace_id,
          workspaceName: row.workspace_name,
          archived: row.archived_at !== null,
          type: row.type,
          timestamp: row.created_at,
          snippet: snippet(row.text, index, needle.length),
        })
        if (results.length >= limit) break
      }
      if (++scanned % 500 === 0) await new Promise<void>((resolve) => setImmediate(resolve))
    }
    return results
  }
}
