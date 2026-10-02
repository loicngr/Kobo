// TS mirror of the backend AgentEvent. Kept verbatim so the two trees stay in
// sync — the frontend has its own tsconfig + package root, so the backend file
// cannot be imported directly. See `src/server/services/agent/engines/types.ts`.

export interface RateLimitBucket {
  id: string
  label?: string
  usedPct: number
  resetsAt?: string
  details?: string
}

export interface RateLimitInfo {
  buckets: RateLimitBucket[]
}

export type AgentEventOrigin = { kind: 'subagent'; toolCallId?: string; threadId?: string }

export type AgentEvent =
  // Lifecycle
  | { kind: 'session:started'; engineSessionId: string; model?: string }
  | {
      kind: 'session:ended'
      reason: 'completed' | 'error' | 'killed' | 'watchdog'
      exitCode: number | null
      superseded?: boolean
    }
  /**
   * The current model turn has produced its terminal result and no tracked
   * background work remains. The session may still be draining internally.
   * This is deliberately separate from `session:ended`, which remains the
   * authoritative lifecycle signal for orchestration and auto-loop.
   */
  | { kind: 'turn:completed' }
  | {
      kind: 'session:user-input-requested'
      requestKind: 'question' | 'permission'
      toolCallId: string
      toolName: string
      payload: unknown
    }
  | { kind: 'session:compacted' }
  // Transient live signal: the engine is compacting context now (`active: true`)
  // or has finished (`active: false`). Ephemeral — never persisted/replayed.
  | { kind: 'session:compacting'; active: boolean }
  | { kind: 'session:brainstorm-complete' }
  // Conversation
  | { kind: 'message:text'; messageId: string; text: string; streaming: boolean; origin?: AgentEventOrigin }
  | { kind: 'message:thinking'; messageId: string; text: string; origin?: AgentEventOrigin }
  | { kind: 'message:end'; messageId: string; origin?: AgentEventOrigin }
  | { kind: 'message:raw'; content: string }
  | {
      kind: 'tool:call'
      messageId: string
      toolCallId: string
      name: string
      input: unknown
      origin?: AgentEventOrigin
    }
  | { kind: 'tool:result'; toolCallId: string; output: unknown; isError: boolean; origin?: AgentEventOrigin }
  // Subagent
  | {
      kind: 'subagent:progress'
      toolCallId: string
      /** Codex child threads owned by this launch (one launch may own several). */
      threadIds?: string[]
      /** Claude SDK task id, used by stopTask; Codex has no equivalent. */
      taskId?: string
      /** Every non-running status is terminal. */
      status: 'running' | 'done' | 'failed' | 'stopped'
      /**
       * Lifecycle edge of a running event: `started` (task_started, a launch or
       * relaunch) or `progress` (task_progress). Only `started` may reopen a
       * terminal task; a late `progress` after a terminal event is ignored.
       * Absent on older persisted events and on Codex: treated as a relaunch.
       */
      phase?: 'started' | 'progress'
      /**
       * Claude SDK ambient task (e.g. Monitor watchers): shown in the panel but
       * excluded from every "agent busy" indicator and from turn completion.
       */
      ambient?: boolean
      /** Claude SDK housekeeping task that the inline transcript should hide. */
      skipTranscript?: boolean
      description?: string
      taskType?: string
      lastToolName?: string
      totalTokens?: number
      toolUses?: number
      durationMs?: number
    }
  // Meta
  | { kind: 'skills:discovered'; skills: string[] }
  | {
      kind: 'usage'
      inputTokens: number
      outputTokens: number
      cacheRead?: number
      cacheWrite?: number
      costUsd?: number
    }
  | { kind: 'rate_limit'; info: RateLimitInfo }
  | { kind: 'mcp:status'; serverName: string; status: 'starting' | 'ready' | 'error'; message?: string }
  // Errors
  | {
      kind: 'error'
      category: 'quota' | 'spawn_failed' | 'parse_error' | 'resume_failed' | 'other'
      message: string
      /** Stable diagnostic identifier; independent of the human-readable message. */
      code?: string
    }

/** Every AgentEvent kind, as a const for exhaustive iteration in tests. */
export const ALL_AGENT_EVENT_KINDS = [
  'session:started',
  'session:ended',
  'turn:completed',
  'session:user-input-requested',
  'session:compacted',
  'session:compacting',
  'session:brainstorm-complete',
  'message:text',
  'message:thinking',
  'message:end',
  'message:raw',
  'tool:call',
  'tool:result',
  'subagent:progress',
  'skills:discovered',
  'usage',
  'rate_limit',
  'mcp:status',
  'error',
] as const

export type AgentEventKind = (typeof ALL_AGENT_EVENT_KINDS)[number]
