import { describe, expect, it, vi } from 'vitest'
import {
  buildResponseForResolve,
  handleServerRequest,
  type PendingApproval,
} from '../../server/services/agent/engines/codex/server-requests.js'
import type { AgentEvent } from '../../server/services/agent/engines/types.js'

function makeArgs(method: string, params: unknown, requestId: number | string = 1) {
  const emitted: AgentEvent[] = []
  const registered: Array<{ callId: string; pending: PendingApproval }> = []
  const emit = vi.fn((ev: AgentEvent) => emitted.push(ev))
  const register = vi.fn((callId: string, pending: PendingApproval) => registered.push({ callId, pending }))
  return { emit, register, emitted, registered, requestId, method, params }
}

// ── 1. item/commandExecution/requestApproval ──────────────────────────────────

describe('handleServerRequest — item/commandExecution/requestApproval', () => {
  it('emits session:user-input-requested with requestKind=permission, toolName=Bash', () => {
    const { emit, register, emitted, registered, method, params, requestId } = makeArgs(
      'item/commandExecution/requestApproval',
      { command: 'rm -rf /tmp/test', cwd: '/home/user', reason: 'cleanup' },
    )
    const result = handleServerRequest({ requestId, method, params, emit, register })
    expect(result).toBe(true)
    expect(emitted).toHaveLength(1)
    expect(emitted[0]).toMatchObject({
      kind: 'session:user-input-requested',
      requestKind: 'permission',
      toolName: 'Bash',
      payload: { command: 'rm -rf /tmp/test', cwd: '/home/user', reason: 'cleanup' },
    })
    expect(registered).toHaveLength(1)
    expect(registered[0].pending.kind).toBe('command')
  })

  it('uses callId from params when present', () => {
    const { emit, register, emitted, method, params, requestId } = makeArgs('item/commandExecution/requestApproval', {
      callId: 'my-call-id',
      command: 'ls',
    })
    handleServerRequest({ requestId, method, params, emit, register })
    expect((emitted[0] as Extract<AgentEvent, { kind: 'session:user-input-requested' }>).toolCallId).toBe('my-call-id')
  })

  it('falls back to srv_{requestId} when callId is absent', () => {
    const { emit, register, emitted, method, params, requestId } = makeArgs(
      'item/commandExecution/requestApproval',
      { command: 'ls' },
      42,
    )
    handleServerRequest({ requestId, method, params, emit, register })
    expect((emitted[0] as Extract<AgentEvent, { kind: 'session:user-input-requested' }>).toolCallId).toBe('srv_42')
  })
})

// ── 2. item/fileChange/requestApproval ────────────────────────────────────────

describe('handleServerRequest — item/fileChange/requestApproval', () => {
  it('emits session:user-input-requested with toolName=Edit, kind=file_change', () => {
    const { emit, register, emitted, registered, method, params, requestId } = makeArgs(
      'item/fileChange/requestApproval',
      { changes: [{ path: 'foo.ts', diff: '+x' }], reason: 'refactor' },
    )
    const result = handleServerRequest({ requestId, method, params, emit, register })
    expect(result).toBe(true)
    expect(emitted[0]).toMatchObject({
      kind: 'session:user-input-requested',
      requestKind: 'permission',
      toolName: 'Edit',
      payload: { changes: [{ path: 'foo.ts', diff: '+x' }], reason: 'refactor' },
    })
    expect(registered[0].pending.kind).toBe('file_change')
  })
})

// ── 3. item/tool/requestUserInput ─────────────────────────────────────────────

describe('handleServerRequest — item/tool/requestUserInput', () => {
  it('emits session:user-input-requested with requestKind=question, toolName=AskUserQuestion', () => {
    const { emit, register, emitted, registered, method, params, requestId } = makeArgs('item/tool/requestUserInput', {
      questions: [{ id: 'q1', text: 'What is your name?' }],
    })
    const result = handleServerRequest({ requestId, method, params, emit, register })
    expect(result).toBe(true)
    expect(emitted[0]).toMatchObject({
      kind: 'session:user-input-requested',
      requestKind: 'question',
      toolName: 'AskUserQuestion',
      payload: { questions: [{ id: 'q1', text: 'What is your name?' }] },
    })
    expect(registered[0].pending.kind).toBe('user_input')
  })
})

// ── 4. item/permissions/requestApproval ───────────────────────────────────────

describe('handleServerRequest — item/permissions/requestApproval', () => {
  it('emits session:user-input-requested with toolName=Permissions, kind=permissions', () => {
    const { emit, register, emitted, registered, method, params, requestId } = makeArgs(
      'item/permissions/requestApproval',
      { scope: 'filesystem', paths: ['/tmp'] },
    )
    const result = handleServerRequest({ requestId, method, params, emit, register })
    expect(result).toBe(true)
    expect(emitted[0]).toMatchObject({
      kind: 'session:user-input-requested',
      requestKind: 'permission',
      toolName: 'Permissions',
    })
    expect(registered[0].pending.kind).toBe('permissions')
  })
})

// ── 5. Unknown method ─────────────────────────────────────────────────────────

describe('handleServerRequest — unknown method', () => {
  it('returns false and does not call emit or register', () => {
    const { emit, register, method, params, requestId } = makeArgs('item/unknown/method', {})
    const result = handleServerRequest({ requestId, method, params, emit, register })
    expect(result).toBe(false)
    expect(emit).not.toHaveBeenCalled()
    expect(register).not.toHaveBeenCalled()
  })
})

// ── 6. buildResponseForResolve — command + permission-allow ───────────────────

describe('buildResponseForResolve — command + permission-allow', () => {
  it('returns { decision: "accept" } (Codex v2 protocol enum)', () => {
    const pending: PendingApproval = { requestId: 1, kind: 'command', payload: {} }
    const result = buildResponseForResolve(pending, { kind: 'permission-allow' })
    expect(result).toEqual({ decision: 'accept' })
  })
})

// ── 7. buildResponseForResolve — command + permission-deny ────────────────────

describe('buildResponseForResolve — command + permission-deny', () => {
  it('returns { decision: "decline" } (Codex v2 protocol enum)', () => {
    const pending: PendingApproval = { requestId: 1, kind: 'command', payload: {} }
    const result = buildResponseForResolve(pending, { kind: 'permission-deny', reason: 'not allowed' })
    expect(result).toEqual({ decision: 'decline' })
  })
})

// ── 8. buildResponseForResolve — user_input + question ───────────────────────

describe('buildResponseForResolve — user_input + question', () => {
  it('returns { answers: { q1: { answers: ["x"] } } }', () => {
    const pending: PendingApproval = { requestId: 2, kind: 'user_input', payload: {} }
    const result = buildResponseForResolve(pending, { kind: 'question', answers: { q1: 'x' } })
    expect(result).toEqual({ answers: { q1: { answers: ['x'] } } })
  })
})

// ── 9. buildResponseForResolve — user_input + question-cancel ────────────────

describe('buildResponseForResolve — user_input + question-cancel', () => {
  it('returns { answers: {} }', () => {
    const pending: PendingApproval = { requestId: 2, kind: 'user_input', payload: {} }
    const result = buildResponseForResolve(pending, { kind: 'question-cancel' })
    expect(result).toEqual({ answers: {} })
  })
})

// ── 10. buildResponseForResolve — file_change + permission-allow ──────────────

describe('buildResponseForResolve — file_change + permission-allow', () => {
  it('returns { decision: "accept" } (Codex v2 protocol enum)', () => {
    const pending: PendingApproval = { requestId: 3, kind: 'file_change', payload: {} }
    const result = buildResponseForResolve(pending, { kind: 'permission-allow' })
    expect(result).toEqual({ decision: 'accept' })
  })
})

// ── 11. buildResponseForResolve — permissions has a different response shape ─

describe('buildResponseForResolve — permissions', () => {
  it('returns { permissions: {}, scope: "turn" } (PermissionsRequestApprovalResponse shape, no decision field)', () => {
    const pending: PendingApproval = { requestId: 4, kind: 'permissions', payload: {} }
    const result = buildResponseForResolve(pending, { kind: 'permission-allow' })
    expect(result).toEqual({ permissions: {}, scope: 'turn' })
  })
})
