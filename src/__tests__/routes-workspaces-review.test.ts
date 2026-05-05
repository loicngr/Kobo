import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// ── Mocks (kept in sync with routes-workspaces.test.ts) ──────────────────────

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

// execFile is promisified at module load. We mock execFile with a
// [util.promisify.custom] property so that promisify returns our mock.
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
  getWorkingTreeDiffStats: vi.fn().mockReturnValue(''),
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
import * as agentManager from '../server/services/agent/orchestrator.js'
import { DEFAULT_REVIEW_PROMPT_TEMPLATE } from '../server/services/review-template-service.js'
import * as settingsService from '../server/services/settings-service.js'
import * as wakeupService from '../server/services/wakeup-service.js'
import * as wsService from '../server/services/websocket-service.js'
import * as workspaceService from '../server/services/workspace-service.js'
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
  model: 'claude-opus-4-7',
  reasoningEffort: 'auto',
  agentPermissionMode: 'bypass' as const,
  devServerStatus: 'stopped',
  hasUnread: false,
  archivedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

const fakeSession = {
  id: 'sess-1',
  workspaceId: 'ws-1',
  startedAt: '2026-01-01T00:00:00.000Z',
  endedAt: null,
  exitCode: null,
  prompt: 'test prompt',
}

const TEMPLATE_WITH_PROJECT = 'PROJECT TEMPLATE — branch {{branch_name}} base {{base_commit}}'

// ── Helpers ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks()

  // Default execFile behaviour: git fetch + git rev-parse both succeed.
  execFilePromiseMock.mockImplementation(async (cmd: string, args: string[]) => {
    if (cmd === 'git' && args[0] === 'fetch') {
      return { stdout: '', stderr: '' }
    }
    if (cmd === 'git' && args[0] === 'rev-parse') {
      return { stdout: 'abc1234deadbeef\n', stderr: '' }
    }
    return { stdout: '', stderr: '' }
  })

  vi.mocked(workspaceService.getWorkspace).mockReturnValue(fakeWorkspace)
  vi.mocked(workspaceService.getActiveSession).mockReturnValue(fakeSession as never)

  vi.mocked(gitOps.getCommitsBetween).mockReturnValue('feat: do thing\nfix: bug')
  vi.mocked(gitOps.getDiffStatsBetween).mockReturnValue(' 2 files changed, 10 insertions(+), 3 deletions(-)')
  vi.mocked(gitOps.getWorkingTreeDiffStats).mockReturnValue('')

  vi.mocked(settingsService.getEffectiveSettings).mockReturnValue({
    model: 'auto',
    dangerouslySkipPermissions: true,
    prPromptTemplate: '',
    reviewPromptTemplate: DEFAULT_REVIEW_PROMPT_TEMPLATE,
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
    reviewPromptTemplate: DEFAULT_REVIEW_PROMPT_TEMPLATE,
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
  } as never)
})

// ── Tests ────────────────────────────────────────────────────────────────────

describe('POST /api/workspaces/:id/start-review', () => {
  it('returns 404 when workspace is missing', async () => {
    vi.mocked(workspaceService.getWorkspace).mockReturnValue(null as never)

    const res = await app.request('/api/workspaces/missing/start-review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })

    expect(res.status).toBe(404)
    const data = await res.json()
    expect(data.error).toContain("Workspace 'missing' not found")
  })

  it('happy path with running agent dispatches via sendMessage and emits user:message', async () => {
    vi.mocked(agentManager.sendMessage).mockReturnValue(undefined as never)

    const res = await app.request('/api/workspaces/ws-1/start-review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })

    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data).toEqual({ ok: true, messageSent: true, newSession: false })

    // sendMessage called with rendered prompt (non-empty string)
    expect(agentManager.sendMessage).toHaveBeenCalledTimes(1)
    const [wsId, prompt] = vi.mocked(agentManager.sendMessage).mock.calls[0]
    expect(wsId).toBe('ws-1')
    expect(typeof prompt).toBe('string')
    expect((prompt as string).length).toBeGreaterThan(0)

    // wsService.emit called with user:message and the rendered prompt
    expect(wsService.emit).toHaveBeenCalledWith(
      'ws-1',
      'user:message',
      expect.objectContaining({ content: prompt, sender: 'user' }),
      'sess-1',
    )

    // wakeupService.cancel called
    expect(wakeupService.cancel).toHaveBeenCalledWith('ws-1', 'user-message')

    // No fallback start
    expect(agentManager.startAgent).not.toHaveBeenCalled()
  })

  it('falls back to startAgent(resume=true) when sendMessage throws', async () => {
    vi.mocked(agentManager.sendMessage).mockImplementation(() => {
      throw new Error('No agent running')
    })

    const res = await app.request('/api/workspaces/ws-1/start-review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })

    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.messageSent).toBe(true)
    expect(data.newSession).toBe(false)

    expect(agentManager.startAgent).toHaveBeenCalledTimes(1)
    const args = vi.mocked(agentManager.startAgent).mock.calls[0]
    // signature: (workspaceId, workingDir, prompt, model?, resume, agentPermissionMode?, existingSessionId?, reasoningEffort?)
    expect(args[0]).toBe('ws-1')
    expect(args[1]).toBe(fakeWorkspace.worktreePath)
    expect(typeof args[2]).toBe('string')
    expect(args[3]).toBe(fakeWorkspace.model)
    expect(args[4]).toBe(true) // resume
    expect(args[5]).toBe(fakeWorkspace.agentPermissionMode)
    expect(args[6]).toBeUndefined()
    expect(args[7]).toBe(fakeWorkspace.reasoningEffort)

    expect(workspaceService.updateWorkspaceStatus).toHaveBeenCalledWith('ws-1', 'executing')
  })

  it('returns 500 when both sendMessage and startAgent fail', async () => {
    vi.mocked(agentManager.sendMessage).mockImplementation(() => {
      throw new Error('No agent running')
    })
    vi.mocked(agentManager.startAgent).mockImplementation(() => {
      throw new Error('boom: cannot start')
    })

    const res = await app.request('/api/workspaces/ws-1/start-review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })

    expect(res.status).toBe(500)
    const data = await res.json()
    expect(data.error).toContain('boom: cannot start')
  })

  it('newSession=true with running agent stops then starts a fresh session', async () => {
    const callOrder: string[] = []
    vi.mocked(agentManager.stopAgent).mockImplementation(() => {
      callOrder.push('stopAgent')
    })
    vi.mocked(agentManager.startAgent).mockImplementation(() => {
      callOrder.push('startAgent')
      return { agentSessionId: 'fresh' } as never
    })

    const res = await app.request('/api/workspaces/ws-1/start-review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newSession: true }),
    })

    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data).toEqual({ ok: true, messageSent: true, newSession: true })

    expect(callOrder).toEqual(['stopAgent', 'startAgent'])
    expect(agentManager.sendMessage).not.toHaveBeenCalled()

    const args = vi.mocked(agentManager.startAgent).mock.calls[0]
    expect(args[4]).toBe(false) // resume=false
    expect(workspaceService.updateWorkspaceStatus).toHaveBeenCalledWith('ws-1', 'executing')
  })

  it('newSession=true without running agent still starts fresh (stopAgent best-effort)', async () => {
    // stopAgent throws because no agent is running — must still proceed.
    vi.mocked(agentManager.stopAgent).mockImplementation(() => {
      throw new Error('No agent running')
    })
    vi.mocked(agentManager.startAgent).mockReturnValue({ agentSessionId: 'fresh' } as never)

    const res = await app.request('/api/workspaces/ws-1/start-review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newSession: true }),
    })

    expect(res.status).toBe(200)
    expect(agentManager.startAgent).toHaveBeenCalledTimes(1)
    const args = vi.mocked(agentManager.startAgent).mock.calls[0]
    expect(args[4]).toBe(false) // resume=false
    expect(workspaceService.updateWorkspaceStatus).toHaveBeenCalledWith('ws-1', 'executing')
  })

  it('newSession=true: stopAgent throws but startAgent still runs', async () => {
    vi.mocked(agentManager.stopAgent).mockImplementation(() => {
      throw new Error('stop failed')
    })
    vi.mocked(agentManager.startAgent).mockReturnValue({ agentSessionId: 'fresh' } as never)

    const res = await app.request('/api/workspaces/ws-1/start-review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newSession: true }),
    })

    expect(res.status).toBe(200)
    // Both called: stop first (and threw), then start.
    expect(agentManager.stopAgent).toHaveBeenCalledTimes(1)
    expect(agentManager.startAgent).toHaveBeenCalledTimes(1)
  })

  it('uses project reviewPromptTemplate when non-empty (overrides global default)', async () => {
    vi.mocked(settingsService.getEffectiveSettings).mockReturnValue({
      model: 'auto',
      dangerouslySkipPermissions: true,
      prPromptTemplate: '',
      reviewPromptTemplate: TEMPLATE_WITH_PROJECT,
      gitConventions: '',
      sourceBranch: 'main',
      devServer: null,
      setupScript: '',
      notionStatusProperty: '',
      notionInProgressStatus: '',
    })
    vi.mocked(agentManager.sendMessage).mockReturnValue(undefined as never)

    const res = await app.request('/api/workspaces/ws-1/start-review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })

    expect(res.status).toBe(200)
    const [, prompt] = vi.mocked(agentManager.sendMessage).mock.calls[0]
    expect(prompt as string).toContain('PROJECT TEMPLATE')
    expect(prompt as string).toContain('feature/test')
    expect(prompt as string).toContain('abc1234deadbeef')
  })

  it('falls back to DEFAULT_REVIEW_PROMPT_TEMPLATE when effective template is empty', async () => {
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
    })
    vi.mocked(agentManager.sendMessage).mockReturnValue(undefined as never)

    const res = await app.request('/api/workspaces/ws-1/start-review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })

    expect(res.status).toBe(200)
    const [, prompt] = vi.mocked(agentManager.sendMessage).mock.calls[0]
    // DEFAULT template starts with "You are reviewing code changes…"
    expect(prompt as string).toContain('You are reviewing code changes')
    expect(prompt as string).toContain('Test Workspace')
  })

  it('returns 500 with explicit message when git rev-parse fails', async () => {
    execFilePromiseMock.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === 'git' && args[0] === 'fetch') {
        return { stdout: '', stderr: '' }
      }
      if (cmd === 'git' && args[0] === 'rev-parse') {
        throw new Error("fatal: ambiguous argument 'origin/main': unknown revision")
      }
      return { stdout: '', stderr: '' }
    })

    const res = await app.request('/api/workspaces/ws-1/start-review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })

    expect(res.status).toBe(500)
    const data = await res.json()
    expect(data.error).toContain('Cannot resolve base commit for branch main')
    expect(data.error).toContain('ambiguous argument')

    // Pipeline never reached the dispatch stage
    expect(agentManager.sendMessage).not.toHaveBeenCalled()
    expect(agentManager.startAgent).not.toHaveBeenCalled()
    // And no user:message ghost in the chat
    expect(wsService.emit).not.toHaveBeenCalled()
  })

  it('inserts the working-tree separator only when working-tree stats are non-empty', async () => {
    vi.mocked(gitOps.getWorkingTreeDiffStats).mockReturnValue(' src/foo.ts | 5 +++--\n')
    vi.mocked(agentManager.sendMessage).mockReturnValue(undefined as never)

    const res = await app.request('/api/workspaces/ws-1/start-review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })

    expect(res.status).toBe(200)
    const [, prompt] = vi.mocked(agentManager.sendMessage).mock.calls[0]
    expect(prompt as string).toContain('— Working tree (uncommitted) —')
    expect(prompt as string).toContain('src/foo.ts | 5 +++--')
  })

  it('omits the working-tree separator when working-tree stats are empty', async () => {
    vi.mocked(gitOps.getWorkingTreeDiffStats).mockReturnValue('')
    vi.mocked(agentManager.sendMessage).mockReturnValue(undefined as never)

    const res = await app.request('/api/workspaces/ws-1/start-review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })

    expect(res.status).toBe(200)
    const [, prompt] = vi.mocked(agentManager.sendMessage).mock.calls[0]
    expect(prompt as string).not.toContain('— Working tree (uncommitted) —')
  })

  it('trims whitespace from additionalInstructions before rendering', async () => {
    vi.mocked(agentManager.sendMessage).mockReturnValue(undefined as never)

    const res = await app.request('/api/workspaces/ws-1/start-review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ additionalInstructions: '   focus on perf   ' }),
    })

    expect(res.status).toBe(200)
    const [, prompt] = vi.mocked(agentManager.sendMessage).mock.calls[0]
    expect(prompt as string).toContain('focus on perf')
    expect(prompt as string).not.toContain('   focus on perf   ')
  })

  it('newSession=true emits user:message with the freshly created session id (not the old one)', async () => {
    // Active session before dispatch is the OLD one (sess-1, from beforeEach).
    // startAgent returns the NEW session id; emit should use that, not sess-1.
    vi.mocked(agentManager.startAgent).mockReturnValue({ agentSessionId: 'sess-fresh' } as never)

    const res = await app.request('/api/workspaces/ws-1/start-review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newSession: true }),
    })

    expect(res.status).toBe(200)

    // emit was called exactly once, with the FRESH session id, not the old one.
    expect(wsService.emit).toHaveBeenCalledTimes(1)
    expect(wsService.emit).toHaveBeenCalledWith(
      'ws-1',
      'user:message',
      expect.objectContaining({ content: expect.any(String), sender: 'user' }),
      'sess-fresh',
    )
    expect(wsService.emit).not.toHaveBeenCalledWith('ws-1', 'user:message', expect.anything(), 'sess-1')
  })

  it('does not emit user:message when dispatch fails (no ghost message in chat)', async () => {
    vi.mocked(agentManager.sendMessage).mockImplementation(() => {
      throw new Error('No agent running')
    })
    vi.mocked(agentManager.startAgent).mockImplementation(() => {
      throw new Error('boom: cannot start')
    })

    const res = await app.request('/api/workspaces/ws-1/start-review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })

    expect(res.status).toBe(500)
    expect(wsService.emit).not.toHaveBeenCalled()
  })
})
