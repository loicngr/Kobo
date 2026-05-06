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
  listEngines: vi.fn().mockReturnValue([{ id: 'claude-code' }]),
  resolveEngine: vi.fn(),
}))

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
  getCommitsBehind: vi.fn().mockReturnValue(0),
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
  listCommitsBehind: vi.fn().mockReturnValue([]),
  fetchSourceBranchAsync: vi.fn().mockResolvedValue(undefined),
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

vi.mock('../server/services/quota-backoff-service.js', () => ({
  arm: vi.fn(),
  cancel: vi.fn(),
  getPending: vi.fn(),
  listPending: vi.fn(() => []),
  restoreOnBoot: vi.fn(),
  setOnFireCallback: vi.fn(),
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
  getProjectSettings: vi.fn(),
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

import router from '../server/routes/workspaces.js'
import * as quotaBackoffService from '../server/services/quota-backoff-service.js'
import * as workspaceService from '../server/services/workspace-service.js'

// ── App setup ───────────────────────────────────────────────────────────────

const app = new Hono()
app.route('/api/workspaces', router)

// ── Tests ────────────────────────────────────────────────────────────────────

describe('GET /api/workspaces/:id/quota-backoff', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns null when no pending backoff exists', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue({ id: 'w1' } as never)
    vi.mocked(quotaBackoffService.getPending).mockReturnValue(null)
    const res = await app.request('/api/workspaces/w1/quota-backoff')
    expect(res.status).toBe(200)
    expect(await res.json()).toBeNull()
  })

  it('returns the pending row when one exists', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue({ id: 'w1' } as never)
    vi.mocked(quotaBackoffService.getPending).mockReturnValue({
      workspaceId: 'w1',
      targetAt: '2026-05-06T13:30:00Z',
      resetsAt: '2026-05-06T13:30:00Z',
      source: 'usage_api',
      retryCount: 1,
      createdAt: '2026-05-06T08:30:00Z',
    } as never)
    const res = await app.request('/api/workspaces/w1/quota-backoff')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { source?: string }
    expect(body?.source).toBe('usage_api')
  })

  it('returns 404 when the workspace does not exist', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(null)
    const res = await app.request('/api/workspaces/missing/quota-backoff')
    expect(res.status).toBe(404)
  })
})

describe('DELETE /api/workspaces/:id/quota-backoff', () => {
  beforeEach(() => vi.clearAllMocks())

  it("returns 204 and calls cancel('user') when a backoff exists", async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue({ id: 'w1' } as never)
    vi.mocked(quotaBackoffService.cancel).mockReturnValue(true)
    const res = await app.request('/api/workspaces/w1/quota-backoff', { method: 'DELETE' })
    expect(res.status).toBe(204)
    expect(quotaBackoffService.cancel).toHaveBeenCalledWith('w1', 'user')
  })

  it('returns 204 even when nothing was pending (idempotent)', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue({ id: 'w1' } as never)
    vi.mocked(quotaBackoffService.cancel).mockReturnValue(false)
    const res = await app.request('/api/workspaces/w1/quota-backoff', { method: 'DELETE' })
    expect(res.status).toBe(204)
  })

  it('returns 404 when the workspace does not exist', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(null)
    const res = await app.request('/api/workspaces/missing/quota-backoff', { method: 'DELETE' })
    expect(res.status).toBe(404)
  })
})
