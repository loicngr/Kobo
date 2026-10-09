import { execFileSync } from 'node:child_process'
import { beforeEach, expect, it, vi } from 'vitest'
import type { AgentEvent, StartOptions } from '../server/services/agent/engines/types.js'
import { resetDb } from './helpers/reset-db.js'

const admissionConfig = vi.hoisted(() => ({ maxConcurrentAgents: 0 }))

vi.mock('../server/services/settings-service.js', () => ({
  getGlobalSettings: () => ({
    autoLoopMaxRetries: 5,
    maxConcurrentAgents: admissionConfig.maxConcurrentAgents,
    onSessionEndedScript: '',
    onAutoLoopDisabledScript: '',
    onPrMergedScript: '',
  }),
  getEffectiveSettings: () => ({
    model: 'auto',
    dangerouslySkipPermissions: true,
    prPromptTemplate: '',
    gitConventions: '',
    sourceBranch: 'main',
    devServer: null,
    setupScript: '',
    cleanupScript: '',
    sessionEndedScript: '',
    autoLoopDisabledScript: '',
    prMergedScript: '',
    notionStatusProperty: '',
    notionInProgressStatus: '',
  }),
}))
vi.mock('../server/services/usage/poller.js', () => ({ refreshNow: vi.fn().mockResolvedValue(null) }))

beforeEach(async () => {
  admissionConfig.maxConcurrentAgents = 0
  vi.resetModules()
  await resetDb()
})

async function fixture(
  sessionModel?: string,
  lifecycle?: {
    reviewClosed?: Promise<void>
    returnReady?: Promise<void>
    retriedReturnReady?: Promise<void>
    returnAccepted?: Promise<void>
  },
) {
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
        permissionModes: ['bypass', 'plan'],
        effortLevels: [{ id: 'high', label: 'High' }],
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
          ...(starts.length === 2 && lifecycle?.reviewClosed ? { closed: lifecycle.reviewClosed } : {}),
          ...(starts.length === 3 && lifecycle?.returnReady ? { ready: lifecycle.returnReady } : {}),
          ...(starts.length === 3 && lifecycle?.returnAccepted
            ? { initialPromptAccepted: lifecycle.returnAccepted }
            : {}),
          ...(starts.length === 4 && lifecycle?.retriedReturnReady ? { ready: lifecycle.retriedReturnReady } : {}),
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
  await vi.waitFor(() => expect(f.returns.getReviewReturn(f.workspace.id)).toBeNull())
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
  expect(f.returns.getReviewReturn(f.workspace.id)?.phase).toBe('blocked')
})

it('preserves the pending return across restart while restoring original settings', async () => {
  const f = await fixture()
  f.returns.reconcileReviewReturns()
  f.returns.reconcileReviewReturns()
  expect(f.ws.getWorkspace(f.workspace.id)?.engine).toBe('claude-code')
  expect(f.returns.getReviewReturn(f.workspace.id)?.reviewSessionId).toBe(f.reviewSessionId)
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

it('preserves the pending review on server shutdown and resumes its own native session on boot', async () => {
  const f = await fixture()
  await f.orch.stopAgentAndWait(f.workspace.id, undefined, 'shutdown')
  expect(f.returns.getReviewReturn(f.workspace.id)?.reviewSessionId).toBe(f.reviewSessionId)
  f.returns.reconcileReviewReturns()
  f.orch.resumePendingReviewReturns()
  f.orch.resumePendingReviewReturns()
  await Promise.resolve()
  await Promise.resolve()
  expect(f.starts).toHaveLength(3)
  expect(f.starts[2]).toMatchObject({
    engine: 'codex',
    options: { model: 'gpt-5.4', effort: 'xhigh', resumeFromEngineSessionId: 'review-native', readOnly: true },
  })
  f.starts[2]!.emit({ kind: 'message:text', messageId: 'finished', text: 'Persisted review report', streaming: false })
  f.starts[2]!.emit({ kind: 'session:ended', reason: 'completed', exitCode: 0 })
  await Promise.resolve()
  await Promise.resolve()
  expect(f.starts).toHaveLength(4)
  expect(f.starts[3]!.options.resumeFromEngineSessionId).toBe('original-native-conversation')
  expect(f.starts[3]!.options.prompt).toContain('Persisted review report')
  await f.orch.stopAgentAndWait(f.workspace.id)
})

it('retains the final report across an abrupt restart before the reviewer process closes', async () => {
  let closeReview!: () => void
  const f = await fixture(undefined, {
    reviewClosed: new Promise<void>((resolve) => {
      closeReview = resolve
    }),
  })
  f.starts[1]!.emit({ kind: 'message:text', messageId: 'final', text: 'Report saved before exit', streaming: false })
  f.starts[1]!.emit({ kind: 'session:ended', reason: 'completed', exitCode: 0 })
  expect(f.returns.getReviewReturn(f.workspace.id)?.phase).toBe('ready')
  expect(f.starts).toHaveLength(2)
  // A fresh process has no surviving controllers; the durable state and events remain.
  f.orch._getControllers().clear()
  f.orch.reconcileOrphanSessions()
  f.returns.reconcileReviewReturns()
  f.orch.resumePendingReviewReturns()
  await vi.waitFor(() => expect(f.starts).toHaveLength(3))
  expect(f.starts[2]!.options.prompt).toContain('Report saved before exit')
  expect(f.starts[2]!.options.resumeFromEngineSessionId).toBe('original-native-conversation')
  closeReview()
  await Promise.resolve()
  expect(f.starts).toHaveLength(3)
  await f.orch.stopAgentAndWait(f.workspace.id)
})

it('waits for actual reviewer closure before returning to the original session', async () => {
  let closeReview!: () => void
  const f = await fixture(undefined, {
    reviewClosed: new Promise<void>((resolve) => {
      closeReview = resolve
    }),
  })
  f.starts[1]!.emit({ kind: 'session:ended', reason: 'completed', exitCode: 0 })
  f.orch.resumePendingReviewReturns()
  await Promise.resolve()
  expect(f.starts).toHaveLength(2)
  closeReview()
  await vi.waitFor(() => expect(f.starts).toHaveLength(3))
  await f.orch.stopAgentAndWait(f.workspace.id)
})

it('does not replay an ambiguous return after reboot and permits an explicit retry', async () => {
  const f = await fixture(undefined, { returnReady: new Promise<void>(() => {}) })
  f.starts[1]!.emit({ kind: 'message:text', messageId: 'final', text: 'Review summary', streaming: false })
  f.starts[1]!.emit({ kind: 'session:ended', reason: 'completed', exitCode: 0 })
  await vi.waitFor(() => expect(f.starts).toHaveLength(3))
  expect(f.returns.getReviewReturn(f.workspace.id)?.phase).toBe('dispatching')
  f.orch._getControllers().clear()
  f.orch.reconcileOrphanSessions()
  f.returns.reconcileReviewReturns()
  f.orch.resumePendingReviewReturns()
  f.returns.reconcileReviewReturns()
  f.orch.resumePendingReviewReturns()
  expect(f.returns.getReviewReturn(f.workspace.id)?.phase).toBe('unknown')
  expect(f.starts).toHaveLength(3)
  f.orch.retryReviewReturn(f.workspace.id)
  await vi.waitFor(() => expect(f.starts).toHaveLength(4))
  expect(f.starts[3]!.options.prompt).toContain('Review summary')
  await f.orch.stopAgentAndWait(f.workspace.id)
})

it('does not silently create a replacement when the original native session is unavailable', async () => {
  const f = await fixture()
  f.getDb().prepare('UPDATE agent_sessions SET engine_session_id = NULL WHERE id = ?').run(f.originalSessionId)
  f.starts[1]!.emit({ kind: 'session:ended', reason: 'completed', exitCode: 0 })
  await Promise.resolve()
  expect(f.starts).toHaveLength(2)
  expect(f.returns.getReviewReturn(f.workspace.id)).toMatchObject({
    phase: 'blocked',
    error: expect.stringContaining('original session'),
  })
  f.orch.cancelReviewReturn(f.workspace.id)
  expect(f.returns.getReviewReturn(f.workspace.id)).toBeNull()
})

it('keeps a completed review queued while the automatic agent limit is full', async () => {
  const f = await fixture()
  const loops = await import('../server/services/auto-loop-service.js')
  const gate = vi.spyOn(loops, 'canStartAutomatically').mockReturnValue(false)
  f.starts[1]!.emit({ kind: 'session:ended', reason: 'completed', exitCode: 0 })
  await Promise.resolve()
  expect(f.starts).toHaveLength(2)
  expect(f.returns.getReviewReturn(f.workspace.id)?.phase).toBe('ready')
  gate.mockRestore()
  f.orch.resumePendingReviewReturns()
  await vi.waitFor(() => expect(f.starts).toHaveLength(3))
  await f.orch.stopAgentAndWait(f.workspace.id)
})

it('resumes a manual reviewer after quota reset without losing its return', async () => {
  const f = await fixture()
  const quota = await import('../server/services/quota-backoff-service.js')
  const loops = await import('../server/services/auto-loop-service.js')
  f.starts[1]!.emit({ kind: 'error', category: 'quota', message: '429 quota exceeded' })
  f.starts[1]!.emit({ kind: 'session:ended', reason: 'error', exitCode: 1 })
  expect(f.ws.getWorkspace(f.workspace.id)?.status).toBe('quota')
  expect(f.returns.getReviewReturn(f.workspace.id)?.phase).toBe('reviewing')
  const pending = quota.getPending(f.workspace.id)!
  expect(pending).not.toBeNull()
  quota.cancel(f.workspace.id, 'completed')
  loops.onQuotaBackoffExpired(f.workspace.id, pending)
  await vi.waitFor(() => expect(f.starts).toHaveLength(3))
  expect(f.starts[2]!.options.resumeFromEngineSessionId).toBe('review-native')
  expect(f.starts[2]!.options.readOnly).toBe(true)
  expect(f.returns.getReviewReturn(f.workspace.id)?.originalSessionId).toBe(f.originalSessionId)
  await f.orch.stopAgentAndWait(f.workspace.id)
})

it('preserves a manual return when quota recovery must stop the old reviewer', async () => {
  const f = await fixture()
  const quota = await import('../server/services/quota-backoff-service.js')
  const loops = await import('../server/services/auto-loop-service.js')
  f.starts[1]!.emit({ kind: 'error', category: 'quota', message: '429 quota exceeded' })
  const pending = quota.getPending(f.workspace.id)!
  quota.cancel(f.workspace.id, 'completed')
  loops.onQuotaBackoffExpired(f.workspace.id, pending)
  await vi.waitFor(() => expect(f.starts).toHaveLength(3))
  expect(f.starts[2]!.options.resumeFromEngineSessionId).toBe('review-native')
  expect(f.returns.getReviewReturn(f.workspace.id)?.originalSessionId).toBe(f.originalSessionId)
  await f.orch.stopAgentAndWait(f.workspace.id)
})

it('does not credit a superseded reviewer completion after a restart of the same session', async () => {
  const f = await fixture()
  f.orch._getControllers().clear()
  f.orch.reconcileOrphanSessions()
  f.returns.reconcileReviewReturns()
  f.orch.resumePendingReviewReturns()
  await vi.waitFor(() => expect(f.starts).toHaveLength(3))
  f.starts[1]!.emit({ kind: 'session:ended', reason: 'completed', exitCode: 0 })
  expect(f.returns.getReviewReturn(f.workspace.id)?.phase).toBe('reviewing')
  await f.orch.stopAgentAndWait(f.workspace.id)
})

it('an explicit Stop also cancels a review still preparing before persistence', async () => {
  const f = await fixture()
  const launches = await import('../server/services/review-launch-runtime.js')
  const launch = launches.beginReviewLaunch(f.workspace.id)!
  await f.orch.stopAgentAndWait(f.workspace.id)
  expect(launch.cancelled).toBe(true)
  launches.finishReviewLaunch(f.workspace.id)
})

it('does not let a late acceptance from an old attempt consume a retried report', async () => {
  let acceptOld!: () => void
  const f = await fixture(undefined, {
    returnReady: new Promise<void>((resolve) => {
      acceptOld = resolve
    }),
    retriedReturnReady: new Promise<void>(() => {}),
  })
  f.starts[1]!.emit({ kind: 'session:ended', reason: 'completed', exitCode: 0 })
  await vi.waitFor(() => expect(f.starts).toHaveLength(3))
  f.starts[2]!.emit({ kind: 'error', category: 'other', message: 'Acceptance not confirmed' })
  f.starts[2]!.emit({ kind: 'session:ended', reason: 'error', exitCode: 1 })
  expect(f.returns.getReviewReturn(f.workspace.id)?.phase).toBe('unknown')
  f.orch.retryReviewReturn(f.workspace.id)
  await vi.waitFor(() => expect(f.starts).toHaveLength(4))
  acceptOld()
  await new Promise((resolve) => setImmediate(resolve))
  expect(f.returns.getReviewReturn(f.workspace.id)?.phase).toBe('dispatching')
  await f.orch.stopAgentAndWait(f.workspace.id)
})

it('explicit retry renews a blocked final reviewer capability and resumes the exact review session', async () => {
  const f = await fixture()
  const finalReview = await import('../server/services/auto-loop-final-review-service.js')
  f.getDb().prepare('UPDATE workspaces SET auto_loop=1 WHERE id=?').run(f.workspace.id)
  f.getDb()
    .prepare(
      `INSERT INTO auto_loop_final_reviews(workspace_id,configuration,state,cycle,review_session_id,original_session_id,token,updated_at) VALUES(?,'{}','reviewing',1,?,?,?,?)`,
    )
    .run(f.workspace.id, f.reviewSessionId, f.originalSessionId, 'old-token', new Date().toISOString())
  f.starts[1]!.emit({ kind: 'session:ended', reason: 'completed', exitCode: 0 })
  expect(f.returns.getReviewReturn(f.workspace.id)?.phase).toBe('blocked')
  expect(finalReview.getFinalReviewStatus(f.workspace.id).state).toBe('blocked')
  f.orch.retryReviewReturn(f.workspace.id)
  await vi.waitFor(() => expect(f.starts).toHaveLength(3))
  expect(f.starts[2]!.options.resumeFromEngineSessionId).toBe('review-native')
  const launch = finalReview.getAutoLoopReviewLaunch(f.workspace.id, f.reviewSessionId)!
  expect(launch.mcpEnv.KOBO_FINAL_REVIEW_TOKEN).not.toBe('old-token')
  finalReview.submitFinalReviewReport(f.workspace.id, f.reviewSessionId, launch.mcpEnv.KOBO_FINAL_REVIEW_TOKEN, {
    summary: 'All clear',
    findings: [],
  })
  f.starts[2]!.emit({ kind: 'session:ended', reason: 'completed', exitCode: 0 })
  await vi.waitFor(() => expect(f.starts).toHaveLength(4))
  expect(f.starts[3]!.options.resumeFromEngineSessionId).toBe('original-native-conversation')
  expect(f.starts[3]!.options.prompt).toContain('All clear')
  await f.orch.stopAgentAndWait(f.workspace.id)
})

it('keeps the return durable after engine initialization until the initial prompt is consumed', async () => {
  let acknowledge!: () => void
  const f = await fixture(undefined, {
    returnReady: Promise.resolve(),
    returnAccepted: new Promise<void>((resolve) => {
      acknowledge = resolve
    }),
  })
  f.starts[1]!.emit({ kind: 'session:ended', reason: 'completed', exitCode: 0 })
  await vi.waitFor(() => expect(f.starts).toHaveLength(3))
  await new Promise((resolve) => setImmediate(resolve))
  expect(f.returns.getReviewReturn(f.workspace.id)?.phase).toBe('dispatching')
  acknowledge()
  await vi.waitFor(() => expect(f.returns.getReviewReturn(f.workspace.id)).toBeNull())
  await f.orch.stopAgentAndWait(f.workspace.id)
})

it('does not hide a failed return when prompt receipt and a provider error arrive together', async () => {
  let acknowledge!: () => void
  const f = await fixture(undefined, {
    returnReady: Promise.resolve(),
    returnAccepted: new Promise<void>((resolve) => {
      acknowledge = resolve
    }),
  })
  const websocket = await import('../server/services/websocket-service.js')
  const events = vi.spyOn(websocket, 'emitEphemeral')
  f.starts[1]!.emit({ kind: 'session:ended', reason: 'completed', exitCode: 0 })
  await vi.waitFor(() => expect(f.starts).toHaveLength(3))
  events.mockClear()
  acknowledge()
  f.starts[2]!.emit({ kind: 'error', category: 'other', message: 'Provider rejected this turn' })
  await new Promise((resolve) => setImmediate(resolve))
  expect(f.returns.getReviewReturn(f.workspace.id)?.phase).toBe('unknown')
  expect(events).not.toHaveBeenCalledWith(f.workspace.id, 'review:return-status', null)
  events.mockRestore()
  await f.orch.stopAgentAndWait(f.workspace.id)
})

it('preserves the healthy original conversation when the restarted reviewer cannot resume', async () => {
  const f = await fixture()
  await f.orch.stopAgentAndWait(f.workspace.id, undefined, 'shutdown')
  f.returns.reconcileReviewReturns()
  f.orch.resumePendingReviewReturns()
  await vi.waitFor(() => expect(f.starts).toHaveLength(3))
  f.starts[2]!.emit({ kind: 'error', category: 'resume_failed', message: 'Reviewer native session no longer exists' })
  f.starts[2]!.emit({ kind: 'session:ended', reason: 'error', exitCode: 1 })
  expect(f.getDb().prepare('SELECT engine_session_id FROM agent_sessions WHERE id=?').get(f.originalSessionId)).toEqual(
    { engine_session_id: 'original-native-conversation' },
  )
  expect(f.getDb().prepare('SELECT engine_session_id FROM agent_sessions WHERE id=?').get(f.reviewSessionId)).toEqual({
    engine_session_id: null,
  })
  expect(f.returns.getReviewReturn(f.workspace.id)?.phase).toBe('blocked')
  // The surviving source remains explicitly resumable even with a different reviewer engine.
  f.orch.cancelReviewReturn(f.workspace.id)
  f.orch.startAgent(f.workspace.id, '/tmp', 'Continue source', f.workspace.model, true, 'bypass', f.originalSessionId)
  await vi.waitFor(() => expect(f.starts).toHaveLength(4))
  expect(f.starts[3]!.options.resumeFromEngineSessionId).toBe('original-native-conversation')
  await f.orch.stopAgentAndWait(f.workspace.id)
})

it('wakes a manual return when another ordinary session releases the last agent slot', async () => {
  admissionConfig.maxConcurrentAgents = 1
  const f = await fixture()
  // Drain the source replacement's deferred capacity notification before this scenario.
  await new Promise((resolve) => setTimeout(resolve, 0))
  const other = f.ws.createWorkspace({
    name: 'Other',
    projectPath: '/tmp',
    sourceBranch: 'main',
    workingBranch: 'other',
  })
  f.ws.updateWorkspaceStatus(other.id, 'brainstorming')
  f.orch.startAgent(other.id, '/tmp', 'Ordinary work', undefined, false, 'bypass')
  await vi.waitFor(() => expect(f.starts).toHaveLength(3))
  f.starts[1]!.emit({ kind: 'session:ended', reason: 'completed', exitCode: 0 })
  await vi.waitFor(() => expect(f.returns.getReviewReturn(f.workspace.id)?.phase).toBe('ready'))
  // Its deferred wakeup must run while the other workspace still owns the slot.
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(f.starts).toHaveLength(3)
  f.starts[2]!.emit({ kind: 'session:ended', reason: 'completed', exitCode: 0 })
  await vi.waitFor(() => expect(f.starts).toHaveLength(4))
  expect(f.starts[3]!.options.resumeFromEngineSessionId).toBe('original-native-conversation')
  await vi.waitFor(() => expect(f.returns.getReviewReturn(f.workspace.id)).toBeNull())
  await f.orch.stopAgentAndWait(f.workspace.id)
})

it.each(['during-session', 'at-creation'] as const)(
  'reviews the final writer when auto-loop is enabled %s',
  async (activation) => {
    const f = await fixture()
    const loops = await import('../server/services/auto-loop-service.js')
    const finals = await import('../server/services/auto-loop-final-review-service.js')
    const gitOps = await import('../server/utils/git-ops.js')
    const fetch = vi.spyOn(gitOps, 'fetchSourceBranchOrThrowAsync').mockResolvedValue(undefined)
    try {
      // Real local Git repository; no network/provider or external agent is used.
      const directory = process.env.KOBO_HOME!
      execFileSync('git', ['init', '-q', '-b', 'main', directory])
      execFileSync(
        'git',
        ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-qm', 'Initial'],
        { cwd: directory },
      )
      execFileSync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: directory })
      execFileSync('git', ['branch', 'work'], { cwd: directory })
      f.ws.updateWorktreePath(f.workspace.id, directory)
      await f.orch.stopAgentAndWait(f.workspace.id)
      f.orch.startAgent(
        f.workspace.id,
        directory,
        'Finish the mission',
        f.workspace.model,
        true,
        'bypass',
        f.originalSessionId,
      )
      f.ws.updateWorkspaceStatus(f.workspace.id, 'executing')
      await vi.waitFor(() => expect(f.starts).toHaveLength(3))
      f.ws.setAutoLoopReady(f.workspace.id, true)
      const task = f.ws.createTask(f.workspace.id, {
        title: '[FINAL] Complete final verification',
        role: 'finalization',
      })
      finals.configureFinalReview(f.workspace.id, {
        engine: 'claude-code',
        model: f.workspace.model,
        reasoningEffort: 'high',
        additionalInstructions: '',
      })
      if (activation === 'during-session') {
        loops.enable(f.workspace.id)
        expect(finals.getFinalReviewSourceSession(f.workspace.id)).toBe(f.originalSessionId)
      } else {
        f.getDb().prepare('UPDATE workspaces SET auto_loop=1 WHERE id=?').run(f.workspace.id)
      }
      f.ws.updateTask(task.id, {
        status: 'done',
        verification: { method: 'test', summary: 'Passed checks', checks: [{ name: 'suite', status: 'passed' }] },
      })
      f.starts[2]!.emit({ kind: 'session:ended', reason: 'completed', exitCode: 0 })
      await vi.waitFor(() => expect(f.starts).toHaveLength(4))
      expect(f.starts[3]!.options.agentPermissionMode).toBe('plan')
      expect(finals.getFinalReviewStatus(f.workspace.id)).toMatchObject({
        state: 'reviewing',
        originalSessionId: f.originalSessionId,
        reason: null,
      })
      expect(f.returns.getReviewReturn(f.workspace.id)?.originalSessionId).toBe(f.originalSessionId)
    } finally {
      fetch.mockRestore()
      await f.orch.stopAgentAndWait(f.workspace.id)
    }
  },
)

it('starts fresh after a failed implicit resume without erasing older conversations', async () => {
  const f = await fixture()
  const older = f.ws.createIdleSession(f.workspace.id)
  f.getDb()
    .prepare(
      "UPDATE agent_sessions SET engine='codex', engine_session_id='older-healthy', activation_order=0 WHERE id=?",
    )
    .run(older.id)
  f.starts[1]!.emit({ kind: 'error', category: 'resume_failed', message: 'Reviewer conversation is stale' })
  f.starts[1]!.emit({ kind: 'session:ended', reason: 'error', exitCode: 1 })
  f.orch.cancelReviewReturn(f.workspace.id)
  f.ws.updateWorkspaceEngineConfiguration(f.workspace.id, 'codex', 'gpt-5.4', 'high', 'bypass')
  f.orch.startAgent(f.workspace.id, '/tmp', 'Continue', 'gpt-5.4', true, 'bypass')
  await vi.waitFor(() => expect(f.starts).toHaveLength(3))
  expect(f.starts[2]!.options.resumeFromEngineSessionId).toBeUndefined()
  expect(f.getDb().prepare('SELECT engine_session_id FROM agent_sessions WHERE id=?').get(older.id)).toEqual({
    engine_session_id: 'older-healthy',
  })
  await f.orch.stopAgentAndWait(f.workspace.id)
})
