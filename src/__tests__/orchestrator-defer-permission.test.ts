import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent } from '../server/services/agent/engines/types.js'
import { resetDb } from './helpers/reset-db.js'

vi.mock('../server/services/websocket-service.js', () => ({
  emit: vi.fn(),
  emitEphemeral: vi.fn(),
}))

vi.mock('../server/services/settings-service.js', () => ({
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
}

const captured: CapturedStart[] = []

describe('Orchestrator — pending permission queue (canUseTool)', () => {
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
        supportsSkills: true,
      },
      async start(opts, onEvent) {
        const resolvePendingUserInput = vi.fn().mockReturnValue(true)
        captured.push({ options: opts as CapturedStart['options'], onEvent, resolvePendingUserInput })
        return {
          pid: 4242,
          engineSessionId: 'engine-sess-1',
          sendMessage() {},
          interrupt() {},
          async stop() {},
          resolvePendingUserInput,
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
