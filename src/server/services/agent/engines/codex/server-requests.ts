import type { AgentEvent } from '../types.js'

export interface PendingApproval {
  requestId: number | string
  kind: 'command' | 'file_change' | 'user_input'
  payload: unknown
}

export interface HandleServerRequestArgs {
  requestId: number | string
  method: string
  params: unknown
  emit: (ev: AgentEvent) => void
  register: (callId: string, pending: PendingApproval) => void
  respond?: (id: number | string, result: unknown) => void
  autoApprove?: (toolName: string, payload: unknown) => boolean
  /**
   * Optional respondError hook used by `handleServerRequest` to immediately
   * decline server requests we cannot satisfy (e.g. MCP elicitation). Without
   * a response, Codex waits forever for a reply that never arrives.
   */
  respondError?: (id: number | string, code: number, message: string) => void
}

export function handleServerRequest(args: HandleServerRequestArgs): boolean {
  const { method, params, requestId, emit, register, respondError, respond, autoApprove } = args
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
    const payload = { command: p.command, cwd: p.cwd, reason: p.reason }
    if (autoApprove?.('Bash', payload)) {
      respond?.(requestId, { decision: 'accept' })
      return true
    }
    register(callId, { requestId, kind: 'command', payload: p })
    emit({
      kind: 'session:user-input-requested',
      requestKind: 'permission',
      toolCallId: callId,
      toolName: 'Bash',
      payload,
    })
    return true
  }

  if (method === 'item/fileChange/requestApproval' || method === 'applyPatchApproval') {
    const payload = { changes: p.changes, reason: p.reason }
    if (autoApprove?.('Edit', payload)) {
      respond?.(requestId, { decision: 'accept' })
      return true
    }
    register(callId, { requestId, kind: 'file_change', payload: p })
    emit({
      kind: 'session:user-input-requested',
      requestKind: 'permission',
      toolCallId: callId,
      toolName: 'Edit',
      payload,
    })
    return true
  }

  if (method === 'item/tool/requestUserInput') {
    register(callId, { requestId, kind: 'user_input', payload: p })
    // Codex allows a free-form question to omit `options` (or send null),
    // while the shared question panel always renders an array. Keep Codex's
    // `id` so the UI can return the protocol key instead of the display text.
    const questions = Array.isArray(p.questions)
      ? p.questions.map((question) => {
          if (!question || typeof question !== 'object') return question
          const raw = question as Record<string, unknown>
          return { ...raw, options: Array.isArray(raw.options) ? raw.options : [] }
        })
      : []
    emit({
      kind: 'session:user-input-requested',
      requestKind: 'question',
      toolCallId: callId,
      toolName: 'AskUserQuestion',
      payload: { questions, autoResolutionMs: p.autoResolutionMs },
    })
    return true
  }

  if (method === 'item/permissions/requestApproval') {
    // Kōbō doesn't model granular permission grants: the only answer we can
    // send is the empty grant (Codex then falls back to the turn policy), so
    // an Allow/Deny card would be a lie — "Allow" and "Deny" produced the
    // same decline. Answer immediately and keep the session moving.
    respond?.(requestId, { permissions: {}, scope: 'turn' })
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
 */
export function buildResponseForResolve(pending: PendingApproval, response: ResolveResponse): unknown {
  if (pending.kind === 'command' || pending.kind === 'file_change') {
    if (response.kind === 'permission-allow') return { decision: 'accept' }
    return { decision: 'decline' }
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
