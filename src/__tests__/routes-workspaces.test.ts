import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('../server/services/workspace-service.js', () => ({
  createWorkspace: vi.fn(),
  getWorkspace: vi.fn(),
  getWorkspaceWithTasks: vi.fn(),
  listWorkspaces: vi.fn(),
  updateWorkspaceStatus: vi.fn(),
  updateWorkspaceName: vi.fn(),
  deleteWorkspace: vi.fn(),
  createTask: vi.fn(),
  listTasks: vi.fn(),
  updateTaskStatus: vi.fn(),
  updateTaskTitle: vi.fn(),
  deleteTask: vi.fn(),
  listSessions: vi.fn(),
  getLatestSession: vi.fn(),
  archiveWorkspace: vi.fn(),
  unarchiveWorkspace: vi.fn(),
  listArchivedWorkspaces: vi.fn(),
}))

vi.mock('../server/services/worktree-service.js', () => ({
  createWorktree: vi.fn(),
  removeWorktree: vi.fn(),
}))

vi.mock('../server/services/agent-manager.js', () => ({
  startAgent: vi.fn(),
  stopAgent: vi.fn(),
  sendMessage: vi.fn(),
}))

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
  return {
    ...actual,
    execFileSync: vi.fn(),
  }
})

vi.mock('../server/services/pr-template-service.js', () => ({
  renderPrTemplate: vi.fn().mockReturnValue('rendered prompt'),
}))

vi.mock('../server/services/notion-service.js', () => ({
  extractNotionPage: vi.fn(),
  parseNotionUrl: vi.fn(),
}))

vi.mock('../server/utils/git-ops.js', () => ({
  deleteLocalBranch: vi.fn(),
  deleteRemoteBranch: vi.fn(),
  pushBranch: vi.fn(),
  getCommitsBetween: vi.fn().mockReturnValue(''),
  getDiffStatsBetween: vi.fn().mockReturnValue(''),
}))

vi.mock('../server/services/websocket-service.js', () => ({
  emit: vi.fn(),
  emitEphemeral: vi.fn(),
}))

vi.mock('../server/services/dev-server-service.js', () => ({
  stopDevServer: vi.fn(),
  startDevServer: vi.fn(),
  getStatus: vi.fn(),
  getDevServerLogs: vi.fn(),
}))

vi.mock('../server/db/index.js', () => ({
  getDb: vi.fn().mockReturnValue({
    prepare: vi.fn().mockReturnValue({
      run: vi.fn(),
      get: vi.fn(),
      all: vi.fn().mockReturnValue([]),
    }),
  }),
}))

vi.mock('../server/services/settings-service.js', () => ({
  getEffectiveSettings: vi.fn(),
}))

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  return {
    ...actual,
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    existsSync: vi.fn().mockReturnValue(false),
  }
})

// ── Imports (after mocks) ────────────────────────────────────────────────────

import * as childProcess from 'node:child_process'
import * as fs from 'node:fs'
import router from '../server/routes/workspaces.js'
import * as agentManager from '../server/services/agent-manager.js'
import * as devServerService from '../server/services/dev-server-service.js'
import * as notionService from '../server/services/notion-service.js'
import * as settingsService from '../server/services/settings-service.js'
import * as wsService from '../server/services/websocket-service.js'
import * as workspaceService from '../server/services/workspace-service.js'
import * as worktreeService from '../server/services/worktree-service.js'
import * as gitOps from '../server/utils/git-ops.js'

// ── App setup ────────────────────────────────────────────────────────────────

const app = new Hono()
app.route('/api/workspaces', router)

// ── Fixtures ─────────────────────────────────────────────────────────────────

const fakeWorkspace = {
  id: 'ws-1',
  name: 'Test Workspace',
  projectPath: '/tmp/project',
  sourceBranch: 'main',
  workingBranch: 'feature/test',
  status: 'idle' as const,
  notionUrl: null,
  notionPageId: null,
  model: 'claude-opus-4-6',
  devServerStatus: 'stopped',
  archivedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

const fakeWorkspaceWithTasks = {
  ...fakeWorkspace,
  tasks: [
    {
      id: 'task-1',
      workspaceId: 'ws-1',
      title: 'Task 1',
      status: 'pending' as const,
      isAcceptanceCriterion: false,
      sortOrder: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  ],
}

const fakeSession = {
  id: 'sess-1',
  workspaceId: 'ws-1',
  startedAt: '2026-01-01T00:00:00.000Z',
  endedAt: null,
  exitCode: null,
  prompt: 'test prompt',
}

// ── Helpers ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks()
  // Default: no git conventions configured — individual tests can override
  vi.mocked(settingsService.getEffectiveSettings).mockReturnValue({
    model: 'auto',
    prPromptTemplate: '',
    gitConventions: '',
    sourceBranch: 'main',
    devServer: null,
  })
})

// ── Tests ────────────────────────────────────────────────────────────────────

describe('GET /api/workspaces', () => {
  it('returns workspace list', async () => {
    vi.mocked(workspaceService.listWorkspaces).mockReturnValue([fakeWorkspace])

    const res = await app.request('/api/workspaces')
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data).toEqual([fakeWorkspace])
    expect(workspaceService.listWorkspaces).toHaveBeenCalledOnce()
  })

  it('returns empty array when no workspaces', async () => {
    vi.mocked(workspaceService.listWorkspaces).mockReturnValue([])

    const res = await app.request('/api/workspaces')
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data).toEqual([])
  })

  it('returns 500 on service error', async () => {
    vi.mocked(workspaceService.listWorkspaces).mockImplementation(() => {
      throw new Error('DB connection failed')
    })

    const res = await app.request('/api/workspaces')
    expect(res.status).toBe(500)
    const data = await res.json()
    expect(data.error).toBe('DB connection failed')
  })
})

describe('POST /api/workspaces', () => {
  it('creates workspace without Notion URL', async () => {
    vi.mocked(workspaceService.createWorkspace).mockReturnValue(fakeWorkspace)
    vi.mocked(worktreeService.createWorktree).mockReturnValue('/tmp/worktree')
    vi.mocked(workspaceService.listTasks).mockReturnValue([])
    vi.mocked(workspaceService.getWorkspaceWithTasks).mockReturnValue(fakeWorkspaceWithTasks)

    const res = await app.request('/api/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Test Workspace',
        projectPath: '/tmp/project',
        sourceBranch: 'main',
        workingBranch: 'feature/test',
      }),
    })

    expect(res.status).toBe(201)
    const data = await res.json()
    expect(data.id).toBe('ws-1')
    expect(workspaceService.createWorkspace).toHaveBeenCalledOnce()
    expect(worktreeService.createWorktree).toHaveBeenCalledWith('/tmp/project', 'feature/test', 'main')
    expect(agentManager.startAgent).toHaveBeenCalledOnce()
  })

  it('creates workspace with Notion URL and extracts content', async () => {
    const notionContent = {
      title: 'Notion Page Title',
      goal: 'Build something',
      todos: [{ title: 'Do thing', checked: false }],
      gherkinFeatures: ['Feature: login'],
    }

    vi.mocked(workspaceService.createWorkspace).mockReturnValue({
      ...fakeWorkspace,
      name: 'workspace',
      notionUrl: 'https://notion.so/page-123',
    })
    vi.mocked(notionService.extractNotionPage).mockResolvedValue(notionContent)
    vi.mocked(notionService.parseNotionUrl).mockReturnValue('page-123')
    vi.mocked(workspaceService.updateWorkspaceName).mockReturnValue({
      ...fakeWorkspace,
      name: 'Notion Page Title',
    })
    vi.mocked(worktreeService.createWorktree).mockReturnValue('/tmp/worktree')
    vi.mocked(workspaceService.listTasks).mockReturnValue([])
    vi.mocked(workspaceService.getWorkspaceWithTasks).mockReturnValue(fakeWorkspaceWithTasks)

    const res = await app.request('/api/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'workspace',
        projectPath: '/tmp/project',
        sourceBranch: 'main',
        workingBranch: 'feature/test',
        notionUrl: 'https://notion.so/page-123',
      }),
    })

    expect(res.status).toBe(201)
    expect(notionService.extractNotionPage).toHaveBeenCalledWith('https://notion.so/page-123')
    expect(workspaceService.createTask).toHaveBeenCalled()
    expect(workspaceService.updateWorkspaceName).toHaveBeenCalledWith('ws-1', 'Notion Page Title')
  })

  it('returns 400 when required fields are missing', async () => {
    const res = await app.request('/api/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Test' }),
    })

    expect(res.status).toBe(400)
    const data = await res.json()
    expect(data.error).toContain('Missing required fields')
  })

  it('returns 500 when worktree creation fails', async () => {
    vi.mocked(workspaceService.createWorkspace).mockReturnValue(fakeWorkspace)
    vi.mocked(worktreeService.createWorktree).mockImplementation(() => {
      throw new Error('git worktree add failed')
    })

    const res = await app.request('/api/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Test',
        projectPath: '/tmp/project',
        sourceBranch: 'main',
        workingBranch: 'feature/test',
      }),
    })

    expect(res.status).toBe(500)
    const data = await res.json()
    expect(data.error).toContain('Failed to create worktree')
    expect(workspaceService.updateWorkspaceStatus).toHaveBeenCalledWith('ws-1', 'error')
  })

  it('crée des tasks et critères manuels quand pas de Notion', async () => {
    vi.mocked(workspaceService.createWorkspace).mockReturnValue({ id: 'ws-1', name: 'workspace' } as never)
    vi.mocked(worktreeService.createWorktree).mockReturnValue('/tmp/wt' as never)
    vi.mocked(workspaceService.listTasks).mockReturnValue([])
    vi.mocked(workspaceService.getWorkspaceWithTasks).mockReturnValue({ id: 'ws-1' } as never)

    const res = await app.request('/api/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'test',
        projectPath: '/p',
        sourceBranch: 'main',
        workingBranch: 'feature/test',
        model: 'auto',
        tasks: ['Task A', 'Task B'],
        acceptanceCriteria: ['Criterion 1'],
      }),
    })

    expect(res.status).toBe(201)
    expect(workspaceService.createTask).toHaveBeenCalledWith(
      'ws-1',
      expect.objectContaining({ title: 'Task A', isAcceptanceCriterion: false }),
    )
    expect(workspaceService.createTask).toHaveBeenCalledWith(
      'ws-1',
      expect.objectContaining({ title: 'Task B', isAcceptanceCriterion: false }),
    )
    expect(workspaceService.createTask).toHaveBeenCalledWith(
      'ws-1',
      expect.objectContaining({ title: 'Criterion 1', isAcceptanceCriterion: true }),
    )
  })
})

describe('GET /api/workspaces/:id', () => {
  it('returns workspace with tasks', async () => {
    vi.mocked(workspaceService.getWorkspaceWithTasks).mockReturnValue(fakeWorkspaceWithTasks)

    const res = await app.request('/api/workspaces/ws-1')
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.id).toBe('ws-1')
    expect(data.tasks).toHaveLength(1)
  })

  it('returns 404 for unknown workspace', async () => {
    vi.mocked(workspaceService.getWorkspaceWithTasks).mockReturnValue(null)

    const res = await app.request('/api/workspaces/nonexistent')
    expect(res.status).toBe(404)
    const data = await res.json()
    expect(data.error).toContain('not found')
  })
})

describe('GET /api/workspaces/:id/sessions', () => {
  it('returns sessions list', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(fakeWorkspace)
    vi.mocked(workspaceService.listSessions).mockReturnValue([fakeSession as any])

    const res = await app.request('/api/workspaces/ws-1/sessions')
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data).toEqual([fakeSession])
    expect(workspaceService.listSessions).toHaveBeenCalledWith('ws-1')
  })

  it('returns 404 when workspace not found', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(null)

    const res = await app.request('/api/workspaces/nonexistent/sessions')
    expect(res.status).toBe(404)
    const data = await res.json()
    expect(data.error).toContain('not found')
  })
})

describe('POST /api/workspaces/:id/refresh-notion', () => {
  it('refreshes Notion content and recreates tasks', async () => {
    const notionContent = {
      title: 'Updated Page',
      goal: 'Updated goal',
      todos: [{ title: 'New task', checked: false }],
      gherkinFeatures: ['Feature: new feature'],
    }

    vi.mocked(workspaceService.getWorkspace).mockReturnValue({
      ...fakeWorkspace,
      notionUrl: 'https://notion.so/page-123',
    })
    vi.mocked(notionService.extractNotionPage).mockResolvedValue(notionContent)
    vi.mocked(workspaceService.getWorkspaceWithTasks).mockReturnValue(fakeWorkspaceWithTasks)

    const res = await app.request('/api/workspaces/ws-1/refresh-notion', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(notionService.extractNotionPage).toHaveBeenCalledWith('https://notion.so/page-123')
    expect(workspaceService.createTask).toHaveBeenCalledTimes(2) // 1 todo + 1 gherkin
  })

  it('returns 404 when workspace not found', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(null)

    const res = await app.request('/api/workspaces/nonexistent/refresh-notion', { method: 'POST' })
    expect(res.status).toBe(404)
  })

  it('returns 400 when no Notion URL configured', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(fakeWorkspace) // notionUrl is null

    const res = await app.request('/api/workspaces/ws-1/refresh-notion', { method: 'POST' })
    expect(res.status).toBe(400)
    const data = await res.json()
    expect(data.error).toContain('No Notion URL')
  })
})

describe('POST /api/workspaces/:id/tasks', () => {
  it('crée une task et retourne 201', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue({ id: 'ws-1' } as never)
    vi.mocked(workspaceService.listTasks).mockReturnValue([])
    vi.mocked(workspaceService.createTask).mockReturnValue({
      id: 'task-1',
      workspaceId: 'ws-1',
      title: 'My task',
      status: 'pending',
      isAcceptanceCriterion: false,
      sortOrder: 0,
      createdAt: 't',
      updatedAt: 't',
    } as never)

    const res = await app.request('/api/workspaces/ws-1/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'My task', isAcceptanceCriterion: false }),
    })

    expect(res.status).toBe(201)
    const data = await res.json()
    expect(data.title).toBe('My task')
  })

  it('retourne 404 si workspace inconnu', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(null as never)
    const res = await app.request('/api/workspaces/unknown/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'test', isAcceptanceCriterion: false }),
    })
    expect(res.status).toBe(404)
  })

  it('retourne 400 si title manquant', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue({ id: 'ws-1' } as never)
    const res = await app.request('/api/workspaces/ws-1/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isAcceptanceCriterion: false }),
    })
    expect(res.status).toBe(400)
  })

  it('retourne 400 si title vide', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue({ id: 'ws-1' } as never)
    const res = await app.request('/api/workspaces/ws-1/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '   ', isAcceptanceCriterion: false }),
    })
    expect(res.status).toBe(400)
  })
})

describe('PATCH /api/workspaces/:id/tasks/:taskId', () => {
  it('updates task status', async () => {
    vi.mocked(workspaceService.updateTaskStatus).mockReturnValue(undefined as any)

    const res = await app.request('/api/workspaces/ws-1/tasks/task-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'done' }),
    })

    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.ok).toBe(true)
    expect(workspaceService.updateTaskStatus).toHaveBeenCalledWith('task-1', 'done')
  })

  it('returns 400 for invalid status', async () => {
    const res = await app.request('/api/workspaces/ws-1/tasks/task-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'invalid_status' }),
    })

    expect(res.status).toBe(400)
    const data = await res.json()
    expect(data.error).toContain('Invalid status')
  })

  it("met à jour le titre d'une task", async () => {
    vi.mocked(workspaceService.updateTaskTitle).mockReturnValue({ id: 'task-1', title: 'New title' } as never)

    const res = await app.request('/api/workspaces/ws-1/tasks/task-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'New title' }),
    })

    expect(res.status).toBe(200)
    expect(workspaceService.updateTaskTitle).toHaveBeenCalledWith('task-1', 'New title')
  })

  it('accepte title et status ensemble', async () => {
    vi.mocked(workspaceService.updateTaskTitle).mockReturnValue({ id: 'task-1' } as never)
    vi.mocked(workspaceService.updateTaskStatus).mockReturnValue({ id: 'task-1' } as never)

    const res = await app.request('/api/workspaces/ws-1/tasks/task-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'New', status: 'done' }),
    })

    expect(res.status).toBe(200)
    expect(workspaceService.updateTaskTitle).toHaveBeenCalled()
    expect(workspaceService.updateTaskStatus).toHaveBeenCalled()
  })

  it('retourne 400 si ni title ni status', async () => {
    const res = await app.request('/api/workspaces/ws-1/tasks/task-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })

  it('retourne 400 si title vide', async () => {
    const res = await app.request('/api/workspaces/ws-1/tasks/task-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '  ' }),
    })
    expect(res.status).toBe(400)
  })
})

describe('DELETE /api/workspaces/:id/tasks/:taskId', () => {
  it('supprime une task et retourne 204', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue({ id: 'ws-1' } as never)

    const res = await app.request('/api/workspaces/ws-1/tasks/task-1', {
      method: 'DELETE',
    })

    expect(res.status).toBe(204)
    expect(workspaceService.deleteTask).toHaveBeenCalledWith('task-1')
  })

  it('retourne 404 si workspace inconnu', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(null as never)
    const res = await app.request('/api/workspaces/unknown/tasks/task-1', {
      method: 'DELETE',
    })
    expect(res.status).toBe(404)
  })
})

describe('POST /api/workspaces/:id/tasks/:taskId/notify-done', () => {
  it('emet un event WebSocket task:updated et retourne 204', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue({ id: 'ws-1' } as never)

    const res = await app.request('/api/workspaces/ws-1/tasks/task-1/notify-done', {
      method: 'POST',
    })

    expect(res.status).toBe(204)
    expect(wsService.emit).toHaveBeenCalledWith(
      'ws-1',
      'task:updated',
      expect.objectContaining({ taskId: 'task-1', status: 'done' }),
    )
  })

  it('retourne 404 si workspace inconnu', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(null as never)

    const res = await app.request('/api/workspaces/unknown/tasks/task-1/notify-done', {
      method: 'POST',
    })
    expect(res.status).toBe(404)
  })
})

describe('PATCH /api/workspaces/:id', () => {
  it('updates workspace status', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(fakeWorkspace)
    vi.mocked(workspaceService.updateWorkspaceStatus).mockReturnValue({
      ...fakeWorkspace,
      status: 'executing',
    })

    const res = await app.request('/api/workspaces/ws-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'executing' }),
    })

    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.status).toBe('executing')
  })

  it('returns 400 when status is missing', async () => {
    const res = await app.request('/api/workspaces/ws-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })

    expect(res.status).toBe(400)
    const data = await res.json()
    expect(data.error).toContain('Missing required field: status')
  })

  it('returns 404 for unknown workspace', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(null)

    const res = await app.request('/api/workspaces/nonexistent', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'idle' }),
    })

    expect(res.status).toBe(404)
  })
})

describe('POST /api/workspaces/:id/start', () => {
  it('starts agent for workspace', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(fakeWorkspace)
    vi.mocked(workspaceService.updateWorkspaceStatus).mockReturnValue({
      ...fakeWorkspace,
      status: 'executing',
    })

    const res = await app.request('/api/workspaces/ws-1/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'Do something' }),
    })

    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.status).toBe('started')
    expect(agentManager.startAgent).toHaveBeenCalledWith(
      'ws-1',
      '/tmp/project/.worktrees/feature/test',
      'Do something',
      'claude-opus-4-6',
    )
    expect(workspaceService.updateWorkspaceStatus).toHaveBeenCalledWith('ws-1', 'executing')
  })

  it('uses default prompt when none provided', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(fakeWorkspace)
    vi.mocked(workspaceService.updateWorkspaceStatus).mockReturnValue({
      ...fakeWorkspace,
      status: 'executing',
    })

    const res = await app.request('/api/workspaces/ws-1/start', { method: 'POST' })

    expect(res.status).toBe(200)
    expect(agentManager.startAgent).toHaveBeenCalledWith(
      'ws-1',
      '/tmp/project/.worktrees/feature/test',
      'Continue the previous task where you left off.',
      'claude-opus-4-6',
    )
  })

  it('returns 404 for unknown workspace', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(null)

    const res = await app.request('/api/workspaces/nonexistent/start', { method: 'POST' })
    expect(res.status).toBe(404)
  })
})

describe('POST /api/workspaces/:id/stop', () => {
  it('stops agent for workspace', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(fakeWorkspace)

    const res = await app.request('/api/workspaces/ws-1/stop', { method: 'POST' })

    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.status).toBe('stopped')
    expect(agentManager.stopAgent).toHaveBeenCalledWith('ws-1')
    expect(workspaceService.updateWorkspaceStatus).toHaveBeenCalledWith('ws-1', 'idle')
  })

  it('returns stopped even when agent is not running', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(fakeWorkspace)
    vi.mocked(agentManager.stopAgent).mockImplementation(() => {
      throw new Error('Agent not tracked')
    })

    const res = await app.request('/api/workspaces/ws-1/stop', { method: 'POST' })

    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.status).toBe('stopped')
  })

  it('returns 404 for unknown workspace', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(null)

    const res = await app.request('/api/workspaces/nonexistent/stop', { method: 'POST' })
    expect(res.status).toBe(404)
  })
})

describe('DELETE /api/workspaces/:id', () => {
  it('deletes workspace with full cleanup', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(fakeWorkspace)

    const res = await app.request('/api/workspaces/ws-1', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deleteLocalBranch: true,
        deleteRemoteBranch: true,
      }),
    })

    expect(res.status).toBe(204)
    expect(agentManager.stopAgent).toHaveBeenCalledWith('ws-1')
    expect(worktreeService.removeWorktree).toHaveBeenCalledWith('/tmp/project', '/tmp/project/.worktrees/feature/test')
    expect(gitOps.deleteLocalBranch).toHaveBeenCalledWith('/tmp/project', 'feature/test')
    expect(gitOps.deleteRemoteBranch).toHaveBeenCalledWith('/tmp/project', 'feature/test')
    expect(workspaceService.deleteWorkspace).toHaveBeenCalledWith('ws-1')
  })

  it('deletes workspace without branch cleanup', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(fakeWorkspace)

    const res = await app.request('/api/workspaces/ws-1', { method: 'DELETE' })

    expect(res.status).toBe(204)
    expect(gitOps.deleteLocalBranch).not.toHaveBeenCalled()
    expect(gitOps.deleteRemoteBranch).not.toHaveBeenCalled()
    expect(workspaceService.deleteWorkspace).toHaveBeenCalledWith('ws-1')
  })

  it('returns 404 for unknown workspace', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(null)

    const res = await app.request('/api/workspaces/nonexistent', { method: 'DELETE' })
    expect(res.status).toBe(404)
  })
})

describe('git conventions file creation on workspace create', () => {
  beforeEach(() => {
    vi.mocked(workspaceService.createWorkspace).mockReturnValue(fakeWorkspace as never)
    vi.mocked(worktreeService.createWorktree).mockReturnValue('/tmp/worktree')
    vi.mocked(workspaceService.listTasks).mockReturnValue([])
    vi.mocked(workspaceService.getWorkspaceWithTasks).mockReturnValue(fakeWorkspaceWithTasks as never)
    vi.mocked(workspaceService.updateWorkspaceStatus).mockReturnValue(fakeWorkspace as never)
    vi.mocked(fs.writeFileSync).mockClear()
  })

  it('writes .ai/git-conventions.md when gitConventions is non-empty', async () => {
    vi.mocked(settingsService.getEffectiveSettings).mockReturnValue({
      model: 'auto',
      prPromptTemplate: '',
      gitConventions: '# My conventions\n- Rule 1',
      sourceBranch: 'main',
      devServer: null,
    })

    await app.request('/api/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Test',
        projectPath: '/tmp/project',
        sourceBranch: 'main',
        workingBranch: 'feature/test',
      }),
    })

    const writeCall = vi
      .mocked(fs.writeFileSync)
      .mock.calls.find(([p]) => typeof p === 'string' && p.includes('git-conventions.md'))
    expect(writeCall).toBeDefined()
    expect(writeCall?.[1]).toBe('# My conventions\n- Rule 1')
  })

  it('does NOT write the file when gitConventions is empty', async () => {
    vi.mocked(settingsService.getEffectiveSettings).mockReturnValue({
      model: 'auto',
      prPromptTemplate: '',
      gitConventions: '',
      sourceBranch: 'main',
      devServer: null,
    })

    await app.request('/api/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Test',
        projectPath: '/tmp/project',
        sourceBranch: 'main',
        workingBranch: 'feature/test',
      }),
    })

    const writeCall = vi
      .mocked(fs.writeFileSync)
      .mock.calls.find(([p]) => typeof p === 'string' && p.includes('git-conventions.md'))
    expect(writeCall).toBeUndefined()
  })

  it('includes the git conventions section in the agent prompt when non-empty', async () => {
    vi.mocked(settingsService.getEffectiveSettings).mockReturnValue({
      model: 'auto',
      prPromptTemplate: '',
      gitConventions: '# conventions',
      sourceBranch: 'main',
      devServer: null,
    })

    await app.request('/api/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Test',
        projectPath: '/tmp/project',
        sourceBranch: 'main',
        workingBranch: 'feature/test',
      }),
    })

    const startCall = vi.mocked(agentManager.startAgent).mock.calls[0]
    expect(startCall).toBeDefined()
    const prompt = startCall?.[2] as string
    expect(prompt).toContain('Git conventions')
    expect(prompt).toContain('.ai/git-conventions.md')
  })

  it('does NOT include the git conventions section when empty', async () => {
    vi.mocked(settingsService.getEffectiveSettings).mockReturnValue({
      model: 'auto',
      prPromptTemplate: '',
      gitConventions: '',
      sourceBranch: 'main',
      devServer: null,
    })

    await app.request('/api/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Test',
        projectPath: '/tmp/project',
        sourceBranch: 'main',
        workingBranch: 'feature/test',
      }),
    })

    const startCall = vi.mocked(agentManager.startAgent).mock.calls[0]
    const prompt = startCall?.[2] as string
    expect(prompt).not.toContain('.ai/git-conventions.md')
  })
})

describe('POST /api/workspaces/:id/push', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Reset pushBranch implementation so a previous test's throw doesn't leak
    vi.mocked(gitOps.pushBranch).mockReset()
  })

  it('pushes the branch and returns 200', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue({
      ...fakeWorkspace,
      workingBranch: 'feature/test',
      projectPath: '/tmp/project',
    } as never)

    const res = await app.request('/api/workspaces/ws-1/push', { method: 'POST' })

    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.ok).toBe(true)
    expect(data.branch).toBe('feature/test')
    expect(vi.mocked(gitOps.pushBranch)).toHaveBeenCalledWith(expect.stringContaining('.worktrees'), 'feature/test')
  })

  it('returns 404 when workspace not found', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(null as never)

    const res = await app.request('/api/workspaces/unknown/push', { method: 'POST' })

    expect(res.status).toBe(404)
  })

  it('returns 500 with stderr when git push fails', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue({
      ...fakeWorkspace,
      workingBranch: 'feature/test',
      projectPath: '/tmp/project',
    } as never)
    vi.mocked(gitOps.pushBranch).mockImplementation(() => {
      throw new Error('remote rejected: non-fast-forward')
    })

    const res = await app.request('/api/workspaces/ws-1/push', { method: 'POST' })

    expect(res.status).toBe(500)
    const data = await res.json()
    expect(data.error).toContain('remote rejected')
  })

  it('emits user:message on success', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue({
      ...fakeWorkspace,
      workingBranch: 'feature/test',
      projectPath: '/tmp/project',
    } as never)
    vi.mocked(workspaceService.getLatestSession).mockReturnValue({
      id: 's-1',
      claudeSessionId: 'session-uuid',
    } as never)

    await app.request('/api/workspaces/ws-1/push', { method: 'POST' })

    const { emit } = await import('../server/services/websocket-service.js')
    expect(vi.mocked(emit)).toHaveBeenCalledWith(
      'ws-1',
      'user:message',
      expect.objectContaining({ content: expect.stringContaining('Pushed') }),
      expect.any(String),
    )
  })
})

describe('POST /api/workspaces/:id/open-pr', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(agentManager.sendMessage).mockReset()
    vi.mocked(childProcess.execFileSync).mockReset()
    vi.mocked(workspaceService.getWorkspace).mockReturnValue({
      ...fakeWorkspace,
      workingBranch: 'feature/test',
      sourceBranch: 'main',
      projectPath: '/tmp/project',
    } as never)
    vi.mocked(workspaceService.listTasks).mockReturnValue([])
    vi.mocked(workspaceService.getLatestSession).mockReturnValue({
      id: 's-1',
      claudeSessionId: 'sess-uuid',
    } as never)
  })

  it('returns 404 when workspace not found', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(null as never)
    const res = await app.request('/api/workspaces/unknown/open-pr', { method: 'POST' })
    expect(res.status).toBe(404)
  })

  it('returns 409 branch_not_pushed when ls-remote returns empty', async () => {
    vi.mocked(childProcess.execFileSync).mockImplementation(((_cmd: string, args: string[]) => {
      if (args.includes('ls-remote')) return Buffer.from('')
      throw new Error('unexpected')
    }) as never)

    const res = await app.request('/api/workspaces/ws-1/open-pr', { method: 'POST' })
    expect(res.status).toBe(409)
    const data = await res.json()
    expect(data.code).toBe('branch_not_pushed')
  })

  it('returns 409 branch_not_pushed when upstream is not configured', async () => {
    vi.mocked(childProcess.execFileSync).mockImplementation(((_cmd: string, args: string[]) => {
      if (args.includes('ls-remote')) return Buffer.from('abc refs/heads/feature/test\n')
      if (args.includes('rev-list')) {
        const err = new Error("fatal: no upstream configured for branch 'feature/test'")
        ;(err as never as { stderr: Buffer }).stderr = Buffer.from('fatal: no upstream configured')
        throw err
      }
      throw new Error('unexpected')
    }) as never)

    const res = await app.request('/api/workspaces/ws-1/open-pr', { method: 'POST' })
    expect(res.status).toBe(409)
    const data = await res.json()
    expect(data.code).toBe('branch_not_pushed')
  })

  it('returns 409 unpushed_commits when rev-list returns > 0', async () => {
    vi.mocked(childProcess.execFileSync).mockImplementation(((_cmd: string, args: string[]) => {
      if (args.includes('ls-remote')) return Buffer.from('abc refs/heads/feature/test\n')
      if (args.includes('rev-list')) return Buffer.from('3\n')
      throw new Error('unexpected')
    }) as never)

    const res = await app.request('/api/workspaces/ws-1/open-pr', { method: 'POST' })
    expect(res.status).toBe(409)
    const data = await res.json()
    expect(data.code).toBe('unpushed_commits')
  })

  it('creates PR, renders template, sends message on happy path', async () => {
    vi.mocked(settingsService.getEffectiveSettings).mockReturnValue({
      model: 'auto',
      prPromptTemplate: 'template body',
      gitConventions: '',
      sourceBranch: 'main',
      devServer: null,
    })

    vi.mocked(childProcess.execFileSync).mockImplementation(((cmd: string, args: string[]) => {
      if (cmd === 'git' && args.includes('ls-remote')) return Buffer.from('abc refs/heads/feature/test\n')
      if (cmd === 'git' && args.includes('rev-list')) return Buffer.from('0\n')
      if (cmd === 'gh' && args.includes('pr') && args.includes('create')) {
        return Buffer.from('https://github.com/org/repo/pull/42\n')
      }
      return Buffer.from('')
    }) as never)

    const prTemplateService = await import('../server/services/pr-template-service.js')
    vi.mocked(prTemplateService.renderPrTemplate).mockReturnValue('RENDERED PROMPT')

    const res = await app.request('/api/workspaces/ws-1/open-pr', { method: 'POST' })

    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.ok).toBe(true)
    expect(data.prNumber).toBe(42)
    expect(data.prUrl).toBe('https://github.com/org/repo/pull/42')
    expect(data.messageSent).toBe(true)

    const { emit } = await import('../server/services/websocket-service.js')
    expect(vi.mocked(emit)).toHaveBeenCalledWith(
      'ws-1',
      'user:message',
      expect.objectContaining({ content: 'RENDERED PROMPT', sender: 'user' }),
      'sess-uuid',
    )
    expect(vi.mocked(agentManager.sendMessage)).toHaveBeenCalledWith('ws-1', 'RENDERED PROMPT')
  })

  it('returns messageSent: false when template is empty (PR still created)', async () => {
    vi.mocked(settingsService.getEffectiveSettings).mockReturnValue({
      model: 'auto',
      prPromptTemplate: '',
      gitConventions: '',
      sourceBranch: 'main',
      devServer: null,
    })

    vi.mocked(childProcess.execFileSync).mockImplementation(((cmd: string, args: string[]) => {
      if (cmd === 'git' && args.includes('ls-remote')) return Buffer.from('abc refs/heads/feature/test\n')
      if (cmd === 'git' && args.includes('rev-list')) return Buffer.from('0\n')
      if (cmd === 'gh') return Buffer.from('https://github.com/org/repo/pull/42\n')
      return Buffer.from('')
    }) as never)

    const res = await app.request('/api/workspaces/ws-1/open-pr', { method: 'POST' })

    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.prNumber).toBe(42)
    expect(data.messageSent).toBe(false)
    expect(vi.mocked(agentManager.sendMessage)).not.toHaveBeenCalled()
  })

  it('returns 500 when gh pr create fails', async () => {
    vi.mocked(settingsService.getEffectiveSettings).mockReturnValue({
      model: 'auto',
      prPromptTemplate: '',
      gitConventions: '',
      sourceBranch: 'main',
      devServer: null,
    })

    vi.mocked(childProcess.execFileSync).mockImplementation(((cmd: string, args: string[]) => {
      if (cmd === 'git' && args.includes('ls-remote')) return Buffer.from('abc refs/heads/feature/test\n')
      if (cmd === 'git' && args.includes('rev-list')) return Buffer.from('0\n')
      if (cmd === 'gh') throw new Error('gh: auth required')
      return Buffer.from('')
    }) as never)

    const res = await app.request('/api/workspaces/ws-1/open-pr', { method: 'POST' })

    expect(res.status).toBe(500)
    const data = await res.json()
    expect(data.error).toContain('auth required')
  })

  it('returns 500 when gh output cannot be parsed', async () => {
    vi.mocked(settingsService.getEffectiveSettings).mockReturnValue({
      model: 'auto',
      prPromptTemplate: '',
      gitConventions: '',
      sourceBranch: 'main',
      devServer: null,
    })

    vi.mocked(childProcess.execFileSync).mockImplementation(((cmd: string, args: string[]) => {
      if (cmd === 'git' && args.includes('ls-remote')) return Buffer.from('abc refs/heads/feature/test\n')
      if (cmd === 'git' && args.includes('rev-list')) return Buffer.from('0\n')
      if (cmd === 'gh') return Buffer.from('some unexpected output\n')
      return Buffer.from('')
    }) as never)

    const res = await app.request('/api/workspaces/ws-1/open-pr', { method: 'POST' })

    expect(res.status).toBe(500)
    const data = await res.json()
    expect(data.error).toContain('parse')
  })

  it('returns 200 with warning when sendMessage fails (PR already created)', async () => {
    vi.mocked(settingsService.getEffectiveSettings).mockReturnValue({
      model: 'auto',
      prPromptTemplate: 'template',
      gitConventions: '',
      sourceBranch: 'main',
      devServer: null,
    })

    vi.mocked(childProcess.execFileSync).mockImplementation(((cmd: string, args: string[]) => {
      if (cmd === 'git' && args.includes('ls-remote')) return Buffer.from('abc refs/heads/feature/test\n')
      if (cmd === 'git' && args.includes('rev-list')) return Buffer.from('0\n')
      if (cmd === 'gh') return Buffer.from('https://github.com/org/repo/pull/42\n')
      return Buffer.from('')
    }) as never)

    vi.mocked(agentManager.sendMessage).mockImplementation(() => {
      throw new Error('No active agent session')
    })

    const res = await app.request('/api/workspaces/ws-1/open-pr', { method: 'POST' })

    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.ok).toBe(true)
    expect(data.prNumber).toBe(42)
    expect(data.messageSent).toBe(false)
    expect(data.warning).toBeDefined()
  })
})

describe('POST /api/workspaces/:id/archive', () => {
  it('returns 200 with archived workspace, stops agent and dev server', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(fakeWorkspace)
    const archivedWs = { ...fakeWorkspace, archivedAt: '2026-04-05T10:00:00.000Z' }
    vi.mocked(workspaceService.archiveWorkspace).mockReturnValue(archivedWs)

    const res = await app.request('/api/workspaces/ws-1/archive', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.archivedAt).toBe('2026-04-05T10:00:00.000Z')
    expect(agentManager.stopAgent).toHaveBeenCalledWith('ws-1')
    expect(devServerService.stopDevServer).toHaveBeenCalledWith('ws-1')
    expect(workspaceService.archiveWorkspace).toHaveBeenCalledWith('ws-1')
    expect(wsService.emitEphemeral).toHaveBeenCalledWith('ws-1', 'workspace:archived', { workspace: archivedWs })
  })

  it('returns 404 when workspace not found', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(null)
    const res = await app.request('/api/workspaces/missing/archive', { method: 'POST' })
    expect(res.status).toBe(404)
  })

  it('returns 400 when workspace already archived', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue({
      ...fakeWorkspace,
      archivedAt: '2026-04-04T10:00:00.000Z',
    })
    const res = await app.request('/api/workspaces/ws-1/archive', { method: 'POST' })
    expect(res.status).toBe(400)
  })

  it('succeeds even if stopDevServer throws (swallowed failure)', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(fakeWorkspace)
    const archivedWs = { ...fakeWorkspace, archivedAt: '2026-04-05T10:00:00.000Z' }
    vi.mocked(workspaceService.archiveWorkspace).mockReturnValue(archivedWs)
    vi.mocked(devServerService.stopDevServer).mockImplementation(() => {
      throw new Error('docker daemon unreachable')
    })
    const res = await app.request('/api/workspaces/ws-1/archive', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(workspaceService.archiveWorkspace).toHaveBeenCalledWith('ws-1')
  })
})

describe('POST /api/workspaces/:id/unarchive', () => {
  it('returns 200 with unarchived workspace, status preserved', async () => {
    const archivedWs = { ...fakeWorkspace, status: 'idle' as const, archivedAt: '2026-04-04T10:00:00.000Z' }
    const restoredWs = { ...archivedWs, archivedAt: null }
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(archivedWs)
    vi.mocked(workspaceService.unarchiveWorkspace).mockReturnValue(restoredWs)

    const res = await app.request('/api/workspaces/ws-1/unarchive', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.archivedAt).toBeNull()
    expect(body.status).toBe('idle')
    expect(workspaceService.unarchiveWorkspace).toHaveBeenCalledWith('ws-1')
    expect(wsService.emitEphemeral).toHaveBeenCalledWith('ws-1', 'workspace:unarchived', { workspace: restoredWs })
  })

  it('returns 404 when workspace not found', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(null)
    const res = await app.request('/api/workspaces/missing/unarchive', { method: 'POST' })
    expect(res.status).toBe(404)
  })

  it('returns 400 when workspace not archived', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue({ ...fakeWorkspace, archivedAt: null })
    const res = await app.request('/api/workspaces/ws-1/unarchive', { method: 'POST' })
    expect(res.status).toBe(400)
  })
})

describe('GET /api/workspaces/archived', () => {
  it('returns archived workspaces', async () => {
    const archivedList = [
      { ...fakeWorkspace, id: 'ws-arch-1', archivedAt: '2026-04-05T10:00:00.000Z' },
      { ...fakeWorkspace, id: 'ws-arch-2', archivedAt: '2026-04-04T10:00:00.000Z' },
    ]
    vi.mocked(workspaceService.listArchivedWorkspaces).mockReturnValue(archivedList)

    const res = await app.request('/api/workspaces/archived')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toHaveLength(2)
    expect(body[0].id).toBe('ws-arch-1')
    expect(workspaceService.listArchivedWorkspaces).toHaveBeenCalled()
  })

  it('returns empty array when no archived workspaces', async () => {
    vi.mocked(workspaceService.listArchivedWorkspaces).mockReturnValue([])
    const res = await app.request('/api/workspaces/archived')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual([])
  })

  it('is not matched by GET /:id (route order regression)', async () => {
    vi.mocked(workspaceService.listArchivedWorkspaces).mockReturnValue([])
    vi.mocked(workspaceService.getWorkspaceWithTasks).mockReturnValue(null)

    const res = await app.request('/api/workspaces/archived')
    expect(res.status).toBe(200)
    expect(workspaceService.listArchivedWorkspaces).toHaveBeenCalled()
    expect(workspaceService.getWorkspaceWithTasks).not.toHaveBeenCalled()
  })
})
