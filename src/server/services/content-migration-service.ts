import type Database from 'better-sqlite3'
import type { AgentEvent } from './agent/engines/types.js'

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

/**
 * Legacy ws_events content migration.
 *
 * Historical context: earlier versions of Kōbō persisted Claude Code stdout as
 * `agent:output` / `agent:stderr` / `agent:status` rows. The migration to the
 * unified `agent:event` shape was completed in v10. As of the Claude Agent SDK
 * cutover, the stream-parser used to reconstruct AgentEvents from those legacy
 * rows has been removed.
 *
 * All production databases have been migrated. This function is now a no-op
 * kept for API compatibility — it always reports `idle`. Should any rare,
 * unmigrated row remain, it is left untouched in `ws_events` (and ignored by
 * the new replay path which only reads `agent:event`).
 */
export async function runContentMigrationIfNeeded(_db: Database.Database, _dbPath: string): Promise<void> {
  if (isRunning) return
  isRunning = true
  try {
    internal.state = 'idle'
  } finally {
    isRunning = false
  }
}

/**
 * Convert a legacy ws_events row into AgentEvents.
 *
 * The stream-parser has been removed; this function now skips every legacy
 * type and returns an empty array. It is preserved as an export for API
 * compatibility with old call sites and tests.
 */
export function convertRow(_type: string, _payload: string, _context?: { workspaceId: string }): AgentEvent[] {
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
