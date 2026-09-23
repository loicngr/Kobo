import { beforeEach, expect, it, vi } from 'vitest'
import type { AgentEvent, StartOptions } from '../server/services/agent/engines/types.js'
import { resetDb } from './helpers/reset-db.js'

vi.mock('../server/services/settings-service.js', () => ({
  getGlobalSettings: () => ({ autoLoopMaxRetries: 5 }),
  getEffectiveSettings: () => ({
    model: 'auto',
    dangerouslySkipPermissions: true,
    prPromptTemplate: '',
    gitConventions: '',
    sourceBranch: 'main',
    devServer: null,
    setupScript: '',
    notionStatusProperty: '',
    notionInProgressStatus: '',
  }),
}))
vi.mock('../server/services/usage/poller.js', () => ({ refreshNow: vi.fn().mockResolvedValue(null) }))

beforeEach(async () => {
  vi.resetModules()
  await resetDb()
})

async function fixture(sessionModel?: string) {
  const ws = await import('../server/services/workspace-service.js')
  const orch = await import('../server/services/agent/orchestrator.js')
  const returns = await import('../server/services/review-return-service.js')
  const { getDb } = await import('../server/db/index.js')
  const { _registerEngineForTest } = await import('../server/services/agent/engines/registry.js')
  const starts: Array<{ engine: string; options: StartOptions; emit: (event: AgentEvent) => void }> = []
  for (const engine of ['claude-code', 'codex'] as const) {
    _registerEngineForTest({
      id: engine,
      displayName: engine,
      capabilities: {
        models: [],
        permissionModes: ['bypass'],
        supportsResume: true,
        supportsMcp: false,
        supportsSkills: false,
        supportsSubagents: false,
        supportsQuotaStatus: false,
      },
      async start(options, emit) {
        starts.push({ engine, options, emit })
        return {
          pid: 1,
          engineSessionId: `${engine}-native`,
          sendMessage() {},
          interrupt() {},
          async stop() {
            emit({ kind: 'session:ended', reason: 'killed', exitCode: null })
          },
          resolvePendingUserInput: () => false,
        }
      },
    })
  }
  const workspace = ws.createWorkspace({
    name: 'Review',
    projectPath: '/tmp',
    sourceBranch: 'main',
    workingBranch: 'work',
    model: 'claude-opus-4-7',
    reasoningEffort: 'high',
  })
  ws.updateWorkspaceStatus(workspace.id, 'brainstorming')
  const originalSessionId = orch.startAgent(
    workspace.id,
    '/tmp',
    'Original work',
    workspace.model,
    false,
    'bypass',
    undefined,
    workspace.reasoningEffort,
  ).agentSessionId
  await Promise.resolve()
  await Promise.resolve()
  starts[0]!.emit({ kind: 'session:started', engineSessionId: 'original-native-conversation' })
  await orch.stopAgentAndWait(workspace.id, undefined, 'replacement')
  const original = {
    ...(sessionModel ? { sessionModel } : {}),
    engine: workspace.engine,
    model: workspace.model,
    reasoningEffort: workspace.reasoningEffort,
    agentPermissionMode: workspace.agentPermissionMode,
  }
  const review = { engine: 'codex', model: 'gpt-5.4', reasoningEffort: 'xhigh', agentPermissionMode: 'bypass' as const }
  ws.updateWorkspaceEngineConfiguration(
    workspace.id,
    review.engine,
    review.model,
    review.reasoningEffort,
    review.agentPermissionMode,
  )
  const reviewSessionId = ws.createIdleSession(workspace.id).id
  returns.registerReviewReturn({ workspaceId: workspace.id, reviewSessionId, originalSessionId, original, review })
  orch.startAgent(
    workspace.id,
    '/tmp',
    'Review',
    review.model,
    false,
    'bypass',
    reviewSessionId,
    review.reasoningEffort,
  )
  ws.updateWorkspaceStatus(workspace.id, 'executing')
  await Promise.resolve()
  await Promise.resolve()
  starts[1]!.emit({ kind: 'session:started', engineSessionId: 'review-native' })
  return { ws, orch, returns, getDb, starts, workspace, reviewSessionId, originalSessionId }
}

it('resumes the exact original session with the final review message once', async () => {
  const f = await fixture()
  f.starts[1]!.emit({ kind: 'message:text', messageId: 'progress', text: 'Exploring code', streaming: true })
  f.starts[1]!.emit({ kind: 'message:text', messageId: 'final', text: 'Critical bug ', streaming: true })
  f.starts[1]!.emit({ kind: 'message:text', messageId: 'final', text: 'in app.ts:12', streaming: true })
  // Snapshot must replace the streaming fragments, not double them.
  f.starts[1]!.emit({ kind: 'message:text', messageId: 'final', text: 'Critical bug in app.ts:12', streaming: false })
  f.starts[1]!.emit({ kind: 'session:ended', reason: 'completed', exitCode: 0 })
  await Promise.resolve()
  await Promise.resolve()
  expect(f.starts).toHaveLength(3)
  expect(f.starts[2]).toMatchObject({
    engine: 'claude-code',
    options: { model: 'claude-opus-4-7', effort: 'high', resumeFromEngineSessionId: 'original-native-conversation' },
  })
  expect(f.starts[2]!.options.prompt).toContain('Critical bug in app.ts:12')
  expect(f.starts[2]!.options.prompt).not.toContain('Exploring code')
  expect(f.starts[2]!.options.prompt.match(/Critical bug/g)).toHaveLength(1)
  expect(f.orch.getActiveSessionId(f.workspace.id)).toBe(f.originalSessionId)
  expect(f.ws.getWorkspace(f.workspace.id)?.engine).toBe('claude-code')
  expect(f.returns.getReviewReturn(f.workspace.id)).toBeNull()
  f.starts[1]!.emit({ kind: 'session:ended', reason: 'completed', exitCode: 0 })
  await Promise.resolve()
  expect(f.starts).toHaveLength(3)
  await f.orch.stopAgentAndWait(f.workspace.id)
})

it('cancels the automatic return on an explicit stop and restores the settings', async () => {
  const f = await fixture()
  await f.orch.stopAgentAndWait(f.workspace.id)
  expect(f.starts).toHaveLength(2)
  expect(f.ws.getWorkspace(f.workspace.id)?.engine).toBe('claude-code')
  expect(f.returns.getReviewReturn(f.workspace.id)).toBeNull()
  f.starts[1]!.emit({ kind: 'session:ended', reason: 'completed', exitCode: 0 })
  await Promise.resolve()
  expect(f.starts).toHaveLength(2)
})

it('restores settings without restarting the original agent after a failed review', async () => {
  const f = await fixture()
  f.starts[1]!.emit({ kind: 'session:ended', reason: 'error', exitCode: 1 })
  await Promise.resolve()
  expect(f.starts).toHaveLength(2)
  expect(f.ws.getWorkspace(f.workspace.id)?.engine).toBe('claude-code')
  expect(f.ws.getWorkspace(f.workspace.id)?.status).toBe('error')
  expect(f.returns.getReviewReturn(f.workspace.id)).toBeNull()
})

it('recovers original configuration on restart without replaying a handoff', async () => {
  const f = await fixture()
  f.returns.reconcileReviewReturns()
  f.returns.reconcileReviewReturns()
  expect(f.ws.getWorkspace(f.workspace.id)?.engine).toBe('claude-code')
  expect(f.returns.getReviewReturn(f.workspace.id)).toBeNull()
  expect(f.starts).toHaveLength(2)
  await f.orch.stopAgentAndWait(f.workspace.id)
})

it("does not consume another session's pending return", async () => {
  const f = await fixture()
  expect(f.returns.restoreReviewConfiguration(f.workspace.id, 'unrelated')).toBeNull()
  expect(f.returns.getReviewReturn(f.workspace.id)?.reviewSessionId).toBe(f.reviewSessionId)
  await f.orch.stopAgentAndWait(f.workspace.id)
})

it('returns with the original session model even when the workspace default is different', async () => {
  const f = await fixture('claude-sonnet-4-6')
  f.starts[1]!.emit({ kind: 'session:ended', reason: 'completed', exitCode: 0 })
  await Promise.resolve()
  await Promise.resolve()
  expect(f.starts[2]!.options.model).toBe('claude-sonnet-4-6')
  expect(f.ws.getWorkspace(f.workspace.id)?.model).toBe('claude-opus-4-7')
  await f.orch.stopAgentAndWait(f.workspace.id)
})

it('returns after a watchdog closure without arming auto-loop recovery', async () => {
  const f = await fixture()
  f.getDb().prepare('UPDATE workspaces SET auto_loop = 1, auto_loop_ready = 1 WHERE id = ?').run(f.workspace.id)
  f.starts[1]!.emit({ kind: 'session:ended', reason: 'watchdog', exitCode: null })
  await Promise.resolve()
  await Promise.resolve()
  expect(f.starts).toHaveLength(3)
  expect(f.orch.getActiveSessionId(f.workspace.id)).toBe(f.originalSessionId)
  expect(
    f.getDb().prepare('SELECT * FROM pending_quota_backoffs WHERE workspace_id = ?').get(f.workspace.id),
  ).toBeUndefined()
  await f.orch.stopAgentAndWait(f.workspace.id)
})

it('never resumes the review native conversation with the original engine after cancellation', async () => {
  const f = await fixture()
  await f.orch.stopAgentAndWait(f.workspace.id)
  expect(() =>
    f.orch.startAgent(f.workspace.id, '/tmp', 'wrong engine', undefined, true, 'bypass', f.reviewSessionId),
  ).toThrow(/engine/)
  const resumed = f.orch.startAgent(f.workspace.id, '/tmp', 'continue', undefined, true)
  expect(resumed.agentSessionId).toBe(f.originalSessionId)
  await Promise.resolve()
  await Promise.resolve()
  expect(f.starts[2]!.options.resumeFromEngineSessionId).toBe('original-native-conversation')
  await f.orch.stopAgentAndWait(f.workspace.id)
})
