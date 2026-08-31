// Permission rules are the second irreversible operation of the product: an
// "always allow" grants a tool a standing right for the life of the workspace.
// A fingerprint bug here is invisible in use — it silently widens the grant.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initSchema } from '../server/db/schema.js'

let tmpDir: string
let dbPath: string

async function resetDb() {
  const { closeDb } = await import('../server/db/index.js')
  closeDb()
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'at-perm-svc-test-'))
  dbPath = path.join(tmpDir, 'test.db')
  const db = new Database(dbPath)
  db.pragma('journal_mode=WAL')
  db.pragma('foreign_keys=ON')
  initSchema(db)
  db.close()
}

beforeEach(async () => {
  await resetDb()
  const { getDb } = await import('../server/db/index.js')
  const db = getDb(dbPath)
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO workspaces (id, name, project_path, source_branch, working_branch, model, created_at, updated_at)
     VALUES ('ws-1', 'w', '/tmp/w', 'main', 'feature/w', 'claude-opus-4-8', ?, ?)`,
  ).run(now, now)
})

afterEach(async () => {
  const { clearTurnPermissions } = await import('../server/services/workspace-permission-policy-service.js')
  clearTurnPermissions('ws-1')
  const { closeDb } = await import('../server/db/index.js')
  closeDb()
  if (tmpDir && fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true })
})

const bashLs = { engine: 'claude-code', toolName: 'Bash', payload: { command: 'ls -la' } }
const bashRm = { engine: 'claude-code', toolName: 'Bash', payload: { command: 'rm -rf /' } }

describe('permissionFingerprint()', () => {
  it('is stable under key reordering — same operation, same fingerprint', async () => {
    const { permissionFingerprint } = await import('../server/services/workspace-permission-policy-service.js')
    expect(permissionFingerprint({ a: 1, b: { c: 2, d: 3 } })).toBe(permissionFingerprint({ b: { d: 3, c: 2 }, a: 1 }))
  })

  it('separates two different operations', async () => {
    const { permissionFingerprint } = await import('../server/services/workspace-permission-policy-service.js')
    expect(permissionFingerprint({ command: 'ls -la' })).not.toBe(permissionFingerprint({ command: 'rm -rf /' }))
  })

  it('does not collapse an array into the object with the same values', async () => {
    const { permissionFingerprint } = await import('../server/services/workspace-permission-policy-service.js')
    expect(permissionFingerprint([1, 2])).not.toBe(permissionFingerprint({ 0: 1, 1: 2 }))
  })
})

describe('turn-scoped permissions', () => {
  it('allows for the current turn only, and forgets on clear', async () => {
    const { allowPermissionForTurn, clearTurnPermissions, isWorkspacePermissionAllowed } = await import(
      '../server/services/workspace-permission-policy-service.js'
    )
    expect(isWorkspacePermissionAllowed('ws-1', bashLs)).toBe(false)

    allowPermissionForTurn('ws-1', bashLs)
    expect(isWorkspacePermissionAllowed('ws-1', bashLs)).toBe(true)
    // Turn scope is per tool, not per payload — the allowance covers the turn.
    expect(isWorkspacePermissionAllowed('ws-1', bashRm)).toBe(true)

    clearTurnPermissions('ws-1')
    expect(isWorkspacePermissionAllowed('ws-1', bashLs)).toBe(false)
  })

  it('never leaks a turn allowance to another workspace', async () => {
    const { allowPermissionForTurn, isWorkspacePermissionAllowed } = await import(
      '../server/services/workspace-permission-policy-service.js'
    )
    allowPermissionForTurn('ws-1', bashLs)
    expect(isWorkspacePermissionAllowed('ws-2', bashLs)).toBe(false)
  })
})

describe('persisted permission rules', () => {
  it("an 'operation' rule covers that exact payload and nothing else", async () => {
    const { createWorkspacePermissionRule, isWorkspacePermissionAllowed } = await import(
      '../server/services/workspace-permission-policy-service.js'
    )
    createWorkspacePermissionRule('ws-1', bashLs, 'operation')

    expect(isWorkspacePermissionAllowed('ws-1', bashLs)).toBe(true)
    expect(
      isWorkspacePermissionAllowed('ws-1', { engine: 'claude-code', toolName: 'Bash', payload: { command: 'ls -la' } }),
    ).toBe(true)
    expect(isWorkspacePermissionAllowed('ws-1', bashRm)).toBe(false)
  })

  it("a 'tool' rule covers every invocation of that tool", async () => {
    const { createWorkspacePermissionRule, isWorkspacePermissionAllowed } = await import(
      '../server/services/workspace-permission-policy-service.js'
    )
    createWorkspacePermissionRule('ws-1', bashLs, 'tool')
    expect(isWorkspacePermissionAllowed('ws-1', bashRm)).toBe(true)
    expect(isWorkspacePermissionAllowed('ws-1', { engine: 'claude-code', toolName: 'Write', payload: {} })).toBe(false)
  })

  it('records the scope, the fingerprint and a label, and lists newest first', async () => {
    const { createWorkspacePermissionRule, listWorkspacePermissionRules, permissionFingerprint } = await import(
      '../server/services/workspace-permission-policy-service.js'
    )
    const operation = createWorkspacePermissionRule('ws-1', bashLs, 'operation')
    expect(operation).toMatchObject({
      workspaceId: 'ws-1',
      engine: 'claude-code',
      toolName: 'Bash',
      scope: 'operation',
      fingerprint: permissionFingerprint(bashLs.payload),
    })
    expect(operation.displayLabel).toContain('Bash')

    const tool = createWorkspacePermissionRule('ws-1', bashLs, 'tool')
    expect(tool.fingerprint).toBeNull()
    expect(tool.displayLabel).toBe('Bash')

    expect(listWorkspacePermissionRules('ws-1')).toHaveLength(2)
  })

  it('revokes a rule, and reports whether anything was revoked', async () => {
    const { createWorkspacePermissionRule, isWorkspacePermissionAllowed, removeWorkspacePermissionRule } = await import(
      '../server/services/workspace-permission-policy-service.js'
    )
    const rule = createWorkspacePermissionRule('ws-1', bashLs, 'tool')
    expect(isWorkspacePermissionAllowed('ws-1', bashRm)).toBe(true)

    expect(removeWorkspacePermissionRule('ws-1', rule.id)).toBe(true)
    expect(isWorkspacePermissionAllowed('ws-1', bashRm)).toBe(false)
    expect(removeWorkspacePermissionRule('ws-1', rule.id)).toBe(false)
  })

  it('refuses to revoke a rule belonging to another workspace', async () => {
    const { createWorkspacePermissionRule, removeWorkspacePermissionRule, isWorkspacePermissionAllowed } = await import(
      '../server/services/workspace-permission-policy-service.js'
    )
    const rule = createWorkspacePermissionRule('ws-1', bashLs, 'tool')
    expect(removeWorkspacePermissionRule('ws-2', rule.id)).toBe(false)
    expect(isWorkspacePermissionAllowed('ws-1', bashRm)).toBe(true)
  })

  it('scopes rules to their workspace', async () => {
    const { createWorkspacePermissionRule, isWorkspacePermissionAllowed, listWorkspacePermissionRules } = await import(
      '../server/services/workspace-permission-policy-service.js'
    )
    createWorkspacePermissionRule('ws-1', bashLs, 'tool')
    expect(isWorkspacePermissionAllowed('ws-2', bashLs)).toBe(false)
    expect(listWorkspacePermissionRules('ws-2')).toEqual([])
  })

  it('does not match a rule created for another engine', async () => {
    const { createWorkspacePermissionRule, isWorkspacePermissionAllowed } = await import(
      '../server/services/workspace-permission-policy-service.js'
    )
    createWorkspacePermissionRule('ws-1', { ...bashLs, engine: 'codex' }, 'tool')
    expect(isWorkspacePermissionAllowed('ws-1', bashLs)).toBe(false)
    expect(isWorkspacePermissionAllowed('ws-1', { ...bashLs, engine: 'codex' })).toBe(true)
  })

  it('disappears with its workspace, without leaving an orphan grant', async () => {
    const { getDb } = await import('../server/db/index.js')
    const { createWorkspacePermissionRule, listWorkspacePermissionRules } = await import(
      '../server/services/workspace-permission-policy-service.js'
    )
    createWorkspacePermissionRule('ws-1', bashLs, 'tool')
    getDb().prepare("DELETE FROM workspaces WHERE id = 'ws-1'").run()
    expect(listWorkspacePermissionRules('ws-1')).toEqual([])
  })
})
