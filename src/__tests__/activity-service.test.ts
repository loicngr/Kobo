import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { migrations, runMigrations, SCHEMA_VERSION } from '../server/db/migrations.js'
import { initSchema } from '../server/db/schema.js'
import { classifyActivity, listActivity, recordActivity } from '../server/services/activity-service.js'

function setup() {
  const db = new Database(':memory:')
  initSchema(db)
  db.prepare(
    "INSERT INTO workspaces (id, name, project_path, source_branch, working_branch, worktree_path, created_at, updated_at) VALUES ('w', 'Mission', '/tmp', 'main', 'feat', '/tmp/feat', '2026-09-09', '2026-09-09')",
  ).run()
  return db
}
describe('absence activity journal', () => {
  it('records useful events, not streaming or user-requested stops', () => {
    expect(classifyActivity('agent:event', { kind: 'message:text', text: 'secret' })).toBeNull()
    expect(classifyActivity('agent:event', { kind: 'session:ended', reason: 'killed' })).toBeNull()
    expect(classifyActivity('agent:event', { kind: 'session:ended', reason: 'completed' })).toBe('completed')
    expect(classifyActivity('agent:event', { kind: 'session:user-input-requested', requestKind: 'question' })).toBe(
      'question',
    )
    expect(classifyActivity('pr:merged', {})).toBe('pr-merged')
    expect(classifyActivity('agent:event', { kind: 'session:ended', reason: 'watchdog', superseded: true })).toBeNull()
  })
  it('paginates without skipping concurrent events, preserves archived context and avoids payload storage', () => {
    const db = setup()
    recordActivity('w', 'agent:event', { kind: 'error', message: 'secret' }, 's', db)
    recordActivity('w', 'pr:merged', {}, undefined, db)
    db.prepare("UPDATE workspaces SET archived_at = '2026-09-09' WHERE id = 'w'").run()
    const first = listActivity(0, 1, db)
    expect(first.items).toHaveLength(1)
    expect(first.hasMore).toBe(true)
    expect(first.items[0]).toMatchObject({ kind: 'error', sessionId: 's', workspaceName: 'Mission' })
    expect(JSON.stringify(first)).not.toContain('secret')
    recordActivity('w', 'pr:approved', {}, undefined, db)
    const next = listActivity(first.nextCursor, 200, db)
    expect(next.items.map((item) => item.kind)).toEqual(['pr-merged', 'pr-approved'])
    expect(next.hasMore).toBe(false)
    db.close()
  })
  it('upgrades version 40 preserving data and converges with fresh installs', () => {
    const upgraded = setup()
    upgraded.exec('DROP TABLE workspace_activity')
    upgraded.exec(
      'CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)',
    )
    for (const version of [1, ...migrations.filter((m) => m.version <= 40).map((m) => m.version)]) {
      upgraded.prepare("INSERT INTO schema_migrations VALUES (?, 'previous', '2026-09-09')").run(version)
    }
    runMigrations(upgraded)
    expect(upgraded.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()).toEqual({
      version: SCHEMA_VERSION,
    })
    expect(upgraded.prepare('SELECT name FROM workspaces').get()).toEqual({ name: 'Mission' })
    const fresh = setup()
    expect(upgraded.prepare('PRAGMA table_info(workspace_activity)').all()).toEqual(
      fresh.prepare('PRAGMA table_info(workspace_activity)').all(),
    )
    runMigrations(upgraded)
    upgraded.close()
    fresh.close()
  })
})
