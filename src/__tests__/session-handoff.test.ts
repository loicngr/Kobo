import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentEvent, StartOptions } from '../server/services/agent/engines/types.js'
import { resetDb } from './helpers/reset-db.js'

vi.mock('../server/services/settings-service.js', () => ({
  getGlobalSettings: () => ({ autoLoopMaxRetries: 5 }),
  getProjectSettings: () => undefined,
  getEffectiveSettings: () => ({ model: 'auto', dangerouslySkipPermissions: true, sourceBranch: 'main' }),
}))
vi.mock('../server/services/usage/poller.js', () => ({ refreshNow: vi.fn().mockResolvedValue(null) }))
let directory: string
beforeEach(async () => {
  vi.resetModules()
  await resetDb()
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kobo-handoff-'))
  execFileSync('git', ['init', '-q', directory])
})
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }))

async function fixture(targetReady?: Promise<void>) {
  const ws = await import('../server/services/workspace-service.js')
  const orch = await import('../server/services/agent/orchestrator.js')
  const service = await import('../server/services/session-handoff-service.js')
  const { getDb } = await import('../server/db/index.js')
  const { _registerEngineForTest } = await import('../server/services/agent/engines/registry.js')
  const starts: Array<{ engine: string; options: StartOptions; emit: (event: AgentEvent) => void; close: () => void }> =
    []
  for (const engine of ['claude-code', 'codex'] as const) {
    _registerEngineForTest({
      id: engine,
      displayName: engine,
      capabilities: {
        models: [{ id: 'auto', label: 'Auto' }],
        effortLevels: [{ id: 'auto', label: 'Auto' }],
        permissionModes: ['bypass'],
        supportsResume: true,
        supportsMcp: true,
        supportsSkills: false,
        supportsSubagents: false,
        supportsQuotaStatus: false,
      },
      async start(options, emit) {
        let close!: () => void
        const closed = new Promise<void>((resolve) => {
          close = resolve
        })
        starts.push({ engine, options, emit, close })
        emit({
          kind: 'session:started',
          engineSessionId: options.resumeFromEngineSessionId ?? `${engine}-${starts.length}`,
        })
        return {
          ...(starts.length > 1 && !options.resumeFromEngineSessionId ? { ready: targetReady } : {}),
          pid: undefined,
          engineSessionId: `${engine}-${starts.length}`,
          closed,
          sendMessage() {},
          interrupt() {},
          resolvePendingUserInput: () => false,
          async stop() {
            emit({ kind: 'session:ended', reason: 'killed', exitCode: null })
            close()
          },
        }
      },
    })
  }
  const workspace = ws.createWorkspace({
    name: 'Mission',
    projectPath: directory,
    sourceBranch: 'main',
    workingBranch: 'work',
    model: 'auto',
  })
  getDb()
    .prepare('UPDATE workspaces SET worktree_path = ?, initial_prompt = ? WHERE id = ?')
    .run(directory, 'Keep all user constraints', workspace.id)
  ws.updateWorkspaceStatus(workspace.id, 'brainstorming')
  const sourceSessionId = orch.startAgent(workspace.id, directory, 'Original work', 'auto').agentSessionId
  await vi.waitFor(() => expect(starts).toHaveLength(1))
  const request = {
    requestId: 'request-1',
    sourceSessionId,
    generateSummary: false,
    target: { engine: 'codex', model: 'auto', reasoningEffort: 'auto', agentPermissionMode: 'bypass' as const },
  }
  return { ws, orch, service, getDb, starts, workspace, request }
}

it.each(['codex', 'claude-code'])(
  'restores the source after a rejected %s target, including after reload',
  async (engine) => {
    let rejectReady!: (error: Error) => void
    const ready = new Promise<void>((_resolve, reject) => {
      rejectReady = reject
    })
    const f = await fixture(ready)
    const h = f.service.createSessionHandoff(f.workspace.id, {
      ...f.request,
      target: { ...f.request.target, engine },
    })
    await vi.waitFor(() => expect(f.starts).toHaveLength(2))
    const sourceBefore = f.ws.listSessions(f.workspace.id).find((session) => session.id === f.request.sourceSessionId)!
    rejectReady(new Error('Initial turn rejected'))
    f.starts[1]!.emit({ kind: 'session:ended', reason: 'error', exitCode: 1 })
    f.starts[1]!.close()
    await vi.waitFor(() => expect(f.service.getCurrentSessionHandoff(f.workspace.id)?.state).toBe('failed'))
    expect(f.ws.getActiveSession(f.workspace.id)?.id).toBe(f.request.sourceSessionId)
    await f.service.decideSessionHandoff(f.workspace.id, h.id, 'cancel')
    const dbPath = f.getDb().name
    const { closeDb } = await import('../server/db/index.js')
    closeDb()
    f.getDb(dbPath)
    const restored = f.ws.getActiveSession(f.workspace.id)!
    expect(restored.id).toBe(f.request.sourceSessionId)
    expect(restored).toMatchObject({ startedAt: sourceBefore.startedAt, endedAt: sourceBefore.endedAt })
    expect(
      f.ws
        .listSessions(f.workspace.id)
        .find((session) => session.id === f.service.getCurrentSessionHandoff(f.workspace.id)?.targetSessionId),
    ).toMatchObject({ status: 'error' })

    const { deliverWorkspaceMessage } = await import('../server/services/workspace-message-service.js')
    // Implicit selection matters for external clients and continuous auto-loop too.
    const delivered = await deliverWorkspaceMessage(f.workspace.id, { content: 'Continue the original mission' })
    expect(delivered.sessionId).toBe(f.request.sourceSessionId)
    await vi.waitFor(() => expect(f.starts).toHaveLength(3))
    expect(f.starts[2]!.options.resumeFromEngineSessionId).toBe('claude-code-1')
    await f.orch.stopAgentAndWait(f.workspace.id)
    const next = f.service.createSessionHandoff(f.workspace.id, {
      ...f.request,
      requestId: 'next',
      generateSummary: true,
      sourceSessionId: f.ws.getActiveSession(f.workspace.id)?.id ?? null,
    })
    await vi.waitFor(() => expect(f.starts).toHaveLength(4))
    expect(f.service.getCurrentSessionHandoff(f.workspace.id)?.state).toBe('generating')
    expect(f.starts[3]!.options.resumeFromEngineSessionId).toBe('claude-code-1')
    await f.service.decideSessionHandoff(f.workspace.id, next.id, 'cancel')
  },
)

it('stops immediately and starts a fresh target without contacting the source for a summary', async () => {
  const f = await fixture()
  const handoff = f.service.createSessionHandoff(f.workspace.id, f.request)
  expect(handoff.state).toBe('stopping')
  await vi.waitFor(() => expect(f.service.getCurrentSessionHandoff(f.workspace.id)?.state).toBe('completed'))
  expect(f.starts).toHaveLength(2)
  expect(f.starts[1]!.engine).toBe('codex')
  expect(f.starts[1]!.options.resumeFromEngineSessionId).toBeUndefined()
  expect(f.starts[1]!.options.prompt).toContain('Keep all user constraints')
  expect(f.starts[1]!.options.prompt).toContain(f.request.sourceSessionId)
  const result = f.service.getCurrentSessionHandoff(f.workspace.id)!
  expect(result.targetSessionId).not.toBe(f.request.sourceSessionId)
  expect(fs.existsSync(path.join(directory, result.reportPath!))).toBe(true)
  await f.orch.stopAgentAndWait(f.workspace.id)
})

it.each(['codex', 'claude-code'])('delivers a preserved wakeup to the fresh %s conversation', async (engine) => {
  let ready!: () => void
  const f = await fixture(
    new Promise<void>((resolve) => {
      ready = resolve
    }),
  )
  const wakeup = await import('../server/services/wakeup-service.js')
  wakeup.schedule(f.workspace.id, 60, 'Check the background job', 'Pending work', f.request.sourceSessionId)
  const scheduled = wakeup.getPending(f.workspace.id)
  f.service.createSessionHandoff(f.workspace.id, { ...f.request, target: { ...f.request.target, engine } })
  await vi.waitFor(() => expect(f.starts).toHaveLength(2))
  const pendingSession = () =>
    f.getDb().prepare('SELECT agent_session_id FROM pending_wakeups WHERE workspace_id=?').get(f.workspace.id)
  expect(pendingSession()).toEqual({ agent_session_id: f.request.sourceSessionId })
  ready()
  await vi.waitFor(() => expect(f.service.getCurrentSessionHandoff(f.workspace.id)?.state).toBe('completed'))
  const targetSessionId = f.service.getCurrentSessionHandoff(f.workspace.id)!.targetSessionId
  expect(pendingSession()).toEqual({ agent_session_id: targetSessionId })
  expect(wakeup.getPending(f.workspace.id)).toEqual(scheduled)
  f.starts[1]!.emit({ kind: 'session:ended', reason: 'completed', exitCode: 0 })
  f.starts[1]!.close()
  await vi.waitFor(() => expect(f.orch.hasController(f.workspace.id)).toBe(false))
  // Rehydrate the due timer as on a backend restart; do not wait a real minute.
  f.getDb()
    .prepare('UPDATE pending_wakeups SET target_at=? WHERE workspace_id=?')
    .run(new Date().toISOString(), f.workspace.id)
  wakeup.rehydrate()
  await vi.waitFor(() => expect(f.starts).toHaveLength(3))
  expect(f.starts[2]!.options.resumeFromEngineSessionId).toBe(`${engine}-2`)
  expect(f.starts[2]!.options.prompt).toContain('Check the background job')
  expect(wakeup.getPending(f.workspace.id)).toBeNull()
  await f.orch.stopAgentAndWait(f.workspace.id)
})

it.each(['codex', 'claude-code'])(
  'leaves no implicit conversation after cancelling a failed first %s transfer',
  async (engine) => {
    let rejectReady!: (error: Error) => void
    const f = await fixture(
      new Promise<void>((_resolve, reject) => {
        rejectReady = reject
      }),
    )
    await f.orch.stopAgentAndWait(f.workspace.id)
    const workspace = f.ws.createWorkspace({
      name: 'New mission',
      projectPath: directory,
      sourceBranch: 'main',
      workingBranch: 'new',
      model: 'auto',
    })
    f.getDb().prepare('UPDATE workspaces SET worktree_path=? WHERE id=?').run(directory, workspace.id)
    const handoff = f.service.createSessionHandoff(workspace.id, {
      ...f.request,
      sourceSessionId: null,
      target: { ...f.request.target, engine },
    })
    await vi.waitFor(() => expect(f.starts).toHaveLength(2))
    rejectReady(new Error('Initial turn rejected'))
    f.starts[1]!.emit({ kind: 'session:ended', reason: 'error', exitCode: 1 })
    f.starts[1]!.close()
    await vi.waitFor(() => expect(f.service.getCurrentSessionHandoff(workspace.id)?.state).toBe('failed'))
    await f.service.decideSessionHandoff(workspace.id, handoff.id, 'cancel')
    const dbPath = f.getDb().name
    const { closeDb } = await import('../server/db/index.js')
    closeDb()
    f.getDb(dbPath)
    expect(f.ws.getWorkspace(workspace.id)?.engine).toBe('claude-code')
    expect(f.ws.getActiveSession(workspace.id)).toBeNull()
    const failed = f.ws.listSessions(workspace.id)[0]!
    expect(failed).toMatchObject({ status: 'error', engineSessionId: `${engine}-2` })
    const { deliverWorkspaceMessage } = await import('../server/services/workspace-message-service.js')
    const delivered = await deliverWorkspaceMessage(workspace.id, { content: 'Continue the original mission' })
    expect(delivered.sessionId).not.toBe(failed.id)
    await vi.waitFor(() => expect(f.starts).toHaveLength(3))
    expect(f.starts[2]!.engine).toBe('claude-code')
    expect(f.starts[2]!.options.resumeFromEngineSessionId).toBeUndefined()
    await f.orch.stopAgentAndWait(workspace.id)
  },
)

it.each(['cancel', 'stop', 'restart'] as const)(
  'restores the source when %s interrupts target startup',
  async (action) => {
    let resolveReady!: () => void
    const f = await fixture(
      new Promise<void>((resolve) => {
        resolveReady = resolve
      }),
    )
    const h = f.service.createSessionHandoff(f.workspace.id, f.request)
    await vi.waitFor(() => expect(f.starts).toHaveLength(2))
    expect(f.service.getCurrentSessionHandoff(f.workspace.id)?.state).toBe('starting')
    if (action === 'restart') {
      const { suspendHandoffTransfers } = await import('../server/services/session-handoff-runtime.js')
      suspendHandoffTransfers()
      await f.orch.stopAgentAndWait(f.workspace.id, undefined, 'shutdown')
      f.service.reconcileSessionHandoffs()
    } else if (action === 'stop') await f.orch.stopAgentAndWait(f.workspace.id)
    else await f.service.decideSessionHandoff(f.workspace.id, h.id, 'cancel')
    expect(f.ws.getActiveSession(f.workspace.id)?.id).toBe(f.request.sourceSessionId)
    expect(f.ws.getWorkspace(f.workspace.id)).toMatchObject({ status: 'idle', engine: 'claude-code' })
    resolveReady()
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(f.service.getCurrentSessionHandoff(f.workspace.id)?.state).toBe(
      action === 'restart' ? 'interrupted' : 'cancelled',
    )
    expect(f.starts).toHaveLength(2)
    if (action === 'restart') await f.service.decideSessionHandoff(f.workspace.id, h.id, 'cancel')

    // Restoration must not pin the source forever: the next ordinary conversation wins.
    const fresh = f.orch.startAgent(f.workspace.id, directory, 'Next mission', 'auto')
    await vi.waitFor(() => expect(f.starts).toHaveLength(3))
    f.starts[2]!.emit({ kind: 'session:ended', reason: 'completed', exitCode: 0 })
    f.starts[2]!.close()
    await vi.waitFor(() => expect(f.orch.hasController(f.workspace.id)).toBe(false))
    expect(f.ws.getActiveSession(f.workspace.id)?.id).toBe(fresh.agentSessionId)
  },
)

it('resumes the exact source only to generate, rejects stale submissions, and waits for actual closure', async () => {
  const f = await fixture()
  const h = f.service.createSessionHandoff(f.workspace.id, { ...f.request, generateSummary: true })
  await vi.waitFor(() => expect(f.starts).toHaveLength(2))
  const summary = f.starts[1]!
  expect(summary.engine).toBe('claude-code')
  expect(summary.options.resumeFromEngineSessionId).toBe('claude-code-1')
  const token = summary.options.mcpServers![0]!.env.KOBO_HANDOFF_TOKEN!
  expect(() => f.service.submitSessionHandoff(f.workspace.id, h.id, 'stale', 'Verified report')).toThrow()
  f.service.submitSessionHandoff(f.workspace.id, h.id, token, 'Verified report')
  summary.emit({ kind: 'session:ended', reason: 'completed', exitCode: 0 })
  await new Promise((resolve) => setTimeout(resolve, 10))
  expect(f.starts).toHaveLength(2)
  summary.close()
  await vi.waitFor(() => expect(f.service.getCurrentSessionHandoff(f.workspace.id)?.state).toBe('completed'))
  expect(f.starts).toHaveLength(3)
  expect(f.starts[2]!.options.prompt).toContain('Verified report')
  expect(f.starts[2]!.options.resumeFromEngineSessionId).toBeUndefined()
  expect(() => f.service.submitSessionHandoff(f.workspace.id, h.id, token, 'Late report')).toThrow()
  await f.orch.stopAgentAndWait(f.workspace.id)
})

it('deduplicates requests and refuses competing transfers or stale source sessions before stopping', async () => {
  const f = await fixture()
  expect(() => f.service.createSessionHandoff(f.workspace.id, { ...f.request, sourceSessionId: 'old' })).toThrow()
  expect(f.starts).toHaveLength(1)
  const h = f.service.createSessionHandoff(f.workspace.id, { ...f.request, generateSummary: true })
  expect(f.service.createSessionHandoff(f.workspace.id, { ...f.request, generateSummary: true }).id).toBe(h.id)
  expect(() => f.service.createSessionHandoff(f.workspace.id, { ...f.request, requestId: 'another' })).toThrow()
  await vi.waitFor(() => expect(f.starts).toHaveLength(2))
  await f.service.decideSessionHandoff(f.workspace.id, h.id, 'cancel')
})

it('keeps generation failures recoverable and allows an explicit skip without a second source call', async () => {
  const f = await fixture()
  const h = f.service.createSessionHandoff(f.workspace.id, { ...f.request, generateSummary: true })
  await vi.waitFor(() => expect(f.starts).toHaveLength(2))
  f.starts[1]!.emit({ kind: 'error', category: 'quota', message: 'No tokens remaining' })
  f.starts[1]!.emit({ kind: 'session:ended', reason: 'error', exitCode: 1 })
  f.starts[1]!.close()
  await vi.waitFor(() => expect(f.service.getCurrentSessionHandoff(f.workspace.id)?.state).toBe('failed'))
  expect(f.ws.getWorkspace(f.workspace.id)?.engine).toBe('claude-code')
  await f.service.decideSessionHandoff(f.workspace.id, h.id, 'skip')
  await vi.waitFor(() => expect(f.service.getCurrentSessionHandoff(f.workspace.id)?.state).toBe('completed'))
  expect(f.starts.map((start) => start.engine)).toEqual(['claude-code', 'claude-code', 'codex'])
  await f.orch.stopAgentAndWait(f.workspace.id)
})

it('keeps target launch pending until the engine confirms that its first turn is ready', async () => {
  const f = await fixture()
  const { _registerEngineForTest } = await import('../server/services/agent/engines/registry.js')
  let ready!: () => void
  const pending = new Promise<void>((resolve) => {
    ready = resolve
  })
  _registerEngineForTest({
    id: 'codex',
    displayName: 'Codex',
    capabilities: {
      models: [{ id: 'auto', label: 'Auto' }],
      permissionModes: ['bypass'],
      supportsResume: true,
      supportsMcp: true,
      supportsSkills: false,
      supportsSubagents: false,
      supportsQuotaStatus: false,
    },
    async start(_options, emit) {
      return {
        pid: undefined,
        engineSessionId: 'target',
        ready: pending,
        sendMessage() {},
        interrupt() {},
        resolvePendingUserInput: () => false,
        async stop() {
          emit({ kind: 'session:ended', reason: 'killed', exitCode: null })
        },
      }
    },
  })
  f.service.createSessionHandoff(f.workspace.id, f.request)
  await vi.waitFor(() => expect(f.service.getCurrentSessionHandoff(f.workspace.id)?.targetSessionId).toBeTruthy())
  expect(f.service.getCurrentSessionHandoff(f.workspace.id)?.state).toBe('starting')
  ready()
  await vi.waitFor(() => expect(f.service.getCurrentSessionHandoff(f.workspace.id)?.state).toBe('completed'))
  await f.orch.stopAgentAndWait(f.workspace.id)
})

it('Stop cancels a submitted generation before closure and cannot launch a fresh session later', async () => {
  const f = await fixture()
  const h = f.service.createSessionHandoff(f.workspace.id, { ...f.request, generateSummary: true })
  await vi.waitFor(() => expect(f.starts).toHaveLength(2))
  f.service.submitSessionHandoff(
    f.workspace.id,
    h.id,
    f.starts[1]!.options.mcpServers![0]!.env.KOBO_HANDOFF_TOKEN,
    'Report',
  )
  await f.orch.stopAgentAndWait(f.workspace.id)
  expect(f.service.getCurrentSessionHandoff(f.workspace.id)?.state).toBe('cancelled')
  f.starts[1]!.emit({ kind: 'session:ended', reason: 'completed', exitCode: 0 })
  await new Promise((resolve) => setTimeout(resolve, 10))
  expect(f.starts).toHaveLength(2)
  expect(f.ws.getWorkspace(f.workspace.id)?.engine).toBe('claude-code')
})

it('does not spend auto-loop diagnostic budgets while generating and preserves unknown instructions', async () => {
  const f = await fixture()
  const { setRuntime } = await import('../server/services/auto-loop-state-service.js')
  const messages = await import('../server/services/auto-loop-message-service.js')
  f.getDb()
    .prepare('UPDATE workspaces SET auto_loop=1, auto_loop_ready=1, no_progress_streak=4 WHERE id=?')
    .run(f.workspace.id)
  setRuntime(f.workspace.id, {
    state: 'active',
    phase: 'execution',
    iteration: 9,
    diagnostic_attempts: 2,
    current_session_id: f.request.sourceSessionId,
  })
  messages.enqueueLoopMessage(f.workspace.id, 'Pending scope change', 'instruction')
  messages.claimLoopMessages(f.workspace.id)
  messages.bindLoopMessages(f.workspace.id, f.request.sourceSessionId)
  const h = f.service.createSessionHandoff(f.workspace.id, { ...f.request, generateSummary: true })
  await vi.waitFor(() => expect(f.starts).toHaveLength(2))
  f.service.submitSessionHandoff(
    f.workspace.id,
    h.id,
    f.starts[1]!.options.mcpServers![0]!.env.KOBO_HANDOFF_TOKEN,
    'Report',
  )
  f.starts[1]!.emit({ kind: 'session:ended', reason: 'completed', exitCode: 0 })
  f.starts[1]!.close()
  await vi.waitFor(() => expect(f.service.getCurrentSessionHandoff(f.workspace.id)?.state).toBe('completed'))
  expect(f.ws.getWorkspace(f.workspace.id)).toMatchObject({ autoLoop: true, noProgressStreak: 4 })
  expect(
    f
      .getDb()
      .prepare('SELECT iteration, diagnostic_attempts FROM auto_loop_runs WHERE workspace_id=?')
      .get(f.workspace.id),
  ).toEqual({ iteration: 9, diagnostic_attempts: 2 })
  expect(messages.listLoopMessages(f.workspace.id)).toMatchObject([{ state: 'unknown' }])
  await f.orch.stopAgentAndWait(f.workspace.id)
})

it('shutdown interrupts a submitted transfer without dispatching its target or losing the report', async () => {
  const f = await fixture()
  const h = f.service.createSessionHandoff(f.workspace.id, { ...f.request, generateSummary: true })
  await vi.waitFor(() => expect(f.starts).toHaveLength(2))
  f.service.submitSessionHandoff(
    f.workspace.id,
    h.id,
    f.starts[1]!.options.mcpServers![0]!.env.KOBO_HANDOFF_TOKEN,
    'Keep this report',
  )
  await f.orch.stopAllAgents()
  await new Promise((resolve) => setTimeout(resolve, 10))
  expect(f.starts).toHaveLength(2)
  expect(f.service.getCurrentSessionHandoff(f.workspace.id)?.state).toBe('interrupted')
  expect(f.getDb().prepare('SELECT report, generation_token FROM session_handoffs WHERE id=?').get(h.id)).toEqual({
    report: 'Keep this report',
    generation_token: null,
  })
})

it('restores a pending transfer after restart without replaying either native session', async () => {
  const f = await fixture()
  const h = f.service.createSessionHandoff(f.workspace.id, { ...f.request, generateSummary: true })
  await vi.waitFor(() => expect(f.starts).toHaveLength(2))
  f.service.reconcileSessionHandoffs()
  expect(f.service.getCurrentSessionHandoff(f.workspace.id)?.state).toBe('interrupted')
  expect(f.starts).toHaveLength(2)
  expect(() =>
    f.service.submitSessionHandoff(
      f.workspace.id,
      h.id,
      f.starts[1]!.options.mcpServers![0]!.env.KOBO_HANDOFF_TOKEN,
      'Late',
    ),
  ).toThrow()
  await f.service.decideSessionHandoff(f.workspace.id, h.id, 'cancel')
  expect(f.ws.getWorkspace(f.workspace.id)).toMatchObject({ engine: 'claude-code', status: 'idle' })
})

it('records pending generation permission requests without permitting a second chat writer', async () => {
  const f = await fixture()
  const h = f.service.createSessionHandoff(f.workspace.id, { ...f.request, generateSummary: true })
  await vi.waitFor(() => expect(f.starts).toHaveLength(2))
  f.starts[1]!.emit({
    kind: 'session:user-input-requested',
    requestKind: 'permission',
    toolCallId: 'read-confirmation',
    toolName: 'Read',
    payload: { path: 'README.md' },
  })
  expect(f.orch.getPendingInputs(f.workspace.id)).toMatchObject([
    { kind: 'permission', toolCallId: 'read-confirmation' },
  ])
  await expect(f.orch.sendMessage(f.workspace.id, 'Concurrent work')).rejects.toThrow()
  await f.service.decideSessionHandoff(f.workspace.id, h.id, 'cancel')
  expect(f.ws.getWorkspace(f.workspace.id)?.status).toBe('idle')
})

it('can start without a prior conversation from a created workspace', async () => {
  const f = await fixture()
  await f.orch.stopAgentAndWait(f.workspace.id)
  const workspace = f.ws.createWorkspace({
    name: 'New mission',
    projectPath: directory,
    sourceBranch: 'main',
    workingBranch: 'new',
    model: 'auto',
  })
  f.getDb().prepare('UPDATE workspaces SET worktree_path=? WHERE id=?').run(directory, workspace.id)
  f.service.createSessionHandoff(workspace.id, { ...f.request, sourceSessionId: null })
  await vi.waitFor(() => expect(f.service.getCurrentSessionHandoff(workspace.id)?.state).toBe('completed'))
  expect(f.ws.getWorkspace(workspace.id)).toMatchObject({ status: 'executing', engine: 'codex' })
  await f.orch.stopAgentAndWait(workspace.id)
})

it('exposes durable asynchronous HTTP transfers and rejects conflicting mutations', async () => {
  const f = await fixture()
  const { Hono } = await import('hono')
  const router = (await import('../server/routes/workspaces.js')).default
  const app = new Hono().route('/api/workspaces', router)
  const url = `/api/workspaces/${f.workspace.id}`
  const body = { ...f.request, generateSummary: true }
  const post = () =>
    app.request(`${url}/session-handoffs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  const response = await post()
  expect(response.status).toBe(202)
  const { handoff } = await response.json()
  expect((await (await post()).json()).handoff.id).toBe(handoff.id)
  await vi.waitFor(() => expect(f.starts).toHaveLength(2))
  expect((await app.request(`${url}/session-handoffs/current`)).status).toBe(200)
  expect((await app.request(`${url}/start-review`, { method: 'POST', body: '{}' })).status).toBe(409)
  expect((await app.request(url, { method: 'PATCH', body: JSON.stringify({ model: 'other' }) })).status).toBe(409)
  expect(
    (
      await app.request(`${url}/session-handoffs/${handoff.id}/report`, {
        method: 'POST',
        body: JSON.stringify({ token: 'wrong', report: 'Fake' }),
      })
    ).status,
  ).toBe(409)
  const cancelled = await app.request(`${url}/session-handoffs/${handoff.id}/decision`, {
    method: 'POST',
    body: JSON.stringify({ action: 'cancel' }),
  })
  expect(cancelled.status).toBe(200)
  expect((await cancelled.json()).handoff.state).toBe('cancelled')
})

it('rejects malformed transfer JSON before any agent side effect', async () => {
  const f = await fixture()
  const { Hono } = await import('hono')
  const router = (await import('../server/routes/workspaces.js')).default
  const app = new Hono().route('/api/workspaces', router)
  const response = await app.request(`/api/workspaces/${f.workspace.id}/session-handoffs`, {
    method: 'POST',
    body: '{',
  })
  expect(response.status).toBe(400)
  expect(f.starts).toHaveLength(1)
  await f.orch.stopAgentAndWait(f.workspace.id)
})

it('blocks a replacement when source shutdown is unconfirmed, and allows cancellation once it closes', async () => {
  const f = await fixture()
  const controller = f.orch._getControllers().get(f.workspace.id)!
  let stopped!: () => void
  const stop = vi.spyOn(controller, 'stop').mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        stopped = resolve
      }),
  )
  vi.useFakeTimers()
  try {
    const h = f.service.createSessionHandoff(f.workspace.id, f.request)
    await vi.advanceTimersByTimeAsync(f.orch.STOP_AGENT_TIMEOUT_MS + 1)
    expect(f.service.getCurrentSessionHandoff(f.workspace.id)?.state).toBe('failed')
    expect(f.starts).toHaveLength(1)
    expect(f.orch.hasController(f.workspace.id)).toBe(true)
    stopped()
    await vi.advanceTimersByTimeAsync(1)
    stop.mockRestore()
    f.starts[0]!.emit({ kind: 'session:ended', reason: 'killed', exitCode: null })
    f.starts[0]!.close()
    await f.service.decideSessionHandoff(f.workspace.id, h.id, 'cancel')
    expect(f.service.getCurrentSessionHandoff(f.workspace.id)?.state).toBe('cancelled')
  } finally {
    vi.useRealTimers()
  }
})

it('rejects a retry from another tab while cancellation is still waiting for shutdown', async () => {
  const f = await fixture()
  const h = f.service.createSessionHandoff(f.workspace.id, { ...f.request, generateSummary: true })
  await vi.waitFor(() => expect(f.starts).toHaveLength(2))
  f.starts[1]!.emit({ kind: 'session:ended', reason: 'error', exitCode: 1 })
  f.starts[1]!.close()
  await vi.waitFor(() => expect(f.service.getCurrentSessionHandoff(f.workspace.id)?.state).toBe('failed'))
  // Reproduce a failed transfer whose residual controller still needs stopping.
  const controller = f.orch._getControllers().get(f.workspace.id)
  expect(controller).toBeUndefined()
  const { requestHandoffStop } = await import('../server/services/session-handoff-runtime.js')
  const finishStop = requestHandoffStop(f.workspace.id)!
  await expect(f.service.decideSessionHandoff(f.workspace.id, h.id, 'retry')).rejects.toThrow(/cancel|stopp/i)
  await expect(f.service.decideSessionHandoff(f.workspace.id, h.id, 'skip')).rejects.toThrow(/cancel|stopp/i)
  finishStop('not-running')
  expect(f.service.getCurrentSessionHandoff(f.workspace.id)?.state).toBe('cancelled')
  const next = f.service.createSessionHandoff(f.workspace.id, {
    ...f.request,
    requestId: 'new-request',
    sourceSessionId: f.ws.getActiveSession(f.workspace.id)?.id ?? null,
    generateSummary: true,
  })
  finishStop('not-running') // A repeated old completion must not release the next owner's reservation.
  expect(f.service.getCurrentSessionHandoff(f.workspace.id)?.id).toBe(next.id)
  await f.service.decideSessionHandoff(f.workspace.id, next.id, 'cancel')
})

it('recovers a rejected target readiness only on explicit retry and reuses the source report', async () => {
  const f = await fixture()
  const { _registerEngineForTest } = await import('../server/services/agent/engines/registry.js')
  let rejectReady!: (error: Error) => void
  let targetEmit!: (event: AgentEvent) => void
  let close!: () => void
  let targetStarts = 0
  _registerEngineForTest({
    id: 'codex',
    displayName: 'Codex',
    capabilities: {
      models: [{ id: 'auto', label: 'Auto' }],
      permissionModes: ['bypass'],
      supportsResume: true,
      supportsMcp: true,
      supportsSkills: false,
      supportsSubagents: false,
      supportsQuotaStatus: false,
    },
    async start(_options, emit) {
      targetStarts++
      targetEmit = emit
      const ready =
        targetStarts === 1
          ? new Promise<void>((_resolve, reject) => {
              rejectReady = reject
            })
          : Promise.resolve()
      const closed = new Promise<void>((resolve) => {
        close = resolve
      })
      return {
        pid: undefined,
        engineSessionId: 'target',
        ready,
        closed,
        sendMessage() {},
        interrupt() {},
        resolvePendingUserInput: () => false,
        async stop() {
          emit({ kind: 'session:ended', reason: 'killed', exitCode: null })
          close()
        },
      }
    },
  })
  const h = f.service.createSessionHandoff(f.workspace.id, { ...f.request, generateSummary: true })
  await vi.waitFor(() => expect(f.starts).toHaveLength(2))
  f.service.submitSessionHandoff(
    f.workspace.id,
    h.id,
    f.starts[1]!.options.mcpServers![0]!.env.KOBO_HANDOFF_TOKEN,
    'Reusable report',
  )
  f.starts[1]!.emit({ kind: 'session:ended', reason: 'completed', exitCode: 0 })
  f.starts[1]!.close()
  await vi.waitFor(() => expect(targetStarts).toBe(1))
  rejectReady(new Error('Initial turn rejected'))
  targetEmit({ kind: 'error', category: 'spawn_failed', message: 'Initial turn rejected' })
  targetEmit({ kind: 'session:ended', reason: 'error', exitCode: 1 })
  close()
  await vi.waitFor(() => expect(f.service.getCurrentSessionHandoff(f.workspace.id)?.state).toBe('failed'))
  expect(f.ws.getWorkspace(f.workspace.id)).toMatchObject({ engine: 'claude-code', status: 'idle' })
  expect(targetStarts).toBe(1)
  await f.service.decideSessionHandoff(f.workspace.id, h.id, 'retry')
  await vi.waitFor(() => expect(f.service.getCurrentSessionHandoff(f.workspace.id)?.state).toBe('completed'))
  expect(targetStarts).toBe(2)
  expect(f.starts).toHaveLength(2)
  expect(f.getDb().prepare('SELECT report FROM session_handoffs WHERE id=?').get(h.id)).toEqual({
    report: 'Reusable report',
  })
  await f.orch.stopAgentAndWait(f.workspace.id)
})

it('preserves the legacy synchronous engine-switch response without requesting a summary', async () => {
  const f = await fixture()
  const { Hono } = await import('hono')
  const router = (await import('../server/routes/workspaces.js')).default
  const app = new Hono().route('/api/workspaces', router)
  const response = await app.request(`/api/workspaces/${f.workspace.id}/switch-engine`, {
    method: 'POST',
    body: JSON.stringify({ ...f.request.target, handoff: 'User supplied transition context' }),
  })
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ workspace: { engine: 'codex' }, sessionId: expect.any(String) })
  expect(f.starts).toHaveLength(2)
  expect(f.starts[1]!.options.prompt).toContain('User supplied transition context')
  await f.orch.stopAgentAndWait(f.workspace.id)
})

it('handles a target that finishes before its start promise settles as a normal work session', async () => {
  const f = await fixture()
  const { _registerEngineForTest } = await import('../server/services/agent/engines/registry.js')
  const loop = await import('../server/services/auto-loop-service.js')
  const ended = vi.spyOn(loop, 'onSessionEnded').mockImplementation(() => {})
  _registerEngineForTest({
    id: 'codex',
    displayName: 'Codex',
    capabilities: {
      models: [{ id: 'auto', label: 'Auto' }],
      permissionModes: ['bypass'],
      supportsResume: true,
      supportsMcp: true,
      supportsSkills: false,
      supportsSubagents: false,
      supportsQuotaStatus: false,
    },
    async start(_options, emit) {
      emit({ kind: 'session:started', engineSessionId: 'fast-target' })
      emit({ kind: 'session:ended', reason: 'completed', exitCode: 0 })
      return {
        pid: undefined,
        engineSessionId: 'fast-target',
        ready: Promise.resolve(),
        closed: Promise.resolve(),
        sendMessage() {},
        interrupt() {},
        resolvePendingUserInput: () => false,
        async stop() {},
      }
    },
  })
  f.service.createSessionHandoff(f.workspace.id, f.request)
  await vi.waitFor(() => expect(f.service.getCurrentSessionHandoff(f.workspace.id)?.state).toBe('completed'))
  expect(ended).toHaveBeenCalledWith(f.workspace.id, 'completed', expect.any(Number), false)
  expect(f.ws.getWorkspace(f.workspace.id)?.status).toBe('completed')
})

it('waits for every concurrent Stop outcome before accepting a retry', async () => {
  const f = await fixture()
  const h = f.service.createSessionHandoff(f.workspace.id, { ...f.request, generateSummary: true })
  await vi.waitFor(() => expect(f.starts).toHaveLength(2))
  f.starts[1]!.emit({ kind: 'session:ended', reason: 'error', exitCode: 1 })
  f.starts[1]!.close()
  await vi.waitFor(() => expect(f.service.getCurrentSessionHandoff(f.workspace.id)?.state).toBe('failed'))
  const { requestHandoffStop } = await import('../server/services/session-handoff-runtime.js')
  const first = requestHandoffStop(f.workspace.id)!
  const second = requestHandoffStop(f.workspace.id)!
  first('timeout')
  await expect(f.service.decideSessionHandoff(f.workspace.id, h.id, 'retry')).rejects.toThrow(/cancel|stopp/i)
  first('failed') // The same completion cannot decrement the pending stop count twice.
  await expect(f.service.decideSessionHandoff(f.workspace.id, h.id, 'skip')).rejects.toThrow(/cancel|stopp/i)
  second('not-running')
  expect(f.service.getCurrentSessionHandoff(f.workspace.id)?.state).toBe('cancelled')
})
