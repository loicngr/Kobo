import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { initSchema } from '../server/db/schema.js'

function makeMemDb() {
  return new Database(':memory:')
}

describe('initSchema(db)', () => {
  it('crée la table workspaces', () => {
    const db = makeMemDb()
    initSchema(db)

    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='workspaces'").get() as
      | { name: string }
      | undefined

    expect(row?.name).toBe('workspaces')
    db.close()
  })

  it('crée la table tasks', () => {
    const db = makeMemDb()
    initSchema(db)

    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'").get() as
      | { name: string }
      | undefined

    expect(row?.name).toBe('tasks')
    db.close()
  })

  it('crée la table agent_sessions', () => {
    const db = makeMemDb()
    initSchema(db)

    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_sessions'").get() as
      | { name: string }
      | undefined

    expect(row?.name).toBe('agent_sessions')
    db.close()
  })

  it('crée la table ws_events', () => {
    const db = makeMemDb()
    initSchema(db)

    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ws_events'").get() as
      | { name: string }
      | undefined

    expect(row?.name).toBe('ws_events')
    db.close()
  })

  it('peut être appelé deux fois sans erreur (idempotent)', () => {
    const db = makeMemDb()
    expect(() => {
      initSchema(db)
      initSchema(db)
    }).not.toThrow()
    db.close()
  })

  it('workspaces a le bon statut par défaut', () => {
    const db = makeMemDb()
    initSchema(db)

    db.prepare(`
      INSERT INTO workspaces (id, name, project_path, source_branch, working_branch, created_at, updated_at)
      VALUES ('1', 'test', '/path', 'main', 'feat/x', '2024-01-01', '2024-01-01')
    `).run()

    const row = db.prepare('SELECT status, model, reasoning_effort FROM workspaces WHERE id=?').get('1') as {
      status: string
      model: string
      reasoning_effort: string
    }

    expect(row.status).toBe('created')
    expect(row.model).toBe('claude-opus-4-7')
    expect(row.reasoning_effort).toBe('auto')
    db.close()
  })

  it('tasks a is_acceptance_criterion et sort_order avec valeur par défaut 0', () => {
    const db = makeMemDb()
    initSchema(db)

    db.prepare(`
      INSERT INTO workspaces (id, name, project_path, source_branch, working_branch, created_at, updated_at)
      VALUES ('w1', 'test', '/path', 'main', 'feat/x', '2024-01-01', '2024-01-01')
    `).run()

    db.prepare(`
      INSERT INTO tasks (id, workspace_id, title, created_at, updated_at)
      VALUES ('t1', 'w1', 'My task', '2024-01-01', '2024-01-01')
    `).run()

    const row = db.prepare('SELECT is_acceptance_criterion, sort_order, status FROM tasks WHERE id=?').get('t1') as {
      is_acceptance_criterion: number
      sort_order: number
      status: string
    }

    expect(row.is_acceptance_criterion).toBe(0)
    expect(row.sort_order).toBe(0)
    expect(row.status).toBe('pending')
    db.close()
  })

  it('cascade DELETE sur ws_events quand workspace est supprimé', () => {
    const db = makeMemDb()
    db.pragma('foreign_keys = ON')
    initSchema(db)

    db.prepare(`
      INSERT INTO workspaces (id, name, project_path, source_branch, working_branch, created_at, updated_at)
      VALUES ('w1', 'test', '/path', 'main', 'feat/x', '2024-01-01', '2024-01-01')
    `).run()

    db.prepare(`
      INSERT INTO ws_events (id, workspace_id, type, payload, created_at)
      VALUES ('e1', 'w1', 'test_event', '{}', '2024-01-01')
    `).run()

    db.prepare('DELETE FROM workspaces WHERE id=?').run('w1')

    const row = db.prepare('SELECT * FROM ws_events WHERE id=?').get('e1')
    expect(row).toBeUndefined()
    db.close()
  })

  it('cascade DELETE sur tasks quand workspace est supprimé', () => {
    const db = makeMemDb()
    db.pragma('foreign_keys = ON')
    initSchema(db)

    db.prepare(`
      INSERT INTO workspaces (id, name, project_path, source_branch, working_branch, created_at, updated_at)
      VALUES ('w1', 'test', '/path', 'main', 'feat/x', '2024-01-01', '2024-01-01')
    `).run()

    db.prepare(`
      INSERT INTO tasks (id, workspace_id, title, created_at, updated_at)
      VALUES ('t1', 'w1', 'My task', '2024-01-01', '2024-01-01')
    `).run()

    db.prepare('DELETE FROM workspaces WHERE id=?').run('w1')

    const row = db.prepare('SELECT * FROM tasks WHERE id=?').get('t1')
    expect(row).toBeUndefined()
    db.close()
  })
})
