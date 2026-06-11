import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { AgentEvent, RateLimitBucket, RateLimitInfo } from '../types.js'

// ── Helpers ───────────────────────────────────────────────────────────────────
// `rate_limit_info` is shaped for claude.ai subscriptions and may evolve.
// Keep the defensive normalisation so a schema bump doesn't drop bucket info.

function normalizeResetsAt(raw: unknown): string | undefined {
  if (typeof raw === 'string' && raw.length > 0) return raw
  if (typeof raw === 'number' && Number.isFinite(raw)) return new Date(raw * 1000).toISOString()
  return undefined
}

function extractUsedPct(source: Record<string, unknown>): number | null {
  const raw = (source.utilization ?? source.used_percent ?? source.percent_used ?? source.usedPct) as unknown
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw <= 1 ? raw * 100 : raw
  const used = source.used ?? source.current ?? source.spent
  const limit = source.limit ?? source.max ?? source.allowed
  if (typeof used === 'number' && typeof limit === 'number' && limit > 0) return (used / limit) * 100
  return null
}

function makeBucket(id: string, source: Record<string, unknown>): RateLimitBucket | null {
  const usedPct = extractUsedPct(source) ?? (source.__fallbackPct as number | undefined) ?? null
  if (usedPct === null) return null
  const resetsAt = normalizeResetsAt(source.resets_at ?? source.reset_at ?? source.resetsAt ?? source.resetAt)
  const label = (typeof source.label === 'string' && source.label) || undefined
  const used = source.used ?? source.current ?? source.spent
  const limit = source.limit ?? source.max ?? source.allowed
  const details = used !== undefined && limit !== undefined ? `${String(used)} / ${String(limit)}` : undefined
  return { id, label, usedPct: Math.max(0, Math.min(100, usedPct)), resetsAt, details }
}

const RATE_LIMIT_STATUSES = new Set(['allowed', 'allowed_warning', 'rejected'])

function extractStatus(info: Record<string, unknown>): RateLimitInfo['status'] {
  const raw = info.status
  if (typeof raw === 'string' && RATE_LIMIT_STATUSES.has(raw)) {
    return raw as RateLimitInfo['status']
  }
  return undefined
}

function normalizeRateLimitInfo(info: Record<string, unknown>): RateLimitInfo {
  const buckets: RateLimitBucket[] = []
  if (typeof info.rateLimitType === 'string') {
    const b = makeBucket(info.rateLimitType, { ...info, __fallbackPct: 0 })
    if (b) buckets.push(b)
  }
  if (Array.isArray(info.buckets)) {
    for (const entry of info.buckets) {
      if (!entry || typeof entry !== 'object') continue
      const obj = entry as Record<string, unknown>
      const id =
        (typeof obj.id === 'string' && obj.id) ||
        (typeof obj.name === 'string' && obj.name) ||
        (typeof obj.rateLimitType === 'string' && obj.rateLimitType) ||
        'unknown'
      const b = makeBucket(id, obj)
      if (b) buckets.push(b)
    }
  }
  const status = extractStatus(info)
  return status ? { buckets, status } : { buckets }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Canonical "out of quota" surfaces from the Claude SDK and CLI. Centralised
 * so the three call-sites stay in sync:
 *  - `result` events with an error subtype (`parsed.error` / `parsed.result`)
 *  - assistant `message:text` blocks (the SDK occasionally streams the user-
 *    visible quota notice as plain assistant text instead of a structured
 *    error result; see workspace `-GyiAYM7X4xTWyZbcHGiR` session #25 for the
 *    repro that motivated this path)
 *  - CLI stderr in `engine.ts`
 *
 * Patterns are kept loose on purpose to absorb minor wording drift between
 * Anthropic's surfaces (`rate_limit_exceeded`, `Claude AI usage limit
 * reached`, `You're out of extra usage`, `quota exceeded`).
 */
export const QUOTA_PATTERN = /out of extra usage|rate[_ ]limit|usage limit|quota exceeded/i

/** Mutable state carried across SDK messages within the same stream. */
export interface MapperState {
  /** The last known engine session_id, to feed session:started once. */
  sessionId?: string
  /** Whether session:started has been emitted for the current session. */
  sessionStartedEmitted: boolean
  /** Track streaming text messages: messageId → seenTextOnce (for `streaming` flag). */
  openMessages: Map<string, { sawText: boolean }>
  /**
   * Set when a `result` message with an error subtype was observed, or when
   * a quota notice was detected in assistant text. Read by the engine after
   * the iterator drains so the natural-completion `session:ended` carries
   * `reason: 'error'` instead of `'completed'`.
   */
  sawErrorResult: boolean
  /**
   * One-shot guard: a single SDK run can stream the quota text repeatedly
   * (e.g. on each subsequent assistant turn before termination). Without
   * this, the orchestrator would receive duplicate `error/quota` events and
   * arm the backoff multiple times.
   */
  quotaErrorEmitted: boolean
  /**
   * Set by the engine's `interrupt()` when the user soft-interrupts the run.
   * The SDK ends an interrupted run by emitting a `result` with subtype
   * `error_during_execution` through the *normal* iterator (no throw), so
   * the catch-block abort guard never sees it. This flag lets the result
   * handler recognise that subtype as a clean stop instead of a failure.
   */
  userInterrupted: boolean
}

export function createMapperState(): MapperState {
  return {
    sessionStartedEmitted: false,
    openMessages: new Map(),
    sawErrorResult: false,
    quotaErrorEmitted: false,
    userInterrupted: false,
  }
}

/** Known SDK `result` subtypes that indicate the run failed. */
export const KNOWN_ERROR_RESULT_SUBTYPES = new Set(['error_max_turns', 'error_during_execution'])

function isErrorResultSubtype(subtype: string | undefined): boolean {
  if (!subtype) return false
  if (KNOWN_ERROR_RESULT_SUBTYPES.has(subtype)) return true
  return subtype.startsWith('error')
}

/**
 * SDK error codes (`SDKAssistantMessageError`) that map to a quota exhaustion
 * — the user has hit the 5h/7d cap or run out of overage credits.
 *  - `'rate_limit'`: classic 429 / Anthropic rate-limit reached
 *  - `'billing_error'`: claude.ai overage credits exhausted
 */
export const QUOTA_ASSISTANT_ERRORS = new Set(['rate_limit', 'billing_error'])

/**
 * Emit an `error/quota` event exactly once per SDK run, regardless of which
 * surface detected the quota (stderr, SDK iterator, message:text fallback…).
 * Also sets `sawErrorResult` so the engine surfaces
 * `session:ended.reason='error'`, which the orchestrator then maps to a
 * `quota` status transition via the `category: 'quota'` discriminator.
 *
 * Exported so the stderr path in `engine.ts` (which bypasses `mapSdkMessage`)
 * can share the same one-shot guard. Without this, two quota surfaces in the
 * same run would call `handleQuota` twice → `retryCount` doubled and the
 * persisted backoff row overwritten.
 */
export function tryEmitQuota(state: MapperState, emit: (ev: AgentEvent) => void, message: string): void {
  if (state.quotaErrorEmitted) return
  state.quotaErrorEmitted = true
  state.sawErrorResult = true
  emit({ kind: 'error', category: 'quota', message })
}

/** Internal wrapper for the in-mapper push pattern. */
function tryEmitQuotaError(state: MapperState, events: AgentEvent[], message: string): void {
  tryEmitQuota(state, (ev) => events.push(ev), message)
}

/**
 * Maps a single typed `SDKMessage` to zero or more `AgentEvent`s, mutating
 * `state` as needed.
 */
export function mapSdkMessage(msg: SDKMessage, state: MapperState): AgentEvent[] {
  // Treat as a generic record — the SDK discriminated union is too broad to
  // narrow per branch here.
  const parsed = msg as unknown as Record<string, unknown>
  const type = parsed.type as string | undefined
  const subtype = parsed.subtype as string | undefined
  const sessionId = typeof parsed.session_id === 'string' ? parsed.session_id : undefined
  const events: AgentEvent[] = []

  // Rate-limit events are top-level in the SDK (no longer nested under `system`).
  if (type === 'rate_limit_event') {
    const info = parsed.rate_limit_info
    if (info && typeof info === 'object') {
      const normalized = normalizeRateLimitInfo(info as Record<string, unknown>)
      events.push({ kind: 'rate_limit', info: normalized })
      // `status: 'rejected'` from the SDK is the explicit "request blocked,
      // out of quota" signal — the most reliable structured surface.
      if (normalized.status === 'rejected') {
        tryEmitQuotaError(state, events, 'Rate limit rejected by Claude SDK (rate_limit_event)')
      }
    }
    return events
  }

  if (type === 'system') {
    if (subtype === 'compact' || subtype === 'compact_boundary') {
      events.push({ kind: 'session:compacted' })
      return events
    }
    // Live status message: the SDK announces it is compacting context before the
    // (slow) `compact_boundary` lands. Surface it as a transient indicator so the
    // UI can tell the user "compacting…" instead of looking frozen.
    if (subtype === 'status') {
      const sdkStatus = typeof parsed.status === 'string' ? (parsed.status as string) : null
      events.push({ kind: 'session:compacting', active: sdkStatus === 'compacting' })
      return events
    }
    if (subtype === 'task_started' || subtype === 'task_progress' || subtype === 'task_notification') {
      const toolCallId = typeof parsed.tool_use_id === 'string' ? (parsed.tool_use_id as string) : undefined
      if (toolCallId) {
        const usage = parsed.usage as Record<string, unknown> | undefined
        const taskStatus = typeof parsed.status === 'string' ? (parsed.status as string) : undefined
        const isDone =
          subtype === 'task_notification' &&
          taskStatus !== undefined &&
          ['completed', 'stopped', 'failed', 'cancelled'].includes(taskStatus)
        events.push({
          kind: 'subagent:progress',
          toolCallId,
          status: isDone ? 'done' : 'running',
          description: typeof parsed.description === 'string' ? (parsed.description as string) : undefined,
          taskType: typeof parsed.task_type === 'string' ? (parsed.task_type as string) : undefined,
          lastToolName: typeof parsed.last_tool_name === 'string' ? (parsed.last_tool_name as string) : undefined,
          totalTokens: typeof usage?.total_tokens === 'number' ? (usage.total_tokens as number) : undefined,
          toolUses: typeof usage?.tool_uses === 'number' ? (usage.tool_uses as number) : undefined,
          durationMs: typeof usage?.duration_ms === 'number' ? (usage.duration_ms as number) : undefined,
        })
      }
      return events
    }
    if (subtype === 'init') {
      if (sessionId && (!state.sessionStartedEmitted || state.sessionId !== sessionId)) {
        events.push({
          kind: 'session:started',
          engineSessionId: sessionId,
          model: typeof parsed.model === 'string' ? parsed.model : undefined,
        })
        state.sessionStartedEmitted = true
        state.sessionId = sessionId
      }
      if (Array.isArray(parsed.slash_commands) && parsed.slash_commands.length > 0) {
        events.push({ kind: 'skills:discovered', skills: parsed.slash_commands as string[] })
      }
      return events
    }
    return events
  }

  if (type === 'assistant') {
    // `SDKAssistantMessage.error` is a typed enum that includes 'rate_limit'
    // and 'billing_error' — explicit, structured quota signals. Surface them
    // before any text processing so the orchestrator transitions to `quota`
    // even on otherwise empty assistant turns.
    const assistantError = typeof parsed.error === 'string' ? (parsed.error as string) : undefined
    if (assistantError && QUOTA_ASSISTANT_ERRORS.has(assistantError)) {
      tryEmitQuotaError(state, events, `Assistant message error: ${assistantError}`)
    }

    const message = parsed.message as Record<string, unknown> | undefined
    const messageId = typeof message?.id === 'string' ? (message.id as string) : 'unknown'
    const content = Array.isArray(message?.content) ? (message?.content as Record<string, unknown>[]) : []

    // SDK runs sometimes finish implicitly when the next turn begins. Close
    // stale openMessages so the UI's streaming spinner doesn't hang.
    for (const openId of Array.from(state.openMessages.keys())) {
      if (openId !== messageId) {
        events.push({ kind: 'message:end', messageId: openId })
        state.openMessages.delete(openId)
      }
    }

    if (!state.openMessages.has(messageId)) {
      state.openMessages.set(messageId, { sawText: false })
    }
    const msgState = state.openMessages.get(messageId)
    if (!msgState) return events

    for (const block of content) {
      const blockType = block.type as string | undefined
      if (blockType === 'text' && typeof block.text === 'string') {
        const text = block.text as string
        events.push({ kind: 'message:text', messageId, text, streaming: true })
        msgState.sawText = true
        if (text.includes('[BRAINSTORM_COMPLETE]')) {
          events.push({ kind: 'session:brainstorm-complete' })
        }
        // Last-resort fallback: some SDK runs surface the quota notice as
        // plain assistant text without setting `assistant.error` or a
        // `result.error`. The structured signals above cover modern SDK
        // versions; this regex absorbs older or drifted wordings.
        if (QUOTA_PATTERN.test(text)) {
          tryEmitQuotaError(state, events, text)
        }
      }
      if (blockType === 'tool_use') {
        events.push({
          kind: 'tool:call',
          messageId,
          toolCallId: typeof block.id === 'string' ? (block.id as string) : 'unknown',
          name: typeof block.name === 'string' ? (block.name as string) : 'unknown',
          input: block.input ?? {},
        })
      }
      if (blockType === 'thinking') {
        events.push({
          kind: 'message:thinking',
          messageId,
          text: typeof block.thinking === 'string' ? (block.thinking as string) : '',
        })
      }
    }

    // Only terminal turns carry non-null `stop_reason`; intermediate deltas
    // have `null` and must NOT trigger message:end.
    const stopReason = (message as { stop_reason?: unknown } | undefined)?.stop_reason
    const isStop = parsed.message_stop === true || (stopReason !== undefined && stopReason !== null)
    if (isStop) {
      events.push({ kind: 'message:end', messageId })
      state.openMessages.delete(messageId)
    }

    return events
  }

  if (type === 'user') {
    const message = parsed.message as Record<string, unknown> | undefined
    const content = Array.isArray(message?.content) ? (message?.content as Record<string, unknown>[]) : []
    for (const block of content) {
      if (block.type === 'tool_result') {
        events.push({
          kind: 'tool:result',
          toolCallId: typeof block.tool_use_id === 'string' ? (block.tool_use_id as string) : 'unknown',
          output: block.content ?? null,
          isError: block.is_error === true,
        })
      }
    }
    return events
  }

  if (type === 'result') {
    // Terminal event — close any still-streaming messages.
    for (const openId of Array.from(state.openMessages.keys())) {
      events.push({ kind: 'message:end', messageId: openId })
      state.openMessages.delete(openId)
    }
    // Detect error variants of `result` (e.g. `error_max_turns`,
    // `error_during_execution`) and surface them as a proper `error` event so
    // the orchestrator can transition the workspace to `error` instead of
    // `completed`. The flag on `state` lets the engine override the
    // post-loop session:ended reason.
    // A user soft-interrupt ends the run with `error_during_execution`
    // through this normal iterator path. That is a clean stop, not a
    // failure — skip the error event so the UI shows no red banner and the
    // workspace is not pushed into `error`.
    const isInterruptedStop = state.userInterrupted && subtype === 'error_during_execution'
    if (isErrorResultSubtype(subtype) && !isInterruptedStop) {
      state.sawErrorResult = true
      const detail =
        (typeof parsed.error === 'string' && parsed.error) || (typeof parsed.result === 'string' && parsed.result) || ''
      const isQuota = QUOTA_PATTERN.test(detail)
      const message = detail ? `Agent run failed (${subtype}): ${detail}` : `Agent run failed (${subtype})`
      if (isQuota) {
        // Coordinate with the structured quota path so we never emit twice.
        tryEmitQuotaError(state, events, message)
      } else {
        events.push({ kind: 'error', category: 'other', message })
      }
    }
    const usage = parsed.usage as Record<string, unknown> | undefined
    if (usage) {
      const costUsd = typeof parsed.total_cost_usd === 'number' ? (parsed.total_cost_usd as number) : undefined
      events.push({
        kind: 'usage',
        inputTokens: Number((usage.input_tokens as number | undefined) ?? 0),
        outputTokens: Number((usage.output_tokens as number | undefined) ?? 0),
        cacheRead:
          typeof usage.cache_read_input_tokens === 'number' ? (usage.cache_read_input_tokens as number) : undefined,
        cacheWrite:
          typeof usage.cache_creation_input_tokens === 'number'
            ? (usage.cache_creation_input_tokens as number)
            : undefined,
        costUsd,
      })
    }
    return events
  }

  return events
}
