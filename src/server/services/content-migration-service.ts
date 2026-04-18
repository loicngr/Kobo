import type Database from 'better-sqlite3'
import { nanoid } from 'nanoid'
import { createParserState, parseClaudeLine } from './agent/engines/claude-code/stream-parser.js'
import type { AgentEvent } from './agent/engines/types.js'
import { createPreMigrationBackup } from './db-backup-service.js'
import { broadcastAll } from './websocket-service.js'

/**
 * Discriminated union. Consumers (frontend store, overlay, tests) narrow on
 * `state` to access variant-specific fields — fields like `total`, `processed`,
 * `finishedAt` only exist in the states where they're meaningful.
 */
export type ContentMigrationStatus =
  | { state: 'idle' }
  | { state: 'backing-up'; startedAt: string }
  | { state: 'running'; total: number; processed: number; startedAt: string; backupPath?: string }
  | {
      state: 'done'
      total: number
      processed: number
      startedAt: string
      finishedAt: string
      backupPath?: string
    }
  | {
      state: 'error'
      errorMessage: string
      startedAt?: string
      backupPath?: string
      total?: number
      processed?: number
    }

// Internal mutable state tracked as plain fields — assembled into the public
// discriminated union only at read time (getContentMigrationStatus) so the
// external API stays exhaustive while the in-memory shape stays simple.
interface InternalState {
  state: ContentMigrationStatus['state']
  total: number
  processed: number
  errorMessage?: string
  startedAt?: string
  finishedAt?: string
  backupPath?: string
}

const internal: InternalState = { state: 'idle', total: 0, processed: 0 }
let isRunning = false

function snapshot(): ContentMigrationStatus {
  switch (internal.state) {
    case 'idle':
      return { state: 'idle' }
    case 'backing-up':
      return { state: 'backing-up', startedAt: internal.startedAt ?? new Date(0).toISOString() }
    case 'running':
      return {
        state: 'running',
        total: internal.total,
        processed: internal.processed,
        startedAt: internal.startedAt ?? new Date(0).toISOString(),
        ...(internal.backupPath !== undefined ? { backupPath: internal.backupPath } : {}),
      }
    case 'done':
      return {
        state: 'done',
        total: internal.total,
        processed: internal.processed,
        startedAt: internal.startedAt ?? new Date(0).toISOString(),
        finishedAt: internal.finishedAt ?? new Date(0).toISOString(),
        ...(internal.backupPath !== undefined ? { backupPath: internal.backupPath } : {}),
      }
    case 'error':
      return {
        state: 'error',
        errorMessage: internal.errorMessage ?? 'Unknown error',
        ...(internal.startedAt !== undefined ? { startedAt: internal.startedAt } : {}),
        ...(internal.backupPath !== undefined ? { backupPath: internal.backupPath } : {}),
        ...(internal.total > 0 ? { total: internal.total } : {}),
        ...(internal.processed > 0 ? { processed: internal.processed } : {}),
      }
  }
}

export function getContentMigrationStatus(): ContentMigrationStatus {
  return snapshot()
}

export async function runContentMigrationIfNeeded(db: Database.Database, dbPath: string): Promise<void> {
  if (isRunning) return
  isRunning = true
  try {
    const row = db
      .prepare("SELECT COUNT(*) AS c FROM ws_events WHERE type IN ('agent:output', 'agent:stderr', 'agent:status')")
      .get() as { c: number }
    if (row.c === 0) {
      internal.state = 'idle'
      isRunning = false
      return
    }
    internal.state = 'backing-up'
    internal.startedAt = new Date().toISOString()
    broadcastStatus()
    const backup = await createPreMigrationBackup(db, dbPath, 'v10')
    internal.backupPath = backup.created ?? undefined

    internal.state = 'running'
    internal.total = row.c
    internal.processed = 0
    broadcastStatus()

    await processLoop(db)

    internal.state = 'done'
    internal.finishedAt = new Date().toISOString()
    broadcastStatus()
  } catch (err) {
    internal.state = 'error'
    internal.errorMessage = err instanceof Error ? err.message : String(err)
    broadcastStatus()
    throw err
  } finally {
    isRunning = false
  }
}

function broadcastStatus(): void {
  // Content-migration events are global (no workspace context) — use broadcastAll so every
  // connected WS client receives them regardless of their workspace subscriptions.
  broadcastAll(internal.state === 'error' ? 'migration:error' : 'migration:progress', getContentMigrationStatus())
}

async function processLoop(db: Database.Database): Promise<void> {
  const batchSize = 500
  const selectStmt = db.prepare(
    "SELECT id, workspace_id, type, payload, session_id, created_at FROM ws_events WHERE type IN ('agent:output', 'agent:stderr', 'agent:status') ORDER BY created_at ASC LIMIT ?",
  )
  const insertStmt = db.prepare(
    'INSERT INTO ws_events (id, workspace_id, type, payload, session_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  )
  const deleteStmt = db.prepare('DELETE FROM ws_events WHERE id = ?')

  while (true) {
    const rows = selectStmt.all(batchSize) as Array<{
      id: string
      workspace_id: string
      type: string
      payload: string
      session_id: string | null
      created_at: string
    }>
    if (rows.length === 0) break

    db.transaction(() => {
      for (const r of rows) {
        const events = convertRow(r.type, r.payload, { workspaceId: r.workspace_id })
        for (const ev of events) {
          insertStmt.run(nanoid(), r.workspace_id, 'agent:event', JSON.stringify(ev), r.session_id, r.created_at)
        }
        deleteStmt.run(r.id)
      }
    })()

    internal.processed += rows.length
    broadcastStatus()
    // Yield to the event loop
    await new Promise((resolve) => setImmediate(resolve))
  }
}

export function convertRow(type: string, payload: string, context?: { workspaceId: string }): AgentEvent[] {
  if (type === 'agent:status') return [] // redundant — re-derivable from session events
  if (type === 'agent:stderr') {
    // Drop: the new engine only logs non-quota stderr via console.warn and
    // does not persist it. Converting legacy stderr rows to error events
    // would surface every historical Claude CLI warning ("no stdin data in
    // 3s…", debug lines) as a UI-blocking banner. Quota-bearing stderr is
    // handled live by the engine's backoff path, not via replay.
    return []
  }
  if (type === 'agent:output') {
    try {
      const parsed = JSON.parse(payload)
      // The legacy payload may be either the raw Claude NDJSON already-parsed object,
      // or a wrapper { type: 'raw', content: '...' } for non-JSON output. Handle both.
      if (parsed && typeof parsed === 'object' && (parsed as { type?: string }).type === 'raw') {
        return [{ kind: 'message:raw', content: String((parsed as { content?: string }).content ?? '') }]
      }
      const state = createParserState()
      const { events } = parseClaudeLine(JSON.stringify(parsed), state)
      return events
    } catch {
      // Log enough to debug (first 200 chars of the bad payload + the owning
      // workspace id when the caller passed one). We intentionally do not log
      // the full payload to keep the console readable on noisy migrations.
      const preview = payload.length > 200 ? `${payload.slice(0, 200)}…` : payload
      const ctx = context?.workspaceId ? ` (workspace=${context.workspaceId})` : ''
      console.warn(
        `[content-migration] Could not parse agent:output payload${ctx}, falling back to message:raw. Preview: ${preview}`,
      )
      return [{ kind: 'message:raw', content: payload }]
    }
  }
  return []
}

/** Test-only. */
export function _resetStatusForTest(): void {
  internal.state = 'idle'
  internal.total = 0
  internal.processed = 0
  internal.errorMessage = undefined
  internal.startedAt = undefined
  internal.finishedAt = undefined
  internal.backupPath = undefined
  isRunning = false
}
