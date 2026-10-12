import { randomBytes, randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { ProgressOwner } from '../../shared/progress-bars.js'
import { getDb } from '../db/index.js'
import { interruptProgressBarsForLaunch, ProgressBarError } from './progress-bar-service.js'
export interface ProgressCapability {
  token: string
  owner: ProgressOwner & { kind: 'internal' }
  database: Database.Database
}
const capabilities = new Map<string, ProgressCapability>()
export function createProgressCapability(workspaceId: string, sessionId: string): ProgressCapability {
  const capability: ProgressCapability = {
    token: randomBytes(32).toString('hex'),
    owner: Object.freeze({ kind: 'internal', workspaceId, sessionId, launchId: randomUUID() }),
    database: getDb(),
  }
  capabilities.set(capability.token, capability)
  return capability
}
export function resolveProgressCapability(token: string | undefined): ProgressOwner & { kind: 'internal' } {
  const capability = token ? capabilities.get(token) : undefined
  if (!capability) throw new ProgressBarError(403, 'invalid_capability', 'Progress capability is missing or revoked')
  return capability.owner
}
export function revokeProgressCapability(token: string): void {
  capabilities.delete(token)
}
/** Revoke on stop immediately; call this only after the producing controller actually closes. */
export function closeProgressCapability(capability: ProgressCapability): void {
  revokeProgressCapability(capability.token)
  // A late child close during shutdown must not call getDb() and reopen production data.
  if (capability.database.open) interruptProgressBarsForLaunch(capability.owner.launchId)
}
