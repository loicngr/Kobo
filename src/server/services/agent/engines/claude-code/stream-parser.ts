import type { AgentEvent, RateLimitBucket, RateLimitInfo } from '../types.js'

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
  return { buckets }
}

/** Mutable state carried across lines for the same stream. */
export interface ParserState {
  /** The last known Claude session_id, to feed session:started once. */
  sessionId?: string
  /** Whether session:started has been emitted for the current session. */
  sessionStartedEmitted: boolean
  /** Track streaming text messages: messageId → seenTextOnce (for `streaming` flag). */
  openMessages: Map<string, { sawText: boolean }>
}

export function createParserState(): ParserState {
  return { sessionStartedEmitted: false, openMessages: new Map() }
}

export interface ParseResult {
  events: AgentEvent[]
  state: ParserState
}

export function parseClaudeLine(line: string, state: ParserState): ParseResult {
  const trimmed = line.trim()
  if (!trimmed) return { events: [], state }

  // The marker can appear as a raw stdout line OR inside an assistant text block.
  // We detect it in the raw line first so even unparseable lines that contain it
  // still emit the signal. The assistant-branch handling below catches the
  // structured case.
  const markerDetected = trimmed.includes('[BRAINSTORM_COMPLETE]')

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    const events: AgentEvent[] = [{ kind: 'message:raw', content: line }]
    if (markerDetected) events.push({ kind: 'session:brainstorm-complete' })
    return { events, state }
  }

  const events: AgentEvent[] = []
  const type = parsed.type as string | undefined
  const subtype = parsed.subtype as string | undefined
  const sessionId = typeof parsed.session_id === 'string' ? parsed.session_id : undefined

  if (type === 'system') {
    if (subtype === 'compact' || subtype === 'compact_boundary') {
      events.push({ kind: 'session:compacted' })
      return { events, state }
    }
    if (subtype === 'rate_limit_event') {
      const info = parsed.rate_limit_info
      if (info && typeof info === 'object') {
        events.push({ kind: 'rate_limit', info: normalizeRateLimitInfo(info as Record<string, unknown>) })
      }
      return { events, state }
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
      return { events, state }
    }
  }

  if (type === 'system' && subtype === 'init') {
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
    return { events, state }
  }

  if (type === 'assistant') {
    const message = parsed.message as Record<string, unknown> | undefined
    const messageId = typeof message?.id === 'string' ? (message.id as string) : 'unknown'
    const content = Array.isArray(message?.content) ? (message?.content as Record<string, unknown>[]) : []

    // A new messageId arriving means any previously-open message is done.
    // Claude CLI's stream-json output doesn't always carry an explicit
    // `stop_reason` or `message_stop` on the last chunk; some runs finish
    // implicitly when the next turn begins. Close stale openMessages here
    // so the UI's streaming spinner doesn't hang forever.
    for (const openId of Array.from(state.openMessages.keys())) {
      if (openId !== messageId) {
        events.push({ kind: 'message:end', messageId: openId })
        state.openMessages.delete(openId)
      }
    }

    if (!state.openMessages.has(messageId)) {
      state.openMessages.set(messageId, { sawText: false })
    }
    const msgState = state.openMessages.get(messageId)!

    for (const block of content) {
      const blockType = block.type as string | undefined
      if (blockType === 'text' && typeof block.text === 'string') {
        events.push({ kind: 'message:text', messageId, text: block.text, streaming: true })
        msgState.sawText = true
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
      if (
        blockType === 'text' &&
        typeof block.text === 'string' &&
        (block.text as string).includes('[BRAINSTORM_COMPLETE]')
      ) {
        events.push({ kind: 'session:brainstorm-complete' })
      }
    }

    // Claude CLI sends many intermediate deltas for the same message; most of
    // them carry `stop_reason: null`. Only a truly terminal event has either
    // `message_stop: true` at the root, or a non-null `stop_reason`. Checking
    // `!== undefined` would spuriously emit message:end on every delta.
    const stopReason = (message as { stop_reason?: unknown } | undefined)?.stop_reason
    const isStop = parsed.message_stop === true || (stopReason !== undefined && stopReason !== null)
    if (isStop) {
      events.push({ kind: 'message:end', messageId })
      state.openMessages.delete(messageId)
    }

    return { events, state }
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
    return { events, state }
  }

  if (type === 'result') {
    // Terminal event — close any message still considered "streaming".
    for (const openId of Array.from(state.openMessages.keys())) {
      events.push({ kind: 'message:end', messageId: openId })
      state.openMessages.delete(openId)
    }
    const usage = parsed.usage as Record<string, unknown> | undefined
    if (usage) {
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
        costUsd: typeof parsed.cost_usd === 'number' ? (parsed.cost_usd as number) : undefined,
      })
    }
    return { events, state }
  }

  return { events, state }
}
