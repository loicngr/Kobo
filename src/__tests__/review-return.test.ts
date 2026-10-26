import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MISTRAL_CAPABILITIES } from '../server/services/agent/engines/mistral-vibe/capabilities.js'
import type { AgentEvent, StartOptions } from '../server/services/agent/engines/types.js'
import { resetDb } from './helpers/reset-db.js'

const nativePeer = vi.hoisted(() => ({ spawn: vi.fn(), connect: vi.fn(), request: vi.fn() }))
vi.mock('../server/services/agent/engines/mistral-vibe/spawn.js', () => ({ spawnVibeAcp: nativePeer.spawn }))
vi.mock('../server/services/agent/engines/mistral-vibe/client.js', () => ({
  connectVibeAcp: nativePeer.connect,
  requestVibeAcp: nativePeer.request,
  closeVibeAcpSession: vi.fn().mockResolvedValue(undefined),
}))
const nativeReviewDirectories: string[] = []
afterEach(() => {
  for (const directory of nativeReviewDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

const admissionConfig = vi.hoisted(() => ({ maxConcurrentAgents: 0 }))

vi.mock('../server/services/settings-service.js', () => ({
  getGlobalSettings: () => ({
    autoLoopMaxRetries: 5,
    memoryMode: 'automatic',
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
  sourceEngine: 'claude-code' | 'mistral-vibe' = 'claude-code',
  configuredModel?: string,
  configuredEffort?: string,
  captureReview = false,
  nativeReview?: 'returning' | 'no-return' | 'final',
) {
  const ws = await import('../server/services/workspace-service.js')
  const orch = await import('../server/services/agent/orchestrator.js')
  const returns = await import('../server/services/review-return-service.js')
  const { getDb } = await import('../server/db/index.js')
  const { _registerEngineForTest } = await import('../server/services/agent/engines/registry.js')
  const starts: Array<{ engine: string; options: StartOptions; emit: (event: AgentEvent) => void }> = []
  for (const engine of ['claude-code', 'codex', 'mistral-vibe'] as const) {
    _registerEngineForTest({
      id: engine,
      displayName: engine,
      capabilities:
        engine === 'mistral-vibe'
          ? { ...MISTRAL_CAPABILITIES }
          : {
              models: captureReview ? [{ id: 'auto', label: 'Auto' }] : [],
              permissionModes: ['bypass', 'plan'],
              effortLevels: [{ id: 'high', label: 'High' }, ...(captureReview ? [{ id: 'auto', label: 'Auto' }] : [])],
              supportsResume: true,
              supportsMcp: false,
              supportsLiveSteering: true,
              supportsReadOnly: true,
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
    engine: sourceEngine,
    model: configuredModel ?? (sourceEngine === 'mistral-vibe' ? 'auto' : 'claude-opus-4-7'),
    reasoningEffort: configuredEffort ?? (sourceEngine === 'mistral-vibe' ? 'auto' : 'high'),
  })
  ws.updateWorkspaceStatus(workspace.id, 'brainstorming')
  const originalSessionId = orch.startAgent(
    workspace.id,
    '/tmp',
    'Original work',
    captureReview ? (sessionModel ?? workspace.model) : workspace.model,
    false,
    'bypass',
    undefined,
    captureReview ? 'max' : workspace.reasoningEffort,
  ).agentSessionId
  await Promise.resolve()
  await Promise.resolve()
  starts[0]!.emit({
    kind: 'session:started',
    engineSessionId: 'original-native-conversation',
    ...(sessionModel ? { model: sessionModel } : {}),
  })
  await orch.stopAgentAndWait(workspace.id, undefined, 'replacement')
  if (captureReview) {
    const directory = mkdtempSync(join(tmpdir(), 'kobo-native-review-return-'))
    nativeReviewDirectories.push(directory)
    execFileSync('git', ['init', '-q', '-b', 'main', directory])
    execFileSync(
      'git',
      ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'Initial'],
      { cwd: directory },
    )
    execFileSync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: directory })
    execFileSync('git', ['branch', 'work'], { cwd: directory })
    getDb().prepare('UPDATE workspaces SET worktree_path = ? WHERE id = ?').run(directory, workspace.id)
    const gitOps = await import('../server/utils/git-ops.js')
    const fetch = vi.spyOn(gitOps, 'fetchSourceBranchOrThrowAsync').mockResolvedValue(undefined)
    try {
      const { startWorkspaceReview } = await import('../server/services/review-service.js')
      await startWorkspaceReview(workspace.id, {
        engine: 'codex',
        model: 'auto',
        reasoningEffort: 'auto',
        returnToSession: true,
      })
    } finally {
      fetch.mockRestore()
    }
    const reviewSessionId = returns.getReviewReturn(workspace.id)!.reviewSessionId
    return { ws, orch, returns, getDb, starts, workspace, reviewSessionId, originalSessionId }
  }
  const original = {
    ...(sessionModel ? { sessionModel } : {}),
    engine: workspace.engine,
    model: workspace.model,
    reasoningEffort: workspace.reasoningEffort,
    agentPermissionMode: workspace.agentPermissionMode,
  }
  const review = nativeReview
    ? { engine: 'mistral-vibe', model: 'auto', reasoningEffort: 'auto', agentPermissionMode: 'interactive' as const }
    : { engine: 'codex', model: 'gpt-5.4', reasoningEffort: 'xhigh', agentPermissionMode: 'bypass' as const }
  ws.updateWorkspaceEngineConfiguration(
    workspace.id,
    review.engine,
    review.model,
    review.reasoningEffort,
    review.agentPermissionMode,
  )
  const reviewSessionId = ws.createIdleSession(workspace.id).id
  if (nativeReview !== 'no-return')
    returns.registerReviewReturn({ workspaceId: workspace.id, reviewSessionId, originalSessionId, original, review })
  let mcpEnv: Record<string, string> | undefined = nativeReview === 'no-return' ? { KOBO_REVIEW_ONLY: '1' } : undefined
  if (nativeReview === 'final') {
    getDb().prepare('UPDATE workspaces SET auto_loop=1 WHERE id=?').run(workspace.id)
    getDb()
      .prepare('INSERT INTO auto_loop_final_reviews(workspace_id,configuration,updated_at) VALUES(?,?,?)')
      .run(workspace.id, JSON.stringify({ ...review, additionalInstructions: '' }), new Date().toISOString())
    const finalReview = await import('../server/services/auto-loop-final-review-service.js')
    mcpEnv = finalReview.bindReviewSession(workspace.id, reviewSessionId, originalSessionId).mcpEnv
  }
  orch.startAgent(
    workspace.id,
    '/tmp',
    'Review',
    review.model,
    false,
    review.agentPermissionMode,
    reviewSessionId,
    review.reasoningEffort,
    undefined,
    { mcpEnv },
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

it('returns to Mistral with configured Auto despite a durable observed session model, then resumes normally', async () => {
  const f = await fixture('native-custom', undefined, 'mistral-vibe')
  f.starts[1]!.emit({ kind: 'session:ended', reason: 'completed', exitCode: 0 })
  await vi.waitFor(() => expect(f.starts).toHaveLength(3))
  expect(f.starts[2]).toMatchObject({
    engine: 'mistral-vibe',
    options: { model: 'auto', resumeFromEngineSessionId: 'original-native-conversation' },
  })
  f.starts[2]!.emit({
    kind: 'session:started',
    engineSessionId: 'original-native-conversation',
    model: 'native-custom',
  })
  expect(f.ws.getActiveSession(f.workspace.id)?.model).toBe('native-custom')
  expect(f.ws.getWorkspace(f.workspace.id)?.model).toBe('auto')
  await vi.waitFor(() => expect(f.returns.getReviewReturn(f.workspace.id)).toBeNull())
  await f.orch.stopAgentAndWait(f.workspace.id)
  f.orch.startAgent(
    f.workspace.id,
    '/tmp',
    'Resume native',
    f.ws.getWorkspace(f.workspace.id)!.model,
    true,
    'bypass',
    f.originalSessionId,
  )
  await vi.waitFor(() => expect(f.starts).toHaveLength(4))
  expect(f.starts[3]).toMatchObject({
    engine: 'mistral-vibe',
    options: { model: 'auto', resumeFromEngineSessionId: 'original-native-conversation' },
  })
  await f.orch.stopAgentAndWait(f.workspace.id)
})

it.each(['explicit-source', undefined])(
  'returns to explicit native source/brainstorm model with observed metadata %s',
  async (observed) => {
    const f = await fixture(observed, undefined, 'mistral-vibe', 'configured-iteration')
    f.starts[1]!.emit({ kind: 'session:ended', reason: 'completed', exitCode: 0 })
    await vi.waitFor(() => expect(f.starts).toHaveLength(3))
    expect(f.starts[2]).toMatchObject({
      engine: 'mistral-vibe',
      options: { model: observed ?? 'configured-iteration', resumeFromEngineSessionId: 'original-native-conversation' },
    })
    expect(f.ws.getWorkspace(f.workspace.id)?.model).toBe('configured-iteration')
    await f.orch.stopAgentAndWait(f.workspace.id)
  },
)

it.each(['auto', 'iteration-a'])(
  'preserves native source thinking while restoring %s/high iteration intent',
  async (model) => {
    const f = await fixture('brainstorm-b', undefined, 'mistral-vibe', model, 'high')
    f.starts[1]!.emit({ kind: 'session:ended', reason: 'completed', exitCode: 0 })
    await vi.waitFor(() => expect(f.starts).toHaveLength(3))
    expect(f.starts[2]!.options).toMatchObject({
      model: model === 'auto' ? 'auto' : 'brainstorm-b',
      effort: 'auto',
      resumeFromEngineSessionId: 'original-native-conversation',
    })
    expect(f.ws.getWorkspace(f.workspace.id)).toMatchObject({ model, reasoningEffort: 'high' })
    await f.orch.stopAgentAndWait(f.workspace.id)
  },
)

it.each(['auto', 'iteration-a'])(
  'captures and returns %s/high intent to native saved brainstorm-b/max before the prompt',
  async (model) => {
    const f = await fixture('brainstorm-b', undefined, 'mistral-vibe', model, 'high', true)
    expect(f.starts[0]!.options).toMatchObject({ model: 'brainstorm-b', effort: 'max' })
    expect(f.returns.getReviewReturn(f.workspace.id)?.original).toMatchObject({ model, reasoningEffort: 'high' })
    let close!: () => void
    const closed = new Promise<void>((resolve) => {
      close = resolve
    })
    nativePeer.spawn.mockReturnValue({ child: new EventEmitter(), closed, stop: async () => close() })
    nativePeer.connect.mockReturnValue({ closed: new Promise(() => {}), close: vi.fn() })
    const configOptions = [
      {
        id: 'mode',
        type: 'select',
        currentValue: 'auto-approve',
        options: [{ value: 'auto-approve', name: 'Auto approve' }],
      },
      {
        id: 'model',
        type: 'select',
        currentValue: 'brainstorm-b',
        options: ['iteration-a', 'brainstorm-b'].map((value) => ({ value, name: value })),
      },
      {
        id: 'thinking',
        type: 'select',
        currentValue: 'max',
        options: ['off', 'low', 'max'].map((value) => ({ value, name: value })),
      },
    ]
    nativePeer.request.mockReset()
    nativePeer.request.mockImplementation(async (_connection, method) => {
      if (method === 'initialize')
        return { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { close: {} } } }
      if (method === 'session/load')
        return {
          configOptions,
          modes: { currentModeId: 'auto-approve', availableModes: [{ id: 'auto-approve', name: 'Auto approve' }] },
        }
      if (method === 'session/set_config_option') return { configOptions }
      if (method === 'session/prompt') return { stopReason: 'end_turn' }
      throw new Error(`Unexpected native method ${method}`)
    })
    const { createMistralVibeEngine } = await import('../server/services/agent/engines/mistral-vibe/engine.js')
    const { _registerEngineForTest } = await import('../server/services/agent/engines/registry.js')
    _registerEngineForTest(createMistralVibeEngine())
    f.starts[1]!.emit({ kind: 'session:ended', reason: 'completed', exitCode: 0 })
    await vi.waitFor(() =>
      expect(nativePeer.request.mock.calls.some((call) => call[1] === 'session/prompt')).toBe(true),
    )
    expect(
      nativePeer.request.mock.calls.filter((call) => call[1] === 'session/set_config_option').map((call) => call[2]),
    ).toEqual([
      { sessionId: 'original-native-conversation', configId: 'mode', value: 'auto-approve' },
      ...(model === 'auto'
        ? []
        : [{ sessionId: 'original-native-conversation', configId: 'model', value: 'brainstorm-b' }]),
    ])
    expect(f.ws.getWorkspace(f.workspace.id)).toMatchObject({ model, reasoningEffort: 'high' })
    await vi.waitFor(() => expect(f.returns.getReviewReturn(f.workspace.id)).toBeNull())
    await f.orch.stopAgentAndWait(f.workspace.id)
  },
)

it.each(['no-return', 'returning', 'final'] as const)(
  'restricts actual orchestrator-issued native %s grants, including automatic memory, and revokes at stopping',
  async (kind) => {
    const f = await fixture(undefined, undefined, 'claude-code', undefined, undefined, false, kind)
    const options = f.starts[1]!.options
    expect(options).toMatchObject({ agentPermissionMode: 'interactive', readOnly: false })
    const { authorizeInternalMcpTool, resolveInternalMcpCapability } = await import(
      '../server/services/internal-mcp-capability-service.js'
    )
    const token = options.mcpServers!.find((server) => server.name === 'kobo-tasks')!.env.KOBO_MCP_SESSION_TOKEN
    const capability = resolveInternalMcpCapability(token)
    expect(capability.readOnly).toBe(true)
    for (const tool of [
      'remember',
      'create_task',
      'mark_task_done',
      'set_auto_loop',
      'create_workspace',
      'delete_workspace',
      'archive_workspace',
      'send_workspace_message',
    ]) {
      expect(() => authorizeInternalMcpTool(token, tool, {}), tool).toThrow('read-only')
    }
    for (const tool of ['list_tasks', 'get_workspace_info', 'list_memory_scopes', 'read_memory'])
      expect(() => authorizeInternalMcpTool(token, tool, {}), tool).not.toThrow()
    expect(options.prompt).toContain('Read-only launch: do not call remember or attempt writes.')
    const { PROGRESS_BAR_TOOLS } = await import('../shared/progress-bar-tools.js')
    for (const tool of PROGRESS_BAR_TOOLS) expect(() => authorizeInternalMcpTool(token, tool.name, {})).not.toThrow()
    const { getMemoryCapability } = await import('../server/services/memory-agent-runtime.js')
    expect(getMemoryCapability(capability.env.KOBO_MEMORY_SESSION_TOKEN)?.readOnly).toBe(true)
    const memory = (await import('../server/routes/memory.js')).default
    const headers = {
      'Content-Type': 'application/json',
      'X-Kobo-Memory-Session': capability.env.KOBO_MEMORY_SESSION_TOKEN!,
    }
    expect((await memory.request('/agent/list_memory_scopes', { method: 'POST', headers, body: '{}' })).status).toBe(
      200,
    )
    expect(
      (
        await memory.request('/agent/remember', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            scope_id: 'anything',
            expected_generation: 0,
            key: 'x',
            title: 'X',
            body: 'forbidden',
          }),
        })
      ).status,
    ).toBe(403)
    if (kind === 'final') {
      expect(() => authorizeInternalMcpTool(token, 'submit_final_review', {})).not.toThrow()
      const final = await import('../server/services/auto-loop-final-review-service.js')
      expect(() =>
        final.submitFinalReviewReport(f.workspace.id, f.reviewSessionId, 'wrong', { summary: 'clear', findings: [] }),
      ).toThrow()
    } else expect(() => authorizeInternalMcpTool(token, 'submit_final_review', {})).toThrow()
    const stop = f.orch.stopAgentAndWait(f.workspace.id)
    expect(() => authorizeInternalMcpTool(token, 'list_tasks', {})).toThrow('revoked')
    expect(getMemoryCapability(capability.env.KOBO_MEMORY_SESSION_TOKEN)).toBeUndefined()
    await stop
  },
)
it('retries a native final reviewer in Interactive and returns only after physical closure', async () => {
  let close!: () => void
  const f = await fixture(
    undefined,
    {
      reviewClosed: new Promise<void>((resolve) => {
        close = resolve
      }),
    },
    'claude-code',
    undefined,
    undefined,
    false,
    'final',
  )
  f.starts[1]!.emit({ kind: 'session:ended', reason: 'completed', exitCode: 0 })
  expect(f.starts).toHaveLength(2)
  close()
  await vi.waitFor(() => expect(f.returns.getReviewReturn(f.workspace.id)?.phase).toBe('blocked'))
  f.orch.retryReviewReturn(f.workspace.id)
  await vi.waitFor(() => expect(f.starts).toHaveLength(3))
  expect(f.starts[2]!.options).toMatchObject({
    agentPermissionMode: 'interactive',
    readOnly: false,
    resumeFromEngineSessionId: 'review-native',
  })
  const { resolveInternalMcpCapability } = await import('../server/services/internal-mcp-capability-service.js')
  const recovered = resolveInternalMcpCapability(
    f.starts[2]!.options.mcpServers!.find((server) => server.name === 'kobo-tasks')!.env.KOBO_MCP_SESSION_TOKEN,
  )
  expect(recovered.readOnly).toBe(true)
  expect(recovered.env.KOBO_REVIEW_ONLY).toBe('1')

  const final = await import('../server/services/auto-loop-final-review-service.js')
  const launch = final.getAutoLoopReviewLaunch(f.workspace.id, f.reviewSessionId)!
  final.submitFinalReviewReport(f.workspace.id, f.reviewSessionId, launch.mcpEnv.KOBO_FINAL_REVIEW_TOKEN, {
    summary: 'Native clear',
    findings: [],
  })
  f.starts[2]!.emit({ kind: 'session:ended', reason: 'completed', exitCode: 0 })
  await vi.waitFor(() => expect(f.starts).toHaveLength(4))
  expect(f.starts[3]!.options).toMatchObject({
    resumeFromEngineSessionId: 'original-native-conversation',
    model: 'claude-opus-4-7',
    effort: 'high',
    agentPermissionMode: 'bypass',
  })
  expect(f.starts[3]!.options.prompt).toContain('Native clear')
  expect(f.starts[3]!.options.prompt).not.toContain('independent read-only review')
  await f.orch.stopAgentAndWait(f.workspace.id)
})
