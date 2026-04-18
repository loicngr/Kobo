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

export type AgentEvent =
  // Lifecycle
  | { kind: 'session:started'; engineSessionId: string; model?: string }
  | { kind: 'session:ended'; reason: 'completed' | 'error' | 'killed'; exitCode: number | null }
  | { kind: 'session:compacted' }
  | { kind: 'session:brainstorm-complete' }
  // Conversation
  | { kind: 'message:text'; messageId: string; text: string; streaming: boolean }
  | { kind: 'message:thinking'; messageId: string; text: string }
  | { kind: 'message:end'; messageId: string }
  | { kind: 'message:raw'; content: string }
  | { kind: 'tool:call'; messageId: string; toolCallId: string; name: string; input: unknown }
  | { kind: 'tool:result'; toolCallId: string; output: unknown; isError: boolean }
  // Subagent
  | {
      kind: 'subagent:progress'
      toolCallId: string
      status: 'running' | 'done'
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
  // Errors
  | {
      kind: 'error'
      category: 'quota' | 'spawn_failed' | 'parse_error' | 'other'
      message: string
    }

/** Every AgentEvent kind, as a const for exhaustive iteration in tests. */
export const ALL_AGENT_EVENT_KINDS = [
  'session:started',
  'session:ended',
  'session:compacted',
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
  'error',
] as const

export type AgentEventKind = (typeof ALL_AGENT_EVENT_KINDS)[number]
