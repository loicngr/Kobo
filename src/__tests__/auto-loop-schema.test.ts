import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { migrations, runMigrations, SCHEMA_VERSION } from '../server/db/migrations.js'
import { initSchema } from '../server/db/schema.js'

describe('durable auto-loop migration', () => {
  it('upgrades v44 without losing tasks and converges with a fresh installation', () => {
    const old = new Database(':memory:')
    initSchema(old)
    // Reconstruct the previous task shape, retaining every historical column.
    const cols = old.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]
    if (cols.some((c) => c.name === 'role')) old.exec('ALTER TABLE tasks DROP COLUMN role')
    if (cols.some((c) => c.name === 'verification')) old.exec('ALTER TABLE tasks DROP COLUMN verification')
    for (const table of ['auto_loop_progress', 'auto_loop_messages', 'auto_loop_runs'])
      old.exec(`DROP TABLE IF EXISTS ${table}`)
    old.exec(`INSERT INTO workspaces (id,name,project_path,source_branch,working_branch,created_at,updated_at) VALUES ('w','w','/tmp','main','work','now','now');
      INSERT INTO tasks (id,workspace_id,title,status,sort_order,created_at,updated_at) VALUES ('t','w','[FINAL] verify','done',0,'now','now');
      CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL);`)
    for (let v = 1; v <= 44; v++) old.prepare('INSERT INTO schema_migrations VALUES (?,?,?)').run(v, `old-${v}`, 'now')
    runMigrations(old)
    expect(SCHEMA_VERSION).toBeGreaterThan(44)
    expect(old.prepare('SELECT title,status,role,verification FROM tasks WHERE id=?').get('t')).toEqual({
      title: '[FINAL] verify',
      status: 'done',
      role: 'finalization',
      verification: null,
    })
    const fresh = new Database(':memory:')
    initSchema(fresh)
    for (const table of ['tasks', 'auto_loop_runs', 'auto_loop_messages', 'auto_loop_progress']) {
      expect(old.prepare(`PRAGMA table_info(${table})`).all()).toEqual(
        fresh.prepare(`PRAGMA table_info(${table})`).all(),
      )
    }
    migrations.at(-1)?.migrate(old)
    expect(old.prepare('SELECT COUNT(*) AS n FROM tasks').get()).toEqual({ n: 1 })
    old.close()
    fresh.close()
  })
})
