import { nanoid } from 'nanoid'
import type { AgentEvent } from '../types.js'
import type {
  AgentMessageDeltaNotification,
  FileUpdateChange,
  ThreadItem,
  TurnCompletedNotification,
} from './protocol/types.js'

// ── QUOTA_PATTERN ─────────────────────────────────────────────────────────────
//
// Loose enough to catch wording drift across OpenAI/Codex quota messages.
// Patterns covered:
//   - "rate limit reached" / "rate_limit exceeded"
//   - "quota exceeded" / "insufficient_quota" / "insufficient quota"
//   - "out of extra usage" / "out of usage"
//   - "usage limit exceeded"

export const QUOTA_PATTERN = /rate[_ ]limit|quota|usage limit|insufficient[_ ]quota|out of (extra )?usage/i

// ── MapperState ───────────────────────────────────────────────────────────────

/** Mutable state carried across app-server notifications within the same turn. */
export interface MapperState {
  /** The thread_id from thread/start or thread/resume. */
  sessionId?: string
  /** Whether session:started has been emitted for the current session. */
  sessionStartedEmitted: boolean
  /**
   * Track open streaming agent_message items.
   * Maps scoped messageId → { sawText: boolean }.
   */
  openMessages: Map<string, { sawText: boolean }>
  /**
   * Set when any error was detected (turn failed, error event, error item, etc.).
   * Read by the engine after iterator drain to emit session:ended with reason='error'.
   */
  sawErrorResult: boolean
  /**
   * Set when the server reports `turn.status === 'interrupted'` without
   * throwing. Without this flag the engine would interpret a clean
   * interrupted-turn finish as `reason='completed'` because the iterator
   * resolves normally. Read alongside `sawErrorResult` to decide between
   * `'killed'` / `'error'` / `'completed'`.
   */
  sawTurnInterrupted: boolean
  /**
   * One-shot guard: prevents duplicate quota error events across multiple
   * surfaces in the same stream (message text, turn.failed, error items).
   */
  quotaErrorEmitted: boolean
  /**
   * Per-engine.start() unique prefix used to scope Codex item ids when emitting
   * messageIds / toolCallIds to the client. Codex numbers items per turn
   * (item_0, item_1, …) and reuses these ids across resumes — without a fresh
   * prefix per session every Kōbō turn after the first would emit item_0 and
   * the client store would silently dedupe.
   */
  sessionPrefix: string
}

export function createMapperState(opts?: { sessionPrefix?: string }): MapperState {
  return {
    sessionStartedEmitted: false,
    openMessages: new Map(),
    sawErrorResult: false,
    sawTurnInterrupted: false,
    quotaErrorEmitted: false,
    // Optional explicit prefix for deterministic testing; production code path
    // generates a fresh nanoid-based prefix per engine.start() call.
    sessionPrefix: opts?.sessionPrefix ?? `cdx_${nanoid(10)}`,
  }
}

// ── tryEmitQuota ──────────────────────────────────────────────────────────────

/**
 * Emit an error/quota event exactly once per stream, regardless of which
 * surface detected the quota condition. Also sets sawErrorResult so the engine
 * can surface session:ended with reason='error'.
 *
 * Exported so the engine's stderr path can share the same one-shot guard.
 */
export function tryEmitQuota(state: MapperState, emit: (ev: AgentEvent) => void, message: string): void {
  if (state.quotaErrorEmitted) return
  state.quotaErrorEmitted = true
  state.sawErrorResult = true
  emit({ kind: 'error', category: 'quota', message })
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/** Push-array variant of tryEmitQuota for use inside handler functions. */
function tryEmitQuotaInline(state: MapperState, events: AgentEvent[], message: string): void {
  tryEmitQuota(state, (ev) => events.push(ev), message)
}

/**
 * Scope item ids by a per-session prefix. Codex restarts item numbering
 * (item_0, item_1, …) on each resume, so a fresh prefix prevents the client
 * store from deduping the second turn's item_0 against the first.
 */
function scopedId(state: MapperState, itemId: string): string {
  return `${state.sessionPrefix}_${itemId}`
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Emit session:started exactly once for this session.
 * Idempotent — subsequent calls for the same threadId are no-ops.
 */
export function emitSessionStarted(threadId: string, state: MapperState): AgentEvent[] {
  if (state.sessionStartedEmitted) return []
  state.sessionStartedEmitted = true
  state.sessionId = threadId
  return [{ kind: 'session:started', engineSessionId: threadId }]
}

/**
 * Handle item/started notifications from the app-server.
 */
export function handleItemStarted(item: ThreadItem, state: MapperState): AgentEvent[] {
  const events: AgentEvent[] = []

  if (item.type === 'agentMessage') {
    const text = item.text ?? ''
    const messageId = scopedId(state, item.id)
    state.openMessages.set(messageId, { sawText: text.length > 0 })
    events.push({ kind: 'message:text', messageId, text, streaming: true })
    return events
  }

  if (item.type === 'commandExecution') {
    events.push({
      kind: 'tool:call',
      messageId: '',
      toolCallId: scopedId(state, item.id),
      name: 'Bash',
      input: { command: item.command },
    })
    return events
  }

  if (item.type === 'fileChange') {
    events.push({
      kind: 'tool:call',
      messageId: '',
      toolCallId: scopedId(state, item.id),
      name: 'Edit',
      input: codexFileChangeToInput(item.changes ?? []),
    })
    return events
  }

  if (item.type === 'mcpToolCall') {
    const name = `mcp__${item.server}__${item.tool}`
    events.push({
      kind: 'tool:call',
      messageId: '',
      toolCallId: scopedId(state, item.id),
      name,
      input: item.arguments,
    })
    return events
  }

  if (item.type === 'webSearch') {
    events.push({
      kind: 'tool:call',
      messageId: '',
      toolCallId: scopedId(state, item.id),
      name: 'WebSearch',
      input: { query: item.query },
    })
    return events
  }

  if (item.type === 'collabAgentToolCall') {
    const toolCallId = scopedId(state, item.id)
    events.push({
      kind: 'tool:call',
      messageId: '',
      toolCallId,
      name: 'Task',
      input: {
        codex_tool: item.tool,
        description: item.prompt ?? item.tool,
        prompt: item.prompt,
        model: item.model,
        sender_thread_id: item.senderThreadId,
        receiver_thread_ids: item.receiverThreadIds,
      },
    })
    events.push({
      kind: 'subagent:progress',
      toolCallId,
      status: 'running',
      description: item.prompt ?? item.tool,
      taskType: item.tool,
    })
    return events
  }

  if (item.type === 'dynamicToolCall') {
    const name = item.namespace ? `${item.namespace}__${item.tool}` : item.tool
    events.push({
      kind: 'tool:call',
      messageId: '',
      toolCallId: scopedId(state, item.id),
      name,
      input: item.arguments ?? {},
    })
    return events
  }

  if (item.type === 'imageView') {
    events.push({
      kind: 'tool:call',
      messageId: '',
      toolCallId: scopedId(state, item.id),
      name: 'Read',
      input: { file_path: item.path },
    })
    return events
  }

  if (item.type === 'imageGeneration') {
    events.push({
      kind: 'tool:call',
      messageId: '',
      toolCallId: scopedId(state, item.id),
      name: 'ImageGeneration',
      input: { revisedPrompt: item.revisedPrompt },
    })
    return events
  }

  if (item.type === 'enteredReviewMode' || item.type === 'exitedReviewMode') {
    const label = item.type === 'enteredReviewMode' ? 'review:start' : 'review:end'
    events.push({
      kind: 'message:thinking',
      messageId: scopedId(state, item.id),
      text: `[${label}] ${item.review}`,
    })
    return events
  }

  if (item.type === 'contextCompaction') {
    events.push({ kind: 'session:compacted' })
    return events
  }

  return events
}

/**
 * Handle item/completed notifications from the app-server.
 */
export function handleItemCompleted(item: ThreadItem, state: MapperState): AgentEvent[] {
  const events: AgentEvent[] = []

  if (item.type === 'agentMessage') {
    const text = item.text ?? ''
    const messageId = scopedId(state, item.id)
    const open = state.openMessages.get(messageId)
    // Skip the final emit when deltas already streamed the text — the client
    // accumulates per-delta and would double-append on a fresh push.
    const alreadyStreamed = open?.sawText === true
    if (!alreadyStreamed) {
      events.push({ kind: 'message:text', messageId, text, streaming: false })
    }
    if (text.includes('[BRAINSTORM_COMPLETE]')) {
      events.push({ kind: 'session:brainstorm-complete' })
    }
    if (QUOTA_PATTERN.test(text)) {
      tryEmitQuotaInline(state, events, text)
    }
    events.push({ kind: 'message:end', messageId })
    state.openMessages.delete(messageId)
    return events
  }

  if (item.type === 'reasoning') {
    const text = [...(item.summary ?? []), ...(item.content ?? [])].join('\n')
    events.push({ kind: 'message:thinking', messageId: scopedId(state, item.id), text })
    return events
  }

  if (item.type === 'commandExecution') {
    events.push({
      kind: 'tool:result',
      toolCallId: scopedId(state, item.id),
      output: { aggregated_output: item.aggregatedOutput ?? '', exit_code: item.exitCode },
      isError: item.status === 'failed',
    })
    return events
  }

  if (item.type === 'fileChange') {
    events.push({
      kind: 'tool:result',
      toolCallId: scopedId(state, item.id),
      output: { changes: item.changes ?? [], status: item.status },
      isError: item.status === 'failed',
    })
    return events
  }

  if (item.type === 'mcpToolCall') {
    events.push({
      kind: 'tool:result',
      toolCallId: scopedId(state, item.id),
      output: item.result ?? item.error ?? null,
      isError: item.status === 'failed',
    })
    return events
  }

  if (item.type === 'webSearch') {
    events.push({
      kind: 'tool:result',
      toolCallId: scopedId(state, item.id),
      output: { query: item.query },
      isError: false,
    })
    return events
  }

  if (item.type === 'collabAgentToolCall') {
    const toolCallId = scopedId(state, item.id)
    events.push({
      kind: 'tool:result',
      toolCallId,
      output: {
        codex_tool: item.tool,
        status: item.status,
        agents_states: item.agentsStates,
      },
      isError: item.status === 'failed',
    })
    events.push({
      kind: 'subagent:progress',
      toolCallId,
      status: 'done',
      description: item.prompt ?? item.tool,
      taskType: item.tool,
    })
    return events
  }

  if (item.type === 'dynamicToolCall') {
    events.push({
      kind: 'tool:result',
      toolCallId: scopedId(state, item.id),
      output: { contentItems: item.contentItems ?? [], success: item.success, durationMs: item.durationMs },
      isError: item.status === 'failed' || item.success === false,
    })
    return events
  }

  if (item.type === 'imageView') {
    events.push({
      kind: 'tool:result',
      toolCallId: scopedId(state, item.id),
      output: { file_path: item.path },
      isError: false,
    })
    return events
  }

  if (item.type === 'imageGeneration') {
    events.push({
      kind: 'tool:result',
      toolCallId: scopedId(state, item.id),
      output: { savedPath: item.savedPath, result: item.result, revisedPrompt: item.revisedPrompt },
      isError: false,
    })
    return events
  }

  if (item.type === 'plan') {
    // Codex's `plan` is a markdown blob, not a structured list — parse bullets.
    events.push({
      kind: 'tool:call',
      messageId: '',
      toolCallId: scopedId(state, item.id),
      name: 'TodoWrite',
      input: { todos: parseCodexPlanText(item.text) },
    })
    return events
  }

  if (item.type === 'error') {
    if (QUOTA_PATTERN.test(item.message)) {
      tryEmitQuotaInline(state, events, item.message)
    } else {
      state.sawErrorResult = true
      events.push({ kind: 'error', category: 'other', message: item.message })
    }
    return events
  }

  return events
}

/**
 * Map `item/agentMessage/delta` to a `message:text` increment.
 * Marks `sawText` so the eventual `item/completed` doesn't re-emit the full
 * text (the client accumulates per-delta — re-emit would double-append).
 */
export function handleAgentMessageDelta(delta: AgentMessageDeltaNotification, state: MapperState): AgentEvent[] {
  const messageId = scopedId(state, delta.itemId)
  if (delta.delta.length > 0) {
    const open = state.openMessages.get(messageId)
    if (open) {
      open.sawText = true
    } else {
      state.openMessages.set(messageId, { sawText: true })
    }
  }
  return [{ kind: 'message:text', messageId, text: delta.delta, streaming: true }]
}

/**
 * Handle `turn/completed`. Emits an `error` on `status=failed`, flags
 * `sawTurnInterrupted` on `status=interrupted`. Token usage arrives on the
 * separate `thread/tokenUsage/updated` notification.
 */
export function handleTurnCompleted(n: TurnCompletedNotification, state: MapperState): AgentEvent[] {
  const events: AgentEvent[] = []
  const { status, error } = n.turn
  if (status === 'failed') {
    const msg = error?.message ?? 'turn failed'
    if (QUOTA_PATTERN.test(msg)) {
      tryEmitQuotaInline(state, events, msg)
    } else {
      state.sawErrorResult = true
      events.push({ kind: 'error', category: 'other', message: msg })
    }
  } else if (status === 'interrupted') {
    // Engine reads this to emit `session:ended reason='killed'` when the
    // turn was interrupted server-side without throwing.
    state.sawTurnInterrupted = true
  }
  return events
}

/**
 * Shape of `account/rateLimits/updated` notification params (Codex v2).
 * `primary` / `secondary` windows: each has `usedPercent` (0-100) and an
 * optional unix-seconds `resetsAt`. `rateLimitReachedType` set means the
 * account hit a hard limit.
 */
interface RateLimitWindowPayload {
  usedPercent: number
  windowDurationMins: number | null
  resetsAt: number | null
}

interface RateLimitsUpdatedPayload {
  rateLimits: {
    limitId: string | null
    limitName: string | null
    primary: RateLimitWindowPayload | null
    secondary: RateLimitWindowPayload | null
    rateLimitReachedType: string | null
  }
}

/**
 * Map `account/rateLimits/updated` to a `rate_limit` AgentEvent for the
 * QuotaFooter. Translates Codex's unix-seconds `resetsAt` to ISO-8601.
 */
export function handleRateLimitsUpdated(payload: unknown, state: MapperState): AgentEvent[] {
  const p = payload as Partial<RateLimitsUpdatedPayload>
  const rl = p?.rateLimits
  if (!rl) return []

  const buckets: { id: string; label?: string; usedPct: number; resetsAt?: string }[] = []
  const toBucket = (id: 'primary' | 'secondary', win: RateLimitWindowPayload | null) => {
    if (!win) return
    const bucket: { id: string; label?: string; usedPct: number; resetsAt?: string } = {
      id,
      usedPct: Math.max(0, Math.min(100, win.usedPercent)),
    }
    if (rl.limitName) bucket.label = rl.limitName
    if (typeof win.resetsAt === 'number' && Number.isFinite(win.resetsAt)) {
      bucket.resetsAt = new Date(win.resetsAt * 1000).toISOString()
    }
    buckets.push(bucket)
  }
  toBucket('primary', rl.primary ?? null)
  toBucket('secondary', rl.secondary ?? null)
  if (buckets.length === 0) return []

  const reached = typeof rl.rateLimitReachedType === 'string' && rl.rateLimitReachedType.length > 0
  const maxPct = Math.max(...buckets.map((b) => b.usedPct))
  const status: 'allowed' | 'allowed_warning' | 'rejected' = reached
    ? 'rejected'
    : maxPct >= 80
      ? 'allowed_warning'
      : 'allowed'

  const events: AgentEvent[] = [{ kind: 'rate_limit', info: { buckets, status } }]

  if (reached) {
    tryEmitQuotaInline(state, events, `Codex rate limit reached: ${rl.rateLimitReachedType}`)
  }
  return events
}

// ── FileChange normalisation ──────────────────────────────────────────────────

/**
 * Normalise Codex's `fileChange` to the Claude-style `tool:call` input the
 * renderer expects (`file_path` + unified `diff`). Without `file_path` the
 * UI falls back to dumping raw JSON.
 */
export function codexFileChangeToInput(changes: FileUpdateChange[]): Record<string, unknown> {
  if (changes.length === 0) {
    return { file_path: '', diff: '', changes: [] }
  }
  const first = changes[0]
  const kind = first.kind.type
  const movePath = first.kind.type === 'update' ? first.kind.move_path : null
  return {
    file_path: first.path,
    diff: first.diff,
    change_kind: kind,
    ...(movePath != null ? { move_path: movePath } : {}),
    changes,
  }
}

// ── Plan parsing ──────────────────────────────────────────────────────────────

const BULLET_LINE = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/
const HEADING_LINE = /^\s*#{1,6}\s/

/**
 * Split a markdown `plan` blob into individual todo items.
 * Bullets (`-`, `*`, `+`, `1.`, `1)`) become items; headings are dropped;
 * untagged continuation lines fold into the previous item.
 */
export function parseCodexPlanText(text: string): Array<{ content: string; status: 'pending' }> {
  const lines = text.split('\n')
  const items: string[] = []
  let current: string | null = null

  const flush = () => {
    if (current != null) {
      const trimmed = current.trim()
      if (trimmed.length > 0) items.push(trimmed)
      current = null
    }
  }

  for (const raw of lines) {
    if (HEADING_LINE.test(raw)) {
      flush()
      continue
    }
    const match = raw.match(BULLET_LINE)
    if (match) {
      flush()
      current = match[1].trim()
      continue
    }
    if (current != null) {
      const cont = raw.trim()
      current = cont.length > 0 ? `${current} ${cont}` : current
    }
  }
  flush()

  if (items.length === 0) {
    const trimmed = text.trim()
    if (trimmed.length === 0) return []
    return [{ content: trimmed, status: 'pending' }]
  }

  return items.map((content) => ({ content, status: 'pending' }))
}
