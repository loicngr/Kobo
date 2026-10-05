import { nanoid } from 'nanoid'
import type { MemoryActor, MemoryEntry, MemoryOperation, MemoryProvenance, MemoryScope } from '../../shared/memory.js'
import {
  deriveMemoryActor,
  isMemoryScope,
  MEMORY_BODY_MAX_CHARS,
  MEMORY_PAGE_SIZE,
  MEMORY_PAGE_SIZE_MAX,
  MEMORY_TITLE_MAX_CHARS,
  memoryWriteDecision,
} from '../../shared/memory.js'
import { getDb } from '../db/index.js'
import { normalizeMemoryProjectPath } from '../utils/memory-project-identity.js'
import { getGlobalSettings } from './settings-service.js'
import { broadcastAll } from './websocket-service.js'

export interface ResolvedMemoryScope {
  id: string
  level: MemoryScope['level']
  projectPath?: string
  workspaceId?: string
  generation: number
  revision: number
}

export class MemoryNotFoundError extends Error {
  constructor(message = 'Memory resource not found') {
    super(message)
    this.name = 'MemoryNotFoundError'
  }
}

export class MemoryConflictError extends Error {
  constructor(message = 'Memory changed; reload before retrying') {
    super(message)
    this.name = 'MemoryConflictError'
  }
}

interface ScopeRow {
  id: string
  level: ResolvedMemoryScope['level']
  project_path: string | null
  workspace_id: string | null
  generation: number
  revision: number
}

interface EntryRow {
  id: string
  scope_id: string
  memory_key: string
  title: string
  body: string
  revision: number
  actor_kind: MemoryActor['kind']
  source_workspace_id: string | null
  source_session_id: string | null
  source_engine: 'claude-code' | 'codex' | null
  client_name: string | null
  transport: 'http' | 'stdio' | null
  created_at: string
  updated_at: string
}

interface OperationRow {
  id: number
  scope_id: string
  operation: MemoryOperation['kind']
  actor_kind: MemoryActor['kind']
  source_workspace_id: string | null
  source_session_id: string | null
  source_engine: 'claude-code' | 'codex' | null
  source_project_path: string | null
  client_name: string | null
  transport: 'http' | 'stdio' | null
  entry_id: string | null
  proposal_id: string | null
  revision: number | null
  affected_entries: number | null
  affected_proposals: number | null
  created_at: string
}

interface ProposalRow extends Omit<EntryRow, 'revision' | 'updated_at'> {
  target_entry_id: string | null
  base_revision: number | null
  generation: number
}

export interface MemoryProposalView {
  id: string
  scopeId: string
  targetEntryId?: string
  baseRevision?: number
  generation: number
  key: string
  title: string
  body: string
  actor: MemoryProvenance
  createdAt: string
}

function mapScope(row: ScopeRow): ResolvedMemoryScope {
  return {
    id: row.id,
    level: row.level,
    ...(row.project_path ? { projectPath: row.project_path } : {}),
    ...(row.workspace_id ? { workspaceId: row.workspace_id } : {}),
    generation: row.generation,
    revision: row.revision,
  }
}

function mapActor(
  row: Pick<
    EntryRow,
    'actor_kind' | 'source_workspace_id' | 'source_session_id' | 'source_engine' | 'client_name' | 'transport'
  >,
): MemoryProvenance {
  if (row.actor_kind === 'human') return { kind: 'human' }
  if (row.actor_kind === 'internal-agent') {
    if (!row.source_engine) {
      throw new Error('Invalid persisted internal memory provenance')
    }
    if (!row.source_workspace_id || !row.source_session_id) {
      return {
        kind: 'internal-agent',
        workspaceId: row.source_workspace_id,
        sessionId: row.source_session_id,
        engine: row.source_engine,
        sourceDeleted: true,
      }
    }
    return {
      kind: 'internal-agent',
      workspaceId: row.source_workspace_id,
      sessionId: row.source_session_id,
      engine: row.source_engine,
    }
  }
  if (!row.client_name || !row.transport) throw new Error('Invalid persisted external memory provenance')
  return { kind: 'external-mcp', clientName: row.client_name, transport: row.transport }
}

function mapEntry(row: EntryRow): MemoryEntry {
  return {
    id: row.id,
    scopeId: row.scope_id,
    key: row.memory_key,
    title: row.title,
    body: row.body,
    revision: row.revision,
    actor: mapActor(row),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapProposal(row: ProposalRow): MemoryProposalView {
  return {
    id: row.id,
    scopeId: row.scope_id,
    ...(row.target_entry_id ? { targetEntryId: row.target_entry_id } : {}),
    ...(row.base_revision !== null ? { baseRevision: row.base_revision } : {}),
    generation: row.generation,
    key: row.memory_key,
    title: row.title,
    body: row.body,
    actor: mapActor(row),
    createdAt: row.created_at,
  }
}

function mapOperation(row: OperationRow): MemoryOperation {
  const result: MemoryOperation = {
    id: row.id,
    scopeId: row.scope_id,
    kind: row.operation,
    actor: mapActor(row),
    createdAt: row.created_at,
    ...(row.entry_id ? { entryId: row.entry_id } : {}),
    ...(row.proposal_id ? { proposalId: row.proposal_id } : {}),
    ...(row.revision !== null ? { revision: row.revision } : {}),
    ...(row.affected_entries !== null ? { affectedEntries: row.affected_entries } : {}),
    ...(row.affected_proposals !== null ? { affectedProposals: row.affected_proposals } : {}),
  }
  return result
}

function projectPathForActor(actor: MemoryActor): string | null {
  if (actor.kind !== 'internal-agent') return null
  const workspace = getDb().prepare('SELECT project_path FROM workspaces WHERE id = ?').get(actor.workspaceId) as
    | { project_path: string }
    | undefined
  return workspace ? normalizeMemoryProjectPath(workspace.project_path) : null
}

function now(): string {
  return new Date().toISOString()
}

function requireBoundedPage(limit: number | undefined): number {
  const resolved = limit ?? MEMORY_PAGE_SIZE
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > MEMORY_PAGE_SIZE_MAX) {
    throw new TypeError(`Page size must be between 1 and ${MEMORY_PAGE_SIZE_MAX}`)
  }
  return resolved
}

function requireCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0
  if (!/^\d+$/.test(cursor)) throw new TypeError('Invalid memory cursor')
  const offset = Number(cursor)
  if (!Number.isSafeInteger(offset)) throw new TypeError('Invalid memory cursor')
  return offset
}

function requireText(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string') throw new TypeError(`${name} must be a string`)
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > max) throw new TypeError(`${name} must be 1-${max} characters`)
  return trimmed
}

function requireKey(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('Memory key must be a string')
  const key = value.trim().toLowerCase()
  if (!/^[a-z0-9][a-z0-9._/-]{0,79}$/.test(key)) throw new TypeError('Memory key must be a stable lowercase identifier')
  return key
}

function getScopeById(scopeId: string): ScopeRow {
  const row = getDb().prepare('SELECT * FROM memory_scopes WHERE id = ?').get(scopeId) as ScopeRow | undefined
  if (!row) throw new MemoryNotFoundError('Memory scope not found')
  return row
}

/** Resolve trusted source ownership and enforce the three exact applicable scopes. */
function assertInternalActorCanAccessScope(actor: MemoryActor, scope: ScopeRow): void {
  if (actor.kind !== 'internal-agent') return
  const source = getDb()
    .prepare(`SELECT s.workspace_id, s.engine, w.project_path
      FROM agent_sessions s JOIN workspaces w ON w.id = s.workspace_id WHERE s.id = ?`)
    .get(actor.sessionId) as { workspace_id: string; engine: string | null; project_path: string } | undefined
  if (!source || source.workspace_id !== actor.workspaceId) {
    throw new MemoryNotFoundError('Agent session is not bound to the stated workspace')
  }
  if (source.engine !== 'claude-code' && source.engine !== 'codex') {
    throw new MemoryNotFoundError('Bound agent session has no valid engine')
  }
  if (source.engine !== actor.engine) throw new MemoryNotFoundError('Agent engine does not match the bound session')

  const allowed =
    scope.level === 'global' ||
    (scope.level === 'workspace' && scope.workspace_id === source.workspace_id) ||
    (scope.level === 'project' &&
      scope.project_path !== null &&
      normalizeMemoryProjectPath(scope.project_path) === normalizeMemoryProjectPath(source.project_path))
  if (!allowed) throw new MemoryNotFoundError('Agent cannot access memory outside its applicable scopes')
}

function materializeScope(input: MemoryScope): ResolvedMemoryScope {
  const db = getDb()
  const timestamp = now()
  if (input.level === 'global') {
    db.prepare(`INSERT OR IGNORE INTO memory_scopes (id, level, generation, revision, created_at, updated_at)
      VALUES (?, 'global', 0, 0, ?, ?)`).run(nanoid(), timestamp, timestamp)
    const row = db.prepare("SELECT * FROM memory_scopes WHERE level = 'global'").get() as ScopeRow
    return mapScope(row)
  }

  if (input.level === 'project') {
    const projectPath = normalizeMemoryProjectPath(input.projectPath)
    db.prepare(`INSERT OR IGNORE INTO memory_scopes (id, level, project_path, generation, revision, created_at, updated_at)
      VALUES (?, 'project', ?, 0, 0, ?, ?)`).run(nanoid(), projectPath, timestamp, timestamp)
    const row = db
      .prepare("SELECT * FROM memory_scopes WHERE level = 'project' AND project_path = ?")
      .get(projectPath) as ScopeRow
    return mapScope(row)
  }

  if (input.level === 'workspace') {
    const workspace = db.prepare('SELECT id FROM workspaces WHERE id = ?').get(input.workspaceId)
    if (!workspace) throw new MemoryNotFoundError('Workspace not found')
    db.prepare(`INSERT OR IGNORE INTO memory_scopes (id, level, workspace_id, generation, revision, created_at, updated_at)
      VALUES (?, 'workspace', ?, 0, 0, ?, ?)`).run(nanoid(), input.workspaceId, timestamp, timestamp)
    const row = db
      .prepare("SELECT * FROM memory_scopes WHERE level = 'workspace' AND workspace_id = ?")
      .get(input.workspaceId) as ScopeRow
    return mapScope(row)
  }

  throw new TypeError('Invalid memory scope')
}

/** Resolve/create a durable exact scope; workspace project identity always comes from the workspace row. */
export function resolveMemoryScope(input: MemoryScope): ResolvedMemoryScope {
  if (!isMemoryScope(input)) throw new TypeError('Invalid memory scope')
  if (input.level === 'workspace') {
    const workspace = getDb().prepare('SELECT project_path FROM workspaces WHERE id = ?').get(input.workspaceId) as
      | { project_path: string }
      | undefined
    if (!workspace) throw new MemoryNotFoundError('Workspace not found')
    materializeScope({ level: 'project', projectPath: workspace.project_path })
  }
  return materializeScope(input)
}

export interface ListMemoryScopesOptions {
  workspaceId?: string
  actor?: MemoryActor
  cursor?: string
  limit?: number
}

/** Lists persisted scopes; a workspace view always includes the exact applicable ancestors. */
export function listMemoryScopes(options: ListMemoryScopesOptions = {}): {
  items: ResolvedMemoryScope[]
  nextCursor?: string
} {
  const limit = requireBoundedPage(options.limit)
  const offset = requireCursor(options.cursor)
  const db = getDb()
  const actor = options.actor ? deriveMemoryActor(options.actor) : undefined
  if (actor?.kind === 'internal-agent') {
    if (options.workspaceId && options.workspaceId !== actor.workspaceId) {
      throw new MemoryNotFoundError('Agent cannot list scopes for another workspace')
    }
    assertInternalActorCanAccessScope(actor, getScopeById(materializeScope({ level: 'global' }).id))
    options = { ...options, workspaceId: actor.workspaceId }
  }
  if (options.workspaceId) {
    const workspace = db.prepare('SELECT project_path FROM workspaces WHERE id = ?').get(options.workspaceId) as
      | { project_path: string }
      | undefined
    if (!workspace) throw new MemoryNotFoundError('Workspace not found')
    const scopes = [
      materializeScope({ level: 'global' }),
      materializeScope({ level: 'project', projectPath: workspace.project_path }),
      materializeScope({ level: 'workspace', workspaceId: options.workspaceId }),
    ]
    return {
      items: scopes.slice(offset, offset + limit),
      ...(offset + limit < scopes.length ? { nextCursor: String(offset + limit) } : {}),
    }
  }
  // A global scope is selectable even on a fresh install. Persisted project and
  // workspace scopes remain discoverable after their source directories vanish.
  materializeScope({ level: 'global' })
  const rows = db
    .prepare(`SELECT * FROM memory_scopes
    ORDER BY CASE level WHEN 'global' THEN 0 WHEN 'project' THEN 1 ELSE 2 END, project_path, workspace_id, id
    LIMIT ? OFFSET ?`)
    .all(limit + 1, offset) as ScopeRow[]
  const hasMore = rows.length > limit
  return { items: rows.slice(0, limit).map(mapScope), ...(hasMore ? { nextCursor: String(offset + limit) } : {}) }
}

export interface CreateMemoryInput {
  scopeId: string
  key: string
  title: string
  body: string
  actor: MemoryActor
}

function writeOperation(
  scope: ScopeRow,
  actor: MemoryActor,
  operation: MemoryOperation['kind'],
  entryId: string | null,
  revision: number | null,
  timestamp: string,
  proposalId: string | null = null,
  affectedEntries: number | null = null,
  affectedProposals: number | null = null,
): number {
  const source =
    actor.kind === 'internal-agent'
      ? [actor.workspaceId, actor.sessionId, actor.engine, null, null]
      : actor.kind === 'external-mcp'
        ? [null, null, null, actor.clientName, actor.transport]
        : [null, null, null, null, null]
  const sourceProjectPath = projectPathForActor(actor)
  return Number(
    getDb()
      .prepare(`INSERT INTO memory_operations
    (scope_id, operation, actor_kind, source_workspace_id, source_session_id, source_engine, source_project_path, client_name, transport, entry_id, proposal_id, revision, affected_entries, affected_proposals, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        scope.id,
        operation,
        actor.kind,
        ...source.slice(0, 3),
        sourceProjectPath,
        ...source.slice(3),
        entryId,
        proposalId,
        revision,
        affectedEntries,
        affectedProposals,
        timestamp,
      ).lastInsertRowid,
  )
}

function notifyCommitted(scope: ScopeRow, operationId: number, journalOnly = false): void {
  broadcastAll('memory:changed', {
    scopeId: scope.id,
    level: scope.level,
    revision: scope.revision,
    generation: scope.generation,
    operationId,
    ...(journalOnly ? { journalOnly: true } : {}),
  })
}

/** Create idempotently by exact scope/key, atomically journaling and revising the scope. */
export function createMemory(input: CreateMemoryInput): MemoryEntry {
  if (!input || typeof input !== 'object') throw new TypeError('Invalid memory input')
  const key = requireKey(input.key)
  const title = requireText(input.title, 'Title', MEMORY_TITLE_MAX_CHARS)
  const body = requireText(input.body, 'Body', MEMORY_BODY_MAX_CHARS)
  const actor = deriveMemoryActor(input.actor)
  const db = getDb()
  let operationId: number | undefined
  let changedScope: ScopeRow | undefined
  const entry = db
    .transaction(() => {
      const scope = getScopeById(input.scopeId)
      assertInternalActorCanAccessScope(actor, scope)
      const existing = db
        .prepare('SELECT * FROM memory_entries WHERE scope_id = ? AND memory_key = ?')
        .get(scope.id, key) as EntryRow | undefined
      if (existing) {
        if (existing.title === title && existing.body === body) return mapEntry(existing)
        throw new MemoryConflictError('A different memory already uses this key')
      }
      const timestamp = now()
      const id = nanoid()
      const source =
        actor.kind === 'internal-agent'
          ? [actor.workspaceId, actor.sessionId, actor.engine, null, null]
          : actor.kind === 'external-mcp'
            ? [null, null, null, actor.clientName, actor.transport]
            : [null, null, null, null, null]
      db.prepare(`INSERT INTO memory_entries
      (id, scope_id, memory_key, title, body, revision, actor_kind, source_workspace_id, source_session_id, source_engine, client_name, transport, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        id,
        scope.id,
        key,
        title,
        body,
        actor.kind,
        ...source,
        timestamp,
        timestamp,
      )
      const scopeRevision = db
        .prepare('UPDATE memory_scopes SET revision = revision + 1, updated_at = ? WHERE id = ?')
        .run(timestamp, scope.id)
      if (scopeRevision.changes !== 1) throw new MemoryNotFoundError('Memory scope not found')
      const updatedScope = getScopeById(scope.id)
      operationId = writeOperation(updatedScope, actor, 'created', id, 1, timestamp)
      changedScope = updatedScope
      const row = db.prepare('SELECT * FROM memory_entries WHERE id = ?').get(id) as EntryRow
      return mapEntry(row)
    })
    .immediate()
  if (operationId !== undefined && changedScope) notifyCommitted(changedScope, operationId)
  return entry
}

export interface UpdateMemoryInput {
  scopeId: string
  entryId: string
  expectedRevision: number
  key?: string
  title?: string
  body?: string
  actor: MemoryActor
}

/** Compare-and-swap update; stale revisions conflict and all writes roll back together. */
export function updateMemory(input: UpdateMemoryInput): MemoryEntry {
  if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1)
    throw new TypeError('Invalid expected revision')
  if (input.key === undefined && input.title === undefined && input.body === undefined)
    throw new TypeError('At least one memory field is required')
  const actor = deriveMemoryActor(input.actor)
  const db = getDb()
  let operationId: number | undefined
  let changedScope: ScopeRow | undefined
  const entry = db
    .transaction(() => {
      const scope = getScopeById(input.scopeId)
      const current = db
        .prepare('SELECT * FROM memory_entries WHERE id = ? AND scope_id = ?')
        .get(input.entryId, scope.id) as EntryRow | undefined
      if (!current) throw new MemoryNotFoundError('Memory entry not found in the selected scope')
      if (current.revision !== input.expectedRevision) throw new MemoryConflictError()
      const key = input.key === undefined ? current.memory_key : requireKey(input.key)
      const title =
        input.title === undefined ? current.title : requireText(input.title, 'Title', MEMORY_TITLE_MAX_CHARS)
      const body = input.body === undefined ? current.body : requireText(input.body, 'Body', MEMORY_BODY_MAX_CHARS)
      const keyOwner = db
        .prepare('SELECT id FROM memory_entries WHERE scope_id = ? AND memory_key = ?')
        .get(scope.id, key) as { id: string } | undefined
      if (keyOwner && keyOwner.id !== current.id)
        throw new MemoryConflictError('A different memory already uses this key')
      assertInternalActorCanAccessScope(actor, scope)
      const timestamp = now()
      const updated =
        db.prepare(`UPDATE memory_entries SET memory_key = ?, title = ?, body = ?, revision = revision + 1,
      actor_kind = ?, source_workspace_id = ?, source_session_id = ?, source_engine = ?, client_name = ?, transport = ?, updated_at = ?
      WHERE id = ? AND scope_id = ? AND revision = ?`)
      const source =
        actor.kind === 'internal-agent'
          ? [actor.workspaceId, actor.sessionId, actor.engine, null, null]
          : actor.kind === 'external-mcp'
            ? [null, null, null, actor.clientName, actor.transport]
            : [null, null, null, null, null]
      const result = updated.run(
        key,
        title,
        body,
        actor.kind,
        ...source,
        timestamp,
        input.entryId,
        scope.id,
        input.expectedRevision,
      )
      if (result.changes !== 1) throw new MemoryConflictError()
      db.prepare('UPDATE memory_scopes SET revision = revision + 1, updated_at = ? WHERE id = ?').run(
        timestamp,
        scope.id,
      )
      const updatedScope = getScopeById(scope.id)
      operationId = writeOperation(updatedScope, actor, 'updated', input.entryId, input.expectedRevision + 1, timestamp)
      changedScope = updatedScope
      return mapEntry(db.prepare('SELECT * FROM memory_entries WHERE id = ?').get(input.entryId) as EntryRow)
    })
    .immediate()
  if (operationId !== undefined && changedScope) notifyCommitted(changedScope, operationId)
  return entry
}

export interface ListMemoriesOptions {
  scopeId?: string
  workspaceId?: string
  actor?: MemoryActor
  query?: string
  cursor?: string
  limit?: number
}
export interface MemoryPage {
  items: MemoryEntry[]
  nextCursor?: string
  totalCount: number
}

function applicableScopes(workspaceId: string): ResolvedMemoryScope[] {
  const workspace = getDb().prepare('SELECT project_path FROM workspaces WHERE id = ?').get(workspaceId) as
    | { project_path: string }
    | undefined
  if (!workspace) throw new MemoryNotFoundError('Workspace not found')
  return [
    materializeScope({ level: 'global' }),
    materializeScope({ level: 'project', projectPath: workspace.project_path }),
    materializeScope({ level: 'workspace', workspaceId }),
  ]
}

function listPage(scopeIds: string[], options: { cursor?: string; limit?: number; query?: string }): MemoryPage {
  const limit = requireBoundedPage(options.limit)
  const offset = requireCursor(options.cursor)
  if (!scopeIds.length) return { items: [], totalCount: 0 }
  const db = getDb()
  const placeholders = scopeIds.map(() => '?').join(',')
  let where = `scope_id IN (${placeholders})`
  const args: (string | number)[] = [...scopeIds]
  if (options.query !== undefined) {
    if (typeof options.query !== 'string' || options.query.trim().length < 1 || options.query.length > 200)
      throw new TypeError('Search query must be 1-200 characters')
    const escaped = options.query.replace(/[\\%_]/g, '\\$&')
    where += " AND (title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\' OR memory_key LIKE ? ESCAPE '\\')"
    const pattern = `%${escaped}%`
    args.push(pattern, pattern, pattern)
  }
  const totalCount = (
    db.prepare(`SELECT COUNT(*) AS count FROM memory_entries WHERE ${where}`).get(...args) as { count: number }
  ).count
  const rows = db
    .prepare(`SELECT * FROM memory_entries WHERE ${where}
    ORDER BY CASE (SELECT level FROM memory_scopes WHERE id = scope_id) WHEN 'global' THEN 0 WHEN 'project' THEN 1 ELSE 2 END,
      updated_at DESC, id DESC LIMIT ? OFFSET ?`)
    .all(...args, limit + 1, offset) as EntryRow[]
  const hasMore = rows.length > limit
  return {
    items: rows.slice(0, limit).map(mapEntry),
    totalCount,
    ...(hasMore ? { nextCursor: String(offset + limit) } : {}),
  }
}

export function listMemories(options: ListMemoriesOptions): MemoryPage {
  const actor = options.actor ? deriveMemoryActor(options.actor) : undefined
  if (actor?.kind === 'internal-agent') {
    if (options.workspaceId && options.workspaceId !== actor.workspaceId) {
      throw new MemoryNotFoundError('Agent cannot list another workspace memory')
    }
    if (options.scopeId) assertInternalActorCanAccessScope(actor, getScopeById(options.scopeId))
    else options = { ...options, workspaceId: actor.workspaceId }
  }
  if (Boolean(options.scopeId) === Boolean(options.workspaceId))
    throw new TypeError('Specify exactly one scopeId or workspaceId')
  const scopeIds = options.scopeId
    ? [getScopeById(options.scopeId).id]
    : applicableScopes(options.workspaceId!).map((scope) => scope.id)
  const source = actor ?? ({ kind: 'human' } as const)
  const db = getDb()
  const result = db
    .transaction(() => {
      const page = listPage(scopeIds, options)
      return { page, reads: recordMemoryReads(page.items, source) }
    })
    .immediate()
  for (const [scopeId, operationId] of result.reads) notifyCommitted(getScopeById(scopeId), operationId, true)
  return result.page
}

export interface ReadMemoryOptions {
  scopeId: string
  entryId: string
  actor?: MemoryActor
}

/** Read by explicit scope and id; journal records the retrieval, not model use. */
export function readMemory(options: ReadMemoryOptions): MemoryEntry {
  const actor = options.actor ? deriveMemoryActor(options.actor) : ({ kind: 'human' } as const)
  const db = getDb()
  let operationId: number | undefined
  let changedScope: ScopeRow | undefined
  const result = db
    .transaction(() => {
      const scope = getScopeById(options.scopeId)
      assertInternalActorCanAccessScope(actor, scope)
      const entry = db
        .prepare('SELECT * FROM memory_entries WHERE id = ? AND scope_id = ?')
        .get(options.entryId, scope.id) as EntryRow | undefined
      if (!entry) throw new MemoryNotFoundError('Memory entry not found in the selected scope')
      const timestamp = now()
      const actorSource =
        actor.kind === 'internal-agent'
          ? [actor.workspaceId, actor.sessionId, actor.engine, null, null]
          : actor.kind === 'external-mcp'
            ? [null, null, null, actor.clientName, actor.transport]
            : [null, null, null, null, null]
      const sourceProjectPath = projectPathForActor(actor)
      operationId = Number(
        db
          .prepare(`INSERT INTO memory_operations
      (scope_id, operation, actor_kind, source_workspace_id, source_session_id, source_engine, source_project_path, client_name, transport, entry_id, revision, created_at)
      VALUES (?, 'read', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(
            scope.id,
            actor.kind,
            ...actorSource.slice(0, 3),
            sourceProjectPath,
            ...actorSource.slice(3),
            entry.id,
            entry.revision,
            timestamp,
          ).lastInsertRowid,
      )
      changedScope = scope
      return mapEntry(entry)
    })
    .immediate()
  if (operationId !== undefined && changedScope) notifyCommitted(changedScope, operationId, true)
  return result
}

export interface SearchMemoriesOptions {
  scopeId: string
  query: string
  actor?: MemoryActor
  cursor?: string
  limit?: number
}
export function searchMemories(options: SearchMemoriesOptions): MemoryPage {
  const scope = getScopeById(options.scopeId)
  const actor = options.actor ? deriveMemoryActor(options.actor) : ({ kind: 'human' } as const)
  assertInternalActorCanAccessScope(actor, scope)
  const db = getDb()
  const result = db
    .transaction(() => {
      const page = listPage([options.scopeId], options)
      return { page, reads: recordMemoryReads(page.items, actor) }
    })
    .immediate()
  for (const [scopeId, operationId] of result.reads) notifyCommitted(getScopeById(scopeId), operationId, true)
  return result.page
}

/** Store one content-free journal row per entry actually returned to the caller. */
function recordMemoryReads(entries: MemoryEntry[], actor: MemoryActor): Map<string, number> {
  const latestOperationByScope = new Map<string, number>()
  for (const entry of entries) {
    const scope = getScopeById(entry.scopeId)
    const operationId = writeOperation(scope, actor, 'read', entry.id, entry.revision, now())
    latestOperationByScope.set(scope.id, operationId)
  }
  return latestOperationByScope
}

export interface ListMemoryOperationsOptions {
  scopeId: string
  workspaceId?: string
  actor?: MemoryActor
  cursor?: string
  limit?: number
}
export function listMemoryOperations(options: ListMemoryOperationsOptions): {
  items: MemoryOperation[]
  nextCursor?: string
} {
  const scope = getScopeById(options.scopeId)
  const actor = options.actor ? deriveMemoryActor(options.actor) : undefined
  if (actor?.kind === 'internal-agent') {
    if (options.workspaceId && options.workspaceId !== actor.workspaceId)
      throw new MemoryNotFoundError('Agent cannot view another workspace operation journal')
    assertInternalActorCanAccessScope(actor, scope)
  }
  const viewWorkspaceId = options.workspaceId ?? (actor?.kind === 'internal-agent' ? actor.workspaceId : undefined)
  let viewProjectPath: string | undefined
  let sameProjectWorkspaceIds: string[] | undefined
  if (viewWorkspaceId) {
    const db = getDb()
    const workspace = db.prepare('SELECT project_path FROM workspaces WHERE id = ?').get(viewWorkspaceId) as
      | { project_path: string }
      | undefined
    if (!workspace) throw new MemoryNotFoundError('Workspace not found')
    viewProjectPath = normalizeMemoryProjectPath(workspace.project_path)
    if (scope.level === 'workspace' && scope.workspace_id !== viewWorkspaceId)
      throw new MemoryNotFoundError('Workspace cannot view another workspace operation journal')
    if (scope.level === 'project' && normalizeMemoryProjectPath(scope.project_path!) !== viewProjectPath)
      throw new MemoryNotFoundError('Workspace cannot view another project operation journal')
    if (scope.level !== 'workspace') {
      sameProjectWorkspaceIds = (
        db.prepare('SELECT id, project_path FROM workspaces').all() as {
          id: string
          project_path: string
        }[]
      )
        .filter((row) => normalizeMemoryProjectPath(row.project_path) === viewProjectPath)
        .map((row) => row.id)
    }
  }
  const limit = requireBoundedPage(options.limit)
  const offset = requireCursor(options.cursor)
  let sql = 'SELECT * FROM memory_operations WHERE scope_id = ?'
  const args: (string | number)[] = [options.scopeId]
  if (viewProjectPath && sameProjectWorkspaceIds) {
    const legacySourceWorkspaceCondition = sameProjectWorkspaceIds.length
      ? `source_project_path IS NULL AND source_workspace_id IN (${sameProjectWorkspaceIds.map(() => '?').join(',')})`
      : '0'
    sql += ` AND (actor_kind <> 'internal-agent' OR source_project_path = ? OR (${legacySourceWorkspaceCondition}))`
    args.push(viewProjectPath, ...sameProjectWorkspaceIds)
  }
  sql += ' ORDER BY id DESC LIMIT ? OFFSET ?'
  args.push(limit + 1, offset)
  const rows = getDb()
    .prepare(sql)
    .all(...args) as OperationRow[]
  const hasMore = rows.length > limit
  return { items: rows.slice(0, limit).map(mapOperation), ...(hasMore ? { nextCursor: String(offset + limit) } : {}) }
}

/**
 * List the operation journal across a workspace's exact three scopes.
 * The cursor is the last global operation id (exclusive), not an offset per
 * scope, so uneven scope distributions cannot repeat or skip later pages.
 */
export function listWorkspaceMemoryOperations(
  workspaceId: string,
  options: { cursor?: string; limit?: number } = {},
): { items: MemoryOperation[]; nextCursor?: string } {
  const limit = requireBoundedPage(options.limit)
  const cursor = options.cursor === undefined ? undefined : requireCursor(options.cursor)
  const db = getDb()
  const workspace = db.prepare('SELECT project_path FROM workspaces WHERE id = ?').get(workspaceId) as
    | { project_path: string }
    | undefined
  if (!workspace) throw new MemoryNotFoundError('Workspace not found')

  const projectPath = normalizeMemoryProjectPath(workspace.project_path)
  const sameProjectWorkspaceIds = (
    db.prepare('SELECT id, project_path FROM workspaces').all() as { id: string; project_path: string }[]
  )
    .filter((row) => normalizeMemoryProjectPath(row.project_path) === projectPath)
    .map((row) => row.id)
  const scopes = listMemoryScopes({ workspaceId }).items
  const globalScope = scopes.find((scope) => scope.level === 'global')
  const projectScope = scopes.find((scope) => scope.level === 'project')
  const workspaceScope = scopes.find((scope) => scope.level === 'workspace')
  if (!globalScope || !projectScope || !workspaceScope) throw new Error('Applicable memory scopes are incomplete')

  const scopeIds = [globalScope.id, projectScope.id, workspaceScope.id]
  const placeholders = scopeIds.map(() => '?').join(', ')
  const sameProjectPlaceholders = sameProjectWorkspaceIds.map(() => '?').join(', ')
  const legacySourceWorkspaceCondition = sameProjectWorkspaceIds.length
    ? `source_project_path IS NULL AND source_workspace_id IN (${sameProjectPlaceholders})`
    : '0'
  const query = `SELECT * FROM memory_operations
    WHERE scope_id IN (${placeholders})
      AND (scope_id = ? OR actor_kind <> 'internal-agent' OR source_project_path = ? OR (${legacySourceWorkspaceCondition}))
      ${cursor === undefined ? '' : 'AND id < ?'}
    ORDER BY id DESC LIMIT ?`
  const parameters: (string | number)[] = [
    ...scopeIds,
    workspaceScope.id,
    projectPath,
    ...sameProjectWorkspaceIds,
    ...(cursor === undefined ? [] : [cursor]),
    limit + 1,
  ]
  const rows = db.prepare(query).all(...parameters) as OperationRow[]
  const page = rows.slice(0, limit)
  return {
    items: page.map(mapOperation),
    ...(rows.length > limit && page.length ? { nextCursor: String(page.at(-1)!.id) } : {}),
  }
}

function isHuman(actor: MemoryActor): boolean {
  return actor.kind === 'human'
}

function assertHuman(actor: MemoryActor, action: string): void {
  if (!isHuman(actor)) throw new MemoryNotFoundError(`${action} is available to the human operator only`)
}

function insertProposal(
  scope: ScopeRow,
  actor: Exclude<MemoryActor, { kind: 'human' }>,
  key: string,
  title: string,
  body: string,
  generation: number,
  targetEntryId?: string,
  baseRevision?: number,
): MemoryProposalView {
  const db = getDb()
  let changedScope: ScopeRow | undefined
  let operationId: number | undefined
  const proposal = db
    .transaction(() => {
      const actorSource =
        actor.kind === 'internal-agent'
          ? [actor.workspaceId, actor.sessionId, actor.engine, null, null]
          : [null, null, null, actor.clientName, actor.transport]
      const repeated = db
        .prepare(`SELECT * FROM memory_proposals
          WHERE scope_id = ? AND target_entry_id IS ? AND base_revision IS ? AND memory_key = ?
            AND title = ? AND body = ? AND generation = ? AND actor_kind = ?
            AND source_workspace_id IS ? AND source_session_id IS ? AND source_engine IS ?
            AND client_name IS ? AND transport IS ?
          ORDER BY created_at DESC, id DESC LIMIT 1`)
        .get(
          scope.id,
          targetEntryId ?? null,
          baseRevision ?? null,
          key,
          title,
          body,
          generation,
          actor.kind,
          ...actorSource,
        ) as ProposalRow | undefined
      if (repeated) return mapProposal(repeated)
      const timestamp = now()
      const id = nanoid()
      db.prepare(`INSERT INTO memory_proposals
      (id, scope_id, target_entry_id, base_revision, memory_key, title, body, generation, actor_kind,
       source_workspace_id, source_session_id, source_engine, client_name, transport, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        id,
        scope.id,
        targetEntryId ?? null,
        baseRevision ?? null,
        key,
        title,
        body,
        generation,
        actor.kind,
        ...actorSource,
        timestamp,
        timestamp,
      )
      db.prepare('UPDATE memory_scopes SET revision = revision + 1, updated_at = ? WHERE id = ?').run(
        timestamp,
        scope.id,
      )
      changedScope = getScopeById(scope.id)
      operationId = writeOperation(changedScope, actor, 'proposed', null, changedScope.revision, timestamp, id)
      return mapProposal(db.prepare('SELECT * FROM memory_proposals WHERE id = ?').get(id) as ProposalRow)
    })
    .immediate()
  if (changedScope && operationId !== undefined) notifyCommitted(changedScope, operationId)
  return proposal
}

export interface RememberMemoryInput extends CreateMemoryInput {
  expectedGeneration: number
  targetEntryId?: string
  expectedRevision?: number
}

export type RememberMemoryResult =
  | { status: 'denied'; reason: string }
  | { status: 'applied'; entry: MemoryEntry }
  | { status: 'proposed'; proposal: MemoryProposalView }

/** Agent-facing write boundary; reads the operating mode on every invocation. */
export function remember(input: RememberMemoryInput): RememberMemoryResult {
  const key = requireKey(input.key)
  const title = requireText(input.title, 'Title', MEMORY_TITLE_MAX_CHARS)
  const body = requireText(input.body, 'Body', MEMORY_BODY_MAX_CHARS)
  const actor = deriveMemoryActor(input.actor)
  if (actor.kind === 'human') throw new TypeError('remember is reserved for agent-originated writes')
  if (!Number.isInteger(input.expectedGeneration) || input.expectedGeneration < 0)
    throw new TypeError('A valid scope generation is required')
  const scope = getScopeById(input.scopeId)
  assertInternalActorCanAccessScope(actor, scope)
  if (scope.generation !== input.expectedGeneration)
    throw new MemoryConflictError('Memory scope generation changed; reread before writing')
  const decision = memoryWriteDecision(getGlobalSettings().memoryMode, scope.level, false)
  if (decision === 'deny') return { status: 'denied', reason: 'Memory mode does not allow agent writes' }
  const existing = getDb()
    .prepare('SELECT * FROM memory_entries WHERE scope_id = ? AND memory_key = ?')
    .get(scope.id, key) as EntryRow | undefined
  const targetId = input.targetEntryId ?? existing?.id
  const target = targetId
    ? (getDb().prepare('SELECT * FROM memory_entries WHERE id = ? AND scope_id = ?').get(targetId, scope.id) as
        | EntryRow
        | undefined)
    : undefined
  if (targetId && !target) throw new MemoryNotFoundError('Target memory entry not found')
  if (target && target.memory_key === key && target.title === title && target.body === body) {
    return { status: 'applied', entry: mapEntry(target) }
  }
  if (target && input.expectedRevision !== target.revision)
    throw new MemoryConflictError('Memory entry revision changed; reread before writing')
  if (!target && input.expectedRevision !== undefined) throw new TypeError('expectedRevision requires a target entry')
  if (target && target.memory_key !== key) {
    const owner = existing
    if (owner && owner.id !== target.id) throw new MemoryConflictError('A different memory already uses this key')
  }
  if (decision === 'propose') {
    return {
      status: 'proposed',
      proposal: insertProposal(scope, actor, key, title, body, scope.generation, target?.id, target?.revision),
    }
  }
  if (target) {
    return {
      status: 'applied',
      entry: updateMemory({
        scopeId: scope.id,
        entryId: target.id,
        expectedRevision: target.revision,
        key,
        title,
        body,
        actor,
      }),
    }
  }
  return { status: 'applied', entry: createMemory({ scopeId: scope.id, key, title, body, actor }) }
}

export function listMemoryProposals(input: string | { scopeId: string; actor?: MemoryActor }): MemoryProposalView[] {
  const scopeId = typeof input === 'string' ? input : input.scopeId
  const source = deriveMemoryActor(typeof input === 'string' ? { kind: 'human' } : (input.actor ?? { kind: 'human' }))
  assertHuman(source, 'Proposal review')
  getScopeById(scopeId)
  return (
    getDb()
      .prepare('SELECT * FROM memory_proposals WHERE scope_id = ? ORDER BY created_at, id')
      .all(scopeId) as ProposalRow[]
  ).map(mapProposal)
}

function requireProposal(id: string): ProposalRow {
  const row = getDb().prepare('SELECT * FROM memory_proposals WHERE id = ?').get(id) as ProposalRow | undefined
  if (!row) throw new MemoryNotFoundError('Pending memory proposal not found')
  return row
}

export function approveMemoryProposal(proposalId: string, actorInput: MemoryActor): MemoryEntry {
  const actor = deriveMemoryActor(actorInput)
  assertHuman(actor, 'Proposal approval')
  const db = getDb()
  let changedScope: ScopeRow | undefined
  let operationId: number | undefined
  const entry = db
    .transaction(() => {
      const proposal = requireProposal(proposalId)
      const scope = getScopeById(proposal.scope_id)
      if (scope.generation !== proposal.generation)
        throw new MemoryConflictError('Scope was cleared after this proposal was made')
      const target = proposal.target_entry_id
        ? (db
            .prepare('SELECT * FROM memory_entries WHERE id = ? AND scope_id = ?')
            .get(proposal.target_entry_id, scope.id) as EntryRow | undefined)
        : undefined
      if (proposal.target_entry_id && (!target || target.revision !== proposal.base_revision))
        throw new MemoryConflictError('Proposal target revision changed; proposal remains pending')
      const collision = db
        .prepare('SELECT id FROM memory_entries WHERE scope_id = ? AND memory_key = ? AND id <> ?')
        .get(scope.id, proposal.memory_key, target?.id ?? '')
      if (collision) throw new MemoryConflictError('A memory now uses the proposed key; proposal remains pending')
      const timestamp = now()
      const id = target?.id ?? nanoid()
      const newRevision = target ? target.revision + 1 : 1
      if (target) {
        const updated = db.prepare(`UPDATE memory_entries SET memory_key = ?, title = ?, body = ?, revision = ?,
        actor_kind = ?, source_workspace_id = ?, source_session_id = ?, source_engine = ?, client_name = ?, transport = ?, updated_at = ?
        WHERE id = ? AND scope_id = ? AND revision = ?`)
        const p = proposalSource(proposal)
        if (
          updated.run(
            proposal.memory_key,
            proposal.title,
            proposal.body,
            newRevision,
            proposal.actor_kind,
            ...p,
            timestamp,
            target.id,
            scope.id,
            proposal.base_revision,
          ).changes !== 1
        )
          throw new MemoryConflictError()
      } else {
        const p = proposalSource(proposal)
        db.prepare(`INSERT INTO memory_entries
        (id, scope_id, memory_key, title, body, revision, actor_kind, source_workspace_id, source_session_id, source_engine, client_name, transport, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          id,
          scope.id,
          proposal.memory_key,
          proposal.title,
          proposal.body,
          proposal.actor_kind,
          ...p,
          timestamp,
          timestamp,
        )
      }
      db.prepare('DELETE FROM memory_proposals WHERE id = ?').run(proposal.id)
      db.prepare('UPDATE memory_scopes SET revision = revision + 1, updated_at = ? WHERE id = ?').run(
        timestamp,
        scope.id,
      )
      changedScope = getScopeById(scope.id)
      operationId = writeOperation(changedScope, actor, 'approved', id, newRevision, timestamp, proposal.id)
      return mapEntry(db.prepare('SELECT * FROM memory_entries WHERE id = ?').get(id) as EntryRow)
    })
    .immediate()
  if (changedScope && operationId !== undefined) notifyCommitted(changedScope, operationId)
  return entry
}

function proposalSource(row: ProposalRow): (string | null)[] {
  return [row.source_workspace_id, row.source_session_id, row.source_engine, row.client_name, row.transport]
}

export function rejectMemoryProposal(proposalId: string, actorInput: MemoryActor): void {
  const actor = deriveMemoryActor(actorInput)
  assertHuman(actor, 'Proposal rejection')
  const db = getDb()
  let changedScope: ScopeRow | undefined
  let operationId: number | undefined
  db.transaction(() => {
    const proposal = requireProposal(proposalId)
    const scope = getScopeById(proposal.scope_id)
    const timestamp = now()
    db.prepare('DELETE FROM memory_proposals WHERE id = ?').run(proposal.id)
    db.prepare('UPDATE memory_scopes SET revision = revision + 1, updated_at = ? WHERE id = ?').run(timestamp, scope.id)
    changedScope = getScopeById(scope.id)
    operationId = writeOperation(changedScope, actor, 'rejected', null, changedScope.revision, timestamp, proposal.id)
  }).immediate()
  if (changedScope && operationId !== undefined) notifyCommitted(changedScope, operationId)
}

export interface DeleteMemoryInput {
  scopeId: string
  entryId: string
  expectedRevision: number
  actor: MemoryActor
}

export function deleteMemory(input: DeleteMemoryInput): void {
  const actor = deriveMemoryActor(input.actor)
  assertHuman(actor, 'Memory deletion')
  const db = getDb()
  let changedScope: ScopeRow | undefined
  let operationId: number | undefined
  db.transaction(() => {
    const scope = getScopeById(input.scopeId)
    const result = db
      .prepare('DELETE FROM memory_entries WHERE id = ? AND scope_id = ? AND revision = ?')
      .run(input.entryId, scope.id, input.expectedRevision)
    if (result.changes !== 1) throw new MemoryConflictError('Memory entry changed or no longer exists')
    const timestamp = now()
    db.prepare('UPDATE memory_scopes SET revision = revision + 1, updated_at = ? WHERE id = ?').run(timestamp, scope.id)
    changedScope = getScopeById(scope.id)
    operationId = writeOperation(changedScope, actor, 'deleted', input.entryId, input.expectedRevision, timestamp)
  }).immediate()
  if (changedScope && operationId !== undefined) notifyCommitted(changedScope, operationId)
}

export interface PromoteMemoryInput {
  sourceScopeId: string
  entryId: string
  targetScopeId: string
  actor: MemoryActor
}

export function promoteMemory(input: PromoteMemoryInput): MemoryEntry {
  const actor = deriveMemoryActor(input.actor)
  assertHuman(actor, 'Memory promotion')
  const db = getDb()
  let changedScope: ScopeRow | undefined
  let operationId: number | undefined
  const entry = db
    .transaction(() => {
      const sourceScope = getScopeById(input.sourceScopeId)
      const targetScope = getScopeById(input.targetScopeId)
      const source = db
        .prepare('SELECT * FROM memory_entries WHERE id = ? AND scope_id = ?')
        .get(input.entryId, sourceScope.id) as EntryRow | undefined
      if (!source) throw new MemoryNotFoundError('Source memory entry not found')
      const collision = db
        .prepare('SELECT id FROM memory_entries WHERE scope_id = ? AND memory_key = ?')
        .get(targetScope.id, source.memory_key)
      if (collision) throw new MemoryConflictError('Target scope already has this memory key')
      const timestamp = now()
      const id = nanoid()
      const p = [
        source.source_workspace_id,
        source.source_session_id,
        source.source_engine,
        source.client_name,
        source.transport,
      ]
      db.prepare(`INSERT INTO memory_entries
      (id, scope_id, memory_key, title, body, revision, actor_kind, source_workspace_id, source_session_id, source_engine, client_name, transport, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        id,
        targetScope.id,
        source.memory_key,
        source.title,
        source.body,
        source.actor_kind,
        ...p,
        timestamp,
        timestamp,
      )
      db.prepare('UPDATE memory_scopes SET revision = revision + 1, updated_at = ? WHERE id = ?').run(
        timestamp,
        targetScope.id,
      )
      changedScope = getScopeById(targetScope.id)
      operationId = writeOperation(changedScope, actor, 'promoted', id, 1, timestamp)
      return mapEntry(db.prepare('SELECT * FROM memory_entries WHERE id = ?').get(id) as EntryRow)
    })
    .immediate()
  if (changedScope && operationId !== undefined) notifyCommitted(changedScope, operationId)
  return entry
}

export interface MemoryClearPreview {
  scope: ResolvedMemoryScope
  entries: number
  proposals: number
  revision: number
  generation: number
}

export function previewMemoryClear(scopeId: string, actorInput: MemoryActor = { kind: 'human' }): MemoryClearPreview {
  assertHuman(deriveMemoryActor(actorInput), 'Memory clearing')
  const scope = getScopeById(scopeId)
  const db = getDb()
  const entries = (
    db.prepare('SELECT COUNT(*) AS count FROM memory_entries WHERE scope_id = ?').get(scopeId) as { count: number }
  ).count
  const proposals = (
    db.prepare('SELECT COUNT(*) AS count FROM memory_proposals WHERE scope_id = ?').get(scopeId) as { count: number }
  ).count
  return { scope: mapScope(scope), entries, proposals, revision: scope.revision, generation: scope.generation }
}

export function clearMemoryScope(input: {
  scopeId: string
  expectedRevision: number
  actor: MemoryActor
}): MemoryClearPreview {
  const actor = deriveMemoryActor(input.actor)
  assertHuman(actor, 'Memory clearing')
  if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 0)
    throw new TypeError('Invalid preview revision')
  const db = getDb()
  let changedScope: ScopeRow | undefined
  let operationId: number | undefined
  const cleared = db
    .transaction(() => {
      const scope = getScopeById(input.scopeId)
      if (scope.revision !== input.expectedRevision)
        throw new MemoryConflictError('Memory changed since the clear preview')
      const entries = (
        db.prepare('SELECT COUNT(*) AS count FROM memory_entries WHERE scope_id = ?').get(scope.id) as { count: number }
      ).count
      const proposals = (
        db.prepare('SELECT COUNT(*) AS count FROM memory_proposals WHERE scope_id = ?').get(scope.id) as {
          count: number
        }
      ).count
      db.prepare('DELETE FROM memory_entries WHERE scope_id = ?').run(scope.id)
      db.prepare('DELETE FROM memory_proposals WHERE scope_id = ?').run(scope.id)
      const timestamp = now()
      db.prepare(
        'UPDATE memory_scopes SET generation = generation + 1, revision = revision + 1, updated_at = ? WHERE id = ?',
      ).run(timestamp, scope.id)
      changedScope = getScopeById(scope.id)
      operationId = writeOperation(
        changedScope,
        actor,
        'cleared',
        null,
        changedScope.revision,
        timestamp,
        null,
        entries,
        proposals,
      )
      return {
        scope: mapScope(changedScope),
        entries,
        proposals,
        revision: changedScope.revision,
        generation: changedScope.generation,
      }
    })
    .immediate()
  if (changedScope && operationId !== undefined) notifyCommitted(changedScope, operationId)
  return cleared
}
