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

describe('Orchestrator — pending question (canUseTool)', () => {
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

  it('transitions to awaiting-user and stores pending entry on session:user-input-requested', async () => {
    const { createWorkspace, updateWorkspaceStatus, getWorkspace } = await import(
      '../server/services/workspace-service.js'
    )
    const ws = createWorkspace({
      name: 'W',
      projectPath: '/tmp',
      sourceBranch: 'develop',
      workingBranch: 'feature/w',
    })
    updateWorkspaceStatus(ws.id, 'brainstorming')
    updateWorkspaceStatus(ws.id, 'executing')

    const orch = await import('../server/services/agent/orchestrator.js')
    const { startAgent, _getPendingDeferred } = orch
    startAgent(ws.id, '/tmp', 'hi')
    await Promise.resolve()
    await Promise.resolve()
    expect(captured.length).toBe(1)
    const onEvent = captured[0]?.onEvent
    if (!onEvent) throw new Error('no onEvent')

    onEvent({ kind: 'session:started', engineSessionId: 'engine-sess-1' })
    onEvent({
      kind: 'session:user-input-requested',
      requestKind: 'question',
      toolCallId: 'toolu_01abc',
      toolName: 'AskUserQuestion',
      payload: { questions: [{ q: 'a' }] },
    })

    expect(getWorkspace(ws.id)?.status).toBe('awaiting-user')
    expect(_getPendingDeferred().get(ws.id)).toMatchObject({
      toolCallId: 'toolu_01abc',
      toolName: 'AskUserQuestion',
    })
  })

  it('answerPendingQuestion resolves the engine callback and transitions back', async () => {
    const { createWorkspace, updateWorkspaceStatus, getWorkspace } = await import(
      '../server/services/workspace-service.js'
    )
    const ws = createWorkspace({
      name: 'W2',
      projectPath: '/tmp',
      sourceBranch: 'develop',
      workingBranch: 'feature/w2',
    })
    updateWorkspaceStatus(ws.id, 'brainstorming')
    updateWorkspaceStatus(ws.id, 'executing')

    const orch = await import('../server/services/agent/orchestrator.js')
    const { startAgent, answerPendingQuestion, _getPendingDeferred } = orch
    startAgent(ws.id, '/tmp', 'hi')
    await Promise.resolve()
    await Promise.resolve()
    const cap = captured[0]
    if (!cap) throw new Error('no capture')

    cap.onEvent({ kind: 'session:started', engineSessionId: 'engine-sess-1' })
    cap.onEvent({
      kind: 'session:user-input-requested',
      requestKind: 'question',
      toolCallId: 'toolu_01abc',
      toolName: 'AskUserQuestion',
      payload: { questions: [{ q: 'a' }] },
    })

    expect(getWorkspace(ws.id)?.status).toBe('awaiting-user')
    expect(_getPendingDeferred().has(ws.id)).toBe(true)

    await answerPendingQuestion(ws.id, { q1: 'react' })

    expect(_getPendingDeferred().has(ws.id)).toBe(false)
    expect(getWorkspace(ws.id)?.status).toBe('executing')
    // No new engine session should be started — the SDK iterator continues.
    expect(captured.length).toBe(1)
    expect(cap.resolvePendingUserInput).toHaveBeenCalledWith('toolu_01abc', {
      kind: 'question',
      answers: { q1: 'react' },
    })
  })

  it('throws when no pending question is queued', async () => {
    const { createWorkspace } = await import('../server/services/workspace-service.js')
    const ws = createWorkspace({
      name: 'W3',
      projectPath: '/tmp',
      sourceBranch: 'develop',
      workingBranch: 'feature/w3',
    })
    const { answerPendingQuestion } = await import('../server/services/agent/orchestrator.js')
    await expect(answerPendingQuestion(ws.id, { a: 'b' })).rejects.toThrow(/No deferred tool use pending/)
  })

  it('throws when there is no active controller', async () => {
    const { createWorkspace, updateWorkspaceStatus } = await import('../server/services/workspace-service.js')
    const ws = createWorkspace({
      name: 'W4',
      projectPath: '/tmp',
      sourceBranch: 'develop',
      workingBranch: 'feature/w4',
    })
    updateWorkspaceStatus(ws.id, 'brainstorming')
    updateWorkspaceStatus(ws.id, 'executing')

    const orch = await import('../server/services/agent/orchestrator.js')
    const { startAgent, answerPendingQuestion } = orch
    startAgent(ws.id, '/tmp', 'hi')
    await Promise.resolve()
    await Promise.resolve()
    const cap = captured[0]
    if (!cap) throw new Error('no capture')
    cap.onEvent({ kind: 'session:started', engineSessionId: 'engine-sess-1' })
    cap.onEvent({
      kind: 'session:user-input-requested',
      requestKind: 'question',
      toolCallId: 'toolu_zz',
      toolName: 'AskUserQuestion',
      payload: { questions: [] },
    })
    // Simulate the engine ending so the controller is removed before the user answers.
    cap.onEvent({ kind: 'session:ended', reason: 'killed', exitCode: null })

    await expect(answerPendingQuestion(ws.id, { x: 'y' })).rejects.toThrow()
  })

  it('stopAgent normalizes awaiting-user → idle and purges queue + persisted requests', async () => {
    const { createWorkspace, updateWorkspaceStatus, getWorkspace } = await import(
      '../server/services/workspace-service.js'
    )
    const ws = createWorkspace({
      name: 'W5',
      projectPath: '/tmp',
      sourceBranch: 'develop',
      workingBranch: 'feature/w5',
    })
    updateWorkspaceStatus(ws.id, 'brainstorming')
    updateWorkspaceStatus(ws.id, 'executing')

    const orch = await import('../server/services/agent/orchestrator.js')
    const { startAgent, stopAgent, _getPendingDeferred } = orch
    startAgent(ws.id, '/tmp', 'hi')
    await Promise.resolve()
    await Promise.resolve()
    const cap = captured[0]
    if (!cap) throw new Error('no capture')
    cap.onEvent({ kind: 'session:started', engineSessionId: 'engine-sess-1' })
    cap.onEvent({
      kind: 'session:user-input-requested',
      requestKind: 'question',
      toolCallId: 'toolu_kill',
      toolName: 'AskUserQuestion',
      payload: { questions: [] },
    })

    expect(getWorkspace(ws.id)?.status).toBe('awaiting-user')
    expect(_getPendingDeferred().get(ws.id)).toBeDefined()

    stopAgent(ws.id)

    expect(getWorkspace(ws.id)?.status).toBe('idle')
    expect(_getPendingDeferred().get(ws.id)).toBeUndefined()
  })

  it('does not attempt invalid idle → completed transition when session:ended fires after stopAgent', async () => {
    const { createWorkspace, updateWorkspaceStatus, getWorkspace } = await import(
      '../server/services/workspace-service.js'
    )
    const ws = createWorkspace({
      name: 'W6',
      projectPath: '/tmp',
      sourceBranch: 'develop',
      workingBranch: 'feature/w6',
    })
    updateWorkspaceStatus(ws.id, 'brainstorming')
    updateWorkspaceStatus(ws.id, 'executing')

    const orch = await import('../server/services/agent/orchestrator.js')
    const { startAgent, stopAgent } = orch
    startAgent(ws.id, '/tmp', 'hi')
    await Promise.resolve()
    await Promise.resolve()
    const cap = captured[0]
    if (!cap) throw new Error('no capture')
    cap.onEvent({ kind: 'session:started', engineSessionId: 'engine-sess-1' })
    cap.onEvent({
      kind: 'session:user-input-requested',
      requestKind: 'question',
      toolCallId: 'toolu_race',
      toolName: 'AskUserQuestion',
      payload: { questions: [] },
    })
    expect(getWorkspace(ws.id)?.status).toBe('awaiting-user')

    // stopAgent transitions awaiting-user → idle synchronously and removes the
    // controller from the map. The engine's stop() then resolves async and
    // emits session:ended — at which point onSessionEnded must NOT try to
    // transition idle → completed (which is invalid).
    stopAgent(ws.id)
    expect(getWorkspace(ws.id)?.status).toBe('idle')

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      cap.onEvent({ kind: 'session:ended', reason: 'killed', exitCode: null })

      const invalidTransitionLogged = errSpy.mock.calls.some((call) => {
        const msg = String(call[0] ?? '')
        return msg.includes('Failed to update workspace status on exit')
      })
      expect(invalidTransitionLogged).toBe(false)
      expect(getWorkspace(ws.id)?.status).toBe('idle')
    } finally {
      errSpy.mockRestore()
    }
  })
})
