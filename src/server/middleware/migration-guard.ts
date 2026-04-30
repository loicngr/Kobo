import type { MiddlewareHandler } from 'hono'
import { getContentMigrationStatus } from '../services/content-migration-service.js'

/**
 * Blocks mutating requests while the content migration is running.
 *
 * Returns 503 with `{ error: 'migration-in-progress' }` whenever the migration
 * state is anything other than `idle` or `done`. Mounted per-handler on routes
 * that write to `ws_events` or spawn agents so the user can still observe
 * progress through GETs and `/api/migration/status` while the migration runs.
 */
export const migrationGuard: MiddlewareHandler = async (c, next) => {
  const state = getContentMigrationStatus().state
  if (state === 'idle' || state === 'done') return next()
  return c.json({ error: 'migration-in-progress' }, 503)
}
