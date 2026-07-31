import { createHash } from 'node:crypto'
import { nanoid } from 'nanoid'
import { getDb } from '../db/index.js'

export type PermissionRuleScope = 'operation' | 'tool'
export interface PermissionRequest {
  engine: string
  toolName: string
  payload: unknown
}
export interface WorkspacePermissionRule {
  id: string
  workspaceId: string
  engine: string | null
  toolName: string
  scope: PermissionRuleScope
  fingerprint: string | null
  displayLabel: string
  createdAt: string
  updatedAt: string
}
const turnRules = new Map<string, Set<string>>()
function turnKey(request: PermissionRequest): string {
  return `${request.engine}\u0000${request.toolName}`
}
export function allowPermissionForTurn(workspaceId: string, request: PermissionRequest): void {
  const rules = turnRules.get(workspaceId) ?? new Set<string>()
  rules.add(turnKey(request))
  turnRules.set(workspaceId, rules)
}
export function clearTurnPermissions(workspaceId: string): void {
  turnRules.delete(workspaceId)
}

function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stable(record[key])}`)
    .join(',')}}`
}
export function permissionFingerprint(payload: unknown): string {
  return createHash('sha256').update(stable(payload)).digest('hex')
}
function toRule(row: Record<string, unknown>): WorkspacePermissionRule {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    engine: row.engine as string | null,
    toolName: String(row.tool_name),
    scope: row.scope as PermissionRuleScope,
    fingerprint: row.fingerprint as string | null,
    displayLabel: String(row.display_label),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }
}
export function listWorkspacePermissionRules(workspaceId: string): WorkspacePermissionRule[] {
  return (
    getDb()
      .prepare('SELECT * FROM workspace_permission_rules WHERE workspace_id=? ORDER BY created_at DESC')
      .all(workspaceId) as Record<string, unknown>[]
  ).map(toRule)
}
export function createWorkspacePermissionRule(
  workspaceId: string,
  request: PermissionRequest,
  scope: PermissionRuleScope,
): WorkspacePermissionRule {
  const now = new Date().toISOString()
  const id = nanoid()
  const fingerprint = scope === 'operation' ? permissionFingerprint(request.payload) : null
  const displayLabel = scope === 'tool' ? request.toolName : `${request.toolName} — opération précise`
  getDb()
    .prepare(
      'INSERT INTO workspace_permission_rules (id,workspace_id,engine,tool_name,scope,fingerprint,display_label,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
    )
    .run(id, workspaceId, request.engine, request.toolName, scope, fingerprint, displayLabel, now, now)
  return {
    id,
    workspaceId,
    engine: request.engine,
    toolName: request.toolName,
    scope,
    fingerprint,
    displayLabel,
    createdAt: now,
    updatedAt: now,
  }
}
export function removeWorkspacePermissionRule(workspaceId: string, ruleId: string): boolean {
  return (
    getDb().prepare('DELETE FROM workspace_permission_rules WHERE id=? AND workspace_id=?').run(ruleId, workspaceId)
      .changes > 0
  )
}
export function isWorkspacePermissionAllowed(workspaceId: string, request: PermissionRequest): boolean {
  if (turnRules.get(workspaceId)?.has(turnKey(request))) return true
  const fingerprint = permissionFingerprint(request.payload)
  try {
    return Boolean(
      getDb()
        .prepare(
          `SELECT 1 FROM workspace_permission_rules WHERE workspace_id=? AND tool_name=? AND (engine IS NULL OR engine=?) AND (scope='tool' OR (scope='operation' AND fingerprint=?)) LIMIT 1`,
        )
        .get(workspaceId, request.toolName, request.engine, fingerprint),
    )
  } catch (error) {
    if (error instanceof Error && /no such table/i.test(error.message)) return false
    throw error
  }
}
