import type { AgentEvent } from '../types.js'

export interface PendingApproval {
  requestId: number | string
  kind: 'command' | 'file_change' | 'user_input' | 'permissions'
  payload: unknown
}

export interface HandleServerRequestArgs {
  requestId: number | string
  method: string
  params: unknown
  emit: (ev: AgentEvent) => void
  register: (callId: string, pending: PendingApproval) => void
  /**
   * Optional respondError hook used by `handleServerRequest` to immediately
   * decline server requests we cannot satisfy (e.g. MCP elicitation). Without
   * a response, Codex waits forever for a reply that never arrives.
   */
  respondError?: (id: number | string, code: number, message: string) => void
}

export function handleServerRequest(args: HandleServerRequestArgs): boolean {
  const { method, params, requestId, emit, register, respondError } = args
  const p = (params ?? {}) as Record<string, unknown>
  const callId = typeof p.callId === 'string' ? p.callId : `srv_${requestId}`

  if (method === 'mcpServer/elicitation/request') {
    // Codex asks an external MCP server's elicitation prompt to be surfaced to
    // the user. Kōbō doesn't model MCP elicitations yet — respond with a
    // JSON-RPC "method not supported" error so the server doesn't block.
    respondError?.(requestId, -32601, 'MCP elicitations not supported by this client')
    return true
  }

  // v2 and v1 method aliases for the same approval semantics. v1 legacy names
  // (`execCommandApproval`, `applyPatchApproval`) are kept for compat with
  // older Codex CLI builds that haven't transitioned to the v2 namespace.
  if (method === 'item/commandExecution/requestApproval' || method === 'execCommandApproval') {
    register(callId, { requestId, kind: 'command', payload: p })
    emit({
      kind: 'session:user-input-requested',
      requestKind: 'permission',
      toolCallId: callId,
      toolName: 'Bash',
      payload: { command: p.command, cwd: p.cwd, reason: p.reason },
    })
    return true
  }

  if (method === 'item/fileChange/requestApproval' || method === 'applyPatchApproval') {
    register(callId, { requestId, kind: 'file_change', payload: p })
    emit({
      kind: 'session:user-input-requested',
      requestKind: 'permission',
      toolCallId: callId,
      toolName: 'Edit',
      payload: { changes: p.changes, reason: p.reason },
    })
    return true
  }

  if (method === 'item/tool/requestUserInput') {
    register(callId, { requestId, kind: 'user_input', payload: p })
    emit({
      kind: 'session:user-input-requested',
      requestKind: 'question',
      toolCallId: callId,
      toolName: 'AskUserQuestion',
      payload: { questions: p.questions },
    })
    return true
  }

  if (method === 'item/permissions/requestApproval') {
    register(callId, { requestId, kind: 'permissions', payload: p })
    emit({
      kind: 'session:user-input-requested',
      requestKind: 'permission',
      toolCallId: callId,
      toolName: 'Permissions',
      payload: p,
    })
    return true
  }

  return false // unknown method
}

export type ResolveResponse =
  | { kind: 'permission-allow' }
  | { kind: 'permission-deny'; reason?: string }
  | { kind: 'question'; answers: Record<string, string> }
  | { kind: 'question-cancel'; reason?: string }

/**
 * Build the JSON-RPC response Codex expects for a given pending request.
 *
 * Decision enum values come from
 * `codex-rs/protocol/src/approvals.rs:CommandExecutionApprovalDecision`
 * (and the matching `FileChangeApprovalDecision`): `'accept' | 'acceptForSession' | 'decline' | 'cancel'`.
 * NOT `'approve' / 'reject'` — those would be silently rejected as unknown
 * variants, which breaks the strict and interactive permission modes.
 *
 * `PermissionsRequestApprovalResponse` has a completely different shape:
 * `{ permissions, scope, strictAutoReview? }` — no `decision` field. Since
 * Kōbō doesn't yet model permission grants, we deny the request by sending
 * an empty permissions response. A future iteration could add a UI for
 * granular permission grants.
 */
export function buildResponseForResolve(pending: PendingApproval, response: ResolveResponse): unknown {
  if (pending.kind === 'command' || pending.kind === 'file_change') {
    if (response.kind === 'permission-allow') return { decision: 'accept' }
    return { decision: 'decline' }
  }
  if (pending.kind === 'permissions') {
    // Codex's PermissionsRequestApprovalResponse shape — not { decision }.
    // We don't yet model granular permission grants, so deny by returning an
    // empty permissions object; Codex falls back to the existing turn policy.
    return { permissions: {}, scope: 'turn' }
  }
  if (pending.kind === 'user_input') {
    if (response.kind === 'question') {
      const answers: Record<string, { answers: string[] }> = {}
      for (const [qid, val] of Object.entries(response.answers)) {
        answers[qid] = { answers: [val] }
      }
      return { answers }
    }
    return { answers: {} }
  }
  return null
}
