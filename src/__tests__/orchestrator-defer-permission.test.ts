import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent } from '../server/services/agent/engines/types.js'
import { resetDb } from './helpers/reset-db.js'

vi.mock('../server/services/websocket-service.js', () => ({
  emit: vi.fn(),
  emitEphemeral: vi.fn(),
}))

vi.mock('../server/services/settings-service.js', () => ({
  getGlobalSettings: () => ({ notionEnabled: false, sentryEnabled: false }),
  getEffectiveSettings: () => ({
    model: 'claude-opus-4-7',
    dangerouslySkipPermissions: true,
    prPromptTemplate: '',
    gitConventions: '',
    sourceBranch: 'develop',
    devServer: null,
    setupScript: '',
    notionStatusProperty: '',
    notionInProgressStatus: '',
  }),
}))

interface CapturedStart {
  options: { resumeFromEngineSessionId?: string }
  onEvent: (ev: AgentEvent) => void
  resolvePendingUserInput: ReturnType<typeof vi.fn>
  hasPendingUserInput: ReturnType<typeof vi.fn>
}

const captured: CapturedStart[] = []

describe('Orchestrator — pending permission queue (canUseTool)', () => {
  it('exports detached serializable pending-input snapshots without callbacks', async () => {
    const orch = await import('../server/services/agent/orchestrator.js')
    const question = {
      kind: 'question' as const,
      agentSessionId: 'session',
      toolCallId: 'q',
      toolName: 'AskUserQuestion',
      input: { questions: [{ question: 'Choose', options: [{ label: 'A' }] }], callback: () => {} },
      resolve: () => {},
    }
    const permission = {
      kind: 'permission' as const,
      agentSessionId: 'session',
      toolCallId: 'p',
      toolName: 'Edit',
      toolInput: { operationApprovalAvailable: false },
      resolve: () => {},
    }
    orch._getPendingQueue().set('snapshot-ws', [question, permission])
    const snapshot = orch.getPendingInputs('snapshot-ws')
    expect(snapshot).toEqual([
      {
        kind: 'question',
        agentSessionId: 'session',
        toolCallId: 'q',
        toolName: 'AskUserQuestion',
        input: { questions: [{ question: 'Choose', options: [{ label: 'A' }] }] },
      },
      {
        kind: 'permission',
        agentSessionId: 'session',
        toolCallId: 'p',
        toolName: 'Edit',
        toolInput: { operationApprovalAvailable: false },
      },
    ])
    if (snapshot[0]?.kind !== 'question') throw new Error('Expected question')
    ;(snapshot[0].input as typeof question.input).questions[0].options[0].label = 'changed'
    snapshot.pop()
    expect(question.input.questions[0].options[0].label).toBe('A')
    expect(orch._getPendingQueue().get('snapshot-ws')).toHaveLength(2)
    expect(orch.getPendingInputs('unknown')).toEqual([])
  })

  beforeEach(async () => {
    vi.resetModules()
    await resetDb()
    captured.length = 0
    const { _registerEngineForTest } = await import('../server/services/agent/engines/registry.js')
    _registerEngineForTest({
      id: 'claude-code',
      displayName: 'Claude Code',
      capabilities: {
        models: [{ id: 'auto', label: 'Auto' }],
        permissionModes: ['bypass'],
        supportsResume: true,
        supportsMcp: true,
        supportsLiveSteering: true,
        supportsReadOnly: true,
        supportsSkills: true,
        supportsSubagents: false,
        supportsQuotaStatus: false,
      },
      async start(opts, onEvent) {
        const resolvePendingUserInput = vi.fn().mockReturnValue(true)
        const hasPendingUserInput = vi.fn().mockReturnValue(true)
        captured.push({
          options: opts as CapturedStart['options'],
          onEvent,
          resolvePendingUserInput,
          hasPendingUserInput,
        })
        return {
          pid: 4242,
          engineSessionId: 'engine-sess-1',
          sendMessage() {},
          interrupt() {},
          async stop() {},
          resolvePendingUserInput,
          hasPendingUserInput,
        }
      },
    })
  })

  it('enqueues a permission item on session:user-input-requested(permission)', async () => {
    const { createWorkspace, updateWorkspaceStatus, getWorkspace } = await import(
      '../server/services/workspace-service.js'
    )
    const ws = createWorkspace({
      name: 'WP',
      projectPath: '/tmp',
      sourceBranch: 'develop',
      workingBranch: 'feature/wp',
    })
    updateWorkspaceStatus(ws.id, 'brainstorming')
    updateWorkspaceStatus(ws.id, 'executing')

    const orch = await import('../server/services/agent/orchestrator.js')
    const { startAgent, _getPendingQueue } = orch
    startAgent(ws.id, '/tmp', 'hi')
    await Promise.resolve()
    await Promise.resolve()
    const cap = captured[0]
    if (!cap) throw new Error('no capture')

    cap.onEvent({ kind: 'session:started', engineSessionId: 'engine-sess-1' })
    cap.onEvent({
      kind: 'session:user-input-requested',
      requestKind: 'permission',
      toolCallId: 'toolu_perm_1',
      toolName: 'Bash',
      payload: { command: 'rm -rf /' },
    })

    expect(getWorkspace(ws.id)?.status).toBe('awaiting-user')
    const queue = _getPendingQueue().get(ws.id) ?? []
    expect(queue.length).toBe(1)
    expect(queue[0]).toMatchObject({
      kind: 'permission',
      toolCallId: 'toolu_perm_1',
      toolName: 'Bash',
    })
  })

  it('answerPendingPermission(allow) resolves the engine callback', async () => {
    const { createWorkspace, updateWorkspaceStatus } = await import('../server/services/workspace-service.js')
    const ws = createWorkspace({
      name: 'WPA',
      projectPath: '/tmp',
      sourceBranch: 'develop',
      workingBranch: 'feature/wpa',
    })
    updateWorkspaceStatus(ws.id, 'brainstorming')
    updateWorkspaceStatus(ws.id, 'executing')

    const orch = await import('../server/services/agent/orchestrator.js')
    const { startAgent, answerPendingPermission, _getPendingQueue } = orch
    startAgent(ws.id, '/tmp', 'hi')
    await Promise.resolve()
    await Promise.resolve()
    const cap = captured[0]
    if (!cap) throw new Error('no capture')

    cap.onEvent({ kind: 'session:started', engineSessionId: 'engine-sess-1' })
    cap.onEvent({
      kind: 'session:user-input-requested',
      requestKind: 'permission',
      toolCallId: 'toolu_perm_1',
      toolName: 'Bash',
      payload: { command: 'ls' },
    })

    await answerPendingPermission(ws.id, { toolCallId: 'toolu_perm_1', decision: 'allow' })

    expect(_getPendingQueue().get(ws.id)).toBeUndefined()
    expect(captured.length).toBe(1)
    expect(cap.resolvePendingUserInput).toHaveBeenCalledWith('toolu_perm_1', { kind: 'permission-allow' })
  })

  it('answerPendingPermission(deny) propagates the reason', async () => {
    const { createWorkspace, updateWorkspaceStatus } = await import('../server/services/workspace-service.js')
    const ws = createWorkspace({
      name: 'WPD',
      projectPath: '/tmp',
      sourceBranch: 'develop',
      workingBranch: 'feature/wpd',
    })
    updateWorkspaceStatus(ws.id, 'brainstorming')
    updateWorkspaceStatus(ws.id, 'executing')

    const orch = await import('../server/services/agent/orchestrator.js')
    const { startAgent, answerPendingPermission } = orch
    startAgent(ws.id, '/tmp', 'hi')
    await Promise.resolve()
    await Promise.resolve()
    const cap = captured[0]
    if (!cap) throw new Error('no capture')

    cap.onEvent({ kind: 'session:started', engineSessionId: 'engine-sess-1' })
    cap.onEvent({
      kind: 'session:user-input-requested',
      requestKind: 'permission',
      toolCallId: 'toolu_perm_2',
      toolName: 'Bash',
      payload: { command: 'ls' },
    })

    await answerPendingPermission(ws.id, {
      toolCallId: 'toolu_perm_2',
      decision: 'deny',
      reason: 'unsafe',
    })

    expect(cap.resolvePendingUserInput).toHaveBeenCalledWith('toolu_perm_2', {
      kind: 'permission-deny',
      reason: 'unsafe',
    })
  })

  it('does not persist a remembered permission for an expired callback', async () => {
    const { createWorkspace, updateWorkspaceStatus } = await import('../server/services/workspace-service.js')
    const ws = createWorkspace({
      name: 'Expired',
      projectPath: '/tmp',
      sourceBranch: 'develop',
      workingBranch: 'feature/expired',
    })
    updateWorkspaceStatus(ws.id, 'brainstorming')
    const orch = await import('../server/services/agent/orchestrator.js')
    orch.startAgent(ws.id, '/tmp', 'hi')
    await Promise.resolve()
    await Promise.resolve()
    const cap = captured[0]!
    cap.onEvent({ kind: 'session:started', engineSessionId: 'engine-sess-1' })
    cap.onEvent({
      kind: 'session:user-input-requested',
      requestKind: 'permission',
      toolCallId: 'expired',
      toolName: 'Bash',
      payload: { command: 'pwd' },
    })
    cap.resolvePendingUserInput.mockReturnValue(false)
    cap.hasPendingUserInput.mockReturnValue(false)
    await expect(
      orch.answerPendingPermission(ws.id, { toolCallId: 'expired', decision: 'allow', scope: 'tool' }),
    ).rejects.toThrow('No pending callback')
    const policy = await import('../server/services/workspace-permission-policy-service.js')
    expect(policy.listWorkspacePermissionRules(ws.id)).toEqual([])
  })

  it('rejects incomplete operations before resolving or persisting and rejects old session ownership', async () => {
    const { createWorkspace, updateWorkspaceStatus } = await import('../server/services/workspace-service.js')
    const ws = createWorkspace({
      name: 'Incomplete',
      projectPath: '/tmp',
      sourceBranch: 'develop',
      workingBranch: 'feature/incomplete',
    })
    updateWorkspaceStatus(ws.id, 'brainstorming')
    const orch = await import('../server/services/agent/orchestrator.js')
    orch.startAgent(ws.id, '/tmp', 'hi')
    await Promise.resolve()
    await Promise.resolve()
    const cap = captured[0]!
    cap.onEvent({ kind: 'session:started', engineSessionId: 'engine-sess-1' })
    const { getDb } = await import('../server/db/index.js')
    getDb().prepare("UPDATE workspaces SET engine='mistral-vibe' WHERE id=?").run(ws.id)
    cap.onEvent({
      kind: 'session:user-input-requested',
      requestKind: 'permission',
      toolCallId: 'incomplete',
      toolName: 'bash',
      payload: { operationApprovalAvailable: false, title: 'bash: pwd' },
    })
    await expect(
      orch.answerPendingPermission(ws.id, { toolCallId: 'incomplete', decision: 'allow', scope: 'operation' }),
    ).rejects.toThrow(/details/i)
    expect(cap.resolvePendingUserInput).not.toHaveBeenCalled()
    const policy = await import('../server/services/workspace-permission-policy-service.js')
    expect(policy.listWorkspacePermissionRules(ws.id)).toEqual([])
    orch._getPendingQueue().get(ws.id)![0]!.agentSessionId = 'older-launch'
    await expect(
      orch.answerPendingPermission(ws.id, { toolCallId: 'incomplete', decision: 'allow', scope: 'tool' }),
    ).rejects.toThrow(/session/i)
    expect(cap.resolvePendingUserInput).not.toHaveBeenCalled()
    expect(policy.listWorkspacePermissionRules(ws.id)).toEqual([])
  })

  it('forwards typed question selections without altering legacy string answers', async () => {
    const { createWorkspace, updateWorkspaceStatus } = await import('../server/services/workspace-service.js')
    const ws = createWorkspace({
      name: 'Selections',
      projectPath: '/tmp',
      sourceBranch: 'develop',
      workingBranch: 'feature/selections',
    })
    updateWorkspaceStatus(ws.id, 'brainstorming')
    const orch = await import('../server/services/agent/orchestrator.js')
    orch.startAgent(ws.id, '/tmp', 'hi')
    await Promise.resolve()
    await Promise.resolve()
    const cap = captured[0]!
    cap.onEvent({ kind: 'session:started', engineSessionId: 'engine-sess-1' })
    cap.onEvent({
      kind: 'session:user-input-requested',
      requestKind: 'question',
      toolCallId: 'qtyped',
      toolName: 'AskUserQuestion',
      payload: { questions: [] },
    })
    await orch.answerPendingQuestion(ws.id, { q: 'One, Two, Three' }, 'qtyped', {
      selections: { q: ['One, Two', 'Three'] },
    })
    expect(cap.resolvePendingUserInput).toHaveBeenCalledWith('qtyped', {
      kind: 'question',
      answers: { q: 'One, Two, Three' },
      selections: { q: ['One, Two', 'Three'] },
    })
  })

  it('keeps a native form pending after validation failure and accepts a corrected answer', async () => {
    const { createWorkspace, updateWorkspaceStatus, getWorkspace } = await import(
      '../server/services/workspace-service.js'
    )
    const ws = createWorkspace({
      name: 'Native question',
      projectPath: '/tmp',
      sourceBranch: 'develop',
      workingBranch: 'feature/native-question',
    })
    updateWorkspaceStatus(ws.id, 'brainstorming')
    const orch = await import('../server/services/agent/orchestrator.js')
    orch.startAgent(ws.id, '/tmp', 'hi')
    await Promise.resolve()
    await Promise.resolve()
    const cap = captured[0]!
    cap.onEvent({ kind: 'session:started', engineSessionId: 'engine-sess-1' })
    const { createMistralServerRequests } = await import(
      '../server/services/agent/engines/mistral-vibe/server-requests.js'
    )
    const bridge = createMistralServerRequests({
      sessionId: 'native',
      readOnly: false,
      emit: cap.onEvent,
      getTool: () => undefined,
      canonicalToolCallId: (id) => `vibe:launch:tool:${id}`,
    })
    cap.resolvePendingUserInput.mockImplementation(bridge.resolvePendingUserInput)
    const response = bridge.createElicitation({
      method: 'elicitation/create',
      requestId: 1,
      signal: new AbortController().signal,
      agent: {} as import('@agentclientprotocol/sdk').ClientContext,
      params: {
        sessionId: 'native',
        mode: 'form',
        message: 'Name?',
        requestedSchema: { properties: { name: { type: 'string', minLength: 2 } }, required: ['name'] },
      },
    })
    const id = orch.getPendingInputs(ws.id)[0]!.toolCallId
    const { PendingUserInputValidationError } = await import('../server/services/agent/engines/types.js')
    try {
      expect(bridge.hasPendingUserInput(id)).toBe(true)
      await expect(orch.answerPendingQuestion(ws.id, { name: 'x' }, id)).rejects.toThrow(
        PendingUserInputValidationError,
      )
      expect(bridge.hasPendingUserInput(id)).toBe(true)
      expect(orch.getPendingInputs(ws.id)[0]?.toolCallId).toBe(id)
      expect(getWorkspace(ws.id)?.status).toBe('awaiting-user')
      await orch.answerPendingQuestion(ws.id, { name: 'valid' }, id)
      expect(await response).toEqual({ action: 'accept', content: { name: 'valid' } })
      expect(bridge.hasPendingUserInput(id)).toBe(false)
      expect(orch.getPendingInputs(ws.id)).toEqual([])
      expect(getWorkspace(ws.id)?.status).toBe('brainstorming')
    } finally {
      bridge.cancelAll()
    }
  })

  it('keeps the callback and queue intact after SQLite remembering fails, then retries and answers the following request', async () => {
    const { createWorkspace, updateWorkspaceStatus, getWorkspace } = await import(
      '../server/services/workspace-service.js'
    )
    const ws = createWorkspace({
      name: 'Remember failure',
      projectPath: '/tmp',
      sourceBranch: 'develop',
      workingBranch: 'feature/remember-failure',
    })
    updateWorkspaceStatus(ws.id, 'brainstorming')
    const orch = await import('../server/services/agent/orchestrator.js')
    orch.startAgent(ws.id, '/tmp', 'hi')
    await Promise.resolve()
    await Promise.resolve()
    const cap = captured[0]!
    cap.onEvent({ kind: 'session:started', engineSessionId: 'engine-sess-1' })
    for (const id of ['remember', 'following'])
      cap.onEvent({
        kind: 'session:user-input-requested',
        requestKind: 'permission',
        toolCallId: id,
        toolName: 'Bash',
        payload: { command: 'pwd' },
      })
    const { getDb } = await import('../server/db/index.js')
    const db = getDb()
    const policy = await import('../server/services/workspace-permission-policy-service.js')
    db.exec(
      "CREATE TEMP TRIGGER fail_permission_rule BEFORE INSERT ON workspace_permission_rules BEGIN SELECT RAISE(FAIL, 'injected permission write failure'); END",
    )
    await expect(
      orch.answerPendingPermission(ws.id, { toolCallId: 'remember', decision: 'allow', scope: 'tool' }),
    ).rejects.toThrow('injected permission write failure')
    expect(cap.resolvePendingUserInput).not.toHaveBeenCalled()
    expect(policy.listWorkspacePermissionRules(ws.id)).toEqual([])
    expect(orch.getPendingInputs(ws.id).map((item) => item.toolCallId)).toEqual(['remember', 'following'])
    expect(getWorkspace(ws.id)?.status).toBe('awaiting-user')
    db.exec('DROP TRIGGER fail_permission_rule')
    cap.resolvePendingUserInput.mockImplementation(() => {
      expect(policy.listWorkspacePermissionRules(ws.id)).toHaveLength(1)
      return true
    })
    await orch.answerPendingPermission(ws.id, { toolCallId: 'remember', decision: 'allow', scope: 'tool' })
    expect(orch.getPendingInputs(ws.id)[0]?.toolCallId).toBe('following')
    await orch.answerPendingPermission(ws.id, { toolCallId: 'following', decision: 'allow', scope: 'once' })
    expect(cap.resolvePendingUserInput).toHaveBeenCalledTimes(2)
    expect(orch.getPendingInputs(ws.id)).toEqual([])
    expect(getWorkspace(ws.id)?.status).toBe('brainstorming')
  })

  it('refuses remembered grants without a callback preflight while preserving one-time decisions', async () => {
    const { createWorkspace, updateWorkspaceStatus } = await import('../server/services/workspace-service.js')
    const ws = createWorkspace({
      name: 'Unknown callback',
      projectPath: '/tmp',
      sourceBranch: 'develop',
      workingBranch: 'feature/unknown-callback',
    })
    updateWorkspaceStatus(ws.id, 'brainstorming')
    const orch = await import('../server/services/agent/orchestrator.js')
    orch.startAgent(ws.id, '/tmp', 'hi')
    await Promise.resolve()
    await Promise.resolve()
    const cap = captured[0]!
    cap.onEvent({ kind: 'session:started', engineSessionId: 'engine-sess-1' })
    cap.onEvent({
      kind: 'session:user-input-requested',
      requestKind: 'permission',
      toolCallId: 'unknown-preflight',
      toolName: 'Bash',
      payload: { command: 'pwd' },
    })
    delete orch._getControllers().get(ws.id)!.engineProcess!.hasPendingUserInput
    const policy = await import('../server/services/workspace-permission-policy-service.js')
    for (const scope of ['tool', 'operation', 'turn'] as const)
      await expect(
        orch.answerPendingPermission(ws.id, { toolCallId: 'unknown-preflight', decision: 'allow', scope }),
      ).rejects.toThrow(/live callback/i)
    expect(cap.resolvePendingUserInput).not.toHaveBeenCalled()
    expect(policy.listWorkspacePermissionRules(ws.id)).toEqual([])
    await orch.answerPendingPermission(ws.id, { toolCallId: 'unknown-preflight', decision: 'allow', scope: 'once' })
    expect(orch.getPendingInputs(ws.id)).toEqual([])
  })

  it('queue ordering: enqueue 2 items, peek/dequeue return them FIFO', async () => {
    const { createWorkspace, updateWorkspaceStatus } = await import('../server/services/workspace-service.js')
    const ws = createWorkspace({
      name: 'WQ',
      projectPath: '/tmp',
      sourceBranch: 'develop',
      workingBranch: 'feature/wq',
    })
    updateWorkspaceStatus(ws.id, 'brainstorming')
    updateWorkspaceStatus(ws.id, 'executing')

    const orch = await import('../server/services/agent/orchestrator.js')
    const { startAgent, _getPendingQueue } = orch
    startAgent(ws.id, '/tmp', 'hi')
    await Promise.resolve()
    await Promise.resolve()
    const cap = captured[0]
    if (!cap) throw new Error('no capture')
    cap.onEvent({ kind: 'session:started', engineSessionId: 'engine-sess-1' })
    cap.onEvent({
      kind: 'session:user-input-requested',
      requestKind: 'question',
      toolCallId: 't_question',
      toolName: 'AskUserQuestion',
      payload: { questions: [] },
    })
    cap.onEvent({
      kind: 'session:user-input-requested',
      requestKind: 'permission',
      toolCallId: 't_perm',
      toolName: 'Bash',
      payload: { command: 'ls' },
    })

    const queue = _getPendingQueue().get(ws.id) ?? []
    expect(queue.length).toBe(2)
    expect(queue[0]?.kind).toBe('question')
    expect(queue[1]?.kind).toBe('permission')
  })

  it('rejects answerPendingPermission when head is a question', async () => {
    const { createWorkspace, updateWorkspaceStatus } = await import('../server/services/workspace-service.js')
    const ws = createWorkspace({
      name: 'WX',
      projectPath: '/tmp',
      sourceBranch: 'develop',
      workingBranch: 'feature/wx',
    })
    updateWorkspaceStatus(ws.id, 'brainstorming')
    updateWorkspaceStatus(ws.id, 'executing')

    const orch = await import('../server/services/agent/orchestrator.js')
    const { startAgent, answerPendingPermission } = orch
    startAgent(ws.id, '/tmp', 'hi')
    await Promise.resolve()
    await Promise.resolve()
    const cap = captured[0]
    if (!cap) throw new Error('no capture')

    cap.onEvent({ kind: 'session:started', engineSessionId: 'engine-sess-1' })
    cap.onEvent({
      kind: 'session:user-input-requested',
      requestKind: 'question',
      toolCallId: 'q1',
      toolName: 'AskUserQuestion',
      payload: { questions: [] },
    })

    await expect(answerPendingPermission(ws.id, { toolCallId: 'q1', decision: 'allow' })).rejects.toThrow(
      /Expected a deferred permission/,
    )
  })
})
