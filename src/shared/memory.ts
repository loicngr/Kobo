export type MemoryMode = 'manual' | 'automatic' | 'hybrid'

export type MemoryScope =
  | { level: 'global' }
  | { level: 'project'; projectPath: string }
  | { level: 'workspace'; workspaceId: string }

/** Selectable scope discovery result; generation is required for agent CAS writes. */
export interface MemoryScopeCatalogueItem {
  readonly id: string
  readonly level: MemoryScope['level']
  readonly generation: number
  readonly revision: number
  readonly projectPath?: string
  readonly workspaceId?: string
}

export type MemoryWriteDecision = 'deny' | 'apply' | 'propose'

export type MemoryEngineId = 'claude-code' | 'codex'
export type MemoryTransport = 'http' | 'stdio'

export type MemoryActor =
  | { readonly kind: 'human' }
  | {
      readonly kind: 'internal-agent'
      readonly workspaceId: string
      readonly sessionId: string
      readonly engine: MemoryEngineId
    }
  | {
      readonly kind: 'external-mcp'
      readonly clientName: string
      readonly transport: MemoryTransport
    }

export type MemoryActorSource =
  | { readonly kind: 'human' }
  | {
      readonly kind: 'internal-agent'
      readonly workspaceId: string
      readonly sessionId: string
      readonly engine: MemoryEngineId
    }
  | {
      readonly kind: 'external-mcp'
      readonly clientName: string
      readonly transport: MemoryTransport
    }

/** Stored provenance after a source workspace/session was deleted with SET NULL. */
export interface DeletedInternalMemoryProvenance {
  readonly kind: 'internal-agent'
  readonly workspaceId: string | null
  readonly sessionId: string | null
  readonly engine: MemoryEngineId
  readonly sourceDeleted: true
}

export type MemoryProvenance = MemoryActor | DeletedInternalMemoryProvenance

export interface MemoryEntry {
  readonly id: string
  readonly scopeId: string
  readonly key: string
  readonly title: string
  readonly body: string
  readonly revision: number
  readonly actor: MemoryProvenance
  readonly createdAt: string
  readonly updatedAt: string
}

export interface MemoryProposal {
  readonly id: string
  readonly scopeId: string
  readonly targetEntryId?: string
  readonly baseRevision?: number
  readonly key: string
  readonly title: string
  readonly body: string
  readonly actor: MemoryProvenance
  readonly createdAt: string
}

export type MemoryOperationKind =
  | 'created'
  | 'updated'
  | 'deleted'
  | 'proposed'
  | 'approved'
  | 'rejected'
  | 'promoted'
  | 'cleared'
  | 'read'

export interface MemoryOperation {
  readonly id: number
  readonly scopeId: string
  readonly kind: MemoryOperationKind
  readonly actor: MemoryProvenance
  readonly entryId?: string
  readonly proposalId?: string
  readonly revision?: number
  readonly affectedEntries?: number
  readonly affectedProposals?: number
  readonly createdAt: string
}

export type MemoryContextState = 'prepared' | 'submitted' | 'initialized' | 'failed' | 'unknown'

export interface MemoryContextRecord {
  readonly id: string
  readonly workspaceId: string
  readonly sessionId: string
  readonly dispatchId: string
  readonly engine: MemoryEngineId
  readonly state: MemoryContextState
  readonly entryRevisions: ReadonlyArray<{ readonly id: string; readonly revision: number }>
  readonly omittedCount: number
  readonly estimatedTokens: number
  readonly createdAt: string
  readonly updatedAt: string
}

export interface MemoryContextEntryState {
  readonly id: string
  readonly revision: number
  readonly state: 'current' | 'changed' | 'deleted'
  readonly title?: string
  readonly body?: string
  readonly bodyTruncated?: boolean
}

export interface MemoryContextViewRecord extends MemoryContextRecord {
  readonly payloadBytes: number
  readonly budgetContextId: string | null
  readonly budgetEpoch: number
  readonly cumulativeEstimatedTokens: number
  readonly remainingEstimatedTokens: number
  readonly limitTokens: number
  readonly entryStates: readonly MemoryContextEntryState[]
}

export interface MemoryFragment {
  readonly text: string
  readonly offset: number
  readonly totalCharacters: number
  readonly truncated: boolean
  readonly nextCursor?: string
}

export interface MemoryOmissionSummary {
  readonly entries: number
  readonly estimatedTokens: number
}

export interface MemoryBudgetReceipt {
  readonly estimatedTokens: number
  readonly chargedTokens: number
  readonly remainingTokens: number
  readonly limitTokens: number
  readonly exhausted: boolean
  readonly alreadyDelivered?: boolean
}

export const MEMORY_TITLE_MAX_CHARS = 160
export const MEMORY_BODY_MAX_CHARS = 2_000
export const MEMORY_PAGE_SIZE = 50
export const MEMORY_PAGE_SIZE_MAX = 100
export const MEMORY_BOOTSTRAP_MAX_TOKENS = 1_000
export const MEMORY_MCP_RESPONSE_MAX_TOKENS = 1_000
export const MEMORY_MCP_RESPONSE_HARD_MAX_TOKENS = 1_500
export const MEMORY_CONVERSATION_BUDGET_TOKENS = 6_000
export const MEMORY_CLIENT_NAME_MAX_CHARS = 120

export function normalizeMemoryClientName(value: unknown): string {
  if (typeof value !== 'string') return 'External MCP client'
  const withoutControlCharacters = [...value]
    .filter((character) => {
      const codePoint = character.codePointAt(0)!
      return !(codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))
    })
    .join('')
  const normalized = withoutControlCharacters.replace(/\s+/g, ' ').trim()
  return normalized.slice(0, MEMORY_CLIENT_NAME_MAX_CHARS).trim() || 'External MCP client'
}

/**
 * Build immutable provenance from a backend-owned source descriptor. Any actor
 * object supplied alongside the request is deliberately ignored.
 */
export function deriveMemoryActor(source: MemoryActorSource, _callerActor?: unknown): MemoryActor {
  if (!source || typeof source !== 'object') throw new TypeError('Invalid memory actor source')

  if (source.kind === 'human') return Object.freeze({ kind: 'human' })

  if (source.kind === 'internal-agent') {
    if (
      !isNonEmptyString(source.workspaceId) ||
      !isNonEmptyString(source.sessionId) ||
      (source.engine !== 'claude-code' && source.engine !== 'codex')
    ) {
      throw new TypeError('Invalid internal memory actor source')
    }
    return Object.freeze({
      kind: 'internal-agent',
      workspaceId: source.workspaceId,
      sessionId: source.sessionId,
      engine: source.engine,
    })
  }

  if (source.kind === 'external-mcp') {
    if (source.transport !== 'http' && source.transport !== 'stdio')
      throw new TypeError('Invalid external memory transport')
    return Object.freeze({
      kind: 'external-mcp',
      clientName: normalizeMemoryClientName(source.clientName),
      transport: source.transport,
    })
  }

  throw new TypeError('Invalid memory actor source')
}

export function isMemoryMode(value: unknown): value is MemoryMode {
  return value === 'manual' || value === 'automatic' || value === 'hybrid'
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value)
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key))
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

export function isMemoryScope(value: unknown): value is MemoryScope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const scope = value as Record<string, unknown>

  if (scope.level === 'global') return hasExactKeys(scope, ['level'])
  if (scope.level === 'project')
    return hasExactKeys(scope, ['level', 'projectPath']) && isNonEmptyString(scope.projectPath)
  if (scope.level === 'workspace')
    return hasExactKeys(scope, ['level', 'workspaceId']) && isNonEmptyString(scope.workspaceId)
  return false
}

export function memoryWriteDecision(
  mode: MemoryMode,
  level: MemoryScope['level'],
  readOnly: boolean,
): MemoryWriteDecision {
  if (readOnly || !isMemoryMode(mode) || mode === 'manual') return 'deny'
  return mode === 'hybrid' && level !== 'workspace' ? 'propose' : 'apply'
}
