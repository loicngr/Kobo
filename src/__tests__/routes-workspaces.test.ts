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
  updateWorkingBranch: vi.fn(),
  updateWorkspaceModel: vi.fn(),
  updateWorkspaceReasoningEffort: vi.fn(),
  updateWorkspacePermissionMode: vi.fn(),
  deleteWorkspace: vi.fn(),
  createTask: vi.fn(),
  getTask: vi.fn(),
  listTasks: vi.fn(),
  updateTaskStatus: vi.fn(),
  updateTaskTitle: vi.fn(),
  deleteTask: vi.fn(),
  listSessions: vi.fn(),
  getLatestSession: vi.fn(),
  getActiveSession: vi.fn(),
  createIdleSession: vi.fn(),
  renameSession: vi.fn(),
  archiveWorkspace: vi.fn(),
  unarchiveWorkspace: vi.fn(),
  listArchivedWorkspaces: vi.fn(),
  markWorkspaceRead: vi.fn(),
  markWorkspaceUnread: vi.fn(),
  setFavorite: vi.fn(),
  unsetFavorite: vi.fn(),
  setWorkspaceTags: vi.fn(),
}))

vi.mock('../server/services/worktree-service.js', () => ({
  createWorktree: vi.fn(),
  removeWorktree: vi.fn(),
}))

vi.mock('../server/services/agent/orchestrator.js', () => ({
  startAgent: vi.fn().mockReturnValue({ agentSessionId: 'mock-agent-session-id' }),
  stopAgent: vi.fn(),
  sendMessage: vi.fn(),
  getAgentStatus: vi.fn().mockReturnValue(null),
}))

vi.mock('../server/services/agent/engines/registry.js', () => ({
  listEngines: vi.fn().mockReturnValue([{ id: 'claude-code' }]),
  resolveEngine: vi.fn(),
}))

// I10: workspaces.ts now uses promisify(execFile) instead of execFileSync.
// We mock execFile with a [util.promisify.custom] property so that promisify returns our mock.
const { execFilePromiseMock } = vi.hoisted(() => {
  const execFilePromiseMock = vi.fn()
  return { execFilePromiseMock }
})
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
  const mock = Object.assign(vi.fn(), {
    [Symbol.for('nodejs.util.promisify.custom')]: execFilePromiseMock,
  })
  return {
    ...actual,
    execFile: mock,
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

vi.mock('../server/services/sentry-service.js', () => ({
  extractSentryIssue: vi.fn(),
  parseSentryUrl: vi.fn(),
}))

vi.mock('../server/utils/git-ops.js', () => ({
  fetchSourceBranch: vi.fn(),
  deleteLocalBranch: vi.fn(),
  deleteRemoteBranch: vi.fn(),
  pushBranch: vi.fn(),
  pullBranch: vi.fn(),
  rebaseBranch: vi.fn(),
  getFileAtRef: vi.fn().mockReturnValue(null),
  getFileContent: vi.fn().mockReturnValue(null),
  getCommitsBetween: vi.fn().mockReturnValue(''),
  getDiffStatsBetween: vi.fn().mockReturnValue(''),
  getCommitCount: vi.fn().mockReturnValue(0),
  getStructuredDiffStatsBetween: vi.fn().mockReturnValue({ filesChanged: 0, insertions: 0, deletions: 0 }),
  getPrUrl: vi.fn().mockReturnValue(null),
  getPrStatus: vi.fn().mockReturnValue(null),
  getUnpushedCount: vi.fn().mockReturnValue(0),
  getPrStatusAsync: vi.fn().mockResolvedValue(null),
  getPrUrlAsync: vi.fn().mockResolvedValue(null),
  getUnpushedCountAsync: vi.fn().mockResolvedValue(0),
  getWorkingTreeStatus: vi.fn().mockReturnValue({ staged: 0, modified: 0, untracked: 0 }),
  getChangedFiles: vi.fn().mockReturnValue([]),
  getUnpushedChangedFiles: vi.fn().mockReturnValue([]),
  listBranchCommits: vi.fn().mockReturnValue([]),
  getCurrentBranch: vi.fn(),
  moveWorktree: vi.fn(),
  renameBranch: vi.fn(),
  branchExists: vi.fn().mockReturnValue(false),
}))

vi.mock('../server/services/wakeup-service.js', () => ({
  schedule: vi.fn(),
  cancel: vi.fn(),
  rehydrate: vi.fn(),
  getPending: vi.fn(() => null),
}))

vi.mock('../server/services/pr-watcher-service.js', () => ({
  getAllPrStates: vi.fn(() => ({})),
  startPrWatcher: vi.fn(),
  stopPrWatcher: vi.fn(),
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
  getGlobalSettings: vi.fn(),
}))

vi.mock('../server/services/setup-script-service.js', () => ({
  runSetupScript: vi.fn(),
}))

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  const mocked = {
    ...actual,
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn().mockReturnValue(''),
    appendFileSync: vi.fn(),
  }
  return {
    ...mocked,
    default: mocked,
  }
})

// ── Imports (after mocks) ────────────────────────────────────────────────────

import * as fs from 'node:fs'
import router from '../server/routes/workspaces.js'
import * as agentManager from '../server/services/agent/orchestrator.js'
import * as devServerService from '../server/services/dev-server-service.js'
import * as notionService from '../server/services/notion-service.js'
import * as settingsService from '../server/services/settings-service.js'
import * as setupScriptService from '../server/services/setup-script-service.js'
import * as wakeupService from '../server/services/wakeup-service.js'
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
  reasoningEffort: 'auto',
  permissionMode: 'auto-accept' as const,
  devServerStatus: 'stopped',
  hasUnread: false,
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
  // fetchSourceBranch succeeds by default; individual tests can override.
  vi.mocked(gitOps.fetchSourceBranch).mockReturnValue(undefined)
  vi.mocked(settingsService.getEffectiveSettings).mockReturnValue({
    model: 'auto',
    dangerouslySkipPermissions: true,
    prPromptTemplate: '',
    gitConventions: '',
    sourceBranch: 'main',
    devServer: null,
    setupScript: '',
    notionStatusProperty: '',
    notionInProgressStatus: '',
  })
  vi.mocked(settingsService.getGlobalSettings).mockReturnValue({
    defaultModel: 'auto',
    dangerouslySkipPermissions: true,
    prPromptTemplate: '',
    gitConventions: '',
    editorCommand: '',
    browserNotifications: true,
    audioNotifications: true,
    notionStatusProperty: '',
    notionInProgressStatus: '',
    defaultPermissionMode: 'plan',
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
      ticketId: 'TK-123',
      status: '',
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
    vi.mocked(workspaceService.updateWorkingBranch).mockReturnValue({
      ...fakeWorkspace,
      name: 'Notion Page Title',
      workingBranch: 'feature/TK-123--notion-page-title',
    } as never)
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
    expect(workspaceService.updateWorkingBranch).toHaveBeenCalledWith('ws-1', 'feature/TK-123--notion-page-title')
  })

  it('calls fetchSourceBranch before createWorkspace on workspace creation', async () => {
    vi.mocked(workspaceService.createWorkspace).mockReturnValue(fakeWorkspace)
    vi.mocked(worktreeService.createWorktree).mockReturnValue('/tmp/worktree')
    vi.mocked(workspaceService.listTasks).mockReturnValue([])
    vi.mocked(workspaceService.getWorkspaceWithTasks).mockReturnValue(fakeWorkspaceWithTasks)

    const callOrder: string[] = []
    vi.mocked(gitOps.fetchSourceBranch).mockImplementation(() => {
      callOrder.push('fetchSourceBranch')
    })
    vi.mocked(workspaceService.createWorkspace).mockImplementation(() => {
      callOrder.push('createWorkspace')
      return fakeWorkspace
    })

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
    expect(callOrder).toEqual(['fetchSourceBranch', 'createWorkspace'])
    expect(gitOps.fetchSourceBranch).toHaveBeenCalledWith('/tmp/project', 'main')
  })

  it('returns 422 when fetchSourceBranch fails, without creating any workspace record', async () => {
    vi.mocked(gitOps.fetchSourceBranch).mockImplementation(() => {
      throw new Error("Failed to fetch 'main' from 'origin': fatal: no remote")
    })

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

    expect(res.status).toBe(422)
    const data = await res.json()
    expect(data.error).toMatch(/fetch.*main/i)
    expect(workspaceService.createWorkspace).not.toHaveBeenCalled()
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

  it('runs setup script when configured and continues on success', async () => {
    vi.mocked(workspaceService.createWorkspace).mockReturnValue(fakeWorkspace)
    vi.mocked(worktreeService.createWorktree).mockReturnValue('/tmp/worktree')
    vi.mocked(workspaceService.listTasks).mockReturnValue([])
    vi.mocked(workspaceService.getWorkspaceWithTasks).mockReturnValue(fakeWorkspaceWithTasks)
    vi.mocked(settingsService.getEffectiveSettings).mockReturnValue({
      model: 'claude-opus-4-6',
      dangerouslySkipPermissions: true,
      prPromptTemplate: '',
      gitConventions: '',
      sourceBranch: 'main',
      devServer: null,
      setupScript: '#!/bin/bash\necho "ok"',
      notionStatusProperty: '',
      notionInProgressStatus: '',
    })
    vi.mocked(setupScriptService.runSetupScript).mockResolvedValue({ exitCode: 0 })

    const res = await app.request('/api/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'test-ws',
        projectPath: '/tmp/test',
        sourceBranch: 'main',
        workingBranch: 'feature/test',
      }),
    })

    expect(res.status).toBe(201)
    expect(vi.mocked(setupScriptService.runSetupScript)).toHaveBeenCalledOnce()
  })

  it('returns workspace in error status when setup script fails', async () => {
    vi.mocked(workspaceService.createWorkspace).mockReturnValue(fakeWorkspace)
    vi.mocked(worktreeService.createWorktree).mockReturnValue('/tmp/worktree')
    vi.mocked(workspaceService.listTasks).mockReturnValue([])
    vi.mocked(workspaceService.getWorkspaceWithTasks).mockReturnValue(fakeWorkspaceWithTasks)
    vi.mocked(settingsService.getEffectiveSettings).mockReturnValue({
      model: 'claude-opus-4-6',
      dangerouslySkipPermissions: true,
      prPromptTemplate: '',
      gitConventions: '',
      sourceBranch: 'main',
      devServer: null,
      setupScript: '#!/bin/bash\nexit 1',
      notionStatusProperty: '',
      notionInProgressStatus: '',
    })
    vi.mocked(setupScriptService.runSetupScript).mockResolvedValue({ exitCode: 1 })

    const res = await app.request('/api/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'test-ws',
        projectPath: '/tmp/test',
        sourceBranch: 'main',
        workingBranch: 'feature/test',
      }),
    })

    expect(res.status).toBe(201)
    expect(workspaceService.updateWorkspaceStatus).toHaveBeenCalledWith(fakeWorkspace.id, 'error')
    // Agent should NOT be started when setup script fails
    expect(agentManager.startAgent).not.toHaveBeenCalled()
  })

  it('does not run setup script when not configured', async () => {
    vi.mocked(workspaceService.createWorkspace).mockReturnValue(fakeWorkspace)
    vi.mocked(worktreeService.createWorktree).mockReturnValue('/tmp/worktree')
    vi.mocked(workspaceService.listTasks).mockReturnValue([])
    vi.mocked(workspaceService.getWorkspaceWithTasks).mockReturnValue(fakeWorkspaceWithTasks)
    vi.mocked(settingsService.getEffectiveSettings).mockReturnValue({
      model: 'claude-opus-4-6',
      dangerouslySkipPermissions: true,
      prPromptTemplate: '',
      gitConventions: '',
      sourceBranch: 'main',
      devServer: null,
      setupScript: '',
      notionStatusProperty: '',
      notionInProgressStatus: '',
    })

    const res = await app.request('/api/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'test-ws',
        projectPath: '/tmp/test',
        sourceBranch: 'main',
        workingBranch: 'feature/test',
      }),
    })

    expect(res.status).toBe(201)
    expect(vi.mocked(setupScriptService.runSetupScript)).not.toHaveBeenCalled()
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
    vi.mocked(workspaceService.getWorkspace).mockReturnValue({ id: 'ws-1' } as never)
    vi.mocked(workspaceService.getTask).mockReturnValue({ id: 'task-1', workspaceId: 'ws-1' } as never)
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
    vi.mocked(workspaceService.getWorkspace).mockReturnValue({ id: 'ws-1' } as never)
    vi.mocked(workspaceService.getTask).mockReturnValue({ id: 'task-1', workspaceId: 'ws-1' } as never)

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
    vi.mocked(workspaceService.getWorkspace).mockReturnValue({ id: 'ws-1' } as never)
    vi.mocked(workspaceService.getTask).mockReturnValue({ id: 'task-1', workspaceId: 'ws-1' } as never)
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
    vi.mocked(workspaceService.getWorkspace).mockReturnValue({ id: 'ws-1' } as never)
    vi.mocked(workspaceService.getTask).mockReturnValue({ id: 'task-1', workspaceId: 'ws-1' } as never)
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
    vi.mocked(workspaceService.getWorkspace).mockReturnValue({ id: 'ws-1' } as never)
    vi.mocked(workspaceService.getTask).mockReturnValue({ id: 'task-1', workspaceId: 'ws-1' } as never)

    const res = await app.request('/api/workspaces/ws-1/tasks/task-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })

  it('retourne 400 si title vide', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue({ id: 'ws-1' } as never)
    vi.mocked(workspaceService.getTask).mockReturnValue({ id: 'task-1', workspaceId: 'ws-1' } as never)

    const res = await app.request('/api/workspaces/ws-1/tasks/task-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '  ' }),
    })
    expect(res.status).toBe(400)
  })

  it('retourne 404 si workspace inconnu', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(null as never)

    const res = await app.request('/api/workspaces/unknown/tasks/task-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'done' }),
    })
    expect(res.status).toBe(404)
  })

  it("retourne 404 si la task n'appartient pas au workspace", async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue({ id: 'ws-1' } as never)
    vi.mocked(workspaceService.getTask).mockReturnValue(null as never)

    const res = await app.request('/api/workspaces/ws-1/tasks/task-other', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'done' }),
    })
    expect(res.status).toBe(404)
    const data = await res.json()
    expect(data.error).toContain("Task 'task-other' not found in workspace 'ws-1'")
  })
})

describe('DELETE /api/workspaces/:id/tasks/:taskId', () => {
  it('supprime une task et retourne 204', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue({ id: 'ws-1' } as never)
    vi.mocked(workspaceService.getTask).mockReturnValue({ id: 'task-1', workspaceId: 'ws-1' } as never)

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

  it("retourne 404 si la task n'appartient pas au workspace", async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue({ id: 'ws-1' } as never)
    vi.mocked(workspaceService.getTask).mockReturnValue(null as never)

    const res = await app.request('/api/workspaces/ws-1/tasks/task-other', {
      method: 'DELETE',
    })
    expect(res.status).toBe(404)
    const data = await res.json()
    expect(data.error).toContain("Task 'task-other' not found in workspace 'ws-1'")
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

  it('updates workspace reasoning effort', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(fakeWorkspace)
    vi.mocked(workspaceService.updateWorkspaceReasoningEffort).mockReturnValue({
      ...fakeWorkspace,
      reasoningEffort: 'high',
    } as any)

    const res = await app.request('/api/workspaces/ws-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reasoningEffort: 'high' }),
    })

    expect(res.status).toBe(200)
    expect(workspaceService.updateWorkspaceReasoningEffort).toHaveBeenCalledWith('ws-1', 'high')
  })
})

describe('POST /api/workspaces/:id/tasks/notify-updated', () => {
  beforeEach(() => vi.clearAllMocks())

  it('emet un event WebSocket task:updated et retourne 204', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue({ id: 'ws-1' } as never)

    const res = await app.request('/api/workspaces/ws-1/tasks/notify-updated', {
      method: 'POST',
    })

    expect(res.status).toBe(204)
    expect(wsService.emit).toHaveBeenCalledWith('ws-1', 'task:updated', expect.any(Object))
  })

  it('retourne 404 si workspace inconnu', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(null as never)

    const res = await app.request('/api/workspaces/unknown/tasks/notify-updated', {
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
    expect(data.error).toContain('Missing field: status, model, reasoningEffort, permissionMode,')
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
      false,
      'auto-accept',
      undefined,
      'auto',
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
      false,
      'auto-accept',
      undefined,
      'auto',
    )
  })

  it('returns 404 for unknown workspace', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(null)

    const res = await app.request('/api/workspaces/nonexistent/start', { method: 'POST' })
    expect(res.status).toBe(404)
  })

  it('returns 400 when the workspace engine is no longer registered', async () => {
    const { listEngines } = await import('../server/services/agent/engines/registry.js')
    vi.mocked(workspaceService.getWorkspace).mockReturnValue({
      ...fakeWorkspace,
      engine: 'unregistered-engine',
    } as unknown as ReturnType<typeof workspaceService.getWorkspace>)
    vi.mocked(listEngines).mockReturnValue([{ id: 'claude-code' } as unknown as ReturnType<typeof listEngines>[number]])

    const res = await app.request('/api/workspaces/ws-1/start', { method: 'POST' })
    expect(res.status).toBe(400)
    const data = (await res.json()) as { error: string }
    expect(data.error).toMatch(/unregistered-engine/)
    expect(data.error).toMatch(/no longer available/i)
    expect(agentManager.startAgent).not.toHaveBeenCalled()
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

  it('surfaces a warning with copy-pasteable sudo command when the worktree removal fails (permission denied)', async () => {
    // Common case: Docker containers created root-owned files inside the
    // worktree. `git worktree remove` fails with EACCES. We still want the
    // DB row gone, but the user needs to know the directory wasn't cleaned
    // up and how to fix it manually.
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(fakeWorkspace)
    vi.mocked(worktreeService.removeWorktree).mockImplementation(() => {
      throw new Error("Failed to remove worktree '/tmp/project/.worktrees/feature/test': EACCES: permission denied")
    })

    const res = await app.request('/api/workspaces/ws-1', { method: 'DELETE' })

    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; warnings: string[] }
    expect(body.ok).toBe(true)
    expect(body.warnings.length).toBeGreaterThan(0)
    expect(body.warnings.join('\n')).toContain('/tmp/project/.worktrees/feature/test')
    expect(body.warnings.join('\n')).toMatch(/sudo rm -rf/)
    expect(body.warnings.join('\n')).toMatch(/git worktree prune/)
    // DB cleanup still ran
    expect(workspaceService.deleteWorkspace).toHaveBeenCalledWith('ws-1')
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

  it('writes .ai/.git-conventions.md when gitConventions is non-empty', async () => {
    vi.mocked(settingsService.getEffectiveSettings).mockReturnValue({
      model: 'auto',
      dangerouslySkipPermissions: true,
      prPromptTemplate: '',
      gitConventions: '# My conventions\n- Rule 1',
      sourceBranch: 'main',
      devServer: null,
      setupScript: '',
      notionStatusProperty: '',
      notionInProgressStatus: '',
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
      .mock.calls.find(([p]) => typeof p === 'string' && p.includes('.git-conventions.md'))
    expect(writeCall).toBeDefined()
    expect(writeCall?.[1]).toBe('# My conventions\n- Rule 1')
  })

  it('does NOT write the file when gitConventions is empty', async () => {
    vi.mocked(settingsService.getEffectiveSettings).mockReturnValue({
      model: 'auto',
      dangerouslySkipPermissions: true,
      prPromptTemplate: '',
      gitConventions: '',
      sourceBranch: 'main',
      devServer: null,
      setupScript: '',
      notionStatusProperty: '',
      notionInProgressStatus: '',
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
      .mock.calls.find(([p]) => typeof p === 'string' && p.includes('.git-conventions.md'))
    expect(writeCall).toBeUndefined()
  })

  it('includes the git conventions section in the agent prompt when non-empty', async () => {
    vi.mocked(settingsService.getEffectiveSettings).mockReturnValue({
      model: 'auto',
      dangerouslySkipPermissions: true,
      prPromptTemplate: '',
      gitConventions: '# conventions',
      sourceBranch: 'main',
      devServer: null,
      setupScript: '',
      notionStatusProperty: '',
      notionInProgressStatus: '',
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
    expect(prompt).toContain('.ai/.git-conventions.md')
  })

  it('does NOT include the git conventions section when empty', async () => {
    vi.mocked(settingsService.getEffectiveSettings).mockReturnValue({
      model: 'auto',
      dangerouslySkipPermissions: true,
      prPromptTemplate: '',
      gitConventions: '',
      sourceBranch: 'main',
      devServer: null,
      setupScript: '',
      notionStatusProperty: '',
      notionInProgressStatus: '',
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
    expect(prompt).not.toContain('.ai/.git-conventions.md')
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
    vi.mocked(workspaceService.getActiveSession).mockReturnValue({
      id: 's-1',
      engineSessionId: 'session-uuid',
    } as never)

    await app.request('/api/workspaces/ws-1/push', { method: 'POST' })

    const { emit } = await import('../server/services/websocket-service.js')
    expect(vi.mocked(emit)).toHaveBeenCalledWith(
      'ws-1',
      'user:message',
      expect.objectContaining({ content: expect.stringContaining('Pushed') }),
      's-1',
    )
  })
})

describe('POST /api/workspaces/:id/pull', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(gitOps.pullBranch).mockReset()
  })

  it('pulls the branch and returns 200', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue({
      ...fakeWorkspace,
      workingBranch: 'feature/test',
      projectPath: '/tmp/project',
    } as never)

    const res = await app.request('/api/workspaces/ws-1/pull', { method: 'POST' })

    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.ok).toBe(true)
    expect(data.branch).toBe('feature/test')
    expect(vi.mocked(gitOps.pullBranch)).toHaveBeenCalledWith(expect.stringContaining('.worktrees'), 'feature/test')
  })

  it('returns 404 when workspace not found', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(null as never)
    const res = await app.request('/api/workspaces/unknown/pull', { method: 'POST' })
    expect(res.status).toBe(404)
  })

  it('returns 500 when git pull fails (non-ff)', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue({
      ...fakeWorkspace,
      workingBranch: 'feature/test',
      projectPath: '/tmp/project',
    } as never)
    vi.mocked(gitOps.pullBranch).mockImplementation(() => {
      throw new Error('Not possible to fast-forward, aborting.')
    })

    const res = await app.request('/api/workspaces/ws-1/pull', { method: 'POST' })

    expect(res.status).toBe(500)
    const data = await res.json()
    expect(data.error).toContain('fast-forward')
  })

  it('emits user:message on success tagged with the active session id', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue({
      ...fakeWorkspace,
      workingBranch: 'feature/test',
      projectPath: '/tmp/project',
    } as never)
    vi.mocked(workspaceService.getActiveSession).mockReturnValue({
      id: 's-active',
      engineSessionId: 'claude-uuid',
    } as never)

    await app.request('/api/workspaces/ws-1/pull', { method: 'POST' })

    const { emit } = await import('../server/services/websocket-service.js')
    expect(vi.mocked(emit)).toHaveBeenCalledWith(
      'ws-1',
      'user:message',
      expect.objectContaining({ content: expect.stringContaining('Pulled') }),
      's-active',
    )
  })
})

describe('POST /api/workspaces/:id/open-pr', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(agentManager.sendMessage).mockReset()
    execFilePromiseMock.mockReset()
    vi.mocked(workspaceService.getWorkspace).mockReturnValue({
      ...fakeWorkspace,
      workingBranch: 'feature/test',
      sourceBranch: 'main',
      projectPath: '/tmp/project',
    } as never)
    vi.mocked(workspaceService.listTasks).mockReturnValue([])
    vi.mocked(workspaceService.getActiveSession).mockReturnValue({
      id: 's-1',
      engineSessionId: 'sess-uuid',
    } as never)
  })

  it('returns 404 when workspace not found', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(null as never)
    const res = await app.request('/api/workspaces/unknown/open-pr', { method: 'POST' })
    expect(res.status).toBe(404)
  })

  it('returns 409 branch_not_pushed when ls-remote returns empty', async () => {
    execFilePromiseMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('ls-remote')) return Promise.resolve({ stdout: '' })
      return Promise.reject(new Error('unexpected'))
    })

    const res = await app.request('/api/workspaces/ws-1/open-pr', { method: 'POST' })
    expect(res.status).toBe(409)
    const data = await res.json()
    expect(data.code).toBe('branch_not_pushed')
  })

  it('returns 409 branch_not_pushed when upstream is not configured', async () => {
    execFilePromiseMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('ls-remote')) return Promise.resolve({ stdout: 'abc refs/heads/feature/test\n' })
      if (args.includes('rev-list')) {
        const err = new Error("fatal: no upstream configured for branch 'feature/test'")
        ;(err as never as { stderr: string }).stderr = 'fatal: no upstream configured'
        return Promise.reject(err)
      }
      return Promise.reject(new Error('unexpected'))
    })

    const res = await app.request('/api/workspaces/ws-1/open-pr', { method: 'POST' })
    expect(res.status).toBe(409)
    const data = await res.json()
    expect(data.code).toBe('branch_not_pushed')
  })

  it('returns 409 unpushed_commits when rev-list returns > 0', async () => {
    execFilePromiseMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('ls-remote')) return Promise.resolve({ stdout: 'abc refs/heads/feature/test\n' })
      if (args.includes('rev-list')) return Promise.resolve({ stdout: '3\n' })
      return Promise.reject(new Error('unexpected'))
    })

    const res = await app.request('/api/workspaces/ws-1/open-pr', { method: 'POST' })
    expect(res.status).toBe(409)
    const data = await res.json()
    expect(data.code).toBe('unpushed_commits')
  })

  it('creates PR, renders template, sends message on happy path', async () => {
    vi.mocked(settingsService.getEffectiveSettings).mockReturnValue({
      model: 'auto',
      dangerouslySkipPermissions: true,
      prPromptTemplate: 'template body',
      gitConventions: '',
      sourceBranch: 'main',
      devServer: null,
      setupScript: '',
      notionStatusProperty: '',
      notionInProgressStatus: '',
    })

    execFilePromiseMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'git' && args.includes('ls-remote'))
        return Promise.resolve({ stdout: 'abc refs/heads/feature/test\n' })
      if (cmd === 'git' && args.includes('rev-list')) return Promise.resolve({ stdout: '0\n' })
      if (cmd === 'gh' && args.includes('pr') && args.includes('create')) {
        return Promise.resolve({ stdout: 'https://github.com/org/repo/pull/42\n' })
      }
      return Promise.resolve({ stdout: '' })
    })

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
      's-1',
    )
    expect(vi.mocked(agentManager.sendMessage)).toHaveBeenCalledWith('ws-1', 'RENDERED PROMPT')
  })

  it('returns messageSent: false when template is empty (PR still created)', async () => {
    vi.mocked(settingsService.getEffectiveSettings).mockReturnValue({
      model: 'auto',
      dangerouslySkipPermissions: true,
      prPromptTemplate: '',
      gitConventions: '',
      sourceBranch: 'main',
      devServer: null,
      setupScript: '',
      notionStatusProperty: '',
      notionInProgressStatus: '',
    })

    execFilePromiseMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'git' && args.includes('ls-remote'))
        return Promise.resolve({ stdout: 'abc refs/heads/feature/test\n' })
      if (cmd === 'git' && args.includes('rev-list')) return Promise.resolve({ stdout: '0\n' })
      if (cmd === 'gh') return Promise.resolve({ stdout: 'https://github.com/org/repo/pull/42\n' })
      return Promise.resolve({ stdout: '' })
    })

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
      dangerouslySkipPermissions: true,
      prPromptTemplate: '',
      gitConventions: '',
      sourceBranch: 'main',
      devServer: null,
      setupScript: '',
      notionStatusProperty: '',
      notionInProgressStatus: '',
    })

    execFilePromiseMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'git' && args.includes('ls-remote'))
        return Promise.resolve({ stdout: 'abc refs/heads/feature/test\n' })
      if (cmd === 'git' && args.includes('rev-list')) return Promise.resolve({ stdout: '0\n' })
      if (cmd === 'gh') return Promise.reject(new Error('gh: auth required'))
      return Promise.resolve({ stdout: '' })
    })

    const res = await app.request('/api/workspaces/ws-1/open-pr', { method: 'POST' })

    expect(res.status).toBe(500)
    const data = await res.json()
    expect(data.error).toContain('auth required')
  })

  it('returns 500 when gh output cannot be parsed', async () => {
    vi.mocked(settingsService.getEffectiveSettings).mockReturnValue({
      model: 'auto',
      dangerouslySkipPermissions: true,
      prPromptTemplate: '',
      gitConventions: '',
      sourceBranch: 'main',
      devServer: null,
      setupScript: '',
      notionStatusProperty: '',
      notionInProgressStatus: '',
    })

    execFilePromiseMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'git' && args.includes('ls-remote'))
        return Promise.resolve({ stdout: 'abc refs/heads/feature/test\n' })
      if (cmd === 'git' && args.includes('rev-list')) return Promise.resolve({ stdout: '0\n' })
      if (cmd === 'gh') return Promise.resolve({ stdout: 'some unexpected output\n' })
      return Promise.resolve({ stdout: '' })
    })

    const res = await app.request('/api/workspaces/ws-1/open-pr', { method: 'POST' })

    expect(res.status).toBe(500)
    const data = await res.json()
    expect(data.error).toContain('parse')
  })

  it('resumes agent when sendMessage fails (PR already created)', async () => {
    vi.mocked(settingsService.getEffectiveSettings).mockReturnValue({
      model: 'auto',
      dangerouslySkipPermissions: true,
      prPromptTemplate: 'template',
      gitConventions: '',
      sourceBranch: 'main',
      devServer: null,
      setupScript: '',
      notionStatusProperty: '',
      notionInProgressStatus: '',
    })

    execFilePromiseMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'git' && args.includes('ls-remote'))
        return Promise.resolve({ stdout: 'abc refs/heads/feature/test\n' })
      if (cmd === 'git' && args.includes('rev-list')) return Promise.resolve({ stdout: '0\n' })
      if (cmd === 'gh') return Promise.resolve({ stdout: 'https://github.com/org/repo/pull/42\n' })
      return Promise.resolve({ stdout: '' })
    })

    vi.mocked(agentManager.sendMessage).mockImplementation(() => {
      throw new Error('No active agent session')
    })

    const res = await app.request('/api/workspaces/ws-1/open-pr', { method: 'POST' })

    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.ok).toBe(true)
    expect(data.prNumber).toBe(42)
    // Agent is resumed with the PR prompt
    expect(data.messageSent).toBe(true)
    expect(agentManager.startAgent).toHaveBeenCalled()
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

describe('GET /api/workspaces/pr-states', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns the snapshot from pr-watcher', async () => {
    const prWatcher = await import('../server/services/pr-watcher-service.js')
    vi.mocked(prWatcher.getAllPrStates).mockReturnValue({ w1: 'OPEN', w2: 'CLOSED' })

    const res = await app.request('/api/workspaces/pr-states')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ w1: 'OPEN', w2: 'CLOSED' })
  })

  it('returns an empty object when no PRs are known', async () => {
    const prWatcher = await import('../server/services/pr-watcher-service.js')
    vi.mocked(prWatcher.getAllPrStates).mockReturnValue({})

    const res = await app.request('/api/workspaces/pr-states')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({})
  })

  it('is not matched by GET /:id (route order regression)', async () => {
    const prWatcher = await import('../server/services/pr-watcher-service.js')
    vi.mocked(prWatcher.getAllPrStates).mockReturnValue({})
    vi.mocked(workspaceService.getWorkspaceWithTasks).mockReturnValue(null)

    const res = await app.request('/api/workspaces/pr-states')
    expect(res.status).toBe(200)
    expect(prWatcher.getAllPrStates).toHaveBeenCalled()
    expect(workspaceService.getWorkspaceWithTasks).not.toHaveBeenCalled()
  })
})

describe('GET /api/workspaces/:id/git-stats', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns commit count and diff stats for a workspace', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue({
      ...fakeWorkspace,
      projectPath: '/tmp/project',
      sourceBranch: 'main',
      workingBranch: 'feature/test',
    } as never)
    vi.mocked(gitOps.getCommitCount).mockReturnValue(5)
    vi.mocked(gitOps.getStructuredDiffStatsBetween).mockReturnValue({
      filesChanged: 3,
      insertions: 42,
      deletions: 7,
    })
    vi.mocked(gitOps.getPrStatusAsync).mockResolvedValue({ state: 'OPEN', url: 'https://github.com/org/repo/pull/1' })

    const res = await app.request('/api/workspaces/ws-1/git-stats')
    expect(res.status).toBe(200)

    const data = await res.json()
    expect(data.commitCount).toBe(5)
    expect(data.filesChanged).toBe(3)
    expect(data.insertions).toBe(42)
    expect(data.deletions).toBe(7)
    expect(data.prUrl).toBe('https://github.com/org/repo/pull/1')
    expect(data.prState).toBe('OPEN')
  })

  it('returns 404 when workspace not found', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(null as never)

    const res = await app.request('/api/workspaces/unknown/git-stats')
    expect(res.status).toBe(404)
  })
})

describe('POST /api/workspaces/:id/run-setup-script', () => {
  beforeEach(() => vi.clearAllMocks())

  it('runs setup script and returns success when exit code is 0', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(fakeWorkspace)
    vi.mocked(settingsService.getEffectiveSettings).mockReturnValue({
      model: 'auto',
      dangerouslySkipPermissions: true,
      prPromptTemplate: '',
      gitConventions: '',
      sourceBranch: 'main',
      devServer: null,
      setupScript: 'echo "hello"',
    })
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(setupScriptService.runSetupScript).mockResolvedValue({ exitCode: 0 })

    const res = await app.request('/api/workspaces/ws-1/run-setup-script', { method: 'POST' })

    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.success).toBe(true)
    expect(setupScriptService.runSetupScript).toHaveBeenCalledWith(
      'ws-1',
      '/tmp/project/.worktrees/feature/test',
      'echo "hello"',
      {
        workspaceName: 'Test Workspace',
        branchName: 'feature/test',
        sourceBranch: 'main',
        projectPath: '/tmp/project',
      },
    )
  })

  it('returns 500 when setup script fails with non-zero exit code', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(fakeWorkspace)
    vi.mocked(settingsService.getEffectiveSettings).mockReturnValue({
      model: 'auto',
      dangerouslySkipPermissions: true,
      prPromptTemplate: '',
      gitConventions: '',
      sourceBranch: 'main',
      devServer: null,
      setupScript: 'exit 1',
    })
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(setupScriptService.runSetupScript).mockResolvedValue({ exitCode: 1 })

    const res = await app.request('/api/workspaces/ws-1/run-setup-script', { method: 'POST' })

    expect(res.status).toBe(500)
    const data = await res.json()
    expect(data.error).toBe('Setup script failed with exit code 1')
  })

  it('returns 400 when no setup script is configured', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(fakeWorkspace)
    vi.mocked(settingsService.getEffectiveSettings).mockReturnValue({
      model: 'auto',
      dangerouslySkipPermissions: true,
      prPromptTemplate: '',
      gitConventions: '',
      sourceBranch: 'main',
      devServer: null,
      setupScript: '',
      notionStatusProperty: '',
      notionInProgressStatus: '',
    })

    const res = await app.request('/api/workspaces/ws-1/run-setup-script', { method: 'POST' })

    expect(res.status).toBe(400)
    const data = await res.json()
    expect(data.error).toBe('No setup script configured')
  })

  it('returns 404 when workspace not found', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(null as never)

    const res = await app.request('/api/workspaces/unknown/run-setup-script', { method: 'POST' })

    expect(res.status).toBe(404)
  })

  it('returns 400 when worktree path does not exist', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(fakeWorkspace)
    vi.mocked(settingsService.getEffectiveSettings).mockReturnValue({
      model: 'auto',
      dangerouslySkipPermissions: true,
      prPromptTemplate: '',
      gitConventions: '',
      sourceBranch: 'main',
      devServer: null,
      setupScript: 'echo "hello"',
    })
    vi.mocked(fs.existsSync).mockReturnValue(false)

    const res = await app.request('/api/workspaces/ws-1/run-setup-script', { method: 'POST' })

    expect(res.status).toBe(400)
    const data = await res.json()
    expect(data.error).toContain('Worktree path does not exist')
  })
})

describe('POST /api/workspaces/:id/mark-read', () => {
  it('returns success when workspace exists', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(fakeWorkspace)

    const res = await app.request('/api/workspaces/ws-1/mark-read', { method: 'POST' })
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.success).toBe(true)
    expect(workspaceService.markWorkspaceRead).toHaveBeenCalledWith('ws-1')
    expect(wsService.emitEphemeral).toHaveBeenCalledWith('ws-1', 'workspace:unread', { hasUnread: false })
  })

  it('returns 404 for unknown workspace', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(null)

    const res = await app.request('/api/workspaces/unknown-id/mark-read', { method: 'POST' })
    expect(res.status).toBe(404)
    const data = await res.json()
    expect(data.error).toContain('not found')
  })
})

describe('POST /api/workspaces/:id/sessions', () => {
  beforeEach(() => vi.clearAllMocks())

  it('crée une session idle et retourne 201', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(fakeWorkspace as any)
    vi.mocked(agentManager.getAgentStatus).mockReturnValue(null)
    const fakeSession = {
      id: 'sess-1',
      workspaceId: 'ws-1',
      status: 'idle',
      startedAt: new Date().toISOString(),
      pid: null,
      engineSessionId: null,
      endedAt: null,
      name: null,
    }
    vi.mocked(workspaceService.createIdleSession).mockReturnValue(fakeSession as any)

    const res = await app.request('/api/workspaces/ws-1/sessions', { method: 'POST' })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.id).toBe('sess-1')
    expect(body.status).toBe('idle')
    expect(workspaceService.createIdleSession).toHaveBeenCalledWith('ws-1')
  })

  it('retourne 404 si workspace introuvable', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(null)
    const res = await app.request('/api/workspaces/unknown/sessions', { method: 'POST' })
    expect(res.status).toBe(404)
  })

  it('retourne 409 si un agent tourne déjà', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(fakeWorkspace as any)
    vi.mocked(agentManager.getAgentStatus).mockReturnValue('running' as any)
    const res = await app.request('/api/workspaces/ws-1/sessions', { method: 'POST' })
    expect(res.status).toBe(409)
  })
})

describe('PATCH /api/workspaces/:id/sessions/:sessionId', () => {
  beforeEach(() => vi.clearAllMocks())

  it('renomme la session et retourne 200', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(fakeWorkspace as any)
    const updated = {
      id: 'sess-1',
      name: 'Mon nom',
      workspaceId: 'ws-1',
      status: 'idle',
      startedAt: new Date().toISOString(),
      pid: null,
      engineSessionId: null,
      endedAt: null,
    }
    vi.mocked(workspaceService.renameSession).mockReturnValue(updated as any)

    const res = await app.request('/api/workspaces/ws-1/sessions/sess-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Mon nom' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.name).toBe('Mon nom')
    expect(workspaceService.renameSession).toHaveBeenCalledWith('sess-1', 'ws-1', 'Mon nom')
  })

  it('retourne 400 si name est vide', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(fakeWorkspace as any)
    const res = await app.request('/api/workspaces/ws-1/sessions/sess-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '' }),
    })
    expect(res.status).toBe(400)
  })

  it('retourne 404 si workspace introuvable', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(null)
    const res = await app.request('/api/workspaces/unknown/sessions/s1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Test' }),
    })
    expect(res.status).toBe(404)
  })

  it('retourne 404 si session introuvable', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(fakeWorkspace as any)
    vi.mocked(workspaceService.renameSession).mockReturnValue(null)
    const res = await app.request('/api/workspaces/ws-1/sessions/nope', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Test' }),
    })
    expect(res.status).toBe(404)
  })
})

describe('POST /api/workspaces/:id/start avec agentSessionId', () => {
  beforeEach(() => vi.clearAllMocks())

  it('passe agentSessionId à startAgent quand fourni', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue({ ...fakeWorkspace, permissionMode: 'auto-accept' } as any)
    vi.mocked(workspaceService.updateWorkspaceStatus).mockReturnValue(undefined as any)

    await app.request('/api/workspaces/ws-1/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'hello', agentSessionId: 'sess-idle-1' }),
    })

    expect(agentManager.startAgent).toHaveBeenCalledWith(
      'ws-1',
      expect.any(String),
      'hello',
      fakeWorkspace.model,
      false,
      'auto-accept',
      'sess-idle-1',
      'auto',
    )
  })

  it('passe undefined si agentSessionId absent', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue({ ...fakeWorkspace, permissionMode: 'auto-accept' } as any)
    vi.mocked(workspaceService.updateWorkspaceStatus).mockReturnValue(undefined as any)

    await app.request('/api/workspaces/ws-1/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'hello' }),
    })

    expect(agentManager.startAgent).toHaveBeenCalledWith(
      'ws-1',
      expect.any(String),
      'hello',
      fakeWorkspace.model,
      false,
      'auto-accept',
      undefined,
      'auto',
    )
  })
})

describe('favorite endpoints', () => {
  beforeEach(() => vi.clearAllMocks())

  const favoritedWorkspace = { ...fakeWorkspace, favoritedAt: '2026-04-17T10:00:00.000Z' } as any

  it('POST /:id/favorite returns 200 + updated workspace and calls setFavorite', async () => {
    vi.mocked(workspaceService.setFavorite).mockReturnValue(favoritedWorkspace)

    const res = await app.request('/api/workspaces/ws-1/favorite', { method: 'POST' })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.favoritedAt).toBe('2026-04-17T10:00:00.000Z')
    expect(workspaceService.setFavorite).toHaveBeenCalledWith('ws-1')
  })

  it('POST /:id/favorite returns 404 when service throws not-found', async () => {
    vi.mocked(workspaceService.setFavorite).mockImplementation(() => {
      throw new Error("Workspace 'ws-missing' not found")
    })

    const res = await app.request('/api/workspaces/ws-missing/favorite', { method: 'POST' })

    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toContain('not found')
  })

  it('DELETE /:id/favorite returns 200 + updated workspace and calls unsetFavorite', async () => {
    const unfavoritedWorkspace = { ...fakeWorkspace, favoritedAt: null } as any
    vi.mocked(workspaceService.unsetFavorite).mockReturnValue(unfavoritedWorkspace)

    const res = await app.request('/api/workspaces/ws-1/favorite', { method: 'DELETE' })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.favoritedAt).toBeNull()
    expect(workspaceService.unsetFavorite).toHaveBeenCalledWith('ws-1')
  })

  it('DELETE /:id/favorite returns 404 when service throws not-found', async () => {
    vi.mocked(workspaceService.unsetFavorite).mockImplementation(() => {
      throw new Error("Workspace 'ws-missing' not found")
    })

    const res = await app.request('/api/workspaces/ws-missing/favorite', { method: 'DELETE' })

    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toContain('not found')
  })

  it('POST /:id/favorite route order regression: reaches favorite handler (not GET /:id)', async () => {
    vi.mocked(workspaceService.setFavorite).mockReturnValue(favoritedWorkspace)
    vi.mocked(workspaceService.getWorkspaceWithTasks).mockReturnValue(null)

    const res = await app.request('/api/workspaces/ws-1/favorite', { method: 'POST' })

    expect(res.status).toBe(200)
    expect(workspaceService.setFavorite).toHaveBeenCalledWith('ws-1')
    // GET /:id uses getWorkspaceWithTasks — if that was called, route order regressed
    expect(workspaceService.getWorkspaceWithTasks).not.toHaveBeenCalled()
  })
})

describe('PUT /api/workspaces/:id/tags', () => {
  beforeEach(() => vi.clearAllMocks())

  const taggedWorkspace = { id: 'ws-1', tags: ['bug', 'urgent'] } as unknown as ReturnType<
    typeof workspaceService.setWorkspaceTags
  >

  it('returns 200 + updated workspace on happy path', async () => {
    vi.mocked(workspaceService.setWorkspaceTags).mockReturnValue(taggedWorkspace)
    const res = await app.request('/api/workspaces/ws-1/tags', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tags: ['bug', 'urgent'] }),
    })
    expect(res.status).toBe(200)
    expect(workspaceService.setWorkspaceTags).toHaveBeenCalledWith('ws-1', ['bug', 'urgent'])
  })

  it('returns 400 when tags is not an array', async () => {
    const res = await app.request('/api/workspaces/ws-1/tags', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tags: 'bug' }),
    })
    expect(res.status).toBe(400)
    expect(workspaceService.setWorkspaceTags).not.toHaveBeenCalled()
  })

  it('returns 400 when tags contains non-strings', async () => {
    const res = await app.request('/api/workspaces/ws-1/tags', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tags: ['bug', 42, 'urgent'] }),
    })
    expect(res.status).toBe(400)
    expect(workspaceService.setWorkspaceTags).not.toHaveBeenCalled()
  })

  it('returns 404 when workspace missing', async () => {
    vi.mocked(workspaceService.setWorkspaceTags).mockImplementation(() => {
      throw new Error("Workspace 'ws-missing' not found")
    })
    const res = await app.request('/api/workspaces/ws-missing/tags', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tags: ['bug'] }),
    })
    expect(res.status).toBe(404)
  })
})

describe('GET /api/workspaces/:id/diff', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(workspaceService.getWorkspace).mockReturnValue({
      id: 'w1',
      name: 'W',
      projectPath: '/p',
      sourceBranch: 'develop',
      workingBranch: 'feature/x',
      status: 'idle',
      model: 'auto',
      engine: 'claude-code',
      reasoningEffort: 'auto',
      permissionMode: 'auto-accept',
      devServerStatus: 'stopped',
      hasUnread: false,
      archivedAt: null,
      favoritedAt: null,
      tags: [],
      createdAt: '2026-04-21',
      updatedAt: '2026-04-21',
    } as never)
  })

  it('returns branch diff by default (vs sourceBranch)', async () => {
    const branchFiles = [{ path: 'a.ts', status: 'modified' }]
    vi.mocked(gitOps.getChangedFiles).mockReturnValue(branchFiles as never)
    vi.mocked(gitOps.getUnpushedChangedFiles).mockReturnValue([])

    const res = await app.request('/api/workspaces/w1/diff')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.mode).toBe('branch')
    expect(body.files).toEqual(branchFiles)
    expect(gitOps.getChangedFiles).toHaveBeenCalledWith(expect.any(String), 'develop')
    expect(gitOps.getUnpushedChangedFiles).not.toHaveBeenCalled()
  })

  it('returns unpushed diff when mode=unpushed (vs origin/<workingBranch>)', async () => {
    const unpushedFiles = [{ path: 'b.ts', status: 'added' }]
    vi.mocked(gitOps.getChangedFiles).mockReturnValue([])
    vi.mocked(gitOps.getUnpushedChangedFiles).mockReturnValue(unpushedFiles as never)

    const res = await app.request('/api/workspaces/w1/diff?mode=unpushed')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.mode).toBe('unpushed')
    expect(body.files).toEqual(unpushedFiles)
    expect(gitOps.getUnpushedChangedFiles).toHaveBeenCalledWith(expect.any(String), 'feature/x')
    expect(gitOps.getChangedFiles).not.toHaveBeenCalled()
  })

  it('falls back to branch mode when mode is anything other than "unpushed"', async () => {
    vi.mocked(gitOps.getChangedFiles).mockReturnValue([])
    const res = await app.request('/api/workspaces/w1/diff?mode=bogus')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.mode).toBe('branch')
  })
})

describe('GET /api/workspaces/:id/diff-file', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(workspaceService.getWorkspace).mockReturnValue({
      id: 'w1',
      name: 'W',
      projectPath: '/p',
      sourceBranch: 'develop',
      workingBranch: 'feature/x',
      status: 'idle',
      model: 'auto',
      engine: 'claude-code',
      reasoningEffort: 'auto',
      permissionMode: 'auto-accept',
      devServerStatus: 'stopped',
      hasUnread: false,
      archivedAt: null,
      favoritedAt: null,
      tags: [],
      createdAt: '2026-04-21',
      updatedAt: '2026-04-21',
    } as never)
    vi.mocked(gitOps.getFileContent).mockReturnValue('modified content')
  })

  it('reads original from sourceBranch when mode=branch (default)', async () => {
    vi.mocked(gitOps.getFileAtRef).mockReturnValue('branch original')
    const res = await app.request('/api/workspaces/w1/diff-file?path=a.ts')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.mode).toBe('branch')
    expect(body.original).toBe('branch original')
    expect(body.modified).toBe('modified content')
    expect(gitOps.getFileAtRef).toHaveBeenCalledWith(expect.any(String), 'develop', 'a.ts')
  })

  it('reads original from origin/<workingBranch> when mode=unpushed', async () => {
    vi.mocked(gitOps.getFileAtRef).mockReturnValue('remote original')
    const res = await app.request('/api/workspaces/w1/diff-file?path=a.ts&mode=unpushed')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.mode).toBe('unpushed')
    expect(body.original).toBe('remote original')
    expect(gitOps.getFileAtRef).toHaveBeenCalledWith(expect.any(String), 'origin/feature/x', 'a.ts')
  })

  it('returns 400 when path query param is missing', async () => {
    const res = await app.request('/api/workspaces/w1/diff-file')
    expect(res.status).toBe(400)
  })
})

describe('GET /api/workspaces/:id/commits', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(workspaceService.getWorkspace).mockReturnValue({
      id: 'w1',
      name: 'W',
      projectPath: '/p',
      sourceBranch: 'develop',
      workingBranch: 'feature/x',
      status: 'idle',
      model: 'auto',
      engine: 'claude-code',
      reasoningEffort: 'auto',
      permissionMode: 'auto-accept',
      devServerStatus: 'stopped',
      hasUnread: false,
      archivedAt: null,
      favoritedAt: null,
      tags: [],
      createdAt: '2026-04-21',
      updatedAt: '2026-04-21',
    } as never)
  })

  it('returns commits with their push state and the branches context', async () => {
    const fakeCommits = [
      {
        sha: 'abc1234567890',
        shortSha: 'abc1234',
        subject: 'feat: add X',
        author: 'Dev',
        date: '2026-04-21T10:00:00Z',
        isPushed: true,
      },
      {
        sha: 'def1234567890',
        shortSha: 'def1234',
        subject: 'fix: Y',
        author: 'Dev',
        date: '2026-04-21T11:00:00Z',
        isPushed: false,
      },
    ]
    vi.mocked(gitOps.listBranchCommits).mockReturnValue(fakeCommits as never)

    const res = await app.request('/api/workspaces/w1/commits')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.commits).toEqual(fakeCommits)
    expect(body.sourceBranch).toBe('develop')
    expect(body.workingBranch).toBe('feature/x')
    expect(gitOps.listBranchCommits).toHaveBeenCalledWith(expect.any(String), 'develop', 'feature/x', 50)
  })

  it('respects the limit query param within [1, 200]', async () => {
    vi.mocked(gitOps.listBranchCommits).mockReturnValue([])
    await app.request('/api/workspaces/w1/commits?limit=10')
    expect(gitOps.listBranchCommits).toHaveBeenCalledWith(expect.any(String), 'develop', 'feature/x', 10)
  })

  it('clamps invalid limit values to the default 50', async () => {
    vi.mocked(gitOps.listBranchCommits).mockReturnValue([])
    await app.request('/api/workspaces/w1/commits?limit=notanumber')
    expect(gitOps.listBranchCommits).toHaveBeenCalledWith(expect.any(String), 'develop', 'feature/x', 50)
  })

  it('returns 404 for unknown workspace', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(undefined as never)
    const res = await app.request('/api/workspaces/w1/commits')
    expect(res.status).toBe(404)
  })
})

describe('GET /api/workspaces/:id/pending-wakeup', () => {
  it('returns null when no wakeup is pending', async () => {
    vi.mocked(wakeupService.getPending).mockReturnValue(null)
    const res = await app.request('/api/workspaces/w1/pending-wakeup')
    expect(res.status).toBe(200)
    expect(await res.json()).toBeNull()
  })

  it('returns { targetAt, reason } when a wakeup is pending', async () => {
    vi.mocked(wakeupService.getPending).mockReturnValue({ targetAt: '2026-04-22T10:00:00Z', reason: 'CI' })
    const res = await app.request('/api/workspaces/w1/pending-wakeup')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ targetAt: '2026-04-22T10:00:00Z', reason: 'CI' })
  })
})

describe('DELETE /api/workspaces/:id/pending-wakeup', () => {
  it('invokes wakeupService.cancel with reason "manual" and returns { ok: true }', async () => {
    const res = await app.request('/api/workspaces/w1/pending-wakeup', { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(wakeupService.cancel).toHaveBeenCalledWith('w1', 'manual')
  })

  it('is idempotent — returns 200 even when nothing is pending', async () => {
    const res = await app.request('/api/workspaces/w1/pending-wakeup', { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })
})

describe('POST /api/workspaces/:id/resync-branch', () => {
  beforeEach(() => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue({
      id: 'w1',
      name: 'test',
      projectPath: '/tmp/project',
      sourceBranch: 'main',
      workingBranch: 'feature/old-name',
      status: 'idle',
      notionUrl: null,
      notionPageId: null,
      model: 'sonnet',
      reasoningEffort: 'auto',
      permissionMode: 'auto-accept',
      devServerStatus: 'stopped',
      hasUnread: false,
      archivedAt: null,
      favoritedAt: null,
      tags: [],
      engine: 'claude-code',
      autoLoop: false,
      autoLoopReady: false,
      noProgressStreak: 0,
      permissionProfile: 'bypass',
      createdAt: 'x',
      updatedAt: 'x',
    } as never)
  })

  it('moves the worktree directory when the branch has been renamed in git', async () => {
    // Agent ran `git branch -m feature/old-name feature/new-name` inside the
    // worktree; Kōbō detects it and calls /resync-branch. The worktree dir is
    // still at .worktrees/feature/old-name → move it to match the new name,
    // otherwise future session spawns fail with ENOENT on .mcp.json.
    vi.mocked(gitOps.getCurrentBranch).mockReturnValue('feature/new-name')
    vi.mocked(workspaceService.updateWorkingBranch).mockReturnValue({
      workingBranch: 'feature/new-name',
    } as never)

    const res = await app.request('/api/workspaces/w1/resync-branch', { method: 'POST' })

    expect(res.status).toBe(200)
    expect(vi.mocked(gitOps.moveWorktree)).toHaveBeenCalledWith(
      '/tmp/project',
      '/tmp/project/.worktrees/feature/old-name',
      '/tmp/project/.worktrees/feature/new-name',
    )
    expect(vi.mocked(workspaceService.updateWorkingBranch)).toHaveBeenCalledWith('w1', 'feature/new-name')
  })

  it('does NOT move the worktree when the branch name is unchanged', async () => {
    vi.mocked(gitOps.getCurrentBranch).mockReturnValue('feature/old-name')

    const res = await app.request('/api/workspaces/w1/resync-branch', { method: 'POST' })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.changed).toBe(false)
    expect(vi.mocked(gitOps.moveWorktree)).not.toHaveBeenCalled()
  })

  it('updates the DB even if moveWorktree fails (dir already moved / dirty / locked)', async () => {
    // Best-effort move: keep the DB aligned with the git ref even when the
    // physical dir rename can't happen — that way subsequent operations at
    // least know the correct branch, and the user can repair manually.
    vi.mocked(gitOps.getCurrentBranch).mockReturnValue('feature/new-name')
    vi.mocked(gitOps.moveWorktree).mockImplementation(() => {
      throw new Error('fatal: directory is not empty')
    })
    vi.mocked(workspaceService.updateWorkingBranch).mockReturnValue({
      workingBranch: 'feature/new-name',
    } as never)

    const res = await app.request('/api/workspaces/w1/resync-branch', { method: 'POST' })

    expect(res.status).toBe(200)
    expect(vi.mocked(workspaceService.updateWorkingBranch)).toHaveBeenCalledWith('w1', 'feature/new-name')
  })
})

describe('POST /api/workspaces — pre-flight URL validation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 422 and creates nothing when notionUrl extraction fails', async () => {
    const notionService = await import('../server/services/notion-service.js')
    const wsService = await import('../server/services/workspace-service.js')
    const worktreeService = await import('../server/services/worktree-service.js')

    vi.mocked(notionService.extractNotionPage).mockRejectedValueOnce(
      new Error('Could not extract page ID from Notion URL'),
    )

    const res = await app.request('/api/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'doomed',
        projectPath: '/tmp/proj',
        sourceBranch: 'main',
        workingBranch: 'feat/doomed',
        notionUrl: 'https://www.notion.so/bad-url',
      }),
    })

    expect(res.status).toBe(422)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/Could not extract page ID/)
    expect(vi.mocked(wsService.createWorkspace)).not.toHaveBeenCalled()
    expect(vi.mocked(worktreeService.createWorktree)).not.toHaveBeenCalled()
  })

  it('returns 422 and creates nothing when sentryUrl extraction fails', async () => {
    const sentryService = await import('../server/services/sentry-service.js')
    const wsService = await import('../server/services/workspace-service.js')
    const worktreeService = await import('../server/services/worktree-service.js')

    vi.mocked(sentryService.extractSentryIssue).mockRejectedValueOnce(new Error('Sentry MCP failed to find issue'))

    const res = await app.request('/api/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'doomed',
        projectPath: '/tmp/proj',
        sourceBranch: 'main',
        workingBranch: 'feat/doomed',
        sentryUrl: 'https://my-org.sentry.io/issues/0/',
      }),
    })

    expect(res.status).toBe(422)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/Sentry/)
    expect(vi.mocked(wsService.createWorkspace)).not.toHaveBeenCalled()
    expect(vi.mocked(worktreeService.createWorktree)).not.toHaveBeenCalled()
  })

  it('happy path: extraction precedes createWorkspace, sentryUrl is forwarded', async () => {
    const notionService = await import('../server/services/notion-service.js')
    const sentryService = await import('../server/services/sentry-service.js')
    const wsService = await import('../server/services/workspace-service.js')

    vi.mocked(notionService.extractNotionPage).mockResolvedValueOnce({
      title: 'Page title',
      ticketId: 'TK-1',
      status: '',
      goal: '',
      todos: [],
      gherkinFeatures: [],
    })
    vi.mocked(sentryService.extractSentryIssue).mockResolvedValueOnce({
      title: 'crash',
      issueId: 'ACME-API-3',
      issueNumericId: '42',
      culprit: 'fn',
      platform: 'js',
      occurrences: 1,
      firstSeen: '2026-01-01',
      lastSeen: '2026-01-02',
      tags: {},
      offendingSpans: [],
      extraContext: '',
    })
    vi.mocked(wsService.createWorkspace).mockReturnValue({
      id: 'ws-new',
      name: 'doomed',
      projectPath: '/tmp/proj',
      sourceBranch: 'main',
      workingBranch: 'feat/x',
      status: 'created',
      notionUrl: 'https://www.notion.so/x',
      notionPageId: null,
      sentryUrl: 'https://my-org.sentry.io/issues/42/',
      model: 'claude-opus-4-7',
      reasoningEffort: 'auto',
      permissionMode: 'auto-accept',
      devServerStatus: 'stopped',
      hasUnread: false,
      archivedAt: null,
      favoritedAt: null,
      tags: [],
      engine: 'claude-code',
      autoLoop: false,
      autoLoopReady: false,
      noProgressStreak: 0,
      permissionProfile: 'bypass',
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
    })

    await app.request('/api/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'doomed',
        projectPath: '/tmp/proj',
        sourceBranch: 'main',
        workingBranch: 'feat/x',
        notionUrl: 'https://www.notion.so/x',
        sentryUrl: 'https://my-org.sentry.io/issues/42/',
      }),
    })

    expect(vi.mocked(wsService.createWorkspace)).toHaveBeenCalledWith(
      expect.objectContaining({ sentryUrl: 'https://my-org.sentry.io/issues/42/' }),
    )

    const notionOrder = vi.mocked(notionService.extractNotionPage).mock.invocationCallOrder[0]
    const sentryOrder = vi.mocked(sentryService.extractSentryIssue).mock.invocationCallOrder[0]
    const createOrder = vi.mocked(wsService.createWorkspace).mock.invocationCallOrder[0]
    expect(notionOrder).toBeLessThan(createOrder)
    expect(sentryOrder).toBeLessThan(createOrder)
  })
})
