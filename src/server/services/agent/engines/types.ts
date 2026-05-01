import type { EffectiveSettings } from '../../settings-service.js'

// ── Engine contract ───────────────────────────────────────────────────────────

/**
 * Known engine identifiers. Expand this union when new engines are added.
 * The registry still accepts plain strings at its resolve boundary because DB
 * values are untyped — validation happens at workspace creation via
 * `listEngines()` (see `workspace-service.ts` / `mapWorkspace`).
 */
export type EngineId = 'claude-code'

export interface AgentEngine {
  readonly id: EngineId
  readonly displayName: string
  readonly capabilities: EngineCapabilities
  start(options: StartOptions, onEvent: (ev: AgentEvent) => void): Promise<EngineProcess>
}

export type PendingUserInputResponse =
  | { kind: 'question'; answers: Record<string, string> }
  | { kind: 'question-cancel'; reason?: string }
  | { kind: 'permission-allow' }
  | { kind: 'permission-deny'; reason?: string }

export interface EngineProcess {
  readonly pid: number | undefined
  readonly engineSessionId: string | undefined
  sendMessage(text: string): void
  interrupt(): void
  stop(): Promise<void>
  /**
   * Resolve a pending `canUseTool` callback by `toolCallId`. Returns true if
   * a pending entry was found and resolved, false if no entry exists for the
   * given id (already resolved, never registered, or different session).
   */
  resolvePendingUserInput(toolCallId: string, response: PendingUserInputResponse): boolean
}

export interface StartOptions {
  workspaceId: string
  workingDir: string
  prompt: string
  model?: string
  effort?: string
  /**
   * Unified SDK-aligned permission mode. Maps 1:1 to the SDK:
   *   - 'plan'        → SDK 'plan' (read-only).
   *   - 'bypass'      → SDK 'bypassPermissions' (+ allowDangerouslySkipPermissions).
   *   - 'strict'      → SDK 'acceptEdits' (auto-accept edits, allow-list rest).
   *   - 'interactive' → SDK 'default' + Kōbō PreToolUse defer hook.
   */
  agentPermissionMode?: 'plan' | 'bypass' | 'strict' | 'interactive'
  resumeFromEngineSessionId?: string
  backendUrl: string
  koboHome: string
  settings: EffectiveSettings
  mcpServers?: McpServerSpec[]
}

export interface McpServerSpec {
  name: string
  command: string
  args: string[]
  env: Record<string, string>
}

export interface EngineCapabilities {
  models: Array<{ id: string; label: string }>
  effortLevels?: Array<{ id: string; label: string }>
  permissionModes: Array<'plan' | 'bypass' | 'strict' | 'interactive'>
  supportsResume: boolean
  supportsMcp: boolean
  supportsSkills: boolean
}

// ── Event model ───────────────────────────────────────────────────────────────

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
  | {
      kind: 'session:ended'
      reason: 'completed' | 'error' | 'killed'
      exitCode: number | null
    }
  | {
      kind: 'session:user-input-requested'
      requestKind: 'question' | 'permission'
      toolCallId: string
      toolName: string
      payload: unknown
    }
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
      category: 'quota' | 'spawn_failed' | 'parse_error' | 'resume_failed' | 'other'
      message: string
    }

/** Every AgentEvent kind, as a const for exhaustive iteration in tests. */
export const ALL_AGENT_EVENT_KINDS = [
  'session:started',
  'session:ended',
  'session:user-input-requested',
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
