import type Database from 'better-sqlite3'
import { getDb } from '../db/index.js'

export function classifyActivity(type: string, payload: unknown): string | null {
  const event = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
  if (type === 'agent:event') {
    if (event.kind === 'session:ended' && event.superseded) return null
    if (event.kind === 'session:user-input-requested')
      return event.requestKind === 'permission' ? 'permission' : 'question'
    if (event.kind === 'error') return 'error'
    if (event.kind === 'session:ended' && event.reason === 'completed') return 'completed'
    if (event.kind === 'session:ended' && (event.reason === 'error' || event.reason === 'watchdog')) return 'error'
  }
  const kinds: Record<string, string> = {
    'pr:merged': 'pr-merged',
    'pr:approved': 'pr-approved',
    'pr:changes-requested': 'pr-changes-requested',
    'pr:ci-failed': 'pr-ci-failed',
    'pr:ci-recovered': 'pr-ci-recovered',
    'pr:merge-conflict': 'pr-merge-conflict',
    'pr:ready-to-merge': 'pr-ready-to-merge',
    'workspace:archived': 'archived',
    'workspace:worktree-purged': 'purged',
    'workspace:worktree-restored': 'restored',
  }
  return kinds[type] ?? null
}

/** Compact metadata only; failure must never interrupt agent/event delivery. */
export function recordActivity(
  workspaceId: string,
  type: string,
  payload: unknown,
  sessionId?: string,
  db?: Database.Database,
): void {
  const kind = classifyActivity(type, payload)
  if (!kind) return
  try {
    const database = db ?? getDb()
    database
      .prepare('INSERT INTO workspace_activity (workspace_id, kind, session_id, created_at) VALUES (?, ?, ?, ?)')
      .run(workspaceId, kind, sessionId ?? null, new Date().toISOString())
    // Bounded even when no browser is connected. Only significant events reach here.
    database
      .prepare('DELETE FROM workspace_activity WHERE created_at < ?')
      .run(new Date(Date.now() - 30 * 86400_000).toISOString())
  } catch (error) {
    console.error('[activity] Could not record workspace activity:', error)
  }
}

export interface ActivityItem {
  id: number
  workspaceId: string
  workspaceName: string
  kind: string
  sessionId: string | null
  createdAt: string
}

export function activityCursor(db: Database.Database = getDb()): number {
  return (
    (
      db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'workspace_activity'").get() as
        | { seq: number }
        | undefined
    )?.seq ?? 0
  )
}

export function listActivity(after: number, limit = 200, db: Database.Database = getDb()) {
  limit = Math.min(200, Math.max(1, limit))
  const rows = db
    .prepare(`SELECT a.id, a.workspace_id AS workspaceId, w.name AS workspaceName,
    a.kind, a.session_id AS sessionId, a.created_at AS createdAt
    FROM workspace_activity a JOIN workspaces w ON w.id = a.workspace_id
    WHERE a.id > ? AND a.created_at >= ? ORDER BY a.id ASC LIMIT ?`)
    .all(after, new Date(Date.now() - 30 * 86400_000).toISOString(), limit + 1) as ActivityItem[]
  const items = rows.slice(0, limit)
  return { items, nextCursor: items.at(-1)?.id ?? after, cursor: activityCursor(db), hasMore: rows.length > limit }
}
