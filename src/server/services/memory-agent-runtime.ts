import { randomBytes } from 'node:crypto'
import { nanoid } from 'nanoid'
import type { MemoryEngineId } from '../../shared/memory.js'
import { getDb } from '../db/index.js'

export interface MemoryCapabilityDescriptor {
  readonly dispatchId: string
  readonly workspaceId: string
  readonly sessionId: string
  readonly engine: MemoryEngineId
  /** Opaque persistent identity for the native conversation's budget ledger. */
  readonly conversationKey: string
  readonly readOnly: boolean
}

const activeCapabilities = new Map<string, Readonly<MemoryCapabilityDescriptor>>()

/** Persist an opaque conversation key independently from a controller/token generation. */
export function allocateMemoryConversationKey(input: {
  sessionId: string
  engine: MemoryEngineId
  nativeConversationId?: string
}): string {
  const db = getDb()
  if (input.nativeConversationId) {
    const existing = db
      .prepare(`SELECT conversation_key FROM memory_budget_contexts
        WHERE kind = 'internal' AND session_id = ? AND engine = ? AND native_conversation_id = ?
        ORDER BY updated_at DESC LIMIT 1`)
      .get(input.sessionId, input.engine, input.nativeConversationId) as { conversation_key: string } | undefined
    if (existing) return existing.conversation_key
  }
  const key = nanoid()
  const timestamp = new Date().toISOString()
  db.prepare(`INSERT INTO memory_budget_contexts
    (id, kind, session_id, engine, conversation_key, native_conversation_id, epoch,
      cumulative_estimated_tokens, delivered_json, created_at, updated_at)
    VALUES (?, 'internal', ?, ?, ?, ?, 0, 0, '[]', ?, ?)`).run(
    nanoid(),
    input.sessionId,
    input.engine,
    key,
    input.nativeConversationId ?? null,
    timestamp,
    timestamp,
  )
  return key
}

/** Bind a fresh conversation's native provider id once the engine confirms it. */
export function bindMemoryNativeConversation(key: string, nativeConversationId: string): void {
  const timestamp = new Date().toISOString()
  getDb()
    .prepare(`UPDATE memory_budget_contexts SET native_conversation_id = ?, updated_at = ?
      WHERE kind = 'internal' AND conversation_key = ? AND epoch = 0 AND native_conversation_id IS NULL`)
    .run(nativeConversationId, timestamp, key)
}

/** Start a new metadata-only ledger epoch after the owning controller confirms compaction. */
export function advanceMemoryConversationEpoch(key: string): { id: string; epoch: number } | undefined {
  const db = getDb()
  const current = db
    .prepare(`SELECT id, session_id, engine, native_conversation_id, epoch FROM memory_budget_contexts
      WHERE kind = 'internal' AND conversation_key = ? ORDER BY epoch DESC LIMIT 1`)
    .get(key) as
    | { id: string; session_id: string; engine: MemoryEngineId; native_conversation_id: string | null; epoch: number }
    | undefined
  if (!current) return undefined
  const id = nanoid()
  const epoch = current.epoch + 1
  const timestamp = new Date().toISOString()
  db.prepare(`INSERT INTO memory_budget_contexts
    (id, kind, session_id, engine, conversation_key, native_conversation_id, epoch,
      cumulative_estimated_tokens, delivered_json, created_at, updated_at)
    VALUES (?, 'internal', ?, ?, ?, ?, ?, 0, '[]', ?, ?)`).run(
    id,
    current.session_id,
    current.engine,
    key,
    current.native_conversation_id,
    epoch,
    timestamp,
    timestamp,
  )
  return { id, epoch }
}

/** Issue an unguessable, launch-specific capability. The raw value is process env only. */
export function createMemoryCapability(descriptor: MemoryCapabilityDescriptor): {
  token: string
  conversationKey: string
} {
  const token = randomBytes(32).toString('hex')
  activeCapabilities.set(token, Object.freeze({ ...descriptor }))
  return { token, conversationKey: descriptor.conversationKey }
}

export function getMemoryCapability(token: string | undefined): Readonly<MemoryCapabilityDescriptor> | undefined {
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return undefined
  return activeCapabilities.get(token)
}

/** Revokes only this launch secret, never another generation sharing its session id. */
export function revokeMemoryCapability(token: string): void {
  activeCapabilities.delete(token)
}
