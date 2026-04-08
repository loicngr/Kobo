import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initSchema } from '../server/db/schema.js'

// We use a fresh in-memory DB for each test by resetting the singleton
let tmpDir: string
let dbPath: string

async function resetDb() {
  const { closeDb } = await import('../server/db/index.js')
  closeDb()
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'at-ws-svc-test-'))
  dbPath = path.join(tmpDir, 'test.db')

  // Pre-create and migrate the DB before the singleton picks it up
  const db = new Database(dbPath)
  db.pragma('journal_mode=WAL')
  db.pragma('foreign_keys=ON')
  initSchema(db)
  db.close()
}

beforeEach(async () => {
  await resetDb()
  // Now import getDb with our pre-created path
  const { getDb } = await import('../server/db/index.js')
  getDb(dbPath)
})

afterEach(async () => {
  const { closeDb } = await import('../server/db/index.js')
  closeDb()
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

describe('createWorkspace()', () => {
  it('crée un workspace et retourne un objet avec les bons champs', async () => {
    const { createWorkspace } = await import('../server/services/workspace-service.js')
    const ws = createWorkspace({
      name: 'Mon projet',
      projectPath: '/tmp/projet',
      sourceBranch: 'main',
      workingBranch: 'feature/test',
    })

    expect(ws.id).toBeTruthy()
    expect(ws.name).toBe('Mon projet')
    expect(ws.projectPath).toBe('/tmp/projet')
    expect(ws.sourceBranch).toBe('main')
    expect(ws.workingBranch).toBe('feature/test')
    expect(ws.status).toBe('created')
    expect(ws.notionUrl).toBeNull()
    expect(ws.notionPageId).toBeNull()
    expect(ws.model).toBe('claude-opus-4-6')
    expect(ws.createdAt).toBeTruthy()
    expect(ws.updatedAt).toBeTruthy()
  })

  it('utilise les valeurs par défaut pour model', async () => {
    const { createWorkspace } = await import('../server/services/workspace-service.js')
    const ws = createWorkspace({
      name: 'Test',
      projectPath: '/tmp/x',
      sourceBranch: 'main',
      workingBranch: 'feat/x',
    })
    expect(ws.model).toBe('claude-opus-4-6')
  })

  it('accepte les champs optionnels notionUrl, notionPageId, model', async () => {
    const { createWorkspace } = await import('../server/services/workspace-service.js')
    const ws = createWorkspace({
      name: 'Notion WS',
      projectPath: '/tmp/n',
      sourceBranch: 'main',
      workingBranch: 'feat/notion',
      notionUrl: 'https://www.notion.so/page-abc',
      notionPageId: 'abc123',
      model: 'claude-sonnet-4-6',
    })
    expect(ws.notionUrl).toBe('https://www.notion.so/page-abc')
    expect(ws.notionPageId).toBe('abc123')
    expect(ws.model).toBe('claude-sonnet-4-6')
  })

  it('génère un ID unique pour chaque workspace', async () => {
    const { createWorkspace } = await import('../server/services/workspace-service.js')
    const ws1 = createWorkspace({ name: 'A', projectPath: '/a', sourceBranch: 'main', workingBranch: 'f1' })
    const ws2 = createWorkspace({ name: 'B', projectPath: '/b', sourceBranch: 'main', workingBranch: 'f2' })
    expect(ws1.id).not.toBe(ws2.id)
  })
})

describe('getWorkspace(id)', () => {
  it('retourne le workspace si trouvé', async () => {
    const { createWorkspace, getWorkspace } = await import('../server/services/workspace-service.js')
    const created = createWorkspace({ name: 'Get me', projectPath: '/p', sourceBranch: 'main', workingBranch: 'b' })
    const found = getWorkspace(created.id)
    expect(found).not.toBeNull()
    expect(found?.id).toBe(created.id)
    expect(found?.name).toBe('Get me')
  })

  it("retourne null si le workspace n'existe pas", async () => {
    const { getWorkspace } = await import('../server/services/workspace-service.js')
    const result = getWorkspace('non-existent-id')
    expect(result).toBeNull()
  })
})

describe('listWorkspaces()', () => {
  it('retourne tous les workspaces ordonnés par updated_at DESC', async () => {
    const { createWorkspace, listWorkspaces } = await import('../server/services/workspace-service.js')
    createWorkspace({ name: 'Premier', projectPath: '/a', sourceBranch: 'main', workingBranch: 'b1' })
    createWorkspace({ name: 'Deuxième', projectPath: '/b', sourceBranch: 'main', workingBranch: 'b2' })

    const workspaces = listWorkspaces()
    expect(workspaces.length).toBeGreaterThanOrEqual(2)
    // Tous les workspaces sont des objets valides
    workspaces.forEach((ws) => {
      expect(ws.id).toBeTruthy()
      expect(ws.name).toBeTruthy()
    })
  })

  it('retourne un tableau vide si aucun workspace', async () => {
    const { listWorkspaces } = await import('../server/services/workspace-service.js')
    const workspaces = listWorkspaces()
    expect(workspaces).toEqual([])
  })
})

describe('updateWorkspaceStatus(id, status)', () => {
  it('met à jour le status et updated_at', async () => {
    const { createWorkspace, updateWorkspaceStatus } = await import('../server/services/workspace-service.js')
    const ws = createWorkspace({ name: 'Update', projectPath: '/p', sourceBranch: 'main', workingBranch: 'b' })
    const updatedAt = ws.updatedAt

    // Petite pause pour garantir un timestamp différent
    await new Promise((r) => setTimeout(r, 10))

    const updated = updateWorkspaceStatus(ws.id, 'extracting')
    expect(updated.status).toBe('extracting')
    expect(updated.updatedAt >= updatedAt).toBe(true)
  })

  it('autorise la self-transition extracting → extracting', async () => {
    const { createWorkspace, updateWorkspaceStatus } = await import('../server/services/workspace-service.js')
    const ws = createWorkspace({ name: 'Self-transition', projectPath: '/p', sourceBranch: 'main', workingBranch: 'b' })
    updateWorkspaceStatus(ws.id, 'extracting')
    const updated = updateWorkspaceStatus(ws.id, 'extracting')
    expect(updated.status).toBe('extracting')
  })

  it('lève une erreur sur une transition invalide', async () => {
    const { createWorkspace, updateWorkspaceStatus } = await import('../server/services/workspace-service.js')
    const ws = createWorkspace({ name: 'Bad transition', projectPath: '/p', sourceBranch: 'main', workingBranch: 'b' })
    // created → completed is not a valid transition
    expect(() => updateWorkspaceStatus(ws.id, 'completed')).toThrow(/Invalid status transition/)
  })

  it("lève une erreur si le workspace n'existe pas", async () => {
    const { updateWorkspaceStatus } = await import('../server/services/workspace-service.js')
    expect(() => updateWorkspaceStatus('ghost-id', 'idle')).toThrow(/not found/)
  })
})

describe('deleteWorkspace(id)', () => {
  it('supprime le workspace', async () => {
    const { createWorkspace, deleteWorkspace, getWorkspace } = await import('../server/services/workspace-service.js')
    const ws = createWorkspace({ name: 'Delete me', projectPath: '/p', sourceBranch: 'main', workingBranch: 'b' })
    deleteWorkspace(ws.id)
    expect(getWorkspace(ws.id)).toBeNull()
  })

  it("ne lève pas d'erreur si le workspace n'existe pas", async () => {
    const { deleteWorkspace } = await import('../server/services/workspace-service.js')
    expect(() => deleteWorkspace('non-existent')).not.toThrow()
  })
})

describe('createTask(workspaceId, data)', () => {
  it("lève une erreur si le workspace n'existe pas", async () => {
    const { createTask } = await import('../server/services/workspace-service.js')
    expect(() => createTask('non-existent-ws-id', { title: 'Orphan task' })).toThrow(/Workspace not found/)
  })

  it('crée une tâche dans le workspace', async () => {
    const { createWorkspace, createTask } = await import('../server/services/workspace-service.js')
    const ws = createWorkspace({ name: 'WS', projectPath: '/p', sourceBranch: 'main', workingBranch: 'b' })
    const task = createTask(ws.id, { title: 'Ma tâche' })

    expect(task.id).toBeTruthy()
    expect(task.workspaceId).toBe(ws.id)
    expect(task.title).toBe('Ma tâche')
    expect(task.status).toBe('pending')
    expect(task.isAcceptanceCriterion).toBe(false)
    expect(task.sortOrder).toBe(0)
  })

  it('accepte isAcceptanceCriterion et sortOrder', async () => {
    const { createWorkspace, createTask } = await import('../server/services/workspace-service.js')
    const ws = createWorkspace({ name: 'WS', projectPath: '/p', sourceBranch: 'main', workingBranch: 'b' })
    const task = createTask(ws.id, { title: 'AC', isAcceptanceCriterion: true, sortOrder: 5 })

    expect(task.isAcceptanceCriterion).toBe(true)
    expect(task.sortOrder).toBe(5)
  })
})

describe('listTasks(workspaceId)', () => {
  it('retourne les tâches ordonnées par sort_order', async () => {
    const { createWorkspace, createTask, listTasks } = await import('../server/services/workspace-service.js')
    const ws = createWorkspace({ name: 'WS', projectPath: '/p', sourceBranch: 'main', workingBranch: 'b' })
    createTask(ws.id, { title: 'Tâche C', sortOrder: 3 })
    createTask(ws.id, { title: 'Tâche A', sortOrder: 1 })
    createTask(ws.id, { title: 'Tâche B', sortOrder: 2 })

    const tasks = listTasks(ws.id)
    expect(tasks.length).toBe(3)
    expect(tasks[0].title).toBe('Tâche A')
    expect(tasks[1].title).toBe('Tâche B')
    expect(tasks[2].title).toBe('Tâche C')
  })

  it('retourne un tableau vide si aucune tâche', async () => {
    const { createWorkspace, listTasks } = await import('../server/services/workspace-service.js')
    const ws = createWorkspace({ name: 'WS', projectPath: '/p', sourceBranch: 'main', workingBranch: 'b' })
    expect(listTasks(ws.id)).toEqual([])
  })
})

describe('updateTaskStatus(taskId, status)', () => {
  it('met à jour le status de la tâche', async () => {
    const { createWorkspace, createTask, updateTaskStatus } = await import('../server/services/workspace-service.js')
    const ws = createWorkspace({ name: 'WS', projectPath: '/p', sourceBranch: 'main', workingBranch: 'b' })
    const task = createTask(ws.id, { title: 'Task' })

    const updated = updateTaskStatus(task.id, 'in_progress')
    expect(updated.status).toBe('in_progress')
  })

  it("lève une erreur si la tâche n'existe pas", async () => {
    const { updateTaskStatus } = await import('../server/services/workspace-service.js')
    expect(() => updateTaskStatus('ghost-task-id', 'done')).toThrow(/not found/)
  })
})

describe('updateTaskTitle(taskId, title)', () => {
  it("met à jour le titre d'une task", async () => {
    const { createWorkspace, createTask, updateTaskTitle, listTasks } = await import(
      '../server/services/workspace-service.js'
    )
    const ws = createWorkspace({ name: 'WS', projectPath: '/p', sourceBranch: 'main', workingBranch: 'b' })
    const task = createTask(ws.id, { title: 'Original', isAcceptanceCriterion: false })
    const updated = updateTaskTitle(task.id, 'Updated title')
    expect(updated.title).toBe('Updated title')
    expect(updated.id).toBe(task.id)
    const fetched = listTasks(ws.id)[0]
    expect(fetched.title).toBe('Updated title')
  })

  it("lève une erreur si la task n'existe pas pour updateTaskTitle", async () => {
    const { updateTaskTitle } = await import('../server/services/workspace-service.js')
    expect(() => updateTaskTitle('nonexistent', 'New')).toThrow(/not found/)
  })

  it('lève une erreur si le title est vide', async () => {
    const { createWorkspace, createTask, updateTaskTitle } = await import('../server/services/workspace-service.js')
    const ws = createWorkspace({ name: 'WS', projectPath: '/p', sourceBranch: 'main', workingBranch: 'b' })
    const task = createTask(ws.id, { title: 'Test', isAcceptanceCriterion: false })
    expect(() => updateTaskTitle(task.id, '')).toThrow(/empty/)
    expect(() => updateTaskTitle(task.id, '   ')).toThrow(/empty/)
  })
})

describe('deleteTask(taskId)', () => {
  it('supprime une task', async () => {
    const { createWorkspace, createTask, deleteTask, listTasks } = await import(
      '../server/services/workspace-service.js'
    )
    const ws = createWorkspace({ name: 'WS', projectPath: '/p', sourceBranch: 'main', workingBranch: 'b' })
    const task = createTask(ws.id, { title: 'To delete', isAcceptanceCriterion: false })
    deleteTask(task.id)
    expect(listTasks(ws.id)).toHaveLength(0)
  })

  it("ne lève pas d'erreur si la task à supprimer n'existe pas", async () => {
    const { deleteTask } = await import('../server/services/workspace-service.js')
    expect(() => deleteTask('nonexistent')).not.toThrow()
  })
})

describe('listSessions(workspaceId)', () => {
  it('retourne un tableau vide si aucune session', async () => {
    const { createWorkspace, listSessions } = await import('../server/services/workspace-service.js')
    const ws = createWorkspace({ name: 'WS', projectPath: '/p', sourceBranch: 'main', workingBranch: 'b' })
    expect(listSessions(ws.id)).toEqual([])
  })

  it('retourne les sessions ordonnees par started_at DESC', async () => {
    const { createWorkspace, listSessions } = await import('../server/services/workspace-service.js')
    const { getDb } = await import('../server/db/index.js')
    const ws = createWorkspace({ name: 'WS', projectPath: '/p', sourceBranch: 'main', workingBranch: 'b' })

    const db = getDb()
    db.prepare('INSERT INTO agent_sessions (id, workspace_id, pid, status, started_at) VALUES (?, ?, ?, ?, ?)').run(
      's1',
      ws.id,
      123,
      'completed',
      '2024-01-01T00:00:00Z',
    )
    db.prepare('INSERT INTO agent_sessions (id, workspace_id, pid, status, started_at) VALUES (?, ?, ?, ?, ?)').run(
      's2',
      ws.id,
      456,
      'running',
      '2024-01-02T00:00:00Z',
    )

    const sessions = listSessions(ws.id)
    expect(sessions.length).toBe(2)
    expect(sessions[0].id).toBe('s2')
    expect(sessions[1].id).toBe('s1')
    expect(sessions[0].workspaceId).toBe(ws.id)
    expect(sessions[0].pid).toBe(456)
    expect(sessions[0].status).toBe('running')
  })
})

describe('getLatestSession(workspaceId)', () => {
  it('retourne null si aucune session', async () => {
    const { createWorkspace, getLatestSession } = await import('../server/services/workspace-service.js')
    const ws = createWorkspace({ name: 'WS', projectPath: '/p', sourceBranch: 'main', workingBranch: 'b' })
    expect(getLatestSession(ws.id)).toBeNull()
  })

  it('retourne la session la plus recente', async () => {
    const { createWorkspace, getLatestSession } = await import('../server/services/workspace-service.js')
    const { getDb } = await import('../server/db/index.js')
    const ws = createWorkspace({ name: 'WS', projectPath: '/p', sourceBranch: 'main', workingBranch: 'b' })

    const db = getDb()
    db.prepare(
      'INSERT INTO agent_sessions (id, workspace_id, pid, claude_session_id, status, started_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('s1', ws.id, 123, 'claude-abc', 'completed', '2024-01-01T00:00:00Z')
    db.prepare(
      'INSERT INTO agent_sessions (id, workspace_id, pid, claude_session_id, status, started_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('s2', ws.id, 456, 'claude-def', 'running', '2024-01-02T00:00:00Z')

    const latest = getLatestSession(ws.id)
    expect(latest).not.toBeNull()
    expect(latest?.id).toBe('s2')
    expect(latest?.claudeSessionId).toBe('claude-def')
  })
})

describe('getWorkspaceWithTasks(id)', () => {
  it('retourne le workspace avec ses tâches', async () => {
    const { createWorkspace, createTask, getWorkspaceWithTasks } = await import(
      '../server/services/workspace-service.js'
    )
    const ws = createWorkspace({ name: 'WS', projectPath: '/p', sourceBranch: 'main', workingBranch: 'b' })
    createTask(ws.id, { title: 'T1' })
    createTask(ws.id, { title: 'T2' })

    const result = getWorkspaceWithTasks(ws.id)
    expect(result).not.toBeNull()
    expect(result?.id).toBe(ws.id)
    expect(result?.tasks.length).toBe(2)
  })

  it("retourne null si le workspace n'existe pas", async () => {
    const { getWorkspaceWithTasks } = await import('../server/services/workspace-service.js')
    expect(getWorkspaceWithTasks('ghost')).toBeNull()
  })

  it('les tâches du workspace sont supprimées en cascade', async () => {
    const { createWorkspace, createTask, deleteWorkspace, listTasks } = await import(
      '../server/services/workspace-service.js'
    )
    const ws = createWorkspace({ name: 'WS', projectPath: '/p', sourceBranch: 'main', workingBranch: 'b' })
    createTask(ws.id, { title: 'T1' })
    deleteWorkspace(ws.id)
    // Après suppression, les tâches orphelines ne doivent plus exister
    expect(listTasks(ws.id)).toEqual([])
  })
})

// ── I6: updateWorkspaceName / updateWorkspaceModel / updateWorkspacePermissionMode throw on missing workspace ──

describe('updateWorkspaceName() throws when workspace not found', () => {
  it("lève une erreur si le workspace n'existe pas", async () => {
    const { updateWorkspaceName } = await import('../server/services/workspace-service.js')
    expect(() => updateWorkspaceName('nonexistent', 'New Name')).toThrow(/not found/)
  })
})

describe('updateWorkspaceModel() throws when workspace not found', () => {
  it("lève une erreur si le workspace n'existe pas", async () => {
    const { updateWorkspaceModel } = await import('../server/services/workspace-service.js')
    expect(() => updateWorkspaceModel('nonexistent', 'claude-sonnet-4-20250514')).toThrow(/not found/)
  })
})

describe('updateWorkspacePermissionMode() throws when workspace not found', () => {
  it("lève une erreur si le workspace n'existe pas", async () => {
    const { updateWorkspacePermissionMode } = await import('../server/services/workspace-service.js')
    expect(() => updateWorkspacePermissionMode('nonexistent', 'plan')).toThrow(/not found/)
  })
})

// ── Gap 8: toutes les transitions de status valides ───────────────────────────

describe('updateWorkspaceStatus() — transitions clés non couvertes', () => {
  it('executing → quota', async () => {
    const { createWorkspace, updateWorkspaceStatus } = await import('../server/services/workspace-service.js')
    const ws = createWorkspace({ name: 'T1', projectPath: '/p', sourceBranch: 'main', workingBranch: 'b' })
    // created → idle → executing → quota
    updateWorkspaceStatus(ws.id, 'idle')
    updateWorkspaceStatus(ws.id, 'executing')
    const updated = updateWorkspaceStatus(ws.id, 'quota')
    expect(updated.status).toBe('quota')
  })

  it('quota → executing', async () => {
    const { createWorkspace, updateWorkspaceStatus } = await import('../server/services/workspace-service.js')
    const ws = createWorkspace({ name: 'T2', projectPath: '/p', sourceBranch: 'main', workingBranch: 'b' })
    // created → idle → executing → quota → executing
    updateWorkspaceStatus(ws.id, 'idle')
    updateWorkspaceStatus(ws.id, 'executing')
    updateWorkspaceStatus(ws.id, 'quota')
    const updated = updateWorkspaceStatus(ws.id, 'executing')
    expect(updated.status).toBe('executing')
  })

  it('error → idle', async () => {
    const { createWorkspace, updateWorkspaceStatus } = await import('../server/services/workspace-service.js')
    const ws = createWorkspace({ name: 'T3', projectPath: '/p', sourceBranch: 'main', workingBranch: 'b' })
    // created → error → idle
    updateWorkspaceStatus(ws.id, 'error')
    const updated = updateWorkspaceStatus(ws.id, 'idle')
    expect(updated.status).toBe('idle')
  })

  it('brainstorming → completed', async () => {
    const { createWorkspace, updateWorkspaceStatus } = await import('../server/services/workspace-service.js')
    const ws = createWorkspace({ name: 'T4', projectPath: '/p', sourceBranch: 'main', workingBranch: 'b' })
    // created → brainstorming → completed
    updateWorkspaceStatus(ws.id, 'brainstorming')
    const updated = updateWorkspaceStatus(ws.id, 'completed')
    expect(updated.status).toBe('completed')
  })
})

describe('archiveWorkspace()', () => {
  it('sets archivedAt on an active workspace', async () => {
    const { createWorkspace, archiveWorkspace } = await import('../server/services/workspace-service.js')
    const ws = createWorkspace({
      name: 'To archive',
      projectPath: '/tmp/a',
      sourceBranch: 'main',
      workingBranch: 'feat/a',
    })
    expect(ws.archivedAt).toBeNull()

    const archived = archiveWorkspace(ws.id)
    expect(archived.archivedAt).toBeTruthy()
    expect(typeof archived.archivedAt).toBe('string')
    expect(new Date(archived.archivedAt!).toString()).not.toBe('Invalid Date')
  })

  it('preserves status when archiving', async () => {
    const { createWorkspace, updateWorkspaceStatus, archiveWorkspace } = await import(
      '../server/services/workspace-service.js'
    )
    const ws = createWorkspace({
      name: 'Keeps status',
      projectPath: '/tmp/b',
      sourceBranch: 'main',
      workingBranch: 'feat/b',
    })
    updateWorkspaceStatus(ws.id, 'idle')
    const archived = archiveWorkspace(ws.id)
    expect(archived.status).toBe('idle')
  })

  it('throws when workspace not found', async () => {
    const { archiveWorkspace } = await import('../server/services/workspace-service.js')
    expect(() => archiveWorkspace('nope')).toThrow(/not found/)
  })

  it('throws when already archived', async () => {
    const { createWorkspace, archiveWorkspace } = await import('../server/services/workspace-service.js')
    const ws = createWorkspace({
      name: 'Twice',
      projectPath: '/tmp/c',
      sourceBranch: 'main',
      workingBranch: 'feat/c',
    })
    archiveWorkspace(ws.id)
    expect(() => archiveWorkspace(ws.id)).toThrow(/already archived/)
  })
})

describe('unarchiveWorkspace()', () => {
  it('clears archivedAt and preserves status', async () => {
    const { createWorkspace, updateWorkspaceStatus, archiveWorkspace, unarchiveWorkspace } = await import(
      '../server/services/workspace-service.js'
    )
    const ws = createWorkspace({
      name: 'Restore me',
      projectPath: '/tmp/r',
      sourceBranch: 'main',
      workingBranch: 'feat/r',
    })
    updateWorkspaceStatus(ws.id, 'idle')
    archiveWorkspace(ws.id)
    const restored = unarchiveWorkspace(ws.id)
    expect(restored.archivedAt).toBeNull()
    expect(restored.status).toBe('idle')
  })

  it('throws when workspace not found', async () => {
    const { unarchiveWorkspace } = await import('../server/services/workspace-service.js')
    expect(() => unarchiveWorkspace('nope')).toThrow(/not found/)
  })

  it('throws when not archived', async () => {
    const { createWorkspace, unarchiveWorkspace } = await import('../server/services/workspace-service.js')
    const ws = createWorkspace({
      name: 'Active',
      projectPath: '/tmp/x',
      sourceBranch: 'main',
      workingBranch: 'feat/x',
    })
    expect(() => unarchiveWorkspace(ws.id)).toThrow(/not archived/)
  })
})

describe('listWorkspaces() and listArchivedWorkspaces()', () => {
  it('listWorkspaces() defaults to excluding archived', async () => {
    const { createWorkspace, archiveWorkspace, listWorkspaces } = await import(
      '../server/services/workspace-service.js'
    )
    const active = createWorkspace({
      name: 'Active',
      projectPath: '/tmp/a1',
      sourceBranch: 'main',
      workingBranch: 'feat/a1',
    })
    const toArchive = createWorkspace({
      name: 'Archived',
      projectPath: '/tmp/a2',
      sourceBranch: 'main',
      workingBranch: 'feat/a2',
    })
    archiveWorkspace(toArchive.id)

    const list = listWorkspaces()
    expect(list.map((w) => w.id)).toContain(active.id)
    expect(list.map((w) => w.id)).not.toContain(toArchive.id)
  })

  it('listWorkspaces(true) includes archived', async () => {
    const { createWorkspace, archiveWorkspace, listWorkspaces } = await import(
      '../server/services/workspace-service.js'
    )
    const toArchive = createWorkspace({
      name: 'Archived',
      projectPath: '/tmp/a3',
      sourceBranch: 'main',
      workingBranch: 'feat/a3',
    })
    archiveWorkspace(toArchive.id)
    const list = listWorkspaces(true)
    expect(list.map((w) => w.id)).toContain(toArchive.id)
  })

  it('listArchivedWorkspaces() returns only archived, sorted by archived_at DESC', async () => {
    const { createWorkspace, archiveWorkspace, listArchivedWorkspaces } = await import(
      '../server/services/workspace-service.js'
    )
    const first = createWorkspace({
      name: 'First archived',
      projectPath: '/tmp/la1',
      sourceBranch: 'main',
      workingBranch: 'feat/la1',
    })
    archiveWorkspace(first.id)
    await new Promise((r) => setTimeout(r, 10))
    const second = createWorkspace({
      name: 'Second archived',
      projectPath: '/tmp/la2',
      sourceBranch: 'main',
      workingBranch: 'feat/la2',
    })
    archiveWorkspace(second.id)
    const active = createWorkspace({
      name: 'Still active',
      projectPath: '/tmp/la3',
      sourceBranch: 'main',
      workingBranch: 'feat/la3',
    })

    const archived = listArchivedWorkspaces()
    expect(archived.map((w) => w.id)).toEqual([second.id, first.id])
    expect(archived.map((w) => w.id)).not.toContain(active.id)
  })

  it('getWorkspace() still returns archived workspaces', async () => {
    const { createWorkspace, archiveWorkspace, getWorkspace } = await import('../server/services/workspace-service.js')
    const ws = createWorkspace({
      name: 'Hidden but gettable',
      projectPath: '/tmp/hg',
      sourceBranch: 'main',
      workingBranch: 'feat/hg',
    })
    archiveWorkspace(ws.id)
    const found = getWorkspace(ws.id)
    expect(found).not.toBeNull()
    expect(found?.archivedAt).toBeTruthy()
  })
})

describe('markWorkspaceRead() / markWorkspaceUnread()', () => {
  it('new workspace has hasUnread = false by default', async () => {
    const { createWorkspace } = await import('../server/services/workspace-service.js')
    const ws = createWorkspace({
      name: 'Unread test',
      projectPath: '/tmp/ur',
      sourceBranch: 'main',
      workingBranch: 'feat/ur',
    })
    expect(ws.hasUnread).toBe(false)
  })

  it('markWorkspaceUnread sets has_unread to 1', async () => {
    const { createWorkspace, getWorkspace, markWorkspaceUnread } = await import(
      '../server/services/workspace-service.js'
    )
    const ws = createWorkspace({
      name: 'Mark unread',
      projectPath: '/tmp/mu',
      sourceBranch: 'main',
      workingBranch: 'feat/mu',
    })
    markWorkspaceUnread(ws.id)
    const found = getWorkspace(ws.id)
    expect(found?.hasUnread).toBe(true)
  })

  it('markWorkspaceRead sets has_unread to 0', async () => {
    const { createWorkspace, getWorkspace, markWorkspaceUnread, markWorkspaceRead } = await import(
      '../server/services/workspace-service.js'
    )
    const ws = createWorkspace({
      name: 'Mark read',
      projectPath: '/tmp/mr',
      sourceBranch: 'main',
      workingBranch: 'feat/mr',
    })
    markWorkspaceUnread(ws.id)
    markWorkspaceRead(ws.id)
    const found = getWorkspace(ws.id)
    expect(found?.hasUnread).toBe(false)
  })
})
