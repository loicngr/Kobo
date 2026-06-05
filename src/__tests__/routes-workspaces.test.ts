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
  updateWorktreePath: vi.fn(),
  updateWorkspaceModel: vi.fn(),
  updateWorkspaceReasoningEffort: vi.fn(),
  updateWorkspaceDescription: vi.fn(),
  updateAgentPermissionMode: vi.fn(),
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
  updateWorkspaceSourceBranch: vi.fn(),
  setInitialPrompt: vi.fn(),
  clearInitialPrompt: vi.fn(),
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
  getActiveSessionId: vi.fn().mockReturnValue('active-session-id'),
}))

vi.mock('../server/services/agent/engines/registry.js', () => ({
  listEngines: vi.fn().mockReturnValue([
    { id: 'claude-code', capabilities: { permissionModes: ['plan', 'bypass', 'strict', 'interactive'] } },
    { id: 'codex', capabilities: { permissionModes: ['plan', 'bypass', 'strict'] } },
  ]),
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
  assignNotionPageToSelf: vi.fn().mockResolvedValue({ assigned: false, reason: 'mock' }),
  listNotionUsers: vi.fn().mockResolvedValue([]),
  updateNotionStatus: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../server/services/sentry-service.js', () => ({
  extractSentryIssue: vi.fn(),
  parseSentryUrl: vi.fn(),
  assignSentryIssueToSelf: vi.fn().mockResolvedValue({ assigned: false, reason: 'mock' }),
}))

vi.mock('../server/utils/git-ops.js', () => ({
  fetchSourceBranch: vi.fn(),
  deleteLocalBranch: vi.fn(),
  deleteRemoteBranch: vi.fn(),
  pushBranch: vi.fn(),
  pullBranch: vi.fn(),
  rebaseBranch: vi.fn(),
  mergeBranch: vi.fn(),
  commitAllChanges: vi.fn(),
  discardWorkingTreeChanges: vi.fn(),
  // Real-enough error classes so `err instanceof gitOps.X` matches what the
  // tests throw. Self-contained — no importActual needed.
  GitConflictError: class GitConflictError extends Error {
    operation: string
    files: string[]
    constructor(operation: string, files: string[]) {
      super(`${operation} conflict`)
      this.name = 'GitConflictError'
      this.operation = operation
      this.files = files
    }
  },
  DirtyWorktreeError: class DirtyWorktreeError extends Error {
    operation: 'rebase' | 'merge' | 'pull'
    status: { staged: number; modified: number; untracked: number }
    constructor(
      operation: 'rebase' | 'merge' | 'pull',
      status: { staged: number; modified: number; untracked: number },
    ) {
      super(`${operation} dirty`)
      this.name = 'DirtyWorktreeError'
      this.operation = operation
      this.status = status
    }
  },
  getFileAtRef: vi.fn().mockReturnValue(null),
  getFileContent: vi.fn().mockReturnValue(null),
  getCommitsBetween: vi.fn().mockReturnValue(''),
  getDiffStatsBetween: vi.fn().mockReturnValue(''),
  getCommitCount: vi.fn().mockReturnValue(0),
  getCommitsBehind: vi.fn().mockReturnValue(0),
  getStructuredDiffStatsBetween: vi.fn().mockReturnValue({ filesChanged: 0, insertions: 0, deletions: 0 }),
  getUnpushedCount: vi.fn().mockReturnValue(0),
  getUnpushedCountAsync: vi.fn().mockResolvedValue(0),
  getWorkingTreeStatus: vi.fn().mockReturnValue({ staged: 0, modified: 0, untracked: 0 }),
  getChangedFiles: vi.fn().mockReturnValue([]),
  getChangedFilesBetween: vi.fn().mockReturnValue([]),
  commitExists: vi.fn().mockReturnValue(true),
  EMPTY_TREE_SHA: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
  getUnpushedChangedFiles: vi.fn().mockReturnValue([]),
  listBranchCommits: vi.fn().mockReturnValue([]),
  listCommitsBehind: vi.fn().mockReturnValue([]),
  fetchSourceBranchAsync: vi.fn().mockResolvedValue(undefined),
  getCurrentBranch: vi.fn(),
  moveWorktree: vi.fn(),
  renameBranch: vi.fn(),
  branchExists: vi.fn().mockReturnValue(false),
  listBackupBranches: vi.fn().mockReturnValue([]),
  restoreBranchFromBackup: vi.fn(),
  getWorkingTreeFiles: vi.fn().mockReturnValue([]),
}))

vi.mock('../server/services/wakeup-service.js', () => ({
  schedule: vi.fn(),
  cancel: vi.fn(),
  rehydrate: vi.fn(),
  getPending: vi.fn(() => null),
}))

vi.mock('../server/services/cron-service.js', () => ({
  arm: vi.fn(),
  cancel: vi.fn(),
  listForWorkspace: vi.fn(),
  cancelAllForWorkspace: vi.fn(),
}))

vi.mock('../server/services/pr-watcher-service.js', () => ({
  getAllPrSnapshots: vi.fn(),
  getAllGitStats: vi.fn(() => ({})),
  refreshPrSnapshot: vi.fn(),
  startPrWatcher: vi.fn(),
  stopPrWatcher: vi.fn(),
}))

vi.mock('../server/services/forge/resolve.js', () => ({
  resolveForge: vi.fn(() => 'github'),
}))
const changePrBaseMock = vi.fn()
const createPrMock = vi.fn()
const getPrStatusMock = vi.fn().mockResolvedValue(null)
const changeSourceBranchMock = vi.fn()
vi.mock('../server/services/change-source-branch-service.js', () => ({
  changeSourceBranch: (...args: unknown[]) => changeSourceBranchMock(...args),
}))
vi.mock('../server/services/forge/registry.js', () => ({
  getForgeProvider: vi.fn(() => ({
    id: 'github',
    capabilities: { canCreatePr: true, canChangePrBase: true, requestTermShort: 'PR' },
    isAvailable: vi.fn(async () => ({ available: true })),
    changePrBase: changePrBaseMock,
    createPr: createPrMock,
    getPrStatus: getPrStatusMock,
  })),
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
  getProjectSettings: vi.fn(),
}))

vi.mock('../server/services/setup-script-service.js', () => ({
  runSetupScript: vi.fn(),
}))

vi.mock('../server/services/chat-history-service.js', () => ({
  listChatHistory: vi.fn().mockReturnValue([]),
  pushChatHistory: vi.fn(),
}))

vi.mock('../server/services/file-editor-service.js', () => ({
  saveWorkspaceFile: vi.fn(),
  shaOf: vi.fn((s: string) => `sha-${s.length}`),
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

import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import { getDb } from '../server/db/index.js'
import router from '../server/routes/workspaces.js'
import * as agentManager from '../server/services/agent/orchestrator.js'
import * as chatHistoryService from '../server/services/chat-history-service.js'
import * as cronService from '../server/services/cron-service.js'
import * as devServerService from '../server/services/dev-server-service.js'
import * as fileEditorService from '../server/services/file-editor-service.js'
import { getForgeProvider } from '../server/services/forge/registry.js'
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
  worktreePath: '/tmp/project/.worktrees/feature/test',
  worktreeOwned: true,
  status: 'idle' as const,
  notionUrl: null,
  notionPageId: null,
  model: 'claude-opus-4-6',
  reasoningEffort: 'auto',
  agentPermissionMode: 'bypass' as const,
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
  // Reset the async-fetch default (clearAllMocks wipes call history but some
  // tests below override with mockResolvedValueOnce — re-pin the baseline so
  // every test sees a resolved promise unless it explicitly opts in).
  vi.mocked(gitOps.fetchSourceBranchAsync).mockResolvedValue(undefined)
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
    notionMcpKey: '',
    sentryMcpKey: '',
    tags: [],
    worktreesPath: '.worktrees',
    worktreesPrefixByProject: false,
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
    expect(worktreeService.createWorktree).toHaveBeenCalledWith(
      '/tmp/project',
      'feature/test',
      'main',
      '.worktrees',
      undefined,
    )
    expect(agentManager.startAgent).toHaveBeenCalledOnce()
  })

  it('creates new workspaces under the configured global worktrees path', async () => {
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
      notionMcpKey: '',
      sentryMcpKey: '',
      tags: [],
      worktreesPath: '$HOME/kobo/worktress',
      worktreesPrefixByProject: false,
    })
    vi.mocked(workspaceService.createWorkspace).mockReturnValue(fakeWorkspace)
    vi.mocked(worktreeService.createWorktree).mockReturnValue('/home/test/kobo/worktress/feature/test')
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
    expect(workspaceService.createWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ worktreesPath: '$HOME/kobo/worktress' }),
    )
    expect(worktreeService.createWorktree).toHaveBeenCalledWith(
      '/tmp/project',
      'feature/test',
      'main',
      '$HOME/kobo/worktress',
      undefined,
    )
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
    // Workspace name is prefixed with the Notion ticket id when the user
    // didn't provide a custom name (placeholder name = "workspace").
    expect(workspaceService.updateWorkspaceName).toHaveBeenCalledWith('ws-1', 'TK-123 | Notion Page Title')
    // Ticket-ID injection now happens BEFORE createWorkspace, so the final
    // working branch is passed in directly — no follow-up updateWorkingBranch call.
    expect(workspaceService.createWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ workingBranch: 'feature/TK-123--notion-page-title' }),
    )
    expect(workspaceService.updateWorkingBranch).not.toHaveBeenCalled()
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

  it('POST / brainstorm prompt advertises kobo__set_workspace_agent_description with the user-description boundary', async () => {
    vi.mocked(workspaceService.createWorkspace).mockReturnValue(fakeWorkspace)
    vi.mocked(worktreeService.createWorktree).mockReturnValue('/tmp/worktree')
    vi.mocked(workspaceService.listTasks).mockReturnValue([])
    vi.mocked(workspaceService.getWorkspaceWithTasks).mockReturnValue(fakeWorkspaceWithTasks)

    const startSpy = vi.mocked(agentManager.startAgent)
    startSpy.mockClear()
    const res = await app.request('/api/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'workspace',
        projectPath: '/tmp/project',
        sourceBranch: 'main',
        workingBranch: 'feature/agent-desc-mention',
      }),
    })
    expect(res.status).toBe(201)
    expect(startSpy).toHaveBeenCalledTimes(1)
    // Third positional arg of startAgent(workspaceId, workingDir, prompt, …)
    const prompt = startSpy.mock.calls[0][2]
    expect(prompt).toMatch(/kobo__set_workspace_agent_description/)
    expect(prompt).toMatch(/short one-line summary/i)
    expect(prompt).not.toMatch(/kobo__set_workspace_description\b(?!_)/)
    expect(prompt).toMatch(/user[- ]controlled `?description`?[\s\S]*not touch/i)
  })

  it('accepts engine: codex on creation', async () => {
    vi.mocked(workspaceService.createWorkspace).mockReturnValue(fakeWorkspace)
    vi.mocked(worktreeService.createWorktree).mockReturnValue('/tmp/worktree')
    vi.mocked(workspaceService.listTasks).mockReturnValue([])
    vi.mocked(workspaceService.getWorkspaceWithTasks).mockReturnValue(fakeWorkspaceWithTasks)

    const res = await app.request('/api/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Codex Workspace',
        projectPath: '/tmp/project',
        sourceBranch: 'main',
        workingBranch: 'feature/codex',
        engine: 'codex',
      }),
    })

    expect(res.status).toBe(201)
    expect(workspaceService.createWorkspace).toHaveBeenCalledWith(expect.objectContaining({ engine: 'codex' }))
  })

  it('rejects unknown engine with 400', async () => {
    const res = await app.request('/api/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Bad Engine Workspace',
        projectPath: '/tmp/project',
        sourceBranch: 'main',
        workingBranch: 'feature/bad-engine',
        engine: 'gemini',
      }),
    })

    expect(res.status).toBe(400)
    const data = (await res.json()) as { error: string }
    expect(data.error).toMatch(/gemini/)
    expect(workspaceService.createWorkspace).not.toHaveBeenCalled()
  })

  it('rejects engine=codex paired with agentPermissionMode=interactive', async () => {
    // Codex does not expose a canUseTool-equivalent hook, so 'interactive'
    // would park the workspace in `awaiting-user` forever. The route must
    // refuse the combination up-front.
    const res = await app.request('/api/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Codex Interactive Workspace',
        projectPath: '/tmp/project',
        sourceBranch: 'main',
        workingBranch: 'feature/codex-interactive',
        engine: 'codex',
        agentPermissionMode: 'interactive',
      }),
    })

    expect(res.status).toBe(400)
    const data = (await res.json()) as { error: string }
    expect(data.error).toMatch(/codex/)
    expect(data.error).toMatch(/interactive/)
    expect(workspaceService.createWorkspace).not.toHaveBeenCalled()
  })
})

// ── Initial-prompt template injection (Notion + Sentry) ──────────────────────
// Eight tests covering the cascade `effective || DEFAULT` resolution in the
// route. The project/global cascade itself is unit-tested in settings-service —
// here we only exercise the route's single-fallback behaviour and the two
// injection points (Notion after `Local copy:`, Sentry after `Fix workflow:`).
describe('POST /api/workspaces — Notion/Sentry initial prompt injection', () => {
  // Defaults used as a reference inside assertions when the user template is
  // empty/whitespace and the route should fall back to the hard-coded prompt.
  const DEFAULT_NOTION =
    'For the Notion ticket {ticket_id}, systematically explore the linked sub-pages (sub-tickets, references, linked blocks) and enrich the local file {notion_file_path} with all relevant information you find before starting the work.'

  function mockEffectiveSettings(overrides: Record<string, unknown>) {
    vi.mocked(settingsService.getEffectiveSettings).mockReturnValue({
      model: 'auto',
      dangerouslySkipPermissions: true,
      prPromptTemplate: '',
      reviewPromptTemplate: '',
      gitConventions: '',
      sourceBranch: 'main',
      devServer: null,
      setupScript: '',
      notionStatusProperty: '',
      notionInProgressStatus: '',
      notionInitialPromptTemplate: '',
      sentryInitialPromptTemplate: '',
      ...overrides,
    } as never)
  }

  function mockNotionExtraction(opts: { ticketId: string }) {
    vi.mocked(notionService.extractNotionPage).mockResolvedValue({
      title: 'Some Page',
      ticketId: opts.ticketId,
      status: '',
      goal: '',
      todos: [],
      gherkinFeatures: [],
    })
    vi.mocked(notionService.parseNotionUrl).mockReturnValue('page-1')
  }

  async function mockSentryExtraction(opts: { issueId: string }) {
    const sentryService = await import('../server/services/sentry-service.js')
    vi.mocked(sentryService.extractSentryIssue).mockResolvedValue({
      title: 'crash',
      issueId: opts.issueId,
      issueNumericId: '42',
      culprit: 'fn',
      url: 'https://my-org.sentry.io/issues/42',
      platform: 'js',
      occurrences: 1,
      firstSeen: '2026-01-01',
      lastSeen: '2026-01-02',
      tags: {},
      offendingSpans: [],
      extraContext: '',
      assignee: '',
    })
  }

  function commonHappyPathMocks() {
    // The body sends `name: 'workspace'` (the placeholder that triggers the
    // Notion/Sentry rename branch in the route). createWorkspace returns the
    // raw row with that placeholder; updateWorkspaceName + updateWorkingBranch
    // both must return a complete workspace object since the route reassigns
    // the local `workspace` variable from their return values.
    vi.mocked(workspaceService.createWorkspace).mockReturnValue({
      ...fakeWorkspace,
      name: 'workspace',
    })
    vi.mocked(workspaceService.updateWorkspaceName).mockReturnValue({
      ...fakeWorkspace,
      name: 'Renamed by Notion/Sentry',
    } as never)
    vi.mocked(workspaceService.updateWorkingBranch).mockReturnValue({
      ...fakeWorkspace,
      name: 'Renamed by Notion/Sentry',
    } as never)
    vi.mocked(worktreeService.createWorktree).mockReturnValue('/tmp/wt')
    vi.mocked(workspaceService.listTasks).mockReturnValue([])
    vi.mocked(workspaceService.getWorkspaceWithTasks).mockReturnValue(fakeWorkspaceWithTasks)
  }

  function getCapturedPrompt(): string {
    expect(agentManager.startAgent).toHaveBeenCalled()
    const startCall = vi.mocked(agentManager.startAgent).mock.calls[0]
    return startCall?.[2] as string
  }

  it('appends the rendered Notion initial prompt after the Local copy line when notionUrl is set', async () => {
    commonHappyPathMocks()
    mockNotionExtraction({ ticketId: 'TK-1' })
    mockEffectiveSettings({ notionInitialPromptTemplate: 'CUSTOM_NOTION {ticket_id}' })

    const res = await app.request('/api/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'workspace',
        projectPath: '/tmp/project',
        sourceBranch: 'main',
        workingBranch: 'feature/test',
        notionUrl: 'https://notion.so/page-1',
      }),
    })

    expect(res.status).toBe(201)
    const prompt = getCapturedPrompt()
    // The Notion render lands immediately after the Local copy line.
    expect(prompt).toMatch(/Local copy: [^\n]+\n\nCUSTOM_NOTION TK-1\n/)
  })

  it('appends the rendered Sentry initial prompt after the Fix workflow paragraph when sentryUrl is set', async () => {
    commonHappyPathMocks()
    await mockSentryExtraction({ issueId: 'ACME-API-3' })
    mockEffectiveSettings({ sentryInitialPromptTemplate: 'CUSTOM_SENTRY {issue_id}' })

    const res = await app.request('/api/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'workspace',
        projectPath: '/tmp/project',
        sourceBranch: 'main',
        workingBranch: 'feature/test',
        sentryUrl: 'https://my-org.sentry.io/issues/42/',
      }),
    })

    expect(res.status).toBe(201)
    const prompt = getCapturedPrompt()
    // The render lands after the Sentry MCP tag-values bullet (last line of the
    // Fix workflow block).
    expect(prompt).toContain('filter by tag\n\nCUSTOM_SENTRY ACME-API-3\n')
    // Notion absent → no notion render either.
    expect(prompt).not.toContain('Notion ticket:')
  })

  it('appends both Notion and Sentry rendered prompts (Notion before Sentry) when both URLs are set', async () => {
    commonHappyPathMocks()
    mockNotionExtraction({ ticketId: 'TK-9' })
    await mockSentryExtraction({ issueId: 'PROJ-1' })
    mockEffectiveSettings({
      notionInitialPromptTemplate: 'NTPL {ticket_id}',
      sentryInitialPromptTemplate: 'STPL {issue_id}',
    })

    const res = await app.request('/api/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'workspace',
        projectPath: '/tmp/project',
        sourceBranch: 'main',
        workingBranch: 'feature/test',
        notionUrl: 'https://notion.so/page-1',
        sentryUrl: 'https://my-org.sentry.io/issues/42/',
      }),
    })

    expect(res.status).toBe(201)
    const prompt = getCapturedPrompt()
    expect(prompt).toContain('NTPL TK-9')
    expect(prompt).toContain('STPL PROJ-1')
    const notionIdx = prompt.indexOf('NTPL TK-9')
    const sentryIdx = prompt.indexOf('STPL PROJ-1')
    expect(notionIdx).toBeLessThan(sentryIdx)
  })

  it('renders the project Notion template (project override beats global)', async () => {
    commonHappyPathMocks()
    mockNotionExtraction({ ticketId: 'TK-2' })
    // The project/global cascade is computed inside getEffectiveSettings —
    // here we simulate the post-cascade outcome: the project override wins.
    mockEffectiveSettings({ notionInitialPromptTemplate: 'PROJ' })

    const res = await app.request('/api/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'workspace',
        projectPath: '/tmp/project',
        sourceBranch: 'main',
        workingBranch: 'feature/test',
        notionUrl: 'https://notion.so/page-1',
      }),
    })

    expect(res.status).toBe(201)
    const prompt = getCapturedPrompt()
    expect(prompt).toContain('PROJ')
    expect(prompt).not.toContain('GLOBAL')
  })

  it('treats a whitespace-only Notion template as an escape hatch (project " ", global "GLOBAL")', async () => {
    commonHappyPathMocks()
    mockNotionExtraction({ ticketId: 'TK-3' })
    // Whitespace-only effective value → no injection, even though the route
    // fallback to DEFAULT only triggers on empty string.
    mockEffectiveSettings({ notionInitialPromptTemplate: ' ' })

    const res = await app.request('/api/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'workspace',
        projectPath: '/tmp/project',
        sourceBranch: 'main',
        workingBranch: 'feature/test',
        notionUrl: 'https://notion.so/page-1',
      }),
    })

    expect(res.status).toBe(201)
    const prompt = getCapturedPrompt()
    // No render: the Local copy line is followed by the next prompt section,
    // not by a rendered template, and DEFAULT_NOTION must NOT appear.
    expect(prompt).not.toContain('GLOBAL')
    expect(prompt).not.toContain(DEFAULT_NOTION)
    // Sanity check: Notion section was emitted (Local copy line present).
    expect(prompt).toMatch(/Local copy: /)
  })

  it('treats a whitespace-only global Notion template as an escape hatch (project "", global " ")', async () => {
    commonHappyPathMocks()
    mockNotionExtraction({ ticketId: 'TK-4' })
    // After the project/global cascade inside getEffectiveSettings, the
    // resulting effective value is the whitespace-only global string.
    mockEffectiveSettings({ notionInitialPromptTemplate: ' ' })

    const res = await app.request('/api/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'workspace',
        projectPath: '/tmp/project',
        sourceBranch: 'main',
        workingBranch: 'feature/test',
        notionUrl: 'https://notion.so/page-1',
      }),
    })

    expect(res.status).toBe(201)
    const prompt = getCapturedPrompt()
    expect(prompt).not.toContain(DEFAULT_NOTION)
  })

  it('falls back to DEFAULT_NOTION_INITIAL_PROMPT when both project and global are empty strings', async () => {
    commonHappyPathMocks()
    mockNotionExtraction({ ticketId: 'TK-5' })
    // Empty effective string → route falls back to the hard-coded default.
    mockEffectiveSettings({ notionInitialPromptTemplate: '' })

    const res = await app.request('/api/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'workspace',
        projectPath: '/tmp/project',
        sourceBranch: 'main',
        workingBranch: 'feature/test',
        notionUrl: 'https://notion.so/page-1',
      }),
    })

    expect(res.status).toBe(201)
    const prompt = getCapturedPrompt()
    // The default template substitutes {ticket_id} and {notion_file_path}; we
    // assert on a stable substring that only appears in the rendered default.
    expect(prompt).toContain('MANDATORY context-enrichment for Notion ticket TK-5')
  })

  it('does NOT inject the Notion template when notionFilePath ends up null (file-write failure)', async () => {
    commonHappyPathMocks()
    mockNotionExtraction({ ticketId: 'TK-6' })
    mockEffectiveSettings({ notionInitialPromptTemplate: 'CUSTOM {ticket_id}' })
    // Force notionFilePath to remain null by making the directory creation
    // throw BEFORE the route assigns notionFilePath. The catch swallows the
    // error so the workspace is still created — only the Notion section of
    // the brainstorm prompt is skipped. Restore the default no-op impl after
    // the assertion to avoid leaking the throw into sibling tests (vi.clearAllMocks
    // resets call history, NOT mockImplementation).
    const mkdirSpy = vi.mocked(fs.mkdirSync).mockImplementation((p) => {
      if (typeof p === 'string' && p.includes('thoughts')) {
        throw new Error('ENOSPC: no space left on device')
      }
      return undefined
    })

    const res = await app.request('/api/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'workspace',
        projectPath: '/tmp/project',
        sourceBranch: 'main',
        workingBranch: 'feature/test',
        notionUrl: 'https://notion.so/page-1',
      }),
    })

    expect(res.status).toBe(201)
    const prompt = getCapturedPrompt()
    // Custom template is non-empty AND notion extraction succeeded, but the
    // file-write failure means the Notion block (Local copy:) is absent and
    // the rendered prompt MUST NOT appear.
    expect(prompt).not.toContain('CUSTOM TK-6')
    expect(prompt).not.toContain('Local copy:')
    // Reset the throwing implementation so it doesn't leak into sibling tests.
    mkdirSpy.mockImplementation(() => undefined)
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

describe('POST /api/workspaces/:id/agent-description/notify-updated', () => {
  beforeEach(() => vi.clearAllMocks())

  it('emits workspace:agent-description-updated with the current value and returns 204', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue({
      id: 'ws-1',
      agentDescription: 'Live status',
    } as never)

    const res = await app.request('/api/workspaces/ws-1/agent-description/notify-updated', {
      method: 'POST',
    })

    expect(res.status).toBe(204)
    expect(wsService.emitEphemeral).toHaveBeenCalledWith('ws-1', 'workspace:agent-description-updated', {
      agentDescription: 'Live status',
    })
  })

  it('emits null when agentDescription is cleared', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue({
      id: 'ws-1',
      agentDescription: null,
    } as never)

    const res = await app.request('/api/workspaces/ws-1/agent-description/notify-updated', {
      method: 'POST',
    })

    expect(res.status).toBe(204)
    expect(wsService.emitEphemeral).toHaveBeenCalledWith('ws-1', 'workspace:agent-description-updated', {
      agentDescription: null,
    })
  })

  it('returns 404 when workspace is unknown', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(null as never)

    const res = await app.request('/api/workspaces/unknown/agent-description/notify-updated', {
      method: 'POST',
    })

    expect(res.status).toBe(404)
    expect(wsService.emitEphemeral).not.toHaveBeenCalled()
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
    expect(data.error).toContain('Missing field: status, model, reasoningEffort, agentPermissionMode,')
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

describe('PATCH /api/workspaces/:id — description', () => {
  it('updates the description and returns 200 with the updated workspace', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(fakeWorkspace)
    vi.mocked(workspaceService.updateWorkspaceDescription).mockReturnValue({
      ...fakeWorkspace,
      description: 'Investigating SERVICE-1600',
    } as never)

    const res = await app.request('/api/workspaces/ws-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: 'Investigating SERVICE-1600' }),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as { description: string }
    expect(body.description).toBe('Investigating SERVICE-1600')
    expect(workspaceService.updateWorkspaceDescription).toHaveBeenCalledWith('ws-1', 'Investigating SERVICE-1600')
  })

  it('returns 400 when description exceeds 200 chars', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(fakeWorkspace)
    vi.mocked(workspaceService.updateWorkspaceDescription).mockImplementation(() => {
      throw new Error('Description must be 200 characters or fewer (got 201)')
    })

    const res = await app.request('/api/workspaces/ws-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: 'x'.repeat(201) }),
    })

    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/200/)
  })

  it('returns 404 when workspace not found', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(null)

    const res = await app.request('/api/workspaces/does-not-exist', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: 'hi' }),
    })

    expect(res.status).toBe(404)
  })

  it('accepts null to clear the description', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(fakeWorkspace)
    vi.mocked(workspaceService.updateWorkspaceDescription).mockReturnValue({
      ...fakeWorkspace,
      description: null,
    } as never)

    const res = await app.request('/api/workspaces/ws-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: null }),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as { description: string | null }
    expect(body.description).toBeNull()
    expect(workspaceService.updateWorkspaceDescription).toHaveBeenCalledWith('ws-1', null)
  })
})

describe('PATCH /api/workspaces/:id — rejects agent_description', () => {
  it('returns 400 when the body contains agent_description', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(fakeWorkspace)

    const res = await app.request('/api/workspaces/ws-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_description: 'attempt to bypass MCP' }),
    })

    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/agent_description/i)
    expect(body.error).toMatch(/MCP/i)
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
      'bypass',
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
      'bypass',
      undefined,
      'auto',
    )
  })

  it('falls back to pending initial_prompt when no body.prompt is provided', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue({
      ...fakeWorkspace,
      initialPrompt: 'Pending brainstorm prompt after setup-script crash',
    } as never)
    vi.mocked(workspaceService.updateWorkspaceStatus).mockReturnValue({
      ...fakeWorkspace,
      status: 'executing',
    })

    const res = await app.request('/api/workspaces/ws-1/start', { method: 'POST' })

    expect(res.status).toBe(200)
    const [, , promptArg] = vi.mocked(agentManager.startAgent).mock.calls[0]
    expect(promptArg).toBe('Pending brainstorm prompt after setup-script crash')
    // Cleared after the agent has been handed the prompt.
    expect(workspaceService.clearInitialPrompt).toHaveBeenCalledWith('ws-1')
  })

  it('body.prompt wins over pending initial_prompt', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue({
      ...fakeWorkspace,
      initialPrompt: 'should be ignored',
    } as never)
    vi.mocked(workspaceService.updateWorkspaceStatus).mockReturnValue({
      ...fakeWorkspace,
      status: 'executing',
    })

    const res = await app.request('/api/workspaces/ws-1/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'explicit user prompt' }),
    })

    expect(res.status).toBe(200)
    const [, , promptArg] = vi.mocked(agentManager.startAgent).mock.calls[0]
    expect(promptArg).toBe('explicit user prompt')
    // Even when an explicit prompt wins, the pending initial_prompt is still
    // cleared so the next /:id/start without body.prompt doesn't replay it.
    expect(workspaceService.clearInitialPrompt).toHaveBeenCalledWith('ws-1')
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

  it('keeps the worktree on disk when the workspace is not owned', async () => {
    // Reused/attached external worktrees: Kōbō did not create the dir, so it
    // must not delete it on the user's behalf. The DB row is still removed.
    vi.mocked(workspaceService.getWorkspace).mockReturnValue({
      ...fakeWorkspace,
      worktreeOwned: false,
      worktreePath: '/tmp/external/foo',
    })

    const res = await app.request('/api/workspaces/ws-1', { method: 'DELETE' })

    expect(res.status).toBe(204)
    expect(vi.mocked(worktreeService.removeWorktree)).not.toHaveBeenCalled()
    expect(vi.mocked(workspaceService.deleteWorkspace)).toHaveBeenCalledWith('ws-1')
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

describe('DELETE /api/workspaces/archived', () => {
  beforeEach(() => {
    // The DELETE /:id suite above leaves removeWorktree throwing — vi.clearAllMocks
    // resets call history but not implementations, so restore the no-ops here.
    vi.mocked(worktreeService.removeWorktree).mockReset()
    vi.mocked(workspaceService.deleteWorkspace).mockReset()
  })

  const archivedA = {
    ...fakeWorkspace,
    id: 'ws-arch-1',
    name: 'Archived A',
    workingBranch: 'feature/a',
    archivedAt: '2026-04-05T10:00:00.000Z',
  }
  const archivedB = {
    ...fakeWorkspace,
    id: 'ws-arch-2',
    name: 'Archived B',
    workingBranch: 'feature/b',
    archivedAt: '2026-04-04T10:00:00.000Z',
  }

  it('bulk-deletes every archived workspace with full cleanup', async () => {
    vi.mocked(workspaceService.listArchivedWorkspaces).mockReturnValue([archivedA, archivedB])

    const res = await app.request('/api/workspaces/archived', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deleteLocalBranch: true, deleteRemoteBranch: true }),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; deleted: number; warnings: string[] }
    expect(body.ok).toBe(true)
    expect(body.deleted).toBe(2)
    expect(body.warnings).toEqual([])
    expect(workspaceService.deleteWorkspace).toHaveBeenCalledWith('ws-arch-1')
    expect(workspaceService.deleteWorkspace).toHaveBeenCalledWith('ws-arch-2')
    expect(gitOps.deleteLocalBranch).toHaveBeenCalledWith('/tmp/project', 'feature/a')
    expect(gitOps.deleteRemoteBranch).toHaveBeenCalledWith('/tmp/project', 'feature/b')
  })

  it('does not touch branches when no options are passed', async () => {
    vi.mocked(workspaceService.listArchivedWorkspaces).mockReturnValue([archivedA])

    const res = await app.request('/api/workspaces/archived', { method: 'DELETE' })

    expect(res.status).toBe(200)
    expect(gitOps.deleteLocalBranch).not.toHaveBeenCalled()
    expect(gitOps.deleteRemoteBranch).not.toHaveBeenCalled()
    expect(workspaceService.deleteWorkspace).toHaveBeenCalledWith('ws-arch-1')
  })

  it('returns deleted: 0 when there are no archived workspaces', async () => {
    vi.mocked(workspaceService.listArchivedWorkspaces).mockReturnValue([])

    const res = await app.request('/api/workspaces/archived', { method: 'DELETE' })

    expect(res.status).toBe(200)
    const body = (await res.json()) as { deleted: number; warnings: string[] }
    expect(body.deleted).toBe(0)
    expect(body.warnings).toEqual([])
    expect(workspaceService.deleteWorkspace).not.toHaveBeenCalled()
  })

  it('keeps deleting the rest of the batch when one workspace fails', async () => {
    vi.mocked(workspaceService.listArchivedWorkspaces).mockReturnValue([archivedA, archivedB])
    vi.mocked(workspaceService.deleteWorkspace).mockImplementation((id: string) => {
      if (id === 'ws-arch-1') throw new Error('DB locked')
    })

    const res = await app.request('/api/workspaces/archived', { method: 'DELETE' })

    expect(res.status).toBe(200)
    const body = (await res.json()) as { deleted: number; warnings: string[] }
    expect(body.deleted).toBe(1)
    expect(body.warnings.join('\n')).toContain('Archived A')
    expect(workspaceService.deleteWorkspace).toHaveBeenCalledWith('ws-arch-2')
  })

  it('is not matched by DELETE /:id (route order regression)', async () => {
    vi.mocked(workspaceService.listArchivedWorkspaces).mockReturnValue([])

    const res = await app.request('/api/workspaces/archived', { method: 'DELETE' })

    expect(res.status).toBe(200)
    expect(workspaceService.listArchivedWorkspaces).toHaveBeenCalled()
    // DELETE /:id resolves the target via getWorkspace — if it ran, order regressed.
    expect(workspaceService.getWorkspace).not.toHaveBeenCalled()
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
    expect(vi.mocked(gitOps.pullBranch)).toHaveBeenCalledWith(
      expect.stringContaining('.worktrees'),
      'feature/test',
      'origin',
      { autostash: false },
    )
  })

  it('returns 404 when workspace not found', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(null as never)
    const res = await app.request('/api/workspaces/unknown/pull', { method: 'POST' })
    expect(res.status).toBe(404)
  })

  it('maps DirtyWorktreeError to 409 with code dirty_worktree on pull', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue({
      ...fakeWorkspace,
      workingBranch: 'feature/test',
      projectPath: '/tmp/project',
    } as never)
    vi.mocked(gitOps.pullBranch).mockImplementation(() => {
      throw new gitOps.DirtyWorktreeError('pull', { staged: 0, modified: 2, untracked: 0 })
    })

    const res = await app.request('/api/workspaces/ws-1/pull', { method: 'POST' })

    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.code).toBe('dirty_worktree')
    expect(body.operation).toBe('pull')
    expect(body.status).toEqual({ staged: 0, modified: 2, untracked: 0 })
  })

  it('passes autostash:true to pullBranch when ?autostash=1', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue({
      ...fakeWorkspace,
      workingBranch: 'feature/test',
      projectPath: '/tmp/project',
    } as never)
    vi.mocked(gitOps.pullBranch).mockReturnValue(undefined)

    const res = await app.request('/api/workspaces/ws-1/pull?autostash=1', { method: 'POST' })

    expect(res.status).toBe(200)
    expect(vi.mocked(gitOps.pullBranch)).toHaveBeenCalledWith(
      expect.stringContaining('.worktrees'),
      'feature/test',
      'origin',
      {
        autostash: true,
      },
    )
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
    createPrMock.mockReset()
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
    // Default: branch is on remote and up-to-date
    execFilePromiseMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('ls-remote')) return Promise.resolve({ stdout: 'abc refs/heads/feature/test\n' })
      if (args.includes('rev-list')) return Promise.resolve({ stdout: '0\n' })
      return Promise.resolve({ stdout: '' })
    })
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

  it('open-pr creates the PR via the resolved forge provider', async () => {
    createPrMock.mockResolvedValueOnce({ url: 'https://github.com/o/r/pull/5', number: 5 })

    const res = await app.request('/api/workspaces/ws-1/open-pr', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(createPrMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ base: expect.any(String), head: expect.any(String) }),
    )
    const data = await res.json()
    expect(data.prNumber).toBe(5)
    expect(data.prUrl).toBe('https://github.com/o/r/pull/5')
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

    createPrMock.mockResolvedValueOnce({ url: 'https://github.com/org/repo/pull/42', number: 42 })

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

    createPrMock.mockResolvedValueOnce({ url: 'https://github.com/org/repo/pull/42', number: 42 })

    const res = await app.request('/api/workspaces/ws-1/open-pr', { method: 'POST' })

    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.prNumber).toBe(42)
    expect(data.messageSent).toBe(false)
    expect(vi.mocked(agentManager.sendMessage)).not.toHaveBeenCalled()
  })

  it('returns 500 when createPr fails', async () => {
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

    createPrMock.mockRejectedValueOnce(new Error('auth required'))

    const res = await app.request('/api/workspaces/ws-1/open-pr', { method: 'POST' })

    expect(res.status).toBe(500)
    const data = await res.json()
    expect(data.error).toContain('auth required')
  })

  it('returns 409 forge_unsupported when canCreatePr is false', async () => {
    vi.mocked(getForgeProvider).mockReturnValueOnce({
      id: 'github',
      capabilities: { canCreatePr: false, canChangePrBase: true, requestTermShort: 'PR' },
      isAvailable: vi.fn(async () => ({ available: true })),
      changePrBase: changePrBaseMock,
      createPr: createPrMock,
    } as never)

    const res = await app.request('/api/workspaces/ws-1/open-pr', { method: 'POST' })

    expect(res.status).toBe(409)
    const data = await res.json()
    expect(data.code).toBe('forge_unsupported')
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

    createPrMock.mockResolvedValueOnce({ url: 'https://github.com/org/repo/pull/42', number: 42 })

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
    vi.mocked(prWatcher.getAllPrSnapshots).mockReturnValue({
      w1: { number: 1, state: 'OPEN' } as never,
      w2: { number: 2, state: 'CLOSED' } as never,
    })

    const res = await app.request('/api/workspaces/pr-states')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      w1: { number: 1, state: 'OPEN' },
      w2: { number: 2, state: 'CLOSED' },
    })
  })

  it('returns an empty object when no PRs are known', async () => {
    const prWatcher = await import('../server/services/pr-watcher-service.js')
    vi.mocked(prWatcher.getAllPrSnapshots).mockReturnValue({})

    const res = await app.request('/api/workspaces/pr-states')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({})
  })

  it('is not matched by GET /:id (route order regression)', async () => {
    const prWatcher = await import('../server/services/pr-watcher-service.js')
    vi.mocked(prWatcher.getAllPrSnapshots).mockReturnValue({})
    vi.mocked(workspaceService.getWorkspaceWithTasks).mockReturnValue(null)

    const res = await app.request('/api/workspaces/pr-states')
    expect(res.status).toBe(200)
    expect(prWatcher.getAllPrSnapshots).toHaveBeenCalled()
    expect(workspaceService.getWorkspaceWithTasks).not.toHaveBeenCalled()
  })

  it('GET /info returns workspaces, prSnapshots and gitStats', async () => {
    const prWatcher = await import('../server/services/pr-watcher-service.js')
    vi.mocked(workspaceService.listWorkspaces).mockReturnValue([{ id: 'ws-1', name: 'w' }] as never)
    vi.mocked(prWatcher.getAllPrSnapshots).mockReturnValue({ 'ws-1': { number: 1 } } as never)
    vi.mocked(prWatcher.getAllGitStats).mockReturnValue({ 'ws-1': { commitCount: 4 } } as never)

    const res = await app.request('/api/workspaces/info')

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.workspaces).toEqual([{ id: 'ws-1', name: 'w' }])
    expect(body.prSnapshots).toEqual({ 'ws-1': { number: 1 } })
    expect(body.gitStats).toEqual({ 'ws-1': { commitCount: 4 } })
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
    getPrStatusMock.mockResolvedValue({ state: 'OPEN', url: 'https://github.com/org/repo/pull/1' })

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

describe('GET /:id/git-stats — extended', () => {
  beforeEach(() => vi.clearAllMocks())

  it('includes behindCount in the response payload', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(fakeWorkspace)
    vi.mocked(gitOps.getCommitsBehind).mockReturnValue(7)
    const res = await app.request('/api/workspaces/ws-1/git-stats')
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.behindCount).toBe(7)
  })

  it('with ?freshFetch=1 awaits fetchSourceBranchAsync before reading refs', async () => {
    let fetchResolved = false
    let fetchResolver!: () => void
    vi.mocked(gitOps.fetchSourceBranchAsync).mockReturnValue(
      new Promise<void>((resolve) => {
        fetchResolver = () => {
          fetchResolved = true
          resolve()
        }
      }),
    )
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(fakeWorkspace)

    const responsePromise = app.request('/api/workspaces/ws-1/git-stats?freshFetch=1')
    await new Promise((r) => setImmediate(r))
    const settled = await Promise.race([
      responsePromise.then(() => 'response'),
      new Promise((r) => setTimeout(() => r('timeout'), 50)),
    ])
    expect(settled).toBe('timeout')
    expect(fetchResolved).toBe(false)

    fetchResolver()
    const res = await responsePromise
    expect(res.status).toBe(200)
  })

  it('without freshFetch kicks fire-and-forget and responds immediately', async () => {
    vi.mocked(gitOps.fetchSourceBranchAsync).mockReturnValue(
      new Promise<void>(() => {
        /* never resolves */
      }),
    )
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(fakeWorkspace)

    const res = (await Promise.race([
      app.request('/api/workspaces/ws-1/git-stats'),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 1000)),
    ])) as Response
    expect(res.status).toBe(200)
  })

  it('does not produce an unhandled rejection when fire-and-forget fetch fails', async () => {
    const handler = vi.fn()
    process.on('unhandledRejection', handler)
    try {
      vi.mocked(gitOps.fetchSourceBranchAsync).mockRejectedValue(new Error('boom'))
      vi.mocked(workspaceService.getWorkspace).mockReturnValue(fakeWorkspace)
      await app.request('/api/workspaces/ws-1/git-stats')
      await new Promise((r) => setImmediate(r))
      await new Promise((r) => setImmediate(r))
      expect(handler).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', handler)
    }
  })
})

describe('GET /api/workspaces/:id/git-stats — forge block', () => {
  beforeEach(() => vi.clearAllMocks())

  it('git-stats response includes the resolved forge block', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(fakeWorkspace)
    vi.mocked(gitOps.getCommitCount).mockReturnValue(0)
    vi.mocked(gitOps.getCommitsBehind).mockReturnValue(0)
    vi.mocked(gitOps.getStructuredDiffStatsBetween).mockReturnValue({
      filesChanged: 0,
      insertions: 0,
      deletions: 0,
    })
    getPrStatusMock.mockResolvedValue(null)

    const res = await app.request('/api/workspaces/ws-1/git-stats')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.forge).toMatchObject({
      id: 'github',
      capabilities: { requestTermShort: 'PR' },
      availability: { available: true },
    })
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
    vi.mocked(workspaceService.getWorkspace).mockReturnValue({ ...fakeWorkspace, agentPermissionMode: 'bypass' } as any)
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
      'bypass',
      'sess-idle-1',
      'auto',
    )
  })

  it('passe undefined si agentSessionId absent', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue({ ...fakeWorkspace, agentPermissionMode: 'bypass' } as any)
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
      'bypass',
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
      worktreePath: '/p/.worktrees/feature/x',
      worktreeOwned: true,
      status: 'idle',
      model: 'auto',
      engine: 'claude-code',
      reasoningEffort: 'auto',
      agentPermissionMode: 'bypass',
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
    expect(gitOps.getChangedFiles).toHaveBeenCalledWith(expect.any(String), 'develop', false)
    expect(gitOps.getUnpushedChangedFiles).not.toHaveBeenCalled()
  })

  it('forwards includeUntracked=1 query param to getChangedFiles', async () => {
    vi.mocked(gitOps.getChangedFiles).mockReturnValue([])
    const res = await app.request('/api/workspaces/w1/diff?includeUntracked=1')
    expect(res.status).toBe(200)
    expect(gitOps.getChangedFiles).toHaveBeenCalledWith(expect.any(String), 'develop', true)
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
      worktreePath: '/p/.worktrees/feature/x',
      worktreeOwned: true,
      status: 'idle',
      model: 'auto',
      engine: 'claude-code',
      reasoningEffort: 'auto',
      agentPermissionMode: 'bypass',
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
    expect(body.modifiedSha).toBe(`sha-${body.modified.length}`)
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
      worktreePath: '/p/.worktrees/feature/x',
      worktreeOwned: true,
      status: 'idle',
      model: 'auto',
      engine: 'claude-code',
      reasoningEffort: 'auto',
      agentPermissionMode: 'bypass',
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

describe('GET /:id/branch-divergence', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 404 when workspace is missing', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(null as never)
    const res = await app.request('/api/workspaces/missing/branch-divergence')
    expect(res.status).toBe(404)
  })

  it('returns ahead and behind lists with branch metadata', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(fakeWorkspace)
    vi.mocked(gitOps.listBranchCommits).mockReturnValue([
      {
        sha: 'a'.repeat(40),
        shortSha: 'aaaaaaa',
        subject: 'feat: a',
        author: 'u',
        date: '2026-01-01',
        isPushed: true,
      },
    ] as never)
    vi.mocked(gitOps.listCommitsBehind).mockReturnValue([
      { sha: 'b'.repeat(40), shortSha: 'bbbbbbb', subject: 'fix: b', author: 'u', date: '2026-01-02' },
    ])
    const res = await app.request('/api/workspaces/ws-1/branch-divergence')
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.ahead).toHaveLength(1)
    expect(data.behind).toHaveLength(1)
    expect(data.sourceBranch).toBe(fakeWorkspace.sourceBranch)
    expect(data.workingBranch).toBe(fakeWorkspace.workingBranch)
  })

  it('clamps limit to [1, 200]', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(fakeWorkspace)
    vi.mocked(gitOps.listBranchCommits).mockReturnValue([] as never)
    vi.mocked(gitOps.listCommitsBehind).mockReturnValue([])

    await app.request('/api/workspaces/ws-1/branch-divergence?limit=0')
    expect(vi.mocked(gitOps.listBranchCommits).mock.calls[0][3]).toBe(1)
    expect(vi.mocked(gitOps.listCommitsBehind).mock.calls[0][3]).toBe(1)

    vi.mocked(gitOps.listBranchCommits).mockClear()
    vi.mocked(gitOps.listCommitsBehind).mockClear()

    await app.request('/api/workspaces/ws-1/branch-divergence?limit=999')
    expect(vi.mocked(gitOps.listBranchCommits).mock.calls[0][3]).toBe(200)
    expect(vi.mocked(gitOps.listCommitsBehind).mock.calls[0][3]).toBe(200)
  })

  it('returns 500 when git ops throw unexpectedly', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(fakeWorkspace)
    vi.mocked(gitOps.listBranchCommits).mockImplementation(() => {
      throw new Error('boom')
    })
    const res = await app.request('/api/workspaces/ws-1/branch-divergence')
    expect(res.status).toBe(500)
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

describe('POST /api/workspaces/:id/pending-wakeup', () => {
  it('pins the wakeup to the active session and returns the resulting pending entry', async () => {
    vi.mocked(agentManager.getActiveSessionId).mockReturnValue('sess-42')
    vi.mocked(wakeupService.getPending).mockReturnValue({ targetAt: '2026-04-22T10:00:00Z', reason: 'CI' })
    const res = await app.request('/api/workspaces/w1/pending-wakeup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ delaySeconds: 120, prompt: 'check the build', reason: 'CI' }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, pending: { targetAt: '2026-04-22T10:00:00Z', reason: 'CI' } })
    expect(wakeupService.schedule).toHaveBeenCalledWith('w1', 120, 'check the build', 'CI', 'sess-42')
  })

  it('rejects with 409 when no active session exists for the workspace', async () => {
    vi.mocked(agentManager.getActiveSessionId).mockReturnValue(undefined)
    const res = await app.request('/api/workspaces/w1/pending-wakeup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ delaySeconds: 60, prompt: 'check' }),
    })
    expect(res.status).toBe(409)
    expect(wakeupService.schedule).not.toHaveBeenCalled()
  })

  it('rejects a missing/invalid delaySeconds with 400', async () => {
    vi.mocked(agentManager.getActiveSessionId).mockReturnValue('sess-42')
    const res = await app.request('/api/workspaces/w1/pending-wakeup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'check' }),
    })
    expect(res.status).toBe(400)
    expect(wakeupService.schedule).not.toHaveBeenCalled()
  })

  it('rejects a missing prompt with 400', async () => {
    vi.mocked(agentManager.getActiveSessionId).mockReturnValue('sess-42')
    const res = await app.request('/api/workspaces/w1/pending-wakeup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ delaySeconds: 60, prompt: '   ' }),
    })
    expect(res.status).toBe(400)
    expect(wakeupService.schedule).not.toHaveBeenCalled()
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
      agentPermissionMode: 'bypass',
      devServerStatus: 'stopped',
      hasUnread: false,
      archivedAt: null,
      favoritedAt: null,
      tags: [],
      engine: 'claude-code',
      autoLoop: false,
      autoLoopReady: false,
      noProgressStreak: 0,
      // legacy field removed
      worktreePath: '/tmp/project/.worktrees/feature/old-name',
      worktreeOwned: true,
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
    expect(vi.mocked(workspaceService.updateWorktreePath)).toHaveBeenCalledWith(
      'w1',
      '/tmp/project/.worktrees/feature/new-name',
    )
    expect(vi.mocked(workspaceService.updateWorkingBranch)).toHaveBeenCalledWith('w1', 'feature/new-name')
  })

  it('moves a Windows worktree directory when the branch has been renamed in git', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue({
      ...fakeWorkspace,
      id: 'w-win',
      projectPath: 'C:\\repo',
      workingBranch: 'feature/old-name',
      worktreePath: 'D:\\kobo\\worktrees\\feature\\old-name',
    })
    vi.mocked(gitOps.getCurrentBranch).mockReturnValue('feature/new-name')
    vi.mocked(workspaceService.updateWorkingBranch).mockReturnValue({
      workingBranch: 'feature/new-name',
    } as never)

    const res = await app.request('/api/workspaces/w-win/resync-branch', { method: 'POST' })

    expect(res.status).toBe(200)
    expect(vi.mocked(gitOps.moveWorktree)).toHaveBeenCalledWith(
      'C:\\repo',
      'D:\\kobo\\worktrees\\feature\\old-name',
      'D:\\kobo\\worktrees\\feature\\new-name',
    )
    expect(vi.mocked(workspaceService.updateWorktreePath)).toHaveBeenCalledWith(
      'w-win',
      'D:\\kobo\\worktrees\\feature\\new-name',
    )
  })

  it('rejects with 400 when the workspace is not owned', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue({
      ...fakeWorkspace,
      worktreeOwned: false,
      worktreePath: '/tmp/external/foo',
    })

    const res = await app.request('/api/workspaces/ws-1/resync-branch', { method: 'POST' })

    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/external worktree/i)
    expect(vi.mocked(gitOps.getCurrentBranch)).not.toHaveBeenCalled()
    expect(vi.mocked(gitOps.moveWorktree)).not.toHaveBeenCalled()
    expect(vi.mocked(workspaceService.updateWorkingBranch)).not.toHaveBeenCalled()
    expect(vi.mocked(workspaceService.updateWorktreePath)).not.toHaveBeenCalled()
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
    expect(vi.mocked(workspaceService.updateWorktreePath)).not.toHaveBeenCalled()
  })
})

describe('POST /api/workspaces/:id/rename-branch', () => {
  beforeEach(() => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(fakeWorkspace)
    // Reset mocks whose implementations may have been overridden by earlier
    // tests (clearAllMocks only resets call history, not implementations).
    vi.mocked(gitOps.branchExists).mockReturnValue(false)
    vi.mocked(gitOps.renameBranch).mockReset()
    vi.mocked(gitOps.moveWorktree).mockReset()
  })

  it('rejects with 400 when the workspace is not owned', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue({
      ...fakeWorkspace,
      worktreeOwned: false,
      worktreePath: '/tmp/external/foo',
    })

    const res = await app.request('/api/workspaces/ws-1/rename-branch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newName: 'feature/new' }),
    })

    expect(res.status).toBe(400)
    const data = (await res.json()) as { error: string }
    expect(data.error).toMatch(/external worktree/i)
    expect(vi.mocked(gitOps.renameBranch)).not.toHaveBeenCalled()
    expect(vi.mocked(gitOps.moveWorktree)).not.toHaveBeenCalled()
    expect(vi.mocked(workspaceService.updateWorkingBranch)).not.toHaveBeenCalled()
    expect(vi.mocked(workspaceService.updateWorktreePath)).not.toHaveBeenCalled()
  })

  it('updates worktreePath after moveWorktree succeeds for owned workspaces', async () => {
    vi.mocked(workspaceService.updateWorkingBranch).mockReturnValue({
      ...fakeWorkspace,
      workingBranch: 'feature/new',
    } as never)

    const res = await app.request('/api/workspaces/ws-1/rename-branch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newName: 'feature/new' }),
    })

    expect(res.status).toBe(200)
    expect(vi.mocked(gitOps.renameBranch)).toHaveBeenCalledWith(
      '/tmp/project/.worktrees/feature/test',
      'feature/test',
      'feature/new',
    )
    expect(vi.mocked(gitOps.moveWorktree)).toHaveBeenCalledWith(
      '/tmp/project',
      '/tmp/project/.worktrees/feature/test',
      '/tmp/project/.worktrees/feature/new',
    )
    expect(vi.mocked(workspaceService.updateWorktreePath)).toHaveBeenCalledWith(
      'ws-1',
      '/tmp/project/.worktrees/feature/new',
    )
    expect(vi.mocked(workspaceService.updateWorkingBranch)).toHaveBeenCalledWith('ws-1', 'feature/new')
  })

  it('keeps worktreePath unchanged when moveWorktree fails for owned workspaces', async () => {
    vi.mocked(gitOps.moveWorktree).mockImplementation(() => {
      throw new Error('fatal: directory is not empty')
    })
    vi.mocked(workspaceService.updateWorkingBranch).mockReturnValue({
      ...fakeWorkspace,
      workingBranch: 'feature/new',
    } as never)

    const res = await app.request('/api/workspaces/ws-1/rename-branch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newName: 'feature/new' }),
    })

    expect(res.status).toBe(200)
    expect(vi.mocked(workspaceService.updateWorktreePath)).not.toHaveBeenCalled()
    expect(vi.mocked(workspaceService.updateWorkingBranch)).toHaveBeenCalledWith('ws-1', 'feature/new')
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
      url: 'https://my-org.sentry.io/issues/ACME-API-3',
      platform: 'js',
      occurrences: 1,
      firstSeen: '2026-01-01',
      lastSeen: '2026-01-02',
      tags: {},
      offendingSpans: [],
      extraContext: '',
      assignee: '',
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
      agentPermissionMode: 'bypass',
      devServerStatus: 'stopped',
      hasUnread: false,
      archivedAt: null,
      favoritedAt: null,
      tags: [],
      engine: 'claude-code',
      autoLoop: false,
      autoLoopReady: false,
      noProgressStreak: 0,
      // legacy field removed
      worktreePath: '/tmp/proj/.worktrees/feat/x',
      worktreeOwned: true,
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

  it('prefixes the workspace name with the Sentry short-id when the user did not name it', async () => {
    const sentryService = await import('../server/services/sentry-service.js')
    const wsService = await import('../server/services/workspace-service.js')

    vi.mocked(sentryService.extractSentryIssue).mockResolvedValueOnce({
      title: "TypeError: undefined is not an object (evaluating 't.key')",
      issueId: 'SEKUR-IOS-9',
      issueNumericId: '99',
      culprit: 'fn',
      url: 'https://my-org.sentry.io/issues/SEKUR-IOS-9',
      platform: 'js',
      occurrences: 1,
      firstSeen: '2026-01-01',
      lastSeen: '2026-01-02',
      tags: {},
      offendingSpans: [],
      extraContext: '',
      assignee: '',
    })
    vi.mocked(wsService.createWorkspace).mockReturnValue({
      ...fakeWorkspace,
      name: 'workspace', // placeholder = "user did not provide a name"
      sentryUrl: 'https://my-org.sentry.io/issues/99/',
    })
    vi.mocked(wsService.getWorkspaceWithTasks).mockReturnValue(fakeWorkspaceWithTasks)
    vi.mocked(worktreeService.createWorktree).mockReturnValue('/tmp/wt')

    await app.request('/api/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'workspace',
        projectPath: '/tmp/proj',
        sourceBranch: 'main',
        workingBranch: 'feat/x',
        sentryUrl: 'https://my-org.sentry.io/issues/99/',
      }),
    })

    expect(wsService.updateWorkspaceName).toHaveBeenCalledWith(
      'ws-1',
      "SEKUR-IOS-9 | TypeError: undefined is not an object (evaluating 't.key')",
    )
  })
})

describe('POST /api/workspaces — reuse existing worktree', () => {
  beforeEach(() => {
    vi.clearAllMocks()
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
      notionMcpKey: '',
      sentryMcpKey: '',
      tags: [],
      worktreesPath: '.worktrees',
    })
  })

  it('returns 422 when worktreePath does not exist on disk', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false)

    const res = await app.request('/api/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'reuse-test',
        projectPath: '/tmp/project',
        sourceBranch: 'main',
        workingBranch: 'feature/placeholder',
        worktreePath: '/tmp/orphan/.worktrees/feature/derived',
      }),
    })

    expect(res.status).toBe(422)
    const data = await res.json()
    expect(data.error).toMatch(/does not exist/i)
    expect(workspaceService.createWorkspace).not.toHaveBeenCalled()
  })

  it('returns 422 when worktreePath is not a git worktree of this project', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true)
    // First call: rev-parse --git-common-dir returns a different repo path
    vi.mocked(execFileSync).mockImplementationOnce(() => '/tmp/OTHER-PROJECT/.git\n' as never)

    const res = await app.request('/api/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'reuse-test',
        projectPath: '/tmp/project',
        sourceBranch: 'main',
        workingBranch: 'feature/placeholder',
        worktreePath: '/tmp/elsewhere/.worktrees/feature/derived',
      }),
    })

    expect(res.status).toBe(422)
    const data = await res.json()
    expect(data.error).toMatch(/different repository/i)
    expect(workspaceService.createWorkspace).not.toHaveBeenCalled()
  })

  it('returns 422 when the worktree branch is detached HEAD', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(execFileSync)
      // rev-parse --git-common-dir → matches /tmp/project/.git
      .mockImplementationOnce(() => '/tmp/project/.git\n' as never)
      // rev-parse --abbrev-ref HEAD → 'HEAD' (detached)
      .mockImplementationOnce(() => 'HEAD\n' as never)

    const res = await app.request('/api/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'reuse-test',
        projectPath: '/tmp/project',
        sourceBranch: 'main',
        workingBranch: 'feature/placeholder',
        worktreePath: '/tmp/project/.worktrees/feature/detached',
      }),
    })

    expect(res.status).toBe(422)
    const data = await res.json()
    expect(data.error).toMatch(/detached HEAD/i)
    expect(workspaceService.createWorkspace).not.toHaveBeenCalled()
  })

  it('returns 422 when the worktreePath is already attached', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(execFileSync)
      .mockImplementationOnce(() => '/tmp/project/.git\n' as never)
      .mockImplementationOnce(() => 'feature/derived\n' as never)
    // DB query returns an existing row with that worktree_path
    vi.mocked(getDb).mockReturnValue({
      prepare: vi.fn().mockReturnValue({
        run: vi.fn(),
        get: vi.fn().mockReturnValue({ id: 'ws-existing' }),
        all: vi.fn().mockReturnValue([]),
      }),
    } as never)

    const res = await app.request('/api/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'reuse-test',
        projectPath: '/tmp/project',
        sourceBranch: 'main',
        workingBranch: 'feature/placeholder',
        worktreePath: '/tmp/project/.worktrees/feature/derived',
      }),
    })

    expect(res.status).toBe(422)
    const data = await res.json()
    expect(data.error).toMatch(/already attached/i)
    expect(workspaceService.createWorkspace).not.toHaveBeenCalled()
  })

  it('happy path: derives branch from git, sets worktreeOwned=false, skips createWorktree + setupScript', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(execFileSync)
      .mockImplementationOnce(() => '/tmp/project/.git\n' as never)
      .mockImplementationOnce(() => 'feature/derived\n' as never)
    // No existing row — happy path
    vi.mocked(getDb).mockReturnValue({
      prepare: vi.fn().mockReturnValue({
        run: vi.fn(),
        get: vi.fn().mockReturnValue(undefined),
        all: vi.fn().mockReturnValue([]),
      }),
    } as never)
    vi.mocked(workspaceService.createWorkspace).mockReturnValue(fakeWorkspace)
    vi.mocked(workspaceService.listTasks).mockReturnValue([])
    vi.mocked(workspaceService.getWorkspaceWithTasks).mockReturnValue(fakeWorkspaceWithTasks)
    // setup script configured — must still be skipped because of useReusedWorktree
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

    const res = await app.request('/api/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'reuse-test',
        projectPath: '/tmp/project',
        sourceBranch: 'main',
        workingBranch: 'feature/placeholder',
        worktreePath: '/tmp/project/.worktrees/feature/derived',
      }),
    })

    expect(res.status).toBe(201)
    expect(workspaceService.createWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        workingBranch: 'feature/derived',
        worktreePath: '/tmp/project/.worktrees/feature/derived',
        worktreeOwned: false,
      }),
    )
    expect(worktreeService.createWorktree).not.toHaveBeenCalled()
    expect(setupScriptService.runSetupScript).not.toHaveBeenCalled()
  })
})

describe('GET /api/workspaces/:id/prep-autoloop-prompt', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 404 when the workspace does not exist', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(null)
    const res = await app.request('/api/workspaces/ghost/prep-autoloop-prompt')
    expect(res.status).toBe(404)
  })

  it('returns a prompt without the E2E review step when E2E is not configured', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(fakeWorkspace)
    vi.mocked(settingsService.getProjectSettings).mockReturnValue({
      path: '/tmp/proj',
      displayName: 'P',
      defaultSourceBranch: 'main',
      defaultModel: '',
      dangerouslySkipPermissions: true,
      prPromptTemplate: '',
      gitConventions: '',
      setupScript: '',
      devServer: { startCommand: '', stopCommand: '' },
      e2e: { framework: '', skill: '', prompt: '' },
    })
    const res = await app.request('/api/workspaces/ws-1/prep-autoloop-prompt')
    expect(res.status).toBe(200)
    const data = (await res.json()) as { prompt: string }
    expect(data.prompt).toContain('1. Call `kobo__list_tasks`')
    expect(data.prompt).not.toContain('E2E review')
  })

  it('includes the E2E review step when configured', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(fakeWorkspace)
    vi.mocked(settingsService.getProjectSettings).mockReturnValue({
      path: '/tmp/proj',
      displayName: 'P',
      defaultSourceBranch: 'main',
      defaultModel: '',
      dangerouslySkipPermissions: true,
      prPromptTemplate: '',
      gitConventions: '',
      setupScript: '',
      devServer: { startCommand: '', stopCommand: '' },
      e2e: { framework: 'cypress', skill: 'cy', prompt: 'pop' },
    })
    const res = await app.request('/api/workspaces/ws-1/prep-autoloop-prompt')
    expect(res.status).toBe(200)
    const data = (await res.json()) as { prompt: string }
    expect(data.prompt).toContain('**E2E review**')
    expect(data.prompt).toContain('The project uses `cypress`.')
    expect(data.prompt).toContain('Use the `cy` skill for this task.')
  })
})

describe('POST /api/workspaces — worktree path collision', () => {
  it('appends a hash suffix when the prospective worktree path already exists and surfaces the flag via header', async () => {
    // First call (base path) → taken. Subsequent calls (suffixed) → free.
    let existsCalls = 0
    vi.mocked(fs.existsSync).mockImplementation((p) => {
      if (typeof p !== 'string') return false
      // Only collide on the exact base path; the suffixed variants are free.
      if (p.endsWith('/feature/test')) {
        existsCalls++
        return true
      }
      return false
    })
    vi.mocked(workspaceService.createWorkspace).mockReturnValue(fakeWorkspace)
    vi.mocked(worktreeService.createWorktree).mockImplementation((_p, branch) => `/tmp/project/.worktrees/${branch}`)
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
    expect(res.headers.get('X-Kobo-Branch-Adjusted')).toBe('1')
    expect(existsCalls).toBeGreaterThanOrEqual(1)
    // The workspace must have been created with the suffixed branch name.
    const createCall = vi.mocked(workspaceService.createWorkspace).mock.calls[0][0]
    expect(createCall.workingBranch).toMatch(/^feature\/test-[A-Z0-9]{4}$/)
    expect(createCall.worktreePath).toContain(createCall.workingBranch)
  })

  it('returns 409 with a clear error after exhausting all retries', async () => {
    // Every candidate path is taken — resolver exhausts retries.
    vi.mocked(fs.existsSync).mockImplementation((p) => {
      return typeof p === 'string' && p.includes('feature/test')
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

    expect(res.status).toBe(409)
    const data = await res.json()
    expect(data.error).toMatch(/unique branch/i)
    expect(workspaceService.createWorkspace).not.toHaveBeenCalled()
  })

  it('passes slug-prefixed worktreePath to createWorkspace when worktreesPrefixByProject is true', async () => {
    // Arrange: enable prefix-by-project and set a displayName that produces slug "sekur"
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
      notionMcpKey: '',
      sentryMcpKey: '',
      tags: [],
      worktreesPath: '.worktrees',
      worktreesPrefixByProject: true,
    })
    vi.mocked(settingsService.getProjectSettings).mockReturnValue({
      displayName: 'Sekur',
    } as never)
    vi.mocked(fs.existsSync).mockReturnValue(false)
    vi.mocked(workspaceService.createWorkspace).mockReturnValue(fakeWorkspace)
    vi.mocked(worktreeService.createWorktree).mockReturnValue('/tmp/project/.worktrees/sekur/feature/test')
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
    // The worktreePath passed to createWorkspace must include the "sekur" slug segment
    expect(workspaceService.createWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreePath: expect.stringContaining('/sekur/'),
      }),
    )
  })
})

describe('POST /api/workspaces — Working directory in brainstorm prompt', () => {
  it('passes "Working directory: <path>" to agentManager.startAgent', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false)
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
    expect(agentManager.startAgent).toHaveBeenCalledOnce()
    const promptArg = vi.mocked(agentManager.startAgent).mock.calls[0][2]
    expect(promptArg).toContain('Working directory: ')
  })
})

describe('GET /api/workspaces/:id/crons', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns the list of crons for a workspace', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(fakeWorkspace)
    vi.mocked(cronService.listForWorkspace).mockReturnValue([
      {
        id: 'c1',
        workspaceId: 'ws-1',
        expression: '@hourly',
        prompt: 'tick',
        label: null,
        agentSessionId: null,
        nextFireAt: '2026-05-07T11:00:00Z',
        lastFiredAt: null,
        createdAt: '2026-05-07T10:00:00Z',
      },
    ])
    const res = await app.request('/api/workspaces/ws-1/crons')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { crons: unknown[] }
    expect(body.crons).toHaveLength(1)
  })

  it('returns 404 when workspace is unknown', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(null as never)
    const res = await app.request('/api/workspaces/unknown/crons')
    expect(res.status).toBe(404)
  })
})

describe('POST /api/workspaces/:id/crons', () => {
  beforeEach(() => vi.clearAllMocks())

  it('arms a new cron and returns it', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(fakeWorkspace)
    const cron = {
      id: 'c1',
      workspaceId: 'ws-1',
      expression: '@hourly',
      prompt: 'tick',
      label: null,
      agentSessionId: null,
      nextFireAt: '2026-05-07T11:00:00Z',
      lastFiredAt: null,
      createdAt: '2026-05-07T10:00:00Z',
    }
    vi.mocked(cronService.arm).mockReturnValue(cron)
    const res = await app.request('/api/workspaces/ws-1/crons', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expression: '@hourly', prompt: 'tick' }),
    })
    expect(res.status).toBe(201)
    expect(await res.json()).toMatchObject({ cron: expect.objectContaining({ id: 'c1' }) })
  })

  it('returns 400 on invalid expression (service throws)', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(fakeWorkspace)
    vi.mocked(cronService.arm).mockImplementation(() => {
      throw new Error('Invalid cron expression: foo')
    })
    const res = await app.request('/api/workspaces/ws-1/crons', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expression: 'foo', prompt: 'p' }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/invalid cron expression/i)
  })

  it('returns 400 when expression or prompt is missing', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(fakeWorkspace)
    const res = await app.request('/api/workspaces/ws-1/crons', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expression: '@hourly' }),
    })
    expect(res.status).toBe(400)
  })

  it("returns 400 on invalid mode (anything other than 'resume' or 'fresh')", async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(fakeWorkspace)
    const res = await app.request('/api/workspaces/ws-1/crons', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expression: '@hourly', prompt: 'tick', mode: 'maybe' }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/mode/)
  })

  it("mode='resume' (default) captures active session id and pins it", async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(fakeWorkspace)
    vi.mocked(agentManager.getActiveSessionId).mockReturnValue('sess-active-1')
    const cron = {
      id: 'c1',
      workspaceId: 'ws-1',
      expression: '@hourly',
      prompt: 'tick',
      label: null,
      agentSessionId: 'sess-active-1',
      nextFireAt: '2026-05-07T11:00:00Z',
      lastFiredAt: null,
      oneShot: false,
      createdAt: '2026-05-07T10:00:00Z',
    }
    vi.mocked(cronService.arm).mockReturnValue(cron)
    const res = await app.request('/api/workspaces/ws-1/crons', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expression: '@hourly', prompt: 'tick' }),
    })
    expect(res.status).toBe(201)
    expect(cronService.arm).toHaveBeenCalledWith(
      'ws-1',
      expect.objectContaining({ agentSessionId: 'sess-active-1', oneShot: false }),
    )
  })

  it("mode='fresh' does NOT pin a session (agentSessionId undefined)", async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(fakeWorkspace)
    vi.mocked(agentManager.getActiveSessionId).mockReturnValue('sess-active-1')
    vi.mocked(cronService.arm).mockReturnValue({
      id: 'c2',
      workspaceId: 'ws-1',
      expression: '@hourly',
      prompt: 'tick',
      label: null,
      agentSessionId: null,
      nextFireAt: '2026-05-07T11:00:00Z',
      lastFiredAt: null,
      oneShot: false,
      createdAt: '2026-05-07T10:00:00Z',
    })
    const res = await app.request('/api/workspaces/ws-1/crons', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expression: '@hourly', prompt: 'tick', mode: 'fresh' }),
    })
    expect(res.status).toBe(201)
    expect(cronService.arm).toHaveBeenCalledWith('ws-1', expect.objectContaining({ agentSessionId: undefined }))
  })

  it('forwards oneShot=true to the service', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(fakeWorkspace)
    vi.mocked(cronService.arm).mockReturnValue({
      id: 'c3',
      workspaceId: 'ws-1',
      expression: '0 14 7 6 *',
      prompt: 'one-time',
      label: null,
      agentSessionId: null,
      nextFireAt: '2026-06-07T12:00:00Z',
      lastFiredAt: null,
      oneShot: true,
      createdAt: '2026-05-07T10:00:00Z',
    })
    const res = await app.request('/api/workspaces/ws-1/crons', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expression: '0 14 7 6 *', prompt: 'one-time', mode: 'fresh', oneShot: true }),
    })
    expect(res.status).toBe(201)
    expect(cronService.arm).toHaveBeenCalledWith('ws-1', expect.objectContaining({ oneShot: true }))
  })

  it('oneShot is false unless body explicitly === true (no truthy coercion)', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(fakeWorkspace)
    vi.mocked(cronService.arm).mockReturnValue({
      id: 'c4',
      workspaceId: 'ws-1',
      expression: '@hourly',
      prompt: 'tick',
      label: null,
      agentSessionId: null,
      nextFireAt: '2026-05-07T11:00:00Z',
      lastFiredAt: null,
      oneShot: false,
      createdAt: '2026-05-07T10:00:00Z',
    })
    const res = await app.request('/api/workspaces/ws-1/crons', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expression: '@hourly', prompt: 'tick', oneShot: 'yes' }),
    })
    expect(res.status).toBe(201)
    expect(cronService.arm).toHaveBeenCalledWith('ws-1', expect.objectContaining({ oneShot: false }))
  })
})

describe('DELETE /api/workspaces/:id/crons/:cronId', () => {
  beforeEach(() => vi.clearAllMocks())

  it('cancels the cron and returns 204', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(fakeWorkspace)
    vi.mocked(cronService.cancel).mockReturnValue(true)
    const res = await app.request('/api/workspaces/ws-1/crons/c1', { method: 'DELETE' })
    expect(res.status).toBe(204)
    expect(cronService.cancel).toHaveBeenCalledWith('c1', 'user')
  })

  it('returns 204 even when cron is unknown (idempotent)', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(fakeWorkspace)
    vi.mocked(cronService.cancel).mockReturnValue(false)
    const res = await app.request('/api/workspaces/ws-1/crons/unknown', { method: 'DELETE' })
    expect(res.status).toBe(204)
  })
})

describe('GET /api/workspaces/pr-states (rich payload)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns the snapshot map from getAllPrSnapshots', async () => {
    const { default: app } = await import('../server/routes/workspaces.js')
    const prWatcher = await import('../server/services/pr-watcher-service.js')
    vi.mocked(prWatcher.getAllPrSnapshots).mockReturnValue({
      'ws-1': { number: 42, state: 'OPEN', reviewDecision: 'CHANGES_REQUESTED' } as never,
    })
    const res = await app.request('/pr-states')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      'ws-1': { number: 42, state: 'OPEN', reviewDecision: 'CHANGES_REQUESTED' },
    })
  })
})

describe('POST /api/workspaces/pr-snapshot/refresh/:id', () => {
  beforeEach(() => vi.clearAllMocks())

  it('200 with snapshot when refreshPrSnapshot succeeds', async () => {
    const { default: app } = await import('../server/routes/workspaces.js')
    const prWatcher = await import('../server/services/pr-watcher-service.js')
    vi.mocked(prWatcher.refreshPrSnapshot).mockResolvedValue({ number: 7, state: 'OPEN' } as never)
    const res = await app.request('/pr-snapshot/refresh/ws-1', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ snapshot: { number: 7, state: 'OPEN' } })
  })

  it('404 when no PR is associated', async () => {
    const { default: app } = await import('../server/routes/workspaces.js')
    const prWatcher = await import('../server/services/pr-watcher-service.js')
    vi.mocked(prWatcher.refreshPrSnapshot).mockResolvedValue(null)
    const res = await app.request('/pr-snapshot/refresh/ws-1', { method: 'POST' })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'No PR for this workspace' })
  })

  it('404 when workspace does not exist', async () => {
    const { default: app } = await import('../server/routes/workspaces.js')
    const prWatcher = await import('../server/services/pr-watcher-service.js')
    vi.mocked(prWatcher.refreshPrSnapshot).mockRejectedValue(new Error("Workspace 'ws-1' not found"))
    const res = await app.request('/pr-snapshot/refresh/ws-1', { method: 'POST' })
    expect(res.status).toBe(404)
  })

  it('500 on unexpected error', async () => {
    const { default: app } = await import('../server/routes/workspaces.js')
    const prWatcher = await import('../server/services/pr-watcher-service.js')
    vi.mocked(prWatcher.refreshPrSnapshot).mockRejectedValue(new Error('gh exploded'))
    const res = await app.request('/pr-snapshot/refresh/ws-1', { method: 'POST' })
    expect(res.status).toBe(500)
    expect(((await res.json()) as { error: string }).error).toMatch(/gh exploded/)
  })
})

describe('POST /api/workspaces/:id/change-pr-base', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    changePrBaseMock.mockReset()
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(fakeWorkspace as never)
  })

  it('change-pr-base calls the resolved forge provider', async () => {
    changePrBaseMock.mockResolvedValueOnce(undefined)
    const res = await app.request('/api/workspaces/ws-1/change-pr-base', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ base: 'develop' }),
    })
    expect(res.status).toBe(200)
    expect(changePrBaseMock).toHaveBeenCalledWith(expect.any(String), 'develop')
  })

  it('returns 404 when workspace not found', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(null as never)
    const res = await app.request('/api/workspaces/ws-1/change-pr-base', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ base: 'develop' }),
    })
    expect(res.status).toBe(404)
  })

  it('returns 400 when base parameter is missing', async () => {
    const res = await app.request('/api/workspaces/ws-1/change-pr-base', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })

  it('returns 409 forge_unsupported when canChangePrBase is false', async () => {
    vi.mocked(getForgeProvider).mockReturnValueOnce({
      id: 'github',
      capabilities: { canCreatePr: true, canChangePrBase: false, requestTermShort: 'PR' },
      isAvailable: vi.fn(async () => ({ available: true })),
      changePrBase: changePrBaseMock,
    } as never)
    const res = await app.request('/api/workspaces/ws-1/change-pr-base', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ base: 'develop' }),
    })
    expect(res.status).toBe(409)
    expect(((await res.json()) as { code: string }).code).toBe('forge_unsupported')
  })

  it('returns 409 forge_cli_missing when CLI is unavailable with reason cli_missing', async () => {
    vi.mocked(getForgeProvider).mockReturnValueOnce({
      id: 'github',
      capabilities: { canCreatePr: true, canChangePrBase: true, requestTermShort: 'PR' },
      isAvailable: vi.fn(async () => ({ available: false, reason: 'cli_missing' })),
      changePrBase: changePrBaseMock,
    } as never)
    const res = await app.request('/api/workspaces/ws-1/change-pr-base', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ base: 'develop' }),
    })
    expect(res.status).toBe(409)
    expect(((await res.json()) as { code: string }).code).toBe('forge_cli_missing')
  })

  it('returns 409 forge_not_authenticated when CLI is unavailable with reason not_authenticated', async () => {
    vi.mocked(getForgeProvider).mockReturnValueOnce({
      id: 'github',
      capabilities: { canCreatePr: true, canChangePrBase: true, requestTermShort: 'PR' },
      isAvailable: vi.fn(async () => ({ available: false, reason: 'not_authenticated' })),
      changePrBase: changePrBaseMock,
    } as never)
    const res = await app.request('/api/workspaces/ws-1/change-pr-base', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ base: 'develop' }),
    })
    expect(res.status).toBe(409)
    expect(((await res.json()) as { code: string }).code).toBe('forge_not_authenticated')
  })

  it('returns 500 when changePrBase throws a generic Error', async () => {
    changePrBaseMock.mockRejectedValueOnce(new Error('boom'))
    const res = await app.request('/api/workspaces/ws-1/change-pr-base', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ base: 'develop' }),
    })
    expect(res.status).toBe(500)
  })
})

describe('POST /api/workspaces/:id/change-source-branch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    changeSourceBranchMock.mockReset()
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(fakeWorkspace as never)
  })

  it('change-source-branch calls the service and returns its status', async () => {
    changeSourceBranchMock.mockResolvedValueOnce({ status: 'done', forcePushNeeded: true, commitCount: 2 })
    const res = await app.request('/api/workspaces/ws-1/change-source-branch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ newBase: 'develop' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ status: 'done', forcePushNeeded: true })
    expect(changeSourceBranchMock).toHaveBeenCalledWith(expect.any(String), 'develop')
  })

  it('change-source-branch maps too-many to a 409', async () => {
    changeSourceBranchMock.mockResolvedValueOnce({ status: 'too-many', forcePushNeeded: false, commitCount: 80 })
    const res = await app.request('/api/workspaces/ws-1/change-source-branch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ newBase: 'develop' }),
    })
    expect(res.status).toBe(409)
    const body = await res.json()
    expect((body as { code: string }).code).toBe('too_many_commits')
  })
})

describe('POST /api/workspaces/:id/cancel-source-change', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(fakeWorkspace as never)
  })

  it('happy path — restores branch and updates source branch', async () => {
    vi.mocked(gitOps.listBackupBranches).mockReturnValue(['kobo-backup/feature-test-123'])
    const res = await app.request('/api/workspaces/ws-1/cancel-source-change', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ previousBase: 'main' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ success: true, restoredFrom: 'kobo-backup/feature-test-123' })
    expect(gitOps.restoreBranchFromBackup).toHaveBeenCalled()
    expect(workspaceService.updateWorkspaceSourceBranch).toHaveBeenCalledWith('ws-1', 'main')
  })

  it('no backup — returns 409 with code no_backup', async () => {
    vi.mocked(gitOps.listBackupBranches).mockReturnValue([])
    const res = await app.request('/api/workspaces/ws-1/cancel-source-change', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ previousBase: 'main' }),
    })
    expect(res.status).toBe(409)
    const body = await res.json()
    expect((body as { code: string }).code).toBe('no_backup')
    expect(gitOps.restoreBranchFromBackup).not.toHaveBeenCalled()
  })

  it('missing previousBase — returns 400', async () => {
    const res = await app.request('/api/workspaces/ws-1/cancel-source-change', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })
})

describe('POST /api/workspaces/:id/force-push', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(fakeWorkspace as never)
  })

  it('calls pushBranch with force:true and returns success', async () => {
    const res = await app.request('/api/workspaces/ws-1/force-push', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ success: true })
    expect(gitOps.pushBranch).toHaveBeenCalledWith(fakeWorkspace.worktreePath, fakeWorkspace.workingBranch, {
      force: true,
    })
  })

  it('returns 404 when workspace not found', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(undefined as never)
    const res = await app.request('/api/workspaces/does-not-exist/force-push', { method: 'POST' })
    expect(res.status).toBe(404)
  })

  it('returns 500 when pushBranch throws', async () => {
    vi.mocked(gitOps.pushBranch).mockImplementation(() => {
      throw new Error('remote rejected')
    })
    const res = await app.request('/api/workspaces/ws-1/force-push', { method: 'POST' })
    expect(res.status).toBe(500)
    const body = await res.json()
    expect((body as { error: string }).error).toContain('remote rejected')
  })
})

describe('chat history routes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(fakeWorkspace)
    vi.mocked(chatHistoryService.listChatHistory).mockReturnValue([])
  })

  it('GET /:id/chat-history returns { history: [] } for a workspace with no history', async () => {
    const res = await app.request('/api/workspaces/ws-1/chat-history')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ history: [] })
    expect(chatHistoryService.listChatHistory).toHaveBeenCalledWith('ws-1')
  })

  it('GET /:id/chat-history returns 404 for an unknown workspace', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(null)
    const res = await app.request('/api/workspaces/does-not-exist/chat-history')
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/not found/i)
    expect(chatHistoryService.listChatHistory).not.toHaveBeenCalled()
  })

  it('POST /:id/chat-history adds a message and GET returns it', async () => {
    // Simulate the service appending to history: after POST, listChatHistory returns the message.
    vi.mocked(chatHistoryService.listChatHistory).mockReturnValue(['hello world'])
    const postRes = await app.request('/api/workspaces/ws-1/chat-history', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hello world' }),
    })
    expect(postRes.status).toBe(204)
    expect(chatHistoryService.pushChatHistory).toHaveBeenCalledWith('ws-1', 'hello world')

    const getRes = await app.request('/api/workspaces/ws-1/chat-history')
    expect(getRes.status).toBe(200)
    expect(await getRes.json()).toEqual({ history: ['hello world'] })
  })

  it('POST /:id/chat-history rejects an empty body with 400', async () => {
    const res = await app.request('/api/workspaces/ws-1/chat-history', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
    expect(chatHistoryService.pushChatHistory).not.toHaveBeenCalled()
  })

  it('POST /:id/chat-history returns 404 for an unknown workspace', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(null)
    const res = await app.request('/api/workspaces/does-not-exist/chat-history', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'x' }),
    })
    expect(res.status).toBe(404)
    expect(chatHistoryService.pushChatHistory).not.toHaveBeenCalled()
  })

  it('POST /:id/chat-history returns 400 when workspace is archived', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue({
      ...fakeWorkspace,
      archivedAt: '2026-04-05T10:00:00.000Z',
    })
    const res = await app.request('/api/workspaces/ws-1/chat-history', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hello' }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/archived/i)
    expect(chatHistoryService.pushChatHistory).not.toHaveBeenCalled()
  })
})

describe('save-file', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(fakeWorkspace)
    vi.mocked(agentManager.getAgentStatus).mockReturnValue(null)
  })

  it('POST /:id/save-file returns 404 for an unknown workspace', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValueOnce(null)
    const res = await app.request('/api/workspaces/no-such/save-file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'a.txt', content: 'hi', baseSha: 'abc' }),
    })
    expect(res.status).toBe(404)
  })

  it('POST /:id/save-file returns 400 when the workspace is archived', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValueOnce({
      ...fakeWorkspace,
      archivedAt: '2025-01-01T00:00:00Z',
    })
    const res = await app.request('/api/workspaces/ws-1/save-file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'a.txt', content: 'hi', baseSha: 'abc' }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/archived/i)
  })

  it('POST /:id/save-file returns 409 when the agent is running', async () => {
    vi.mocked(agentManager.getAgentStatus).mockReturnValueOnce('running')
    const res = await app.request('/api/workspaces/ws-1/save-file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'a.txt', content: 'hi', baseSha: 'abc' }),
    })
    expect(res.status).toBe(409)
  })

  it('POST /:id/save-file returns 400 when path is missing or empty', async () => {
    const res = await app.request('/api/workspaces/ws-1/save-file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'hi', baseSha: 'abc' }),
    })
    expect(res.status).toBe(400)
  })

  it('POST /:id/save-file returns 400 when content is not a string', async () => {
    const res = await app.request('/api/workspaces/ws-1/save-file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'a.txt', content: 42, baseSha: 'abc' }),
    })
    expect(res.status).toBe(400)
  })

  it('POST /:id/save-file returns 400 when baseSha is missing', async () => {
    const res = await app.request('/api/workspaces/ws-1/save-file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'a.txt', content: 'hi' }),
    })
    expect(res.status).toBe(400)
  })

  it('POST /:id/save-file returns 204 on a successful save', async () => {
    vi.mocked(fileEditorService.saveWorkspaceFile).mockReturnValueOnce({ status: 'saved' })
    const res = await app.request('/api/workspaces/ws-1/save-file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'a.txt', content: 'hi', baseSha: 'abc' }),
    })
    expect(res.status).toBe(204)
  })

  it('POST /:id/save-file returns 412 with currentSha on conflict', async () => {
    vi.mocked(fileEditorService.saveWorkspaceFile).mockReturnValueOnce({
      status: 'conflict',
      currentSha: 'fresh-sha',
    })
    const res = await app.request('/api/workspaces/ws-1/save-file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'a.txt', content: 'hi', baseSha: 'stale-sha' }),
    })
    expect(res.status).toBe(412)
    const body = (await res.json()) as { error: string; currentSha: string }
    expect(body.error).toMatch(/changed on disk/i)
    expect(body.currentSha).toBe('fresh-sha')
  })

  it('POST /:id/save-file returns 500 when the service throws (e.g. path traversal)', async () => {
    vi.mocked(fileEditorService.saveWorkspaceFile).mockImplementationOnce(() => {
      throw new Error("Path '../etc/passwd' escapes the worktree")
    })
    const res = await app.request('/api/workspaces/ws-1/save-file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '../etc/passwd', content: 'x', baseSha: 'abc' }),
    })
    expect(res.status).toBe(500)
  })
})

describe('POST /api/workspaces/:id/start-ci-fix', () => {
  beforeEach(() => vi.clearAllMocks())

  function mockFailingCiSnapshot(overrides: Record<string, unknown> = {}) {
    return {
      number: 42,
      title: 'fix something',
      url: 'https://github.com/org/repo/pull/42',
      state: 'OPEN',
      base: 'develop',
      reviewDecision: null,
      author: { login: 'me' },
      assignees: [],
      reviewers: [],
      labels: [],
      ci: {
        rollup: 'FAILURE',
        checks: [
          { name: 'lint', conclusion: 'FAILURE', status: 'COMPLETED', detailsUrl: 'https://ci/1' },
          { name: 'tests', conclusion: 'FAILURE', status: 'COMPLETED', detailsUrl: null },
          { name: 'fast', conclusion: 'SUCCESS', status: 'COMPLETED', detailsUrl: null },
        ],
      },
      updatedAt: '2026-05-01T00:00:00.000Z',
      unresolvedReviewThreadsCount: 0,
      ...overrides,
    }
  }

  it('returns 404 when workspace is unknown', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(null)
    const res = await app.request('/api/workspaces/ghost/start-ci-fix', { method: 'POST' })
    expect(res.status).toBe(404)
  })

  it('returns 400 when workspace is archived', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue({
      ...fakeWorkspace,
      archivedAt: '2026-04-01T00:00:00.000Z',
    } as never)
    const res = await app.request('/api/workspaces/ws-1/start-ci-fix', { method: 'POST' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/archived/i)
  })

  it('returns 400 when no failing CI is detected', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(fakeWorkspace as never)
    const prWatcher = await import('../server/services/pr-watcher-service.js')
    vi.mocked(prWatcher.refreshPrSnapshot).mockResolvedValueOnce(null)
    vi.mocked(prWatcher.getAllPrSnapshots).mockReturnValue({})

    const res = await app.request('/api/workspaces/ws-1/start-ci-fix', { method: 'POST' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/no failing ci/i)
  })

  it('returns 400 when CI is not in FAILURE state', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(fakeWorkspace as never)
    const prWatcher = await import('../server/services/pr-watcher-service.js')
    vi.mocked(prWatcher.refreshPrSnapshot).mockResolvedValueOnce(
      mockFailingCiSnapshot({ ci: { rollup: 'SUCCESS', checks: [] } }) as never,
    )

    const res = await app.request('/api/workspaces/ws-1/start-ci-fix', { method: 'POST' })
    expect(res.status).toBe(400)
  })

  it('returns 400 when no ciFixPromptTemplate is configured', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(fakeWorkspace as never)
    const prWatcher = await import('../server/services/pr-watcher-service.js')
    vi.mocked(prWatcher.refreshPrSnapshot).mockResolvedValueOnce(mockFailingCiSnapshot() as never)
    vi.mocked(settingsService.getEffectiveSettings).mockReturnValue({
      model: 'auto',
      dangerouslySkipPermissions: true,
      prPromptTemplate: '',
      ciFixPromptTemplate: '',
      gitConventions: '',
      sourceBranch: 'main',
      devServer: null,
      setupScript: '',
      notionStatusProperty: '',
      notionInProgressStatus: '',
    } as never)

    const res = await app.request('/api/workspaces/ws-1/start-ci-fix', { method: 'POST' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/no ci-fix prompt template/i)
  })

  it('sends the rendered template to the active agent and returns ok', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(fakeWorkspace as never)
    vi.mocked(workspaceService.getActiveSession).mockReturnValue({
      id: 'sess-1',
      workspaceId: 'ws-1',
      pid: null,
      claudeSessionId: null,
      status: 'idle',
      startedAt: null,
      endedAt: null,
      name: null,
    } as never)
    const prWatcher = await import('../server/services/pr-watcher-service.js')
    vi.mocked(prWatcher.refreshPrSnapshot).mockResolvedValueOnce(mockFailingCiSnapshot() as never)
    vi.mocked(settingsService.getEffectiveSettings).mockReturnValue({
      model: 'auto',
      dangerouslySkipPermissions: true,
      prPromptTemplate: '',
      ciFixPromptTemplate: 'Fix CI on PR {{pr_url}}\n{{failed_jobs}}',
      gitConventions: '',
      sourceBranch: 'main',
      devServer: null,
      setupScript: '',
      notionStatusProperty: '',
      notionInProgressStatus: '',
    } as never)

    const res = await app.request('/api/workspaces/ws-1/start-ci-fix', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; failedChecksCount: number }
    expect(body.ok).toBe(true)
    expect(body.failedChecksCount).toBe(2)

    expect(agentManager.sendMessage).toHaveBeenCalledTimes(1)
    const [, prompt] = vi.mocked(agentManager.sendMessage).mock.calls[0]
    expect(prompt).toContain('https://github.com/org/repo/pull/42')
    expect(prompt).toContain('- lint')
    expect(prompt).toContain('- tests')
    expect(prompt).not.toContain('- fast')
  })

  it('starts a fresh resume session when sendMessage throws (no live agent)', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(fakeWorkspace as never)
    vi.mocked(workspaceService.getActiveSession).mockReturnValue(null)
    vi.mocked(agentManager.sendMessage).mockImplementationOnce(() => {
      throw new Error('no live agent')
    })
    const prWatcher = await import('../server/services/pr-watcher-service.js')
    vi.mocked(prWatcher.refreshPrSnapshot).mockResolvedValueOnce(mockFailingCiSnapshot() as never)
    vi.mocked(settingsService.getEffectiveSettings).mockReturnValue({
      model: 'auto',
      dangerouslySkipPermissions: true,
      prPromptTemplate: '',
      ciFixPromptTemplate: 'fix it',
      gitConventions: '',
      sourceBranch: 'main',
      devServer: null,
      setupScript: '',
      notionStatusProperty: '',
      notionInProgressStatus: '',
    } as never)

    const res = await app.request('/api/workspaces/ws-1/start-ci-fix', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(agentManager.startAgent).toHaveBeenCalledTimes(1)
    // resume=true → 5th positional arg
    expect(vi.mocked(agentManager.startAgent).mock.calls[0][4]).toBe(true)
  })
})

describe('POST /:id/rebase & /:id/merge dirty-worktree handling', () => {
  beforeEach(() => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(fakeWorkspace)
  })

  it('maps DirtyWorktreeError to 409 with code dirty_worktree on rebase', async () => {
    vi.mocked(gitOps.rebaseBranch).mockImplementation(() => {
      throw new gitOps.DirtyWorktreeError('rebase', { staged: 0, modified: 1, untracked: 0 })
    })
    const res = await app.request('/api/workspaces/ws-1/rebase', { method: 'POST' })
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.code).toBe('dirty_worktree')
    expect(body.operation).toBe('rebase')
    expect(body.status).toEqual({ staged: 0, modified: 1, untracked: 0 })
  })

  it('maps DirtyWorktreeError to 409 with code dirty_worktree on merge', async () => {
    vi.mocked(gitOps.mergeBranch).mockImplementation(() => {
      throw new gitOps.DirtyWorktreeError('merge', { staged: 1, modified: 0, untracked: 0 })
    })
    const res = await app.request('/api/workspaces/ws-1/merge', { method: 'POST' })
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.code).toBe('dirty_worktree')
    expect(body.operation).toBe('merge')
    expect(body.status).toEqual({ staged: 1, modified: 0, untracked: 0 })
  })

  it('passes autostash:true to rebaseBranch when ?autostash=1', async () => {
    vi.mocked(gitOps.rebaseBranch).mockReturnValue(undefined)
    const res = await app.request('/api/workspaces/ws-1/rebase?autostash=1', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(gitOps.rebaseBranch).toHaveBeenCalledWith(fakeWorkspace.worktreePath, fakeWorkspace.sourceBranch, {
      autostash: true,
    })
  })

  it('passes autostash:false to rebaseBranch when no query param', async () => {
    vi.mocked(gitOps.rebaseBranch).mockReturnValue(undefined)
    const res = await app.request('/api/workspaces/ws-1/rebase', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(gitOps.rebaseBranch).toHaveBeenCalledWith(fakeWorkspace.worktreePath, fakeWorkspace.sourceBranch, {
      autostash: false,
    })
  })

  it('passes autostash:true to mergeBranch when ?autostash=1', async () => {
    vi.mocked(gitOps.mergeBranch).mockReturnValue(undefined)
    const res = await app.request('/api/workspaces/ws-1/merge?autostash=1', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(gitOps.mergeBranch).toHaveBeenCalledWith(fakeWorkspace.worktreePath, fakeWorkspace.sourceBranch, {
      autostash: true,
    })
  })

  it('passes autostash:false to mergeBranch when no query param', async () => {
    vi.mocked(gitOps.mergeBranch).mockReturnValue(undefined)
    const res = await app.request('/api/workspaces/ws-1/merge', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(gitOps.mergeBranch).toHaveBeenCalledWith(fakeWorkspace.worktreePath, fakeWorkspace.sourceBranch, {
      autostash: false,
    })
  })
})

describe('POST /:id/git/commit-all', () => {
  beforeEach(() => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(fakeWorkspace)
  })

  it('commits all changes and returns success', async () => {
    vi.mocked(gitOps.commitAllChanges).mockReturnValue(undefined)
    const res = await app.request('/api/workspaces/ws-1/git/commit-all', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'chore: snapshot' }),
    })
    expect(res.status).toBe(200)
    expect(gitOps.commitAllChanges).toHaveBeenCalledWith(fakeWorkspace.worktreePath, 'chore: snapshot')
  })

  it('rejects a blank commit message with 400', async () => {
    const res = await app.request('/api/workspaces/ws-1/git/commit-all', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: '   ' }),
    })
    expect(res.status).toBe(400)
    expect(gitOps.commitAllChanges).not.toHaveBeenCalled()
  })

  it('returns 404 when the workspace does not exist', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(undefined)
    const res = await app.request('/api/workspaces/nope/git/commit-all', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'chore: snapshot' }),
    })
    expect(res.status).toBe(404)
    expect(gitOps.commitAllChanges).not.toHaveBeenCalled()
  })
})

describe('POST /:id/git/discard', () => {
  beforeEach(() => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(fakeWorkspace)
  })

  it('discards working-tree changes and returns success', async () => {
    vi.mocked(gitOps.discardWorkingTreeChanges).mockReturnValue(undefined)
    const res = await app.request('/api/workspaces/ws-1/git/discard', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(gitOps.discardWorkingTreeChanges).toHaveBeenCalledWith(fakeWorkspace.worktreePath)
  })

  it('returns 404 when the workspace does not exist', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(undefined)
    const res = await app.request('/api/workspaces/nope/git/discard', { method: 'POST' })
    expect(res.status).toBe(404)
  })
})

describe('GET /:id/diff mode=commits', () => {
  beforeEach(() => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(fakeWorkspace)
    vi.mocked(gitOps.commitExists).mockReturnValue(true)
  })

  it('returns the file list between two commits', async () => {
    vi.mocked(gitOps.getChangedFilesBetween).mockReturnValue([{ path: 'a.txt', status: 'modified' }])
    const res = await app.request('/api/workspaces/ws-1/diff?mode=commits&from=aaa&to=bbb')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.mode).toBe('commits')
    expect(body.from).toBe('aaa')
    expect(body.to).toBe('bbb')
    expect(body.files).toEqual([{ path: 'a.txt', status: 'modified' }])
    expect(gitOps.getChangedFilesBetween).toHaveBeenCalledWith(fakeWorkspace.worktreePath, 'aaa', 'bbb')
  })

  it('400 when from or to is missing', async () => {
    const res = await app.request('/api/workspaces/ws-1/diff?mode=commits&from=aaa')
    expect(res.status).toBe(400)
  })

  it('400 when the to ref is invalid', async () => {
    vi.mocked(gitOps.commitExists).mockImplementation((_repo, ref) => ref !== 'bad')
    const res = await app.request('/api/workspaces/ws-1/diff?mode=commits&from=aaa&to=bad')
    expect(res.status).toBe(400)
  })

  it('falls back to the empty-tree base when from does not resolve (root commit)', async () => {
    vi.mocked(gitOps.commitExists).mockImplementation((_repo, ref) => ref !== 'aaa^')
    vi.mocked(gitOps.getChangedFilesBetween).mockReturnValue([{ path: 'a.txt', status: 'added' }])
    const res = await app.request('/api/workspaces/ws-1/diff?mode=commits&from=aaa%5E&to=aaa')
    expect(res.status).toBe(200)
    expect(gitOps.getChangedFilesBetween).toHaveBeenCalledWith(
      fakeWorkspace.worktreePath,
      '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
      'aaa',
    )
  })
})

describe('GET /:id/diff-file mode=commits', () => {
  beforeEach(() => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(fakeWorkspace)
    vi.mocked(gitOps.commitExists).mockReturnValue(true)
  })

  it('returns original/modified from each ref, no modifiedSha', async () => {
    vi.mocked(gitOps.getFileAtRef).mockImplementation((_repo, ref) => (ref === 'aaa' ? 'old' : 'new'))
    const res = await app.request('/api/workspaces/ws-1/diff-file?mode=commits&from=aaa&to=bbb&path=a.txt')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.original).toBe('old')
    expect(body.modified).toBe('new')
    expect(body.mode).toBe('commits')
    expect(body.modifiedSha).toBeUndefined()
    expect(gitOps.getFileAtRef).toHaveBeenCalledWith(fakeWorkspace.worktreePath, 'aaa', 'a.txt')
    expect(gitOps.getFileAtRef).toHaveBeenCalledWith(fakeWorkspace.worktreePath, 'bbb', 'a.txt')
  })

  it('400 when from or to is missing', async () => {
    const res = await app.request('/api/workspaces/ws-1/diff-file?mode=commits&to=bbb&path=a.txt')
    expect(res.status).toBe(400)
  })

  it('400 when the to ref is invalid', async () => {
    vi.mocked(gitOps.commitExists).mockImplementation((_repo, ref) => ref !== 'bad')
    const res = await app.request('/api/workspaces/ws-1/diff-file?mode=commits&from=aaa&to=bad&path=a.txt')
    expect(res.status).toBe(400)
  })

  it('falls back to the empty-tree base when from does not resolve (root commit)', async () => {
    vi.mocked(gitOps.commitExists).mockImplementation((_repo, ref) => ref !== 'aaa^')
    vi.mocked(gitOps.getFileAtRef).mockReturnValue('content')
    const res = await app.request('/api/workspaces/ws-1/diff-file?mode=commits&from=aaa%5E&to=aaa&path=a.txt')
    expect(res.status).toBe(200)
    expect(gitOps.getFileAtRef).toHaveBeenCalledWith(
      fakeWorkspace.worktreePath,
      '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
      'a.txt',
    )
  })
})

describe('GET /api/workspaces/:id/working-tree-files', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(fakeWorkspace)
  })

  it('returns the working-tree files', async () => {
    vi.mocked(gitOps.getWorkingTreeFiles).mockReturnValue([
      { path: 'a.txt', staged: true, modified: false, untracked: false },
      { path: 'b.txt', staged: false, modified: true, untracked: false },
    ])
    const res = await app.request('/api/workspaces/ws-1/working-tree-files')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.files).toHaveLength(2)
    expect(body.files[0].path).toBe('a.txt')
  })

  it('returns 404 when workspace not found', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(null as never)
    const res = await app.request('/api/workspaces/unknown/working-tree-files')
    expect(res.status).toBe(404)
  })
})
