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
    expect(ws.model).toBe('claude-opus-4-7')
    expect(ws.reasoningEffort).toBe('auto')
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
    expect(ws.model).toBe('claude-opus-4-7')
    expect(ws.reasoningEffort).toBe('auto')
  })

  it('accepte les champs optionnels notionUrl, notionPageId, model, reasoningEffort', async () => {
    const { createWorkspace } = await import('../server/services/workspace-service.js')
    const ws = createWorkspace({
      name: 'Notion WS',
      projectPath: '/tmp/n',
      sourceBranch: 'main',
      workingBranch: 'feat/notion',
      notionUrl: 'https://www.notion.so/page-abc',
      notionPageId: 'abc123',
      model: 'claude-sonnet-4-6',
      reasoningEffort: 'high',
    })
    expect(ws.notionUrl).toBe('https://www.notion.so/page-abc')
    expect(ws.notionPageId).toBe('abc123')
    expect(ws.model).toBe('claude-sonnet-4-6')
    expect(ws.reasoningEffort).toBe('high')
  })

  it('génère un ID unique pour chaque workspace', async () => {
    const { createWorkspace } = await import('../server/services/workspace-service.js')
    const ws1 = createWorkspace({ name: 'A', projectPath: '/a', sourceBranch: 'main', workingBranch: 'f1' })
    const ws2 = createWorkspace({ name: 'B', projectPath: '/b', sourceBranch: 'main', workingBranch: 'f2' })
    expect(ws1.id).not.toBe(ws2.id)
  })

  it('persists sentryUrl and returns it on read', async () => {
    const { createWorkspace, getWorkspace } = await import('../server/services/workspace-service.js')
    const ws = createWorkspace({
      name: 'with-sentry',
      projectPath: '/tmp/proj',
      sourceBranch: 'main',
      workingBranch: 'feat/x',
      sentryUrl: 'https://my-org.sentry.io/issues/12345/',
    })
    expect(ws.sentryUrl).toBe('https://my-org.sentry.io/issues/12345/')

    const fetched = getWorkspace(ws.id)
    expect(fetched?.sentryUrl).toBe('https://my-org.sentry.io/issues/12345/')
  })

  it('defaults sentryUrl to null when not provided', async () => {
    const { createWorkspace } = await import('../server/services/workspace-service.js')
    const ws = createWorkspace({
      name: 'no-sentry',
      projectPath: '/tmp/proj',
      sourceBranch: 'main',
      workingBranch: 'feat/y',
    })
    expect(ws.sentryUrl).toBeNull()
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
      'INSERT INTO agent_sessions (id, workspace_id, pid, engine_session_id, status, started_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('s1', ws.id, 123, 'claude-abc', 'completed', '2024-01-01T00:00:00Z')
    db.prepare(
      'INSERT INTO agent_sessions (id, workspace_id, pid, engine_session_id, status, started_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('s2', ws.id, 456, 'claude-def', 'running', '2024-01-02T00:00:00Z')

    const latest = getLatestSession(ws.id)
    expect(latest).not.toBeNull()
    expect(latest?.id).toBe('s2')
    expect(latest?.engineSessionId).toBe('claude-def')
  })
})

describe('getActiveSession(workspaceId)', () => {
  it('retourne null si aucune session', async () => {
    const { createWorkspace, getActiveSession } = await import('../server/services/workspace-service.js')
    const ws = createWorkspace({ name: 'WS', projectPath: '/p', sourceBranch: 'main', workingBranch: 'b' })
    expect(getActiveSession(ws.id)).toBeNull()
  })

  it('ignore les sessions idle meme si elles sont plus recentes', async () => {
    const { createWorkspace, getActiveSession } = await import('../server/services/workspace-service.js')
    const { getDb } = await import('../server/db/index.js')
    const ws = createWorkspace({ name: 'WS', projectPath: '/p', sourceBranch: 'main', workingBranch: 'b' })

    const db = getDb()
    // Completed session at T0
    db.prepare(
      'INSERT INTO agent_sessions (id, workspace_id, pid, engine_session_id, status, started_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('s-completed', ws.id, 100, 'claude-A', 'completed', '2024-01-01T00:00:00Z')
    // Idle session at T1 (more recent than the completed one)
    db.prepare(
      'INSERT INTO agent_sessions (id, workspace_id, pid, engine_session_id, status, started_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('s-idle', ws.id, null, null, 'idle', '2024-01-02T00:00:00Z')

    const active = getActiveSession(ws.id)
    expect(active?.id).toBe('s-completed')
  })

  it('privilegie la session running sur les completed plus recentes', async () => {
    const { createWorkspace, getActiveSession } = await import('../server/services/workspace-service.js')
    const { getDb } = await import('../server/db/index.js')
    const ws = createWorkspace({ name: 'WS', projectPath: '/p', sourceBranch: 'main', workingBranch: 'b' })

    const db = getDb()
    db.prepare(
      'INSERT INTO agent_sessions (id, workspace_id, pid, engine_session_id, status, started_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('s-running', ws.id, 100, 'claude-R', 'running', '2024-01-01T00:00:00Z')
    db.prepare(
      'INSERT INTO agent_sessions (id, workspace_id, pid, engine_session_id, status, started_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('s-completed', ws.id, 200, 'claude-C', 'completed', '2024-01-02T00:00:00Z')

    const active = getActiveSession(ws.id)
    expect(active?.id).toBe('s-running')
  })

  it('retourne null si toutes les sessions sont idle', async () => {
    const { createWorkspace, createIdleSession, getActiveSession } = await import(
      '../server/services/workspace-service.js'
    )
    const ws = createWorkspace({ name: 'WS', projectPath: '/p', sourceBranch: 'main', workingBranch: 'b' })
    createIdleSession(ws.id)
    createIdleSession(ws.id)
    expect(getActiveSession(ws.id)).toBeNull()
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

describe('updateWorkspaceReasoningEffort() throws when workspace not found', () => {
  it("lève une erreur si le workspace n'existe pas", async () => {
    const { updateWorkspaceReasoningEffort } = await import('../server/services/workspace-service.js')
    expect(() => updateWorkspaceReasoningEffort('nonexistent', 'high')).toThrow(/not found/)
  })
})

describe('updateWorkspaceReasoningEffort()', () => {
  it('met à jour le niveau de raisonnement', async () => {
    const { createWorkspace, updateWorkspaceReasoningEffort } = await import('../server/services/workspace-service.js')
    const ws = createWorkspace({ name: 'Reasoning', projectPath: '/p', sourceBranch: 'main', workingBranch: 'b' })
    const updated = updateWorkspaceReasoningEffort(ws.id, 'max')
    expect(updated.reasoningEffort).toBe('max')
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

describe('createIdleSession()', () => {
  it('insère une session idle et la retourne avec name=null', async () => {
    const { createWorkspace, createIdleSession } = await import('../server/services/workspace-service.js')
    const ws = createWorkspace({
      name: 'WS',
      projectPath: '/p',
      sourceBranch: 'main',
      workingBranch: 'bci1',
    })
    const session = createIdleSession(ws.id)
    expect(session.id).toBeTruthy()
    expect(session.workspaceId).toBe(ws.id)
    expect(session.status).toBe('idle')
    expect(session.pid).toBeNull()
    expect(session.engineSessionId).toBeNull()
    expect(session.name).toBeNull()
    expect(session.endedAt).toBeNull()
  })

  it('est visible dans listSessions()', async () => {
    const { createWorkspace, createIdleSession, listSessions } = await import('../server/services/workspace-service.js')
    const ws = createWorkspace({
      name: 'WS',
      projectPath: '/p',
      sourceBranch: 'main',
      workingBranch: 'bci2',
    })
    createIdleSession(ws.id)
    const sessions = listSessions(ws.id)
    expect(sessions.length).toBe(1)
    expect(sessions[0].status).toBe('idle')
    expect(sessions[0].name).toBeNull()
  })
})

describe('setFavorite / unsetFavorite', () => {
  it('setFavorite sets favoritedAt to an ISO timestamp and bumps updatedAt', async () => {
    const { createWorkspace, setFavorite } = await import('../server/services/workspace-service.js')
    const ws = createWorkspace({ name: 'Fav', projectPath: '/p', sourceBranch: 'main', workingBranch: 'b' })
    expect(ws.favoritedAt).toBeNull()

    await new Promise((r) => setTimeout(r, 10))

    const favorited = setFavorite(ws.id)
    expect(favorited.favoritedAt).not.toBeNull()
    expect(typeof favorited.favoritedAt).toBe('string')
    expect(new Date(favorited.favoritedAt!).toString()).not.toBe('Invalid Date')
    expect(favorited.updatedAt > ws.updatedAt).toBe(true)
  })

  it('setFavorite is idempotent — calling twice refreshes the timestamp', async () => {
    const { createWorkspace, setFavorite } = await import('../server/services/workspace-service.js')
    const ws = createWorkspace({ name: 'Fav2', projectPath: '/p', sourceBranch: 'main', workingBranch: 'b2' })

    const first = setFavorite(ws.id)
    expect(first.favoritedAt).not.toBeNull()

    await new Promise((r) => setTimeout(r, 10))

    const second = setFavorite(ws.id)
    expect(second.favoritedAt).not.toBeNull()
    // The second call must have produced a strictly later timestamp
    expect(second.favoritedAt! > first.favoritedAt!).toBe(true)
  })

  it("setFavorite throws Workspace '<id>' not found on unknown id", async () => {
    const { setFavorite } = await import('../server/services/workspace-service.js')
    expect(() => setFavorite('ghost-id')).toThrow("Workspace 'ghost-id' not found")
  })

  it('unsetFavorite clears favoritedAt and bumps updatedAt', async () => {
    const { createWorkspace, setFavorite, unsetFavorite } = await import('../server/services/workspace-service.js')
    const ws = createWorkspace({ name: 'Unfav', projectPath: '/p', sourceBranch: 'main', workingBranch: 'b3' })

    const favorited = setFavorite(ws.id)
    expect(favorited.favoritedAt).not.toBeNull()

    await new Promise((r) => setTimeout(r, 10))

    const unfavorited = unsetFavorite(ws.id)
    expect(unfavorited.favoritedAt).toBeNull()
    expect(unfavorited.updatedAt > favorited.updatedAt).toBe(true)
  })

  it('unsetFavorite is idempotent on a non-favorite (returns workspace with favoritedAt === null)', async () => {
    const { createWorkspace, unsetFavorite } = await import('../server/services/workspace-service.js')
    const ws = createWorkspace({ name: 'NonFav', projectPath: '/p', sourceBranch: 'main', workingBranch: 'b4' })
    expect(ws.favoritedAt).toBeNull()

    const before = ws.updatedAt

    await new Promise((r) => setTimeout(r, 10))

    const result = unsetFavorite(ws.id)
    expect(result.favoritedAt).toBeNull()
    // updated_at still gets bumped even on a non-favorite
    expect(result.updatedAt).not.toBe(before)
  })

  it("unsetFavorite throws Workspace '<id>' not found on unknown id", async () => {
    const { unsetFavorite } = await import('../server/services/workspace-service.js')
    expect(() => unsetFavorite('ghost-id')).toThrow("Workspace 'ghost-id' not found")
  })
})

describe('renameSession()', () => {
  it('met à jour le name de la session', async () => {
    const { createWorkspace, createIdleSession, listSessions, renameSession } = await import(
      '../server/services/workspace-service.js'
    )
    const ws = createWorkspace({
      name: 'WS',
      projectPath: '/p',
      sourceBranch: 'main',
      workingBranch: 'brs1',
    })
    const session = createIdleSession(ws.id)
    renameSession(session.id, ws.id, 'Mon nom custom')
    const sessions = listSessions(ws.id)
    expect(sessions[0].name).toBe('Mon nom custom')
  })

  it('retourne la session mise à jour', async () => {
    const { createWorkspace, createIdleSession, renameSession } = await import(
      '../server/services/workspace-service.js'
    )
    const ws = createWorkspace({
      name: 'WS',
      projectPath: '/p',
      sourceBranch: 'main',
      workingBranch: 'brs2',
    })
    const session = createIdleSession(ws.id)
    const updated = renameSession(session.id, ws.id, 'Nouveau nom')
    expect(updated).not.toBeNull()
    expect(updated!.name).toBe('Nouveau nom')
  })

  it('retourne null si la session est introuvable', async () => {
    const { renameSession } = await import('../server/services/workspace-service.js')
    const result = renameSession('unknown-id', 'unknown-ws', 'test')
    expect(result).toBeNull()
  })

  it('retourne null si la session appartient à un autre workspace', async () => {
    const { createWorkspace, createIdleSession, renameSession } = await import(
      '../server/services/workspace-service.js'
    )
    const wsA = createWorkspace({
      name: 'WS-A',
      projectPath: '/pa',
      sourceBranch: 'main',
      workingBranch: 'brs-a',
    })
    const wsB = createWorkspace({
      name: 'WS-B',
      projectPath: '/pb',
      sourceBranch: 'main',
      workingBranch: 'brs-b',
    })
    const sessionA = createIdleSession(wsA.id)
    // Try to rename sessionA using wsB.id → must fail
    const result = renameSession(sessionA.id, wsB.id, 'pwned')
    expect(result).toBeNull()
  })
})

describe('setWorkspaceTags(id, tags)', () => {
  it('stores the normalized tag list on the workspace', async () => {
    const { createWorkspace, setWorkspaceTags } = await import('../server/services/workspace-service.js')
    const ws = createWorkspace({ name: 'tags-test', projectPath: '/p', sourceBranch: 'main', workingBranch: 'f' })
    const updated = setWorkspaceTags(ws.id, ['bug', 'urgent'])
    expect(updated.tags).toEqual(['bug', 'urgent'])
  })

  it('trims whitespace and drops empty strings', async () => {
    const { createWorkspace, setWorkspaceTags } = await import('../server/services/workspace-service.js')
    const ws = createWorkspace({ name: 'trim', projectPath: '/p', sourceBranch: 'main', workingBranch: 'f' })
    const updated = setWorkspaceTags(ws.id, ['  bug  ', '', '   ', 'feature'])
    expect(updated.tags).toEqual(['bug', 'feature'])
  })

  it('deduplicates identical tags (after trim)', async () => {
    const { createWorkspace, setWorkspaceTags } = await import('../server/services/workspace-service.js')
    const ws = createWorkspace({ name: 'dedupe', projectPath: '/p', sourceBranch: 'main', workingBranch: 'f' })
    const updated = setWorkspaceTags(ws.id, ['bug', 'BUG', 'bug ', ' bug'])
    // Trim yields the same value; case mismatch is intentionally kept as-is (case-sensitive).
    expect(updated.tags).toEqual(['bug', 'BUG'])
  })

  it('drops tags longer than 50 characters', async () => {
    const { createWorkspace, setWorkspaceTags } = await import('../server/services/workspace-service.js')
    const ws = createWorkspace({ name: 'long', projectPath: '/p', sourceBranch: 'main', workingBranch: 'f' })
    const updated = setWorkspaceTags(ws.id, ['ok', 'x'.repeat(51)])
    expect(updated.tags).toEqual(['ok'])
  })

  it('caps the total number of tags at 50', async () => {
    const { createWorkspace, setWorkspaceTags } = await import('../server/services/workspace-service.js')
    const ws = createWorkspace({ name: 'many', projectPath: '/p', sourceBranch: 'main', workingBranch: 'f' })
    const hundred = Array.from({ length: 100 }, (_, i) => `tag-${i}`)
    const updated = setWorkspaceTags(ws.id, hundred)
    expect(updated.tags).toHaveLength(50)
    expect(updated.tags[0]).toBe('tag-0')
    expect(updated.tags[49]).toBe('tag-49')
  })

  it('silently filters non-string values from the input', async () => {
    const { createWorkspace, setWorkspaceTags } = await import('../server/services/workspace-service.js')
    const ws = createWorkspace({ name: 'mixed', projectPath: '/p', sourceBranch: 'main', workingBranch: 'f' })
    // Tolerant normalization — but see the route test for the strict 400 rejection.
    const updated = setWorkspaceTags(ws.id, ['bug', 42 as unknown as string, 'urgent'])
    expect(updated.tags).toEqual(['bug', 'urgent'])
  })

  it('bumps updatedAt on write', async () => {
    const { createWorkspace, setWorkspaceTags } = await import('../server/services/workspace-service.js')
    const ws = createWorkspace({ name: 'ua', projectPath: '/p', sourceBranch: 'main', workingBranch: 'f' })
    const before = ws.updatedAt
    await new Promise((r) => setTimeout(r, 10))
    const updated = setWorkspaceTags(ws.id, ['bug'])
    expect(updated.updatedAt).not.toBe(before)
  })

  it('throws "Workspace \'<id>\' not found" on unknown id', async () => {
    const { setWorkspaceTags } = await import('../server/services/workspace-service.js')
    expect(() => setWorkspaceTags('does-not-exist', ['bug'])).toThrow("Workspace 'does-not-exist' not found")
  })

  it('allows clearing tags by passing an empty array', async () => {
    const { createWorkspace, setWorkspaceTags } = await import('../server/services/workspace-service.js')
    const ws = createWorkspace({ name: 'clear', projectPath: '/p', sourceBranch: 'main', workingBranch: 'f' })
    setWorkspaceTags(ws.id, ['bug'])
    const cleared = setWorkspaceTags(ws.id, [])
    expect(cleared.tags).toEqual([])
  })
})

describe('setPermissionProfile(id, profile)', () => {
  it('defaults to bypass on a freshly created workspace', async () => {
    const { createWorkspace } = await import('../server/services/workspace-service.js')
    const ws = createWorkspace({ name: 'p', projectPath: '/p', sourceBranch: 'main', workingBranch: 'f' })
    expect(ws.permissionProfile).toBe('bypass')
  })

  it('flips the profile to strict and reads it back', async () => {
    const { createWorkspace, setPermissionProfile, getWorkspace } = await import(
      '../server/services/workspace-service.js'
    )
    const ws = createWorkspace({ name: 'p', projectPath: '/p', sourceBranch: 'main', workingBranch: 'f' })
    setPermissionProfile(ws.id, 'strict')
    expect(getWorkspace(ws.id)?.permissionProfile).toBe('strict')
  })

  it('flips back from strict to bypass', async () => {
    const { createWorkspace, setPermissionProfile, getWorkspace } = await import(
      '../server/services/workspace-service.js'
    )
    const ws = createWorkspace({ name: 'p', projectPath: '/p', sourceBranch: 'main', workingBranch: 'f' })
    setPermissionProfile(ws.id, 'strict')
    setPermissionProfile(ws.id, 'bypass')
    expect(getWorkspace(ws.id)?.permissionProfile).toBe('bypass')
  })

  it('throws on unknown workspace id', async () => {
    const { setPermissionProfile } = await import('../server/services/workspace-service.js')
    expect(() => setPermissionProfile('nope', 'strict')).toThrow("Workspace 'nope' not found")
  })
})
