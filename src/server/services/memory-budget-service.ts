import { nanoid } from 'nanoid'
import { MEMORY_CONVERSATION_BUDGET_TOKENS, type MemoryTransport } from '../../shared/memory.js'
import { getDb } from '../db/index.js'

export interface MemoryBudgetReservation {
  readonly accepted: boolean
  readonly budgetContextId: string
  readonly estimatedTokens: number
  readonly remainingTokens: number
  readonly limitTokens: number
  readonly reason?: 'response-limit' | 'conversation-limit'
}

export interface MemoryDenialReservation {
  readonly responseAllowed: boolean
  readonly budgetContextId: string
  readonly estimatedTokens: number
  readonly remainingTokens: number
  readonly limitTokens: number
}

export interface MemoryDeliveryMetadata {
  entryId: string
  revision: number
  kind: 'metadata' | 'excerpt' | 'body-fragment'
  start?: number
  end?: number
}

export interface MemoryBootstrapFingerprint {
  guidanceHash: string
  snapshotHash: string
}

/** Metadata only: fingerprints never retain note bodies or prompt text. */
export function getMemoryBootstrapFingerprint(budgetContextId: string): MemoryBootstrapFingerprint | undefined {
  const row = getDb().prepare('SELECT delivered_json FROM memory_budget_contexts WHERE id = ?').get(budgetContextId) as
    | { delivered_json: string }
    | undefined
  if (!row) return undefined
  try {
    const records: unknown = JSON.parse(row.delivered_json)
    if (!Array.isArray(records)) return undefined
    const record = records.reverse().find((item) => item?.kind === 'bootstrap')
    if (typeof record?.guidanceHash === 'string' && typeof record?.snapshotHash === 'string')
      return { guidanceHash: record.guidanceHash, snapshotHash: record.snapshotHash }
  } catch {
    /* Legacy or malformed metadata cannot prove prior delivery. */
  }
  return undefined
}

export interface ExternalMemoryBudgetContext {
  id: string
  cumulativeEstimatedTokens: number
}

export function getInternalMemoryBudgetContext(conversationKey: string): {
  id: string
  epoch: number
  cumulativeEstimatedTokens: number
} {
  const row = getDb()
    .prepare(`SELECT id, epoch, cumulative_estimated_tokens AS cumulativeEstimatedTokens
    FROM memory_budget_contexts WHERE kind = 'internal' AND conversation_key = ?
    ORDER BY epoch DESC LIMIT 1`)
    .get(conversationKey) as { id: string; epoch: number; cumulativeEstimatedTokens: number } | undefined
  if (!row) throw new TypeError('Internal memory budget ledger not found')
  return row
}

interface BudgetRow {
  id: string
  kind: 'internal' | 'external'
  cumulative_estimated_tokens: number
  delivered_json: string
}

const MEMORY_DENIAL_RESERVE_TOKENS = 500
const MEMORY_REGULAR_OUTPUT_LIMIT = MEMORY_CONVERSATION_BUDGET_TOKENS - MEMORY_DENIAL_RESERVE_TOKENS
const BUDGET_DENIAL_MARKER = 'budget-denial'

function now(): string {
  return new Date().toISOString()
}

/** Create a new external handle or resolve one previously returned to the same client/transport. */
export function createExternalMemoryBudgetContext(
  requestedId: string | undefined,
  clientName: string,
  transport: MemoryTransport,
): ExternalMemoryBudgetContext {
  const db = getDb()
  if (requestedId !== undefined) {
    if (requestedId.length < 12 || requestedId.length > 128) throw new TypeError('Invalid memory_context_id')
    const row = db
      .prepare(`SELECT id, kind, cumulative_estimated_tokens, client_name, transport
      FROM memory_budget_contexts WHERE external_context_id = ? OR id = ?`)
      .get(requestedId, requestedId) as
      | { id: string; kind: string; cumulative_estimated_tokens: number; client_name: string; transport: string }
      | undefined
    if (row?.kind !== 'external' || row.id !== requestedId) {
      throw new TypeError('Unknown external memory_context_id')
    }
    if (row.client_name !== clientName || row.transport !== transport) {
      throw new TypeError('memory_context_id belongs to another external client context')
    }
    return { id: row.id, cumulativeEstimatedTokens: row.cumulative_estimated_tokens }
  }

  const id = nanoid(32)
  const timestamp = now()
  db.prepare(`INSERT INTO memory_budget_contexts
    (id, kind, external_context_id, epoch, cumulative_estimated_tokens, delivered_json, client_name, transport, created_at, updated_at)
    VALUES (?, 'external', ?, 0, 0, '[]', ?, ?, ?, ?)`).run(
    id,
    id,
    clientName.slice(0, 120),
    transport,
    timestamp,
    timestamp,
  )
  return { id, cumulativeEstimatedTokens: 0 }
}

/**
 * Charges a native-conversation bootstrap or an MCP response using an immediate
 * SQLite transaction, so concurrent sub-agents cannot spend the same allowance.
 * Unknown/failed delivery is intentionally still charged.
 */
export function reserveMemoryBudget(input: {
  budgetContextId: string
  estimatedTokens: number
  delivery?: MemoryDeliveryMetadata
  deliveries?: ReadonlyArray<MemoryDeliveryMetadata>
  responseLimitTokens?: number
  bootstrap?: MemoryBootstrapFingerprint
}): MemoryBudgetReservation {
  if (!Number.isSafeInteger(input.estimatedTokens) || input.estimatedTokens < 1)
    throw new TypeError('Memory budget charge must be a positive integer')
  const responseLimitTokens = input.responseLimitTokens
  if (responseLimitTokens !== undefined && input.estimatedTokens > responseLimitTokens) {
    return {
      accepted: false,
      budgetContextId: input.budgetContextId,
      estimatedTokens: input.estimatedTokens,
      remainingTokens: 0,
      limitTokens: responseLimitTokens,
      reason: 'response-limit',
    }
  }

  const db = getDb()
  return db
    .transaction(() => {
      const row = db
        .prepare(`SELECT id, kind, cumulative_estimated_tokens, delivered_json
      FROM memory_budget_contexts WHERE id = ?`)
        .get(input.budgetContextId) as BudgetRow | undefined
      if (!row) throw new TypeError('Memory budget ledger not found')
      let delivered: unknown[]
      try {
        const parsed: unknown = JSON.parse(row.delivered_json)
        delivered = Array.isArray(parsed) ? parsed : []
      } catch {
        delivered = []
      }
      const denialAlreadyUsed = delivered.some(
        (item) => item && typeof item === 'object' && (item as Record<string, unknown>).kind === BUDGET_DENIAL_MARKER,
      )
      const remaining = denialAlreadyUsed
        ? 0
        : Math.max(0, MEMORY_REGULAR_OUTPUT_LIMIT - row.cumulative_estimated_tokens)
      if (input.estimatedTokens > remaining) {
        return {
          accepted: false,
          budgetContextId: row.id,
          estimatedTokens: input.estimatedTokens,
          remainingTokens: remaining,
          limitTokens: MEMORY_REGULAR_OUTPUT_LIMIT,
          reason: 'conversation-limit' as const,
        }
      }
      const newDeliveries = [...(input.deliveries ?? []), ...(input.delivery ? [input.delivery] : [])]
      if (input.bootstrap) {
        delivered = delivered.filter(
          (item) => !item || typeof item !== 'object' || (item as Record<string, unknown>).kind !== 'bootstrap',
        )
        delivered.push({ kind: 'bootstrap', ...input.bootstrap })
      }
      if (newDeliveries.length > 0) {
        delivered.push(...newDeliveries)
        if (delivered.length > 2_000) delivered = delivered.slice(-2_000)
      }
      const cumulative = row.cumulative_estimated_tokens + input.estimatedTokens
      db.prepare(`UPDATE memory_budget_contexts SET cumulative_estimated_tokens = ?, delivered_json = ?, updated_at = ?
      WHERE id = ?`).run(cumulative, JSON.stringify(delivered), now(), row.id)
      return {
        accepted: true,
        budgetContextId: row.id,
        estimatedTokens: input.estimatedTokens,
        remainingTokens: MEMORY_REGULAR_OUTPUT_LIMIT - cumulative,
        limitTokens: MEMORY_REGULAR_OUTPUT_LIMIT,
      }
    })
    .immediate()
}

/** Spend one reserved terminal receipt; later exhausted calls are suppressed without output. */
export function reserveMemoryBudgetDenial(budgetContextId: string, estimatedTokens: number): MemoryDenialReservation {
  if (!Number.isSafeInteger(estimatedTokens) || estimatedTokens < 1 || estimatedTokens > MEMORY_DENIAL_RESERVE_TOKENS)
    throw new TypeError('Memory budget denial receipt exceeds its reserved allowance')
  const db = getDb()
  return db
    .transaction(() => {
      const row = db
        .prepare(`SELECT id, cumulative_estimated_tokens, delivered_json
          FROM memory_budget_contexts WHERE id = ?`)
        .get(budgetContextId) as Pick<BudgetRow, 'id' | 'cumulative_estimated_tokens' | 'delivered_json'> | undefined
      if (!row) throw new TypeError('Memory budget ledger not found')
      let delivered: unknown[]
      try {
        const parsed: unknown = JSON.parse(row.delivered_json)
        delivered = Array.isArray(parsed) ? parsed : []
      } catch {
        delivered = []
      }
      const alreadyUsed = delivered.some(
        (item) => item && typeof item === 'object' && (item as Record<string, unknown>).kind === BUDGET_DENIAL_MARKER,
      )
      if (alreadyUsed || row.cumulative_estimated_tokens + estimatedTokens > MEMORY_CONVERSATION_BUDGET_TOKENS) {
        return {
          responseAllowed: false,
          budgetContextId: row.id,
          estimatedTokens: 0,
          remainingTokens: Math.max(0, MEMORY_CONVERSATION_BUDGET_TOKENS - row.cumulative_estimated_tokens),
          limitTokens: MEMORY_CONVERSATION_BUDGET_TOKENS,
        }
      }
      delivered.push({ kind: BUDGET_DENIAL_MARKER, estimatedTokens })
      const cumulative = row.cumulative_estimated_tokens + estimatedTokens
      db.prepare(`UPDATE memory_budget_contexts
        SET cumulative_estimated_tokens = ?, delivered_json = ?, updated_at = ? WHERE id = ?`).run(
        cumulative,
        JSON.stringify(delivered),
        now(),
        row.id,
      )
      return {
        responseAllowed: true,
        budgetContextId: row.id,
        estimatedTokens,
        remainingTokens: MEMORY_CONVERSATION_BUDGET_TOKENS - cumulative,
        limitTokens: MEMORY_CONVERSATION_BUDGET_TOKENS,
      }
    })
    .immediate()
}

/** Returns delivery metadata only; persisted note bodies are never stored in this ledger. */
export function wasMemoryFragmentDelivered(
  budgetContextId: string,
  delivery: Pick<MemoryDeliveryMetadata, 'entryId' | 'revision' | 'kind' | 'start' | 'end'>,
): boolean {
  const row = getDb()
    .prepare('SELECT kind, delivered_json FROM memory_budget_contexts WHERE id = ?')
    .get(budgetContextId) as Pick<BudgetRow, 'kind' | 'delivered_json'> | undefined
  if (!row) return false
  try {
    const items: unknown = JSON.parse(row.delivered_json)
    return (
      Array.isArray(items) &&
      items.some((item) => {
        if (!item || typeof item !== 'object') return false
        const candidate = item as Record<string, unknown>
        return (
          candidate.entryId === delivery.entryId &&
          candidate.revision === delivery.revision &&
          candidate.kind === delivery.kind &&
          candidate.start === delivery.start &&
          candidate.end === delivery.end
        )
      })
    )
  } catch {
    return false
  }
}
