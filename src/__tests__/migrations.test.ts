import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { runMigrations, SCHEMA_VERSION } from '../server/db/migrations.js'

describe('runMigrations(db)', () => {
  it('crée toutes les tables requises', () => {
    const db = new Database(':memory:')
    runMigrations(db)

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as {
      name: string
    }[]

    const tableNames = tables.map((t) => t.name)
    expect(tableNames).toContain('workspaces')
    expect(tableNames).toContain('tasks')
    expect(tableNames).toContain('agent_sessions')
    expect(tableNames).toContain('ws_events')
    db.close()
  })

  it('crée la table schema_version', () => {
    const db = new Database(':memory:')
    runMigrations(db)

    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'").get() as
      | { name: string }
      | undefined

    expect(row?.name).toBe('schema_version')
    db.close()
  })

  it('insère la version courante dans schema_version après migration', () => {
    const db = new Database(':memory:')
    runMigrations(db)

    const row = db.prepare('SELECT version FROM schema_version LIMIT 1').get() as { version: number } | undefined

    expect(row?.version).toBe(SCHEMA_VERSION)
    db.close()
  })

  it('exporte SCHEMA_VERSION = 1', () => {
    expect(SCHEMA_VERSION).toBe(1)
  })

  it('est idempotent (peut être appelé plusieurs fois)', () => {
    const db = new Database(':memory:')
    expect(() => {
      runMigrations(db)
      runMigrations(db)
      runMigrations(db)
    }).not.toThrow()
    db.close()
  })

  it("n'applique pas la migration si la version est déjà à jour", () => {
    const db = new Database(':memory:')
    runMigrations(db)

    // Simuler un deuxième appel: la version est déjà SCHEMA_VERSION, ne doit pas recréer
    const beforeCount = (
      db.prepare("SELECT count(*) as c FROM sqlite_master WHERE type='table'").get() as { c: number }
    ).c

    runMigrations(db)

    const afterCount = (db.prepare("SELECT count(*) as c FROM sqlite_master WHERE type='table'").get() as { c: number })
      .c

    expect(afterCount).toBe(beforeCount)
    db.close()
  })
})
