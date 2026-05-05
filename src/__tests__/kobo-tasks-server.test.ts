import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock settings-service to avoid filesystem access during tests.
vi.mock('../server/services/settings-service.js', () => ({
  getGlobalSettings: vi.fn(() => ({
    worktreesPath: '',
    worktreesPrefixByProject: false,
  })),
  getProjectSettings: vi.fn(),
}))

import {
  createTaskHandler,
  deleteTaskHandler,
  getDevServerStatusHandler,
  getSessionUsageHandler,
  getSettingsHandler,
  getWorkspaceInfoHandler,
  listDocumentsHandler,
  listTasksHandler,
  listWorkspaceImagesHandler,
  logThoughtHandler,
  markTaskDoneHandler,
  readDocumentHandler,
  updateTaskHandler,
} from '../mcp-server/kobo-tasks-handlers.js'
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

  describe('createTaskHandler', () => {
    it('crée une tâche dans le workspace courant', () => {
      const task = createTaskHandler(db, workspaceId, { title: 'New task' })
      expect(task.title).toBe('New task')
      expect(task.status).toBe('pending')
      expect(task.is_acceptance_criterion).toBe(false)
      expect(task.id).toBeTruthy()
    })

    it('crée un critère d acceptation', () => {
      const task = createTaskHandler(db, workspaceId, { title: 'Crit', is_acceptance_criterion: true })
      expect(task.is_acceptance_criterion).toBe(true)
    })

    it('incrémente sort_order en fin de liste', () => {
      const task = createTaskHandler(db, workspaceId, { title: 'Last' })
      const row = db.prepare('SELECT sort_order FROM tasks WHERE id = ?').get(task.id) as { sort_order: number }
      expect(row.sort_order).toBe(2) // task-1=0, task-2=1, new=2
    })

    it('lance une erreur si title vide', () => {
      expect(() => createTaskHandler(db, workspaceId, { title: '' })).toThrow(/title is required/)
      expect(() => createTaskHandler(db, workspaceId, { title: '   ' })).toThrow(/title is required/)
    })

    it('lance une erreur si workspace inexistant', () => {
      expect(() => createTaskHandler(db, 'nonexistent', { title: 'x' })).toThrow(/Workspace .* not found/)
    })

    it('trim les espaces du title', () => {
      const task = createTaskHandler(db, workspaceId, { title: '  padded  ' })
      expect(task.title).toBe('padded')
    })
  })

  describe('updateTaskHandler', () => {
    it('met à jour le title', () => {
      const task = updateTaskHandler(db, workspaceId, 'task-1', { title: 'Renamed' })
      expect(task.title).toBe('Renamed')
    })

    it('met à jour le status', () => {
      const task = updateTaskHandler(db, workspaceId, 'task-1', { status: 'in_progress' })
      expect(task.status).toBe('in_progress')
    })

    it('rejette un status invalide', () => {
      expect(() => updateTaskHandler(db, workspaceId, 'task-1', { status: 'todo' })).toThrow(/Invalid status/)
      expect(() => updateTaskHandler(db, workspaceId, 'task-1', { status: 'done-maybe' })).toThrow(/Invalid status/)
    })

    it('accepte les trois status valides', () => {
      expect(() => updateTaskHandler(db, workspaceId, 'task-1', { status: 'pending' })).not.toThrow()
      expect(() => updateTaskHandler(db, workspaceId, 'task-1', { status: 'in_progress' })).not.toThrow()
      expect(() => updateTaskHandler(db, workspaceId, 'task-1', { status: 'done' })).not.toThrow()
    })

    it('toggle is_acceptance_criterion', () => {
      const task = updateTaskHandler(db, workspaceId, 'task-1', { is_acceptance_criterion: true })
      expect(task.is_acceptance_criterion).toBe(true)
    })

    it('lance une erreur si aucun champ fourni', () => {
      expect(() => updateTaskHandler(db, workspaceId, 'task-1', {})).toThrow(/No fields to update/)
    })

    it('lance une erreur si title vide', () => {
      expect(() => updateTaskHandler(db, workspaceId, 'task-1', { title: '   ' })).toThrow(/title cannot be empty/)
    })

    it('lance une erreur si task d un autre workspace', () => {
      expect(() => updateTaskHandler(db, workspaceId, 'task-other', { title: 'x' })).toThrow(/not found/)
    })

    it('lance une erreur si task inexistante', () => {
      expect(() => updateTaskHandler(db, workspaceId, 'nonexistent', { title: 'x' })).toThrow(/not found/)
    })
  })

  describe('deleteTaskHandler', () => {
    it('supprime une task', () => {
      const result = deleteTaskHandler(db, workspaceId, 'task-1')
      expect(result.success).toBe(true)
      expect(result.task_id).toBe('task-1')
      const row = db.prepare('SELECT id FROM tasks WHERE id = ?').get('task-1')
      expect(row).toBeUndefined()
    })

    it('lance une erreur si task inexistante', () => {
      expect(() => deleteTaskHandler(db, workspaceId, 'nonexistent')).toThrow(/not found/)
    })

    it('lance une erreur si task d un autre workspace', () => {
      expect(() => deleteTaskHandler(db, workspaceId, 'task-other')).toThrow(/not found/)
      // task-other doit toujours exister
      const row = db.prepare('SELECT id FROM tasks WHERE id = ?').get('task-other')
      expect(row).toBeDefined()
    })
  })

  describe('getDevServerStatusHandler', () => {
    it('retourne le status du workspace', () => {
      const result = getDevServerStatusHandler(db, workspaceId)
      expect(result.workspaceId).toBe(workspaceId)
      expect(result.status).toBe('stopped') // default
    })

    it('lance une erreur si workspace inexistant', () => {
      expect(() => getDevServerStatusHandler(db, 'nonexistent')).toThrow(/not found/)
    })

    it('reflète le status mis à jour en DB', () => {
      db.prepare('UPDATE workspaces SET dev_server_status = ? WHERE id = ?').run('running', workspaceId)
      expect(getDevServerStatusHandler(db, workspaceId).status).toBe('running')
    })
  })

  describe('getWorkspaceInfoHandler', () => {
    it('retourne toutes les métadonnées du workspace', () => {
      const info = getWorkspaceInfoHandler(db, workspaceId)
      expect(info.id).toBe(workspaceId)
      expect(info.name).toBe('Test WS')
      expect(info.projectPath).toBe('/tmp')
      expect(info.sourceBranch).toBe('main')
      expect(info.workingBranch).toBe('feature/test')
      expect(info.status).toBe('idle')
      expect(info.devServerStatus).toBe('stopped')
    })

    it('construit worktreePath depuis projectPath + workingBranch', () => {
      const info = getWorkspaceInfoHandler(db, workspaceId)
      expect(info.worktreePath).toBe('/tmp/.worktrees/feature/test')
    })

    it('lance une erreur si workspace inexistant', () => {
      expect(() => getWorkspaceInfoHandler(db, 'nonexistent')).toThrow(/not found/)
    })

    it('expose les flags autoLoop et autoLoopReady (false par défaut)', () => {
      const info = getWorkspaceInfoHandler(db, workspaceId)
      expect(info.autoLoop).toBe(false)
      expect(info.autoLoopReady).toBe(false)
    })

    it('expose autoLoop=true quand auto_loop=1 en DB', () => {
      db.prepare('UPDATE workspaces SET auto_loop = 1, auto_loop_ready = 1 WHERE id = ?').run(workspaceId)
      const info = getWorkspaceInfoHandler(db, workspaceId)
      expect(info.autoLoop).toBe(true)
      expect(info.autoLoopReady).toBe(true)
    })
  })

  describe('getSettingsHandler', () => {
    let settingsPath: string

    beforeEach(() => {
      settingsPath = path.join(tmpDir, 'settings.json')
    })

    it('retourne une shape par défaut si le fichier est absent (sans project_path)', () => {
      const result = getSettingsHandler(undefined) as { global: null; projects: unknown[]; error: string }
      expect(result.global).toBeNull()
      expect(result.projects).toEqual([])
      expect(result.error).toBeTruthy()
    })

    it('retourne une shape projet si le fichier est absent (avec project_path)', () => {
      const result = getSettingsHandler(undefined, '/some/path') as { global: null; project: null; error: string }
      expect(result.global).toBeNull()
      expect(result.project).toBeNull()
      expect(result.error).toBeTruthy()
    })

    it('lit le fichier de settings global', () => {
      fs.writeFileSync(
        settingsPath,
        JSON.stringify({
          global: { defaultModel: 'auto' },
          projects: [{ path: '/a', displayName: 'A' }],
        }),
      )
      const result = getSettingsHandler(settingsPath) as {
        global: { defaultModel: string }
        projects: unknown[]
      }
      expect(result.global.defaultModel).toBe('auto')
      expect(result.projects).toHaveLength(1)
    })

    it('filtre par project_path', () => {
      fs.writeFileSync(
        settingsPath,
        JSON.stringify({
          global: { defaultModel: 'auto' },
          projects: [
            { path: '/a', displayName: 'A' },
            { path: '/b', displayName: 'B' },
          ],
        }),
      )
      const result = getSettingsHandler(settingsPath, '/b') as {
        project: { displayName: string } | null
      }
      expect(result.project?.displayName).toBe('B')
    })

    it('retourne project: null si le projet nexiste pas', () => {
      fs.writeFileSync(settingsPath, JSON.stringify({ global: {}, projects: [] }))
      const result = getSettingsHandler(settingsPath, '/unknown') as { project: null }
      expect(result.project).toBeNull()
    })

    it('throw si JSON invalide', () => {
      fs.writeFileSync(settingsPath, '{invalid json')
      expect(() => getSettingsHandler(settingsPath)).toThrow(/Failed to read settings/)
    })
  })

  describe('listWorkspaceImagesHandler', () => {
    let worktreePath: string
    let imagesDir: string

    beforeEach(() => {
      worktreePath = path.join(tmpDir, 'worktree')
      imagesDir = path.join(worktreePath, '.ai', 'images')
      fs.mkdirSync(imagesDir, { recursive: true })
    })

    it('retourne un array vide si index.json absent', () => {
      expect(listWorkspaceImagesHandler(worktreePath)).toEqual([])
    })

    it('retourne un array vide si worktreePath nexiste pas', () => {
      expect(listWorkspaceImagesHandler('/nonexistent/path')).toEqual([])
    })

    it('retourne un array vide si JSON invalide', () => {
      fs.writeFileSync(path.join(imagesDir, 'index.json'), '{invalid')
      expect(listWorkspaceImagesHandler(worktreePath)).toEqual([])
    })

    it('liste les images avec leurs métadonnées', () => {
      const entries = [
        { uid: 'abc123', originalName: 'screenshot.png', createdAt: '2026-04-05T12:00:00Z' },
        { uid: 'def456', originalName: 'photo.jpg', createdAt: '2026-04-05T13:00:00Z' },
      ]
      fs.writeFileSync(path.join(imagesDir, 'index.json'), JSON.stringify(entries))
      fs.writeFileSync(path.join(imagesDir, 'abc123.png'), 'fake image data')
      fs.writeFileSync(path.join(imagesDir, 'def456.jpg'), 'fake image data')

      const result = listWorkspaceImagesHandler(worktreePath)
      expect(result).toHaveLength(2)
      expect(result[0].uid).toBe('abc123')
      expect(result[0].originalName).toBe('screenshot.png')
      expect(result[0].relativePath).toBe('.ai/images/abc123.png')
      expect(result[1].relativePath).toBe('.ai/images/def456.jpg')
    })

    it('retourne relativePath vide si le fichier est absent mais listé dans index', () => {
      const entries = [{ uid: 'orphan', originalName: 'x.png', createdAt: '2026-04-05T12:00:00Z' }]
      fs.writeFileSync(path.join(imagesDir, 'index.json'), JSON.stringify(entries))
      // Pas de fichier orphan.png
      const result = listWorkspaceImagesHandler(worktreePath)
      expect(result[0].relativePath).toBe('')
    })
  })

  describe('listDocumentsHandler', () => {
    let worktreePath: string

    beforeEach(() => {
      worktreePath = path.join(tmpDir, 'doc-wt')
      fs.mkdirSync(worktreePath, { recursive: true })
    })

    it('retourne un array vide quand aucun dossier de docs existe', () => {
      expect(listDocumentsHandler(worktreePath)).toEqual([])
    })

    it('liste les .md de docs/plans, docs/superpowers et .ai/thoughts (récursif)', () => {
      const plansDir = path.join(worktreePath, 'docs', 'plans')
      const superNested = path.join(worktreePath, 'docs', 'superpowers', 'plans', '2026-04')
      const thoughtsDir = path.join(worktreePath, '.ai', 'thoughts')
      fs.mkdirSync(plansDir, { recursive: true })
      fs.mkdirSync(superNested, { recursive: true })
      fs.mkdirSync(thoughtsDir, { recursive: true })
      fs.writeFileSync(path.join(plansDir, 'a.md'), '# A')
      fs.writeFileSync(path.join(superNested, 'b.md'), '# B')
      fs.writeFileSync(path.join(thoughtsDir, 'SENTRY-1.md'), '# S')
      fs.writeFileSync(path.join(plansDir, 'notes.txt'), 'ignore') // non-md ignoré

      const docs = listDocumentsHandler(worktreePath)
      expect(docs.map((d) => d.path).sort()).toEqual([
        '.ai/thoughts/SENTRY-1.md',
        'docs/plans/a.md',
        'docs/superpowers/plans/2026-04/b.md',
      ])
    })

    it('ignore les fichiers hors DOCUMENT_DIRS', () => {
      fs.mkdirSync(path.join(worktreePath, 'src'), { recursive: true })
      fs.writeFileSync(path.join(worktreePath, 'src', 'README.md'), '# NO')
      expect(listDocumentsHandler(worktreePath)).toEqual([])
    })
  })

  describe('readDocumentHandler', () => {
    let worktreePath: string

    beforeEach(() => {
      worktreePath = path.join(tmpDir, 'doc-wt-read')
      fs.mkdirSync(path.join(worktreePath, 'docs', 'plans'), { recursive: true })
      fs.writeFileSync(path.join(worktreePath, 'docs', 'plans', 'x.md'), '# X\n\nhello')
    })

    it('retourne le contenu pour un path valide', () => {
      const res = readDocumentHandler(worktreePath, 'docs/plans/x.md')
      expect(res.path).toBe('docs/plans/x.md')
      expect(res.content).toBe('# X\n\nhello')
    })

    it('rejette les path traversal', () => {
      expect(() => readDocumentHandler(worktreePath, 'docs/plans/../../etc/passwd')).toThrow(/Invalid path/)
    })

    it('rejette les path hors DOCUMENT_DIRS', () => {
      expect(() => readDocumentHandler(worktreePath, 'src/server/index.ts')).toThrow(/Invalid path/)
    })

    it('rejette les non-.md', () => {
      fs.writeFileSync(path.join(worktreePath, 'docs', 'plans', 'foo.txt'), 'nope')
      expect(() => readDocumentHandler(worktreePath, 'docs/plans/foo.txt')).toThrow(/Only \.md/)
    })

    it('throw si le fichier est absent', () => {
      expect(() => readDocumentHandler(worktreePath, 'docs/plans/ghost.md')).toThrow(/not found/)
    })
  })

  describe('logThoughtHandler', () => {
    let worktreePath: string

    beforeEach(() => {
      worktreePath = path.join(tmpDir, 'log-wt')
      fs.mkdirSync(worktreePath, { recursive: true })
    })

    it('crée un fichier dans .ai/thoughts/ avec un slug depuis le titre', () => {
      const res = logThoughtHandler(worktreePath, { title: 'Decision: use pinia', content: 'Reason is X.' })
      expect(res.path).toMatch(/^\.ai\/thoughts\/\d{4}-\d{2}-\d{2}-decision-use-pinia\.md$/)
      const absolutePath = path.join(worktreePath, res.path)
      expect(fs.existsSync(absolutePath)).toBe(true)
      const content = fs.readFileSync(absolutePath, 'utf-8')
      expect(content).toContain('# Decision: use pinia')
      expect(content).toContain('Reason is X.')
    })

    it('ajoute le tag en suffixe quand fourni', () => {
      const res = logThoughtHandler(worktreePath, { title: 'Note', content: 'body', tag: 'arch' })
      expect(res.path).toMatch(/-note-arch\.md$/)
    })

    it('throw si title ou content manquent', () => {
      expect(() => logThoughtHandler(worktreePath, { title: '', content: 'x' })).toThrow(/title/)
      expect(() => logThoughtHandler(worktreePath, { title: 'y', content: '' })).toThrow(/content/)
    })
  })

  describe('getSessionUsageHandler', () => {
    it('retourne 0 quand il n’y a aucun event usage', () => {
      const res = getSessionUsageHandler(db, workspaceId)
      expect(res.workspaceTotals).toEqual({ inputTokens: 0, outputTokens: 0, costUsd: 0 })
      expect(res.currentSession.sessionId).toBeNull()
    })

    it('agrège les usage events et scope la session courante sur la session running', () => {
      const now = new Date().toISOString()
      db.prepare(
        "INSERT INTO agent_sessions (id, workspace_id, status, started_at) VALUES ('sess-running', ?, 'running', ?)",
      ).run(workspaceId, now)
      db.prepare(
        "INSERT INTO agent_sessions (id, workspace_id, status, started_at, ended_at) VALUES ('sess-old', ?, 'completed', ?, ?)",
      ).run(workspaceId, now, now)

      const insert = db.prepare(
        "INSERT INTO ws_events (id, workspace_id, type, payload, session_id, created_at) VALUES (?, ?, 'agent:event', ?, ?, ?)",
      )
      insert.run(
        'e1',
        workspaceId,
        JSON.stringify({ kind: 'usage', inputTokens: 100, outputTokens: 50, costUsd: 0.01 }),
        'sess-old',
        now,
      )
      insert.run(
        'e2',
        workspaceId,
        JSON.stringify({ kind: 'usage', inputTokens: 200, outputTokens: 75, costUsd: 0.02 }),
        'sess-running',
        now,
      )
      // Non-usage event — doit être ignoré
      insert.run(
        'e3',
        workspaceId,
        JSON.stringify({ kind: 'message:text', text: 'x', streaming: false, messageId: 'm' }),
        'sess-running',
        now,
      )

      const res = getSessionUsageHandler(db, workspaceId)
      expect(res.workspaceTotals).toEqual({ inputTokens: 300, outputTokens: 125, costUsd: 0.03 })
      expect(res.currentSession).toEqual({
        sessionId: 'sess-running',
        inputTokens: 200,
        outputTokens: 75,
        costUsd: 0.02,
      })
    })
  })
})
