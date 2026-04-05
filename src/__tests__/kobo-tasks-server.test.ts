import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { listTasksHandler, markTaskDoneHandler } from '../mcp-server/kobo-tasks-handlers.js'
import { initSchema } from '../server/db/schema.js'

describe('MCP tasks server handlers', () => {
  let tmpDir: string
  let dbPath: string
  let db: Database.Database
  const workspaceId = 'ws-test-1'

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'at-mcp-test-'))
    dbPath = path.join(tmpDir, 'test.db')
    db = new Database(dbPath)
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
    initSchema(db)

    const now = new Date().toISOString()
    db.prepare(
      'INSERT INTO workspaces (id, name, project_path, source_branch, working_branch, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(workspaceId, 'Test WS', '/tmp', 'main', 'feature/test', 'idle', now, now)
    db.prepare(
      'INSERT INTO tasks (id, workspace_id, title, status, is_acceptance_criterion, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run('task-1', workspaceId, 'Task A', 'pending', 0, 0, now, now)
    db.prepare(
      'INSERT INTO tasks (id, workspace_id, title, status, is_acceptance_criterion, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run('task-2', workspaceId, 'Criterion 1', 'pending', 1, 1, now, now)
    db.prepare(
      'INSERT INTO workspaces (id, name, project_path, source_branch, working_branch, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run('other-ws', 'Other', '/tmp', 'main', 'feature/other', 'idle', now, now)
    db.prepare(
      'INSERT INTO tasks (id, workspace_id, title, status, is_acceptance_criterion, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run('task-other', 'other-ws', 'Other task', 'pending', 0, 0, now, now)
  })

  afterEach(() => {
    db.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  describe('listTasksHandler', () => {
    it('retourne les tasks du workspace courant uniquement', () => {
      const result = listTasksHandler(db, workspaceId)
      expect(result).toHaveLength(2)
      expect(result.map((t) => t.id).sort()).toEqual(['task-1', 'task-2'])
    })

    it('retourne des tasks avec tous les champs attendus', () => {
      const result = listTasksHandler(db, workspaceId)
      const task = result.find((t) => t.id === 'task-1')!
      expect(task).toMatchObject({
        id: 'task-1',
        title: 'Task A',
        status: 'pending',
        is_acceptance_criterion: false,
      })
    })

    it('distingue tasks et criteria via is_acceptance_criterion', () => {
      const result = listTasksHandler(db, workspaceId)
      const criterion = result.find((t) => t.id === 'task-2')!
      expect(criterion.is_acceptance_criterion).toBe(true)
    })

    it('retourne un array vide si workspace inexistant', () => {
      expect(listTasksHandler(db, 'nonexistent')).toEqual([])
    })
  })

  describe('markTaskDoneHandler', () => {
    it('marque une task comme done', () => {
      const result = markTaskDoneHandler(db, workspaceId, 'task-1')
      expect(result.success).toBe(true)
      expect(result.task.status).toBe('done')
      expect(result.task.id).toBe('task-1')

      const row = db.prepare('SELECT status FROM tasks WHERE id = ?').get('task-1') as { status: string }
      expect(row.status).toBe('done')
    })

    it('lance une erreur si task_id nexiste pas', () => {
      expect(() => markTaskDoneHandler(db, workspaceId, 'nonexistent')).toThrow(/not found/)
    })

    it('lance une erreur si task appartient a un autre workspace', () => {
      expect(() => markTaskDoneHandler(db, workspaceId, 'task-other')).toThrow(/not found/)
    })

    it('met a jour updated_at', () => {
      const before = db.prepare('SELECT updated_at FROM tasks WHERE id = ?').get('task-1') as { updated_at: string }
      markTaskDoneHandler(db, workspaceId, 'task-1')
      const after = db.prepare('SELECT updated_at FROM tasks WHERE id = ?').get('task-1') as { updated_at: string }
      expect(after.updated_at >= before.updated_at).toBe(true)
    })
  })
})
