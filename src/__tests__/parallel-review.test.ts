import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentEvent, StartOptions } from '../server/services/agent/engines/types.js'
import { resetDb } from './helpers/reset-db.js'

const admissionSettings = vi.hoisted(() => ({ memoryMode: 'manual', maxConcurrentAgents: 0 }))
vi.mock('../server/services/settings-service.js', () => ({
  getGlobalSettings: () => admissionSettings,
  getEffectiveSettings: () => ({ gitConventions: '', prPromptTemplate: '', cleanupScript: '' }),
}))
vi.mock('../server/services/usage/poller.js', () => ({ refreshNow: vi.fn().mockResolvedValue(null) }))
beforeEach(async () => {
  admissionSettings.maxConcurrentAgents = 0
  vi.resetModules()
  await resetDb()
})

afterEach(async () => {
  const orch = await import('../server/services/agent/orchestrator.js')
  await orch.stopAllAgents(20)
})

async function fixture(returnToSession = false, reviewClosed?: Promise<void>, resumedAccepted?: Promise<void>) {
  const ws = await import('../server/services/workspace-service.js')
  const orch = await import('../server/services/agent/orchestrator.js')
  const { getDb } = await import('../server/db/index.js')
  const { _registerEngineForTest } = await import('../server/services/agent/engines/registry.js')
  const { CLAUDE_CODE_CAPABILITIES } = await import('../server/services/agent/engines/claude-code/capabilities.js')
  const starts: Array<{
    options: StartOptions
    emit: (ev: AgentEvent) => void
    stop: ReturnType<typeof vi.fn>
    sendMessage: ReturnType<typeof vi.fn>
    resolvePendingUserInput: ReturnType<typeof vi.fn>
  }> = []
  _registerEngineForTest({
    id: 'claude-code',
    displayName: 'Test',
    capabilities: CLAUDE_CODE_CAPABILITIES,
    async start(options, emit) {
      const stop = vi.fn(async () => {
        emit({ kind: 'session:ended', reason: 'killed', exitCode: null })
      })
      const sendMessage = vi.fn()
      const resolvePendingUserInput = vi.fn(() => true)
      starts.push({ options, emit, stop, sendMessage, resolvePendingUserInput })
      return {
        pid: undefined,
        engineSessionId: undefined,
        ...(starts.length === 2 && reviewClosed ? { closed: reviewClosed } : {}),
        ...(starts.length === 3 && resumedAccepted ? { initialPromptAccepted: resumedAccepted } : {}),
        stop,
        sendMessage,
        interrupt() {},
        resolvePendingUserInput,
        hasPendingUserInput: () => true,
      }
    },
  })
  const workspace = ws.createWorkspace({
    name: 'Parallel',
    projectPath: '/tmp',
    sourceBranch: 'main',
    workingBranch: 'work',
  })
  ws.updateWorkspaceStatus(workspace.id, 'brainstorming')
  ws.updateWorkspaceStatus(workspace.id, 'executing')
  const primary = orch.startAgent(workspace.id, '/tmp', 'Work').agentSessionId
  await new Promise((resolve) => setImmediate(resolve))
  starts[0]!.emit({ kind: 'session:started', engineSessionId: 'primary-native' })
  const review = ws.createIdleSession(workspace.id).id
  const parallel = await import('../server/services/parallel-review-service.js')
  parallel.registerParallelReview(workspace.id, {
    reviewSessionId: review,
    originalSessionId: primary,
    returnToSession,
    original: {
      engine: workspace.engine,
      model: workspace.model,
      reasoningEffort: workspace.reasoningEffort,
      agentPermissionMode: workspace.agentPermissionMode,
    },
  })
  orch.startAgent(workspace.id, '/tmp', 'Review', 'auto', false, 'plan', review, 'auto', undefined, {
    parallelReview: { engine: 'claude-code' },
  })
  await new Promise((resolve) => setImmediate(resolve))
  return { ws, orch, getDb, workspace, primary, review, starts, parallel }
}

it('keeps the primary identity, configuration and status while recording reviewer events', async () => {
  const f = await fixture()
  expect(f.starts).toHaveLength(2)
  expect(f.starts[0]!.stop).not.toHaveBeenCalled()
  expect(f.ws.getActiveSession(f.workspace.id)?.id).toBe(f.primary)
  expect(f.orch.getActiveSessionId(f.workspace.id)).toBe(f.primary)
  expect(f.ws.listSessions(f.workspace.id).find((s) => s.id === f.review)?.role).toBe('parallel-review')
  for (const ev of [
    { kind: 'session:started', engineSessionId: 'review-native' },
    { kind: 'session:compacting', active: true },
    { kind: 'error', category: 'other', message: 'Reviewer failure' },
    { kind: 'session:ended', reason: 'error', exitCode: 1 },
  ] as AgentEvent[])
    f.starts[1]!.emit(ev)
  await new Promise((resolve) => setImmediate(resolve))
  expect(f.ws.getWorkspace(f.workspace.id)?.status).toBe('executing')
  expect(f.orch.getActiveSessionId(f.workspace.id)).toBe(f.primary)
  const events = f.getDb().prepare('SELECT payload FROM ws_events WHERE session_id=?').all(f.review) as {
    payload: string
  }[]
  expect(events.length).toBeGreaterThan(0)
  expect(events.every((row) => JSON.parse(row.payload).sessionRole === 'parallel-review')).toBe(true)
})

it('targets reviewer messages and permissions without touching primary input', async () => {
  const f = await fixture()
  await f.orch.sendMessage(f.workspace.id, 'Review this too', f.review)
  expect(f.starts[1]!.sendMessage).toHaveBeenCalledWith('Review this too')
  expect(f.starts[0]!.sendMessage).not.toHaveBeenCalled()
  f.starts[1]!.emit({
    kind: 'session:user-input-requested',
    requestKind: 'permission',
    toolCallId: 'p',
    toolName: 'Bash',
    payload: {},
  })
  await f.orch.answerPendingPermission(f.workspace.id, { toolCallId: 'p', decision: 'deny', sessionId: f.review })
  expect(f.starts[1]!.resolvePendingUserInput).toHaveBeenCalledWith('p', { kind: 'permission-deny', reason: undefined })
  expect(f.starts[0]!.resolvePendingUserInput).not.toHaveBeenCalled()
  expect(f.ws.getWorkspace(f.workspace.id)?.status).toBe('executing')
})

it('stops only the identified review and stops both for workspace teardown', async () => {
  const f = await fixture()
  await f.orch.stopParallelReview(f.workspace.id, f.review)
  expect(f.starts[1]!.stop).toHaveBeenCalled()
  expect(f.starts[0]!.stop).not.toHaveBeenCalled()
  expect(f.orch.getActiveSessionId(f.workspace.id)).toBe(f.primary)
  await f.orch.stopAgentAndWait(f.workspace.id)
  expect(f.starts[0]!.stop).toHaveBeenCalled()
})

it.each([false, true])('returns exactly once to the live source only when enabled (%s)', async (enabled) => {
  const f = await fixture(enabled)
  admissionSettings.maxConcurrentAgents = 1
  f.starts[1]!.emit({ kind: 'message:text', messageId: 'report', text: 'Review findings', streaming: false })
  f.starts[1]!.emit({ kind: 'session:ended', reason: 'completed', exitCode: 0 })
  await new Promise((resolve) => setImmediate(resolve))
  expect(f.starts[0]!.sendMessage).toHaveBeenCalledTimes(enabled ? 1 : 0)
  expect(f.parallel.getParallelReviewStatus(f.workspace.id)?.phase).toBe('completed')
  await f.orch.dispatchParallelReviewReturn(f.workspace.id)
  expect(f.starts[0]!.sendMessage).toHaveBeenCalledTimes(enabled ? 1 : 0)
})

it('retains both lifecycle ownership and the report until native closure', async () => {
  let close!: () => void
  const f = await fixture(
    true,
    new Promise<void>((resolve) => {
      close = resolve
    }),
  )
  f.starts[1]!.emit({ kind: 'session:ended', reason: 'completed', exitCode: 0 })
  await new Promise((resolve) => setImmediate(resolve))
  expect(f.starts[0]!.sendMessage).not.toHaveBeenCalled()
  expect(f.orch.hasParallelReviewController(f.workspace.id)).toBe(true)
  expect(await f.orch.stopAgentAndWait(f.workspace.id, 5, 'purge')).toBe('timeout')
  expect(f.orch.hasParallelReviewController(f.workspace.id)).toBe(true)
  close()
  await new Promise((resolve) => setImmediate(resolve))
  expect(f.orch.hasParallelReviewController(f.workspace.id)).toBe(false)
  expect(f.starts[0]!.sendMessage).not.toHaveBeenCalled()
})

it('preserves the reviewer during a primary replacement and never delivers to that replacement', async () => {
  const f = await fixture(true)
  await f.orch.stopAgentAndWait(f.workspace.id, 100, 'replacement')
  expect(f.starts[1]!.stop).not.toHaveBeenCalled()
  const replacement = f.orch.startAgent(f.workspace.id, '/tmp', 'New task').agentSessionId
  await new Promise((resolve) => setImmediate(resolve))
  f.starts[1]!.emit({ kind: 'session:ended', reason: 'completed', exitCode: 0 })
  await new Promise((resolve) => setImmediate(resolve))
  expect(f.orch.getActiveSessionId(f.workspace.id)).toBe(replacement)
  expect(f.starts[2]!.sendMessage).not.toHaveBeenCalled()
  expect(f.parallel.getParallelReviewStatus(f.workspace.id)?.phase).toBe('ready')
})

it('resumes the exact finished source with its saved configuration', async () => {
  const f = await fixture(true)
  f.starts[0]!.emit({ kind: 'session:ended', reason: 'completed', exitCode: 0 })
  await new Promise((resolve) => setImmediate(resolve))
  f.starts[1]!.emit({ kind: 'session:ended', reason: 'completed', exitCode: 0 })
  await new Promise((resolve) => setImmediate(resolve))
  expect(f.starts).toHaveLength(3)
  expect(f.orch.getActiveSessionId(f.workspace.id)).toBe(f.primary)
  expect(f.starts[2]!.options.resumeFromEngineSessionId).toBe('primary-native')
  expect(f.parallel.getParallelReviewStatus(f.workspace.id)?.phase).toBe('completed')
})

it('does not automatically retry uncertain delivery after restart', async () => {
  const f = await fixture(true)
  f.parallel.setParallelReviewPhase(f.workspace.id, 'dispatching', null, 'Saved report')
  f.parallel.reconcileParallelReviews()
  f.orch.resumePendingParallelReviewReturns()
  await new Promise((resolve) => setImmediate(resolve))
  expect(f.parallel.getParallelReviewStatus(f.workspace.id)?.phase).toBe('unknown')
  expect(f.parallel.getParallelReview(f.workspace.id)?.returnPrompt).toBe('Saved report')
  expect(f.starts[0]!.sendMessage).not.toHaveBeenCalled()
})

it('rejects another parallel launch and cannot resume a historical reviewer as primary', async () => {
  const f = await fixture()
  expect(() =>
    f.orch.startAgent(f.workspace.id, '/tmp', 'Again', 'auto', false, 'plan', undefined, 'auto', undefined, {
      parallelReview: { engine: 'claude-code' },
    }),
  ).toThrow(/already running/)
  await f.orch.stopAgentAndWait(f.workspace.id)
  expect(() => f.orch.startAgent(f.workspace.id, '/tmp', 'Continue', 'auto', true, 'bypass', f.review)).toThrow(
    /cannot be resumed as the primary/,
  )
  await expect(f.orch.sendMessage(f.workspace.id, 'Unsafe fallback', f.review)).rejects.toThrow(/no longer active/)
})

it('isolates managed capabilities and revokes only the reviewer when its stop starts', async () => {
  let close!: () => void
  const f = await fixture(
    false,
    new Promise<void>((resolve) => {
      close = resolve
    }),
  )
  const capabilities = await import('../server/services/internal-mcp-capability-service.js')
  const primaryToken = f.starts[0]!.options.mcpServers!.find((server) => server.name === 'kobo-tasks')!.env
    .KOBO_MCP_SESSION_TOKEN
  const reviewToken = f.starts[1]!.options.mcpServers!.find((server) => server.name === 'kobo-tasks')!.env
    .KOBO_MCP_SESSION_TOKEN
  expect(capabilities.resolveInternalMcpCapability(reviewToken).sessionId).toBe(f.review)
  expect(() =>
    capabilities.authorizeInternalMcpTool(reviewToken, 'set_workspace_status', { status: 'completed' }),
  ).toThrow(/read-only/)
  expect(() => capabilities.authorizeInternalMcpTool(reviewToken, 'remember', {})).toThrow(/read-only/)
  expect(() => capabilities.authorizeInternalMcpTool(reviewToken, 'create_progress_bar', {})).not.toThrow()
  const stop = f.orch.stopParallelReview(f.workspace.id, f.review, 5)
  expect(() => capabilities.resolveInternalMcpCapability(reviewToken)).toThrow(/revoked/)
  expect(() => capabilities.resolveInternalMcpCapability(primaryToken)).not.toThrow()
  expect(await stop).toBe('timeout')
  close()
  await new Promise((resolve) => setImmediate(resolve))
})

it('keeps the report when the source was deleted and exposes a recoverable failure', async () => {
  const f = await fixture(true)
  f.starts[0]!.emit({ kind: 'session:ended', reason: 'completed', exitCode: 0 })
  await new Promise((resolve) => setImmediate(resolve))
  expect(f.ws.deleteSession(f.primary, f.workspace.id)).toBe(true)
  f.starts[1]!.emit({ kind: 'message:text', messageId: 'report', text: 'Preserved findings', streaming: false })
  f.starts[1]!.emit({ kind: 'session:ended', reason: 'completed', exitCode: 0 })
  await new Promise((resolve) => setImmediate(resolve))
  expect(f.parallel.getParallelReview(f.workspace.id)).toMatchObject({
    phase: 'blocked',
    returnPrompt: expect.stringContaining('Preserved findings'),
  })
  expect(() => f.ws.deleteSession(f.review, f.workspace.id)).toThrow(/pending review/)
  f.orch.cancelParallelReviewReturn(f.workspace.id)
  expect(f.ws.deleteSession(f.review, f.workspace.id)).toBe(true)
})

it('marks an ambiguous send unknown until explicitly retried', async () => {
  const f = await fixture(true)
  f.starts[0]!.sendMessage.mockRejectedValueOnce(new Error('Acknowledgement lost'))
  f.starts[1]!.emit({ kind: 'session:ended', reason: 'completed', exitCode: 0 })
  await new Promise((resolve) => setImmediate(resolve))
  expect(f.parallel.getParallelReviewStatus(f.workspace.id)?.phase).toBe('unknown')
  f.orch.resumePendingParallelReviewReturns()
  expect(f.starts[0]!.sendMessage).toHaveBeenCalledTimes(1)
  f.orch.retryParallelReviewReturn(f.workspace.id)
  await new Promise((resolve) => setImmediate(resolve))
  expect(f.starts[0]!.sendMessage).toHaveBeenCalledTimes(2)
  expect(f.parallel.getParallelReviewStatus(f.workspace.id)?.phase).toBe('completed')
})

it('blocks workspace teardown when reviewer shutdown rejects', async () => {
  const f = await fixture()
  f.starts[1]!.stop.mockRejectedValueOnce(new Error('Native stop failed'))
  expect(await f.orch.stopAgentAndWait(f.workspace.id, 20, 'delete')).toBe('failed')
  expect(f.orch.hasParallelReviewController(f.workspace.id)).toBe(true)
  expect(f.ws.listSessions(f.workspace.id).find((session) => session.id === f.review)?.status).toBe('running')
})

it('serves targeted HTTP permission and review lifecycle endpoints', async () => {
  const f = await fixture(true)
  const { Hono } = await import('hono')
  const routes = await import('../server/routes/workspaces.js')
  const app = new Hono().route('/api/workspaces', routes.default)
  const post = (path: string, body: unknown) =>
    app.request(`/api/workspaces/${f.workspace.id}/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  const request: AgentEvent = {
    kind: 'session:user-input-requested',
    requestKind: 'permission',
    toolCallId: 'shared-id',
    toolName: 'Bash',
    payload: {},
  }
  f.starts[0]!.emit(request)
  f.starts[1]!.emit(request)
  expect(
    (await post('deferred-permission/decision', { sessionId: f.review, toolCallId: 'shared-id', decision: 'deny' }))
      .status,
  ).toBe(200)
  expect(f.starts[1]!.resolvePendingUserInput).toHaveBeenCalledTimes(1)
  expect(f.starts[0]!.resolvePendingUserInput).not.toHaveBeenCalled()
  expect(f.orch.getPendingInputs(f.workspace.id).map((item) => item.agentSessionId)).toEqual([f.primary])
  expect((await post('parallel-review/stop', { sessionId: f.primary })).status).toBe(409)
  expect((await post('parallel-review/stop', { sessionId: f.review })).status).toBe(200)
  expect(f.starts[0]!.stop).not.toHaveBeenCalled()
  const status = await app.request(`/api/workspaces/${f.workspace.id}/parallel-review`)
  expect(await status.json()).toMatchObject({
    reviewSessionId: f.review,
    originalSessionId: f.primary,
    phase: 'interrupted',
  })
  expect((await post('parallel-review/cancel-return', { sessionId: f.review })).status).toBe(200)
  expect(f.orch.getActiveSessionId(f.workspace.id)).toBe(f.primary)
})

it('targets HTTP question cancellation without consuming the primary question', async () => {
  const f = await fixture()
  const { Hono } = await import('hono')
  const routes = await import('../server/routes/workspaces.js')
  const app = new Hono().route('/api/workspaces', routes.default)
  const request: AgentEvent = {
    kind: 'session:user-input-requested',
    requestKind: 'question',
    toolCallId: 'same-question',
    toolName: 'AskUserQuestion',
    payload: { questions: [] },
  }
  f.starts[0]!.emit(request)
  f.starts[1]!.emit(request)
  const response = await app.request(`/api/workspaces/${f.workspace.id}/deferred-tool-use/cancel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: f.review, toolCallId: 'same-question' }),
  })
  expect(response.status).toBe(200)
  expect(f.starts[1]!.resolvePendingUserInput).toHaveBeenCalledWith('same-question', {
    kind: 'question-cancel',
    reason: undefined,
  })
  expect(f.starts[0]!.resolvePendingUserInput).not.toHaveBeenCalled()
  expect(f.orch.getPendingInputs(f.workspace.id).map((item) => item.agentSessionId)).toEqual([f.primary])
})

it('answering the primary preserves a reviewer request with the same native tool id for replay', async () => {
  const f = await fixture()
  const request: AgentEvent = {
    kind: 'session:user-input-requested',
    requestKind: 'permission',
    toolCallId: 'collision',
    toolName: 'Bash',
    payload: {},
  }
  f.starts[0]!.emit(request)
  f.starts[1]!.emit(request)
  await f.orch.answerPendingPermission(f.workspace.id, {
    sessionId: f.primary,
    toolCallId: 'collision',
    decision: 'deny',
  })
  const events = f
    .getDb()
    .prepare("SELECT session_id FROM ws_events WHERE json_extract(payload,'$.kind')='session:user-input-requested'")
    .all()
  expect(events).toEqual([{ session_id: f.review }])
})

it('reconciles an interrupted reviewer without restarting it or claiming success', async () => {
  const f = await fixture(true)
  f.parallel.reconcileParallelReviews()
  f.orch.resumePendingParallelReviewReturns()
  expect(f.parallel.getParallelReviewStatus(f.workspace.id)?.phase).toBe('interrupted')
  expect(f.starts).toHaveLength(2)
  expect(f.starts[0]!.sendMessage).not.toHaveBeenCalled()
})

it('hydrates reviewer compaction over HTTP without changing primary status', async () => {
  const f = await fixture()
  const { Hono } = await import('hono')
  const routes = await import('../server/routes/parallel-reviews.js')
  const app = new Hono().route('/api/workspaces', routes.default)
  f.starts[1]!.emit({ kind: 'session:compacting', active: true })
  const response = await app.request(`/api/workspaces/${f.workspace.id}/parallel-review`)
  expect(await response.json()).toMatchObject({ reviewSessionId: f.review, compacting: true })
  expect(f.ws.getWorkspace(f.workspace.id)?.status).toBe('executing')
  await expect(f.orch.sendMessage(f.workspace.id, 'Wait', f.review)).rejects.toThrow(/compacting/)
  f.starts[1]!.emit({ kind: 'session:compacted' })
  const next = await app.request(`/api/workspaces/${f.workspace.id}/parallel-review`)
  expect(await next.json()).toMatchObject({ compacting: false })
})

it.each(['rename-branch', 'resync-branch', 'rollback-file', 'cancel-source-change'])(
  'refuses %s while only the reviewer remains',
  async (action) => {
    const f = await fixture()
    await f.orch.stopAgentAndWait(f.workspace.id, 100, 'replacement')
    const { Hono } = await import('hono')
    const routes = await import('../server/routes/workspaces.js')
    const app = new Hono().route('/api/workspaces', routes.default)
    const response = await app.request(`/api/workspaces/${f.workspace.id}/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    expect(response.status).toBe(409)
    expect(f.starts[1]!.stop).not.toHaveBeenCalled()
  },
)

it('a later source error must not reopen a successfully delivered return', async () => {
  const f = await fixture(true)
  f.starts[0]!.emit({ kind: 'session:ended', reason: 'completed', exitCode: 0 })
  await new Promise((resolve) => setImmediate(resolve))
  f.starts[1]!.emit({ kind: 'session:ended', reason: 'completed', exitCode: 0 })
  await new Promise((resolve) => setImmediate(resolve))
  expect(f.parallel.getParallelReviewStatus(f.workspace.id)?.phase).toBe('completed')
  f.starts[2]!.emit({ kind: 'error', category: 'other', message: 'Later unrelated primary error' })
  expect(f.parallel.getParallelReviewStatus(f.workspace.id)?.phase).toBe('completed')
  const previous = f.parallel.getParallelReview(f.workspace.id)!
  const next = f.ws.createIdleSession(f.workspace.id).id
  f.parallel.registerParallelReview(f.workspace.id, { ...previous, reviewSessionId: next, returnToSession: true })
  f.starts[2]!.emit({ kind: 'error', category: 'other', message: 'Later error while another review is running' })
  expect(f.parallel.getParallelReviewStatus(f.workspace.id)?.phase).toBe('reviewing')
})

it('cancelled delivery completion must not settle the next review delivery', async () => {
  const f = await fixture(true)
  let releaseFirst!: () => void
  let rejectSecond!: (error: Error) => void
  f.starts[0]!.sendMessage.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        releaseFirst = resolve
      }),
  )
  f.starts[1]!.emit({ kind: 'session:ended', reason: 'completed', exitCode: 0 })
  await new Promise((resolve) => setImmediate(resolve))
  expect(f.parallel.getParallelReviewStatus(f.workspace.id)?.phase).toBe('dispatching')
  f.orch.cancelParallelReviewReturn(f.workspace.id)
  const old = f.parallel.getParallelReview(f.workspace.id)!
  const next = f.ws.createIdleSession(f.workspace.id).id
  f.parallel.registerParallelReview(f.workspace.id, {
    reviewSessionId: next,
    originalSessionId: f.primary,
    returnToSession: true,
    original: old.original,
  })
  f.orch.startAgent(f.workspace.id, '/tmp', 'Second review', 'auto', false, 'plan', next, 'auto', undefined, {
    parallelReview: { engine: 'claude-code' },
  })
  await new Promise((resolve) => setImmediate(resolve))
  f.starts[0]!.sendMessage.mockImplementationOnce(
    () =>
      new Promise<void>((_, reject) => {
        rejectSecond = reject
      }),
  )
  f.starts[2]!.emit({ kind: 'session:ended', reason: 'completed', exitCode: 0 })
  await new Promise((resolve) => setImmediate(resolve))
  expect(f.parallel.getParallelReviewStatus(f.workspace.id)?.phase).toBe('dispatching')
  releaseFirst()
  await new Promise((resolve) => setImmediate(resolve))
  const phaseAfterOldAck = f.parallel.getParallelReviewStatus(f.workspace.id)?.phase
  rejectSecond(new Error('Second dispatch uncertain'))
  await new Promise((resolve) => setImmediate(resolve))
  expect({ phaseAfterOldAck, finalPhase: f.parallel.getParallelReviewStatus(f.workspace.id)?.phase }).toEqual({
    phaseAfterOldAck: 'dispatching',
    finalPhase: 'unknown',
  })
})

it('a delayed initial acceptance cannot settle a retry of the same review', async () => {
  let acceptOriginal!: () => void
  const f = await fixture(
    true,
    undefined,
    new Promise<void>((resolve) => {
      acceptOriginal = resolve
    }),
  )
  f.starts[0]!.emit({ kind: 'session:ended', reason: 'completed', exitCode: 0 })
  await new Promise((resolve) => setImmediate(resolve))
  f.starts[1]!.emit({ kind: 'session:ended', reason: 'completed', exitCode: 0 })
  await new Promise((resolve) => setImmediate(resolve))
  expect(f.parallel.getParallelReviewStatus(f.workspace.id)?.phase).toBe('dispatching')
  f.starts[2]!.emit({ kind: 'error', category: 'other', message: 'Original receipt uncertain' })
  expect(f.parallel.getParallelReviewStatus(f.workspace.id)?.phase).toBe('unknown')
  let rejectRetry!: (error: Error) => void
  f.starts[2]!.sendMessage.mockImplementationOnce(
    () =>
      new Promise<void>((_, reject) => {
        rejectRetry = reject
      }),
  )
  f.orch.retryParallelReviewReturn(f.workspace.id)
  await new Promise((resolve) => setImmediate(resolve))
  expect(f.parallel.getParallelReviewStatus(f.workspace.id)?.phase).toBe('dispatching')
  acceptOriginal()
  await new Promise((resolve) => setImmediate(resolve))
  const phaseAfterOldAcceptance = f.parallel.getParallelReviewStatus(f.workspace.id)?.phase
  rejectRetry(new Error('Retry receipt lost'))
  await new Promise((resolve) => setImmediate(resolve))
  expect({ phaseAfterOldAcceptance, finalPhase: f.parallel.getParallelReviewStatus(f.workspace.id)?.phase }).toEqual({
    phaseAfterOldAcceptance: 'dispatching',
    finalPhase: 'unknown',
  })
})

it('rejects malformed stop JSON and stale return requests without affecting a newer review', async () => {
  const f = await fixture(true)
  const { Hono } = await import('hono')
  const routes = await import('../server/routes/parallel-reviews.js')
  const app = new Hono().route('/api/workspaces', routes.default)
  const post = (action: string, body: string) =>
    app.request(`/api/workspaces/${f.workspace.id}/parallel-review/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    })
  expect((await post('stop', '{')).status).toBe(400)
  expect(f.starts[1]!.stop).not.toHaveBeenCalled()
  await f.orch.stopParallelReview(f.workspace.id, f.review)
  const previous = f.parallel.getParallelReview(f.workspace.id)!
  const next = f.ws.createIdleSession(f.workspace.id).id
  f.parallel.registerParallelReview(f.workspace.id, { ...previous, reviewSessionId: next, returnToSession: true })
  f.parallel.setParallelReviewPhase(f.workspace.id, 'unknown', 'Receipt uncertain', 'New report')
  expect((await post('cancel-return', JSON.stringify({ sessionId: f.review }))).status).toBe(409)
  expect((await post('retry-return', JSON.stringify({ sessionId: f.review }))).status).toBe(409)
  expect(f.parallel.getParallelReviewStatus(f.workspace.id)?.phase).toBe('unknown')
  expect(f.starts[0]!.sendMessage).not.toHaveBeenCalled()
  expect(f.parallel.getParallelReviewStatus(f.workspace.id)?.returnToSession).toBe(true)
  expect((await post('retry-return', '{}')).status).toBe(400)
})

it('cancelling while a source is starting invalidates the old pre-dispatch guard', async () => {
  const f = await fixture(true)
  const controller = f.orch._getControllers().get(f.workspace.id)!
  const send = controller.sendMessage.bind(controller)
  let releaseOld!: () => void
  const oldStartup = new Promise<void>((resolve) => {
    releaseOld = resolve
  })
  vi.spyOn(controller, 'sendMessage').mockImplementationOnce(async (content, beforeDispatch) => {
    await oldStartup
    await send(content, beforeDispatch)
  })
  f.starts[1]!.emit({ kind: 'session:ended', reason: 'completed', exitCode: 0 })
  await new Promise((resolve) => setImmediate(resolve))
  expect(f.parallel.getParallelReviewStatus(f.workspace.id)?.phase).toBe('dispatching')
  f.orch.cancelParallelReviewReturn(f.workspace.id)
  const previous = f.parallel.getParallelReview(f.workspace.id)!
  const next = f.ws.createIdleSession(f.workspace.id).id
  f.parallel.registerParallelReview(f.workspace.id, { ...previous, reviewSessionId: next, returnToSession: true })
  f.parallel.setParallelReviewPhase(f.workspace.id, 'ready', null, 'New report')
  let rejectNext!: (error: Error) => void
  f.starts[0]!.sendMessage.mockImplementationOnce(
    () =>
      new Promise<void>((_, reject) => {
        rejectNext = reject
      }),
  )
  const nextDelivery = f.orch.dispatchParallelReviewReturn(f.workspace.id)
  await new Promise((resolve) => setImmediate(resolve))
  releaseOld()
  await new Promise((resolve) => setImmediate(resolve))
  expect(f.starts[0]!.sendMessage).toHaveBeenCalledExactlyOnceWith('New report')
  expect(f.parallel.getParallelReviewStatus(f.workspace.id)?.phase).toBe('dispatching')
  rejectNext(new Error('New report receipt uncertain'))
  await nextDelivery
  expect(f.parallel.getParallelReviewStatus(f.workspace.id)?.phase).toBe('unknown')
})

it.each(['operation', 'tool', 'turn'] as const)(
  'scopes %s permissions to the resumed source engine after workspace reconfiguration',
  async (scope) => {
    const f = await fixture(true)
    f.starts[0]!.emit({ kind: 'session:ended', reason: 'completed', exitCode: 0 })
    await new Promise((resolve) => setImmediate(resolve))
    f.getDb().prepare("UPDATE workspaces SET engine='mistral-vibe' WHERE id=?").run(f.workspace.id)
    f.starts[1]!.emit({ kind: 'session:ended', reason: 'completed', exitCode: 0 })
    await new Promise((resolve) => setImmediate(resolve))
    expect(f.starts).toHaveLength(3)
    f.starts[2]!.emit({
      kind: 'session:user-input-requested',
      requestKind: 'permission',
      toolCallId: 'source-permission',
      toolName: 'Bash',
      payload: { command: 'pwd' },
    })
    await expect(
      f.orch.answerPendingPermission(f.workspace.id, {
        sessionId: f.primary,
        toolCallId: 'source-permission',
        decision: 'allow',
        scope,
      }),
    ).resolves.toBeUndefined()
    const policy = await import('../server/services/workspace-permission-policy-service.js')
    for (const engine of ['claude-code', 'mistral-vibe'])
      expect(
        policy.isWorkspacePermissionAllowed(f.workspace.id, { engine, toolName: 'Bash', payload: { command: 'pwd' } }),
      ).toBe(engine === 'claude-code')
    expect(f.ws.getWorkspace(f.workspace.id)?.engine).toBe('mistral-vibe')
  },
)

it('delivers chat and explicitly resumes the captured source without preflighting the workspace default engine', async () => {
  const f = await fixture(true)
  f.starts[0]!.emit({ kind: 'session:ended', reason: 'completed', exitCode: 0 })
  await new Promise((resolve) => setImmediate(resolve))
  f.getDb().prepare("UPDATE workspaces SET engine='mistral-vibe' WHERE id=?").run(f.workspace.id)
  f.starts[1]!.emit({ kind: 'session:ended', reason: 'completed', exitCode: 0 })
  await new Promise((resolve) => setImmediate(resolve))
  const { deliverWorkspaceMessage } = await import('../server/services/workspace-message-service.js')
  await deliverWorkspaceMessage(f.workspace.id, { content: 'Continue reviewing', sessionId: f.primary })
  expect(f.starts[2]!.sendMessage).toHaveBeenCalledWith('Continue reviewing')
  f.starts[2]!.emit({ kind: 'session:ended', reason: 'completed', exitCode: 0 })
  await new Promise((resolve) => setImmediate(resolve))
  await deliverWorkspaceMessage(f.workspace.id, { content: 'Continue later', sessionId: f.primary })
  await new Promise((resolve) => setImmediate(resolve))
  expect(f.starts).toHaveLength(4)
  expect(f.starts[3]!.options.resumeFromEngineSessionId).toBe('primary-native')
  expect(f.orch.getActiveSessionId(f.workspace.id)).toBe(f.primary)
  expect(f.ws.getWorkspace(f.workspace.id)?.engine).toBe('mistral-vibe')
  expect(f.parallel.getParallelReviewSourceConfiguration(f.workspace.id, 'another-session', 'mistral-vibe')).toBeNull()
  expect(f.parallel.getParallelReviewSourceConfiguration(f.workspace.id, f.primary, 'claude-code')).toBeNull()
})

it('explicitly resumes the captured source through HTTP using its own configuration', async () => {
  const f = await fixture(true)
  f.starts[0]!.emit({ kind: 'session:ended', reason: 'completed', exitCode: 0 })
  await new Promise((resolve) => setImmediate(resolve))
  f.getDb().prepare("UPDATE workspaces SET engine='mistral-vibe' WHERE id=?").run(f.workspace.id)
  f.starts[1]!.emit({ kind: 'session:ended', reason: 'completed', exitCode: 0 })
  await new Promise((resolve) => setImmediate(resolve))
  const { Hono } = await import('hono')
  const routes = await import('../server/routes/workspaces.js')
  const app = new Hono().route('/api/workspaces', routes.default)
  const response = await app.request(`/api/workspaces/${f.workspace.id}/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentSessionId: f.primary, resume: true, prompt: 'Resume source' }),
  })
  expect(await response.json()).toMatchObject({ status: 'started' })
  expect(response.status).toBe(200)
  await new Promise((resolve) => setImmediate(resolve))
  expect(f.starts).toHaveLength(4)
  expect(f.starts[3]!.options.resumeFromEngineSessionId).toBe('primary-native')
  expect(f.ws.getWorkspace(f.workspace.id)?.engine).toBe('mistral-vibe')
})

it('keeps a logically finished reviewer stoppable until native closure without interrupting the primary', async () => {
  let close!: () => void
  const f = await fixture(
    true,
    new Promise<void>((resolve) => {
      close = resolve
    }),
  )
  try {
    f.starts[1]!.emit({ kind: 'message:text', messageId: 'report', text: 'Saved findings', streaming: false })
    f.starts[1]!.emit({ kind: 'session:ended', reason: 'completed', exitCode: 0 })
    await new Promise((resolve) => setImmediate(resolve))
    expect(f.parallel.getParallelReview(f.workspace.id)).toMatchObject({
      phase: 'closing',
      returnPrompt: expect.stringContaining('Saved findings'),
    })
    const { Hono } = await import('hono')
    const routes = await import('../server/routes/parallel-reviews.js')
    const response = await new Hono()
      .route('/api/workspaces', routes.default)
      .request(`/api/workspaces/${f.workspace.id}/parallel-review`)
    expect(await response.json()).toMatchObject({ phase: 'closing' })
    await expect(f.orch.sendMessage(f.workspace.id, 'Too late', f.review)).rejects.toThrow(/no longer active/)
    expect(() => f.orch.retryParallelReviewReturn(f.workspace.id, f.review)).toThrow(/No retryable/)
    expect(await f.orch.stopParallelReview(f.workspace.id, f.review, 5)).toBe('timeout')
    expect(f.starts[1]!.stop).toHaveBeenCalledOnce()
    expect(f.starts[0]!.stop).not.toHaveBeenCalled()
    expect(f.starts[0]!.sendMessage).not.toHaveBeenCalled()
    expect(f.orch.hasParallelReviewController(f.workspace.id)).toBe(true)
  } finally {
    close()
    await new Promise((resolve) => setImmediate(resolve))
  }
  expect(f.parallel.getParallelReviewStatus(f.workspace.id)?.phase).toBe('interrupted')
  expect(f.orch.getActiveSessionId(f.workspace.id)).toBe(f.primary)
  expect(f.starts[0]!.stop).not.toHaveBeenCalled()
})

it('delivers the saved report only after the reviewer closes natively', async () => {
  let close!: () => void
  const f = await fixture(
    true,
    new Promise<void>((resolve) => {
      close = resolve
    }),
  )
  f.starts[1]!.emit({ kind: 'session:ended', reason: 'completed', exitCode: 0 })
  expect(f.parallel.getParallelReviewStatus(f.workspace.id)?.phase).toBe('closing')
  await f.orch.dispatchParallelReviewReturn(f.workspace.id)
  expect(f.starts[0]!.sendMessage).not.toHaveBeenCalled()
  close()
  await new Promise((resolve) => setImmediate(resolve))
  expect(f.starts[0]!.sendMessage).toHaveBeenCalledOnce()
  expect(f.parallel.getParallelReviewStatus(f.workspace.id)?.phase).toBe('completed')
})

it.each([false, true])('recovers a saved closing report after restart (return=%s)', async (returnToSession) => {
  const f = await fixture(returnToSession)
  f.parallel.setParallelReviewPhase(f.workspace.id, 'closing', null, 'Saved before shutdown')
  f.parallel.reconcileParallelReviews()
  expect(f.parallel.getParallelReview(f.workspace.id)).toMatchObject({
    phase: returnToSession ? 'ready' : 'completed',
    returnPrompt: 'Saved before shutdown',
  })
  f.orch.resumePendingParallelReviewReturns()
  expect(f.starts).toHaveLength(2)
  expect(f.starts[0]!.sendMessage).not.toHaveBeenCalled()
})

it('publishes one coherent live and HTTP compaction snapshot when cancelling return', async () => {
  const f = await fixture(true)
  const websocket = await import('../server/services/websocket-service.js')
  const spy = vi.spyOn(websocket, 'emitEphemeral')
  f.starts[1]!.emit({ kind: 'session:compacting', active: true })
  spy.mockClear()
  f.orch.cancelParallelReviewReturn(f.workspace.id, f.review)
  const events = spy.mock.calls.filter(([, kind]) => kind === 'review:parallel-status')
  expect(events).toHaveLength(1)
  expect(events[0]![2]).toMatchObject({ compacting: true, returnToSession: false })
  const { Hono } = await import('hono')
  const routes = await import('../server/routes/parallel-reviews.js')
  const response = await new Hono()
    .route('/api/workspaces', routes.default)
    .request(`/api/workspaces/${f.workspace.id}/parallel-review`)
  expect(await response.json()).toEqual(events[0]![2])
  expect(f.orch.isParallelReviewCompacting(f.workspace.id)).toBe(true)
  spy.mockRestore()
})

it('keeps a parallel return ready at capacity and resumes the exact source once after release', async () => {
  admissionSettings.maxConcurrentAgents = 1
  const f = await fixture(true)
  f.starts[0]!.emit({ kind: 'session:ended', reason: 'completed', exitCode: 0 })
  await new Promise((resolve) => setImmediate(resolve))
  const other = f.ws.createWorkspace({
    name: 'Other',
    projectPath: '/tmp',
    sourceBranch: 'main',
    workingBranch: 'other',
  })
  f.ws.updateWorkspaceStatus(other.id, 'brainstorming')
  f.ws.updateWorkspaceStatus(other.id, 'executing')
  f.orch.startAgent(other.id, '/tmp', 'Occupy capacity')
  await new Promise((resolve) => setImmediate(resolve))
  f.starts[1]!.emit({ kind: 'message:text', messageId: 'report', text: 'Saved findings', streaming: false })
  f.starts[1]!.emit({ kind: 'session:ended', reason: 'completed', exitCode: 0 })
  await new Promise((resolve) => setImmediate(resolve))
  expect(f.starts).toHaveLength(3)
  expect(f.orch.runningAgentCount()).toBe(1)
  expect(f.parallel.getParallelReview(f.workspace.id)).toMatchObject({
    phase: 'ready',
    returnPrompt: expect.stringContaining('Saved findings'),
  })
  f.orch.resumePendingReviewReturns()
  await new Promise((resolve) => setImmediate(resolve))
  expect(f.starts).toHaveLength(3)
  f.starts[2]!.emit({ kind: 'session:ended', reason: 'completed', exitCode: 0 })
  await vi.waitFor(() => expect(f.starts).toHaveLength(4))
  expect(f.starts[3]!.options.resumeFromEngineSessionId).toBe('primary-native')
  expect(f.orch.getActiveSessionId(f.workspace.id)).toBe(f.primary)
  expect(f.orch.runningAgentCount()).toBe(1)
  expect(f.parallel.getParallelReviewStatus(f.workspace.id)?.phase).toBe('completed')
  f.orch.notifyCapacityAvailable()
  f.orch.resumePendingReviewReturns()
  await new Promise((resolve) => setImmediate(resolve))
  expect(f.starts).toHaveLength(4)
})
