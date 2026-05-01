import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// ── Mocks ────────────────────────────────────────────────────────────────────
//
// The deferred-tool-use route only depends on agentManager.answerPendingQuestion
// + Hono itself, but workspaces.ts pulls in a wide service tree at import time.
// We mirror the mock surface from routes-workspaces.test.ts so this file can
// import the router without booting the real DB / git / agent stack.

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
  startAgent: vi.fn(),
  stopAgent: vi.fn(),
  sendMessage: vi.fn(),
  getAgentStatus: vi.fn().mockReturnValue(null),
  answerPendingQuestion: vi.fn(),
  answerPendingPermission: vi.fn(),
  resumeDeferredToolUse: vi.fn(),
  resumeDeferredQuestion: vi.fn(),
  resumeDeferredPermission: vi.fn(),
  interruptAgent: vi.fn(),
}))

vi.mock('../server/services/agent/engines/registry.js', () => ({
  listEngines: vi.fn().mockReturnValue([{ id: 'claude-code' }]),
  resolveEngine: vi.fn(),
}))

const { execFilePromiseMock } = vi.hoisted(() => ({ execFilePromiseMock: vi.fn() }))
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
  const mock = Object.assign(vi.fn(), {
    [Symbol.for('nodejs.util.promisify.custom')]: execFilePromiseMock,
  })
  return { ...actual, execFile: mock, execFileSync: vi.fn(), spawn: vi.fn() }
})

vi.mock('../server/services/pr-template-service.js', () => ({
  renderPrTemplate: vi.fn(),
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

vi.mock('../server/services/auto-loop-service.js', () => ({
  enable: vi.fn(),
  disable: vi.fn(),
  onSessionEnded: vi.fn(),
  getStatus: vi.fn(() => ({ enabled: false })),
}))

vi.mock('../server/services/terminal-service.js', () => ({
  spawnTerminal: vi.fn(),
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

vi.mock('../server/middleware/migration-guard.js', () => ({
  migrationGuard: vi.fn((_c: unknown, next: () => Promise<unknown>) => next()),
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
  return { ...mocked, default: mocked }
})

import router from '../server/routes/workspaces.js'
import * as agentManager from '../server/services/agent/orchestrator.js'

beforeEach(() => {
  vi.clearAllMocks()
})

function makeApp(): Hono {
  const app = new Hono()
  app.route('/api/workspaces', router)
  return app
}

describe('POST /api/workspaces/:id/deferred-tool-use/answer', () => {
  it('returns 200 when resume succeeds', async () => {
    vi.mocked(agentManager.answerPendingQuestion).mockResolvedValueOnce(undefined)
    const res = await makeApp().request('/api/workspaces/abc/deferred-tool-use/answer', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ answers: { q1: 'react' } }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean }
    expect(body.ok).toBe(true)
    expect(agentManager.answerPendingQuestion).toHaveBeenCalledWith('abc', { q1: 'react' }, undefined)
  })

  it('returns 400 when answers are missing', async () => {
    const res = await makeApp().request('/api/workspaces/abc/deferred-tool-use/answer', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/answers payload required/)
    expect(agentManager.answerPendingQuestion).not.toHaveBeenCalled()
  })

  it('returns 409 when the resume throws "No deferred tool use pending"', async () => {
    vi.mocked(agentManager.answerPendingQuestion).mockRejectedValueOnce(
      new Error("No deferred tool use pending for workspace 'abc'"),
    )
    const res = await makeApp().request('/api/workspaces/abc/deferred-tool-use/answer', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ answers: { q1: 'x' } }),
    })
    // Conflict (not bad-request): the user's payload was valid, the backend
    // simply has no pending callback to answer (race / replay). The frontend
    // self-heals on this error string regardless of status code.
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/No deferred tool use pending/)
  })
})

describe('POST /api/workspaces/:id/deferred-permission/decision', () => {
  it('returns 200 on a valid allow decision', async () => {
    vi.mocked(agentManager.answerPendingPermission).mockResolvedValueOnce(undefined)
    const res = await makeApp().request('/api/workspaces/abc/deferred-permission/decision', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ toolCallId: 't1', decision: 'allow' }),
    })
    expect(res.status).toBe(200)
    expect(agentManager.answerPendingPermission).toHaveBeenCalledWith('abc', {
      toolCallId: 't1',
      decision: 'allow',
      reason: undefined,
    })
  })

  it('returns 200 on a valid deny decision with reason', async () => {
    vi.mocked(agentManager.answerPendingPermission).mockResolvedValueOnce(undefined)
    const res = await makeApp().request('/api/workspaces/abc/deferred-permission/decision', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ toolCallId: 't1', decision: 'deny', reason: 'unsafe' }),
    })
    expect(res.status).toBe(200)
    expect(agentManager.answerPendingPermission).toHaveBeenCalledWith('abc', {
      toolCallId: 't1',
      decision: 'deny',
      reason: 'unsafe',
    })
  })

  it('returns 400 when toolCallId is missing', async () => {
    const res = await makeApp().request('/api/workspaces/abc/deferred-permission/decision', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'allow' }),
    })
    expect(res.status).toBe(400)
    expect(agentManager.answerPendingPermission).not.toHaveBeenCalled()
  })

  it('returns 400 when decision is invalid', async () => {
    const res = await makeApp().request('/api/workspaces/abc/deferred-permission/decision', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ toolCallId: 't1', decision: 'maybe' }),
    })
    expect(res.status).toBe(400)
    expect(agentManager.answerPendingPermission).not.toHaveBeenCalled()
  })

  it('returns 400 when head is not a permission item', async () => {
    vi.mocked(agentManager.answerPendingPermission).mockRejectedValueOnce(
      new Error("Expected a deferred permission at the head of the queue, got 'question'"),
    )
    const res = await makeApp().request('/api/workspaces/abc/deferred-permission/decision', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ toolCallId: 't1', decision: 'allow' }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/Expected a deferred permission/)
  })
})
