import type Database from 'better-sqlite3'

/**
 * How a workspace's agent actually behaved, over every session it ran.
 *
 * Meant for the engine comparison table: commits and diff size say what came
 * out, this says what it took — how much the user had to type, how often the
 * agent stopped to ask, how many tools and tokens went into it.
 */
export interface WorkspaceActivityStats {
  sessions: number
  /** Wall-clock sum of the sessions that have ended. */
  durationMs: number
  /** Messages the user typed. */
  userMessages: number
  /** Prompts Kōbō injected itself (auto-loop iterations, resumes). */
  injectedPrompts: number
  /** Distinct agent messages, whatever the number of streamed deltas. */
  agentMessages: number
  /** Times the agent stopped to ask the user something. */
  questions: number
  toolCalls: number
  errors: number
  inputTokens: number
  outputTokens: number
}

/**
 * The tools an engine calls to ask the user a question. The persisted
 * `session:user-input-requested` event is purged once answered, so the tool
 * call — which stays — is what gets counted.
 */
const QUESTION_TOOLS = ['AskUserQuestion', 'request_user_input']

export function computeWorkspaceActivityStats(db: Database.Database, workspaceId: string): WorkspaceActivityStats {
  const sessions = db
    .prepare(
      `SELECT COUNT(*) AS count,
              COALESCE(SUM(CASE WHEN ended_at IS NOT NULL
                                THEN MAX(0, (julianday(ended_at) - julianday(started_at)) * 86400000.0)
                                ELSE 0 END), 0) AS duration_ms
         FROM agent_sessions WHERE workspace_id = ?`,
    )
    .get(workspaceId) as { count: number; duration_ms: number }

  const metrics = db
    .prepare(
      `SELECT COALESCE(SUM(tool_calls), 0) AS tool_calls, COALESCE(SUM(errors), 0) AS errors,
              COALESCE(SUM(input_tokens), 0) AS input_tokens, COALESCE(SUM(output_tokens), 0) AS output_tokens
         FROM session_event_metrics WHERE workspace_id = ?`,
    )
    .get(workspaceId) as { tool_calls: number; errors: number; input_tokens: number; output_tokens: number }

  const messages = db
    .prepare(
      `SELECT
         SUM(CASE WHEN type = 'user:message' AND json_extract(payload, '$.sender') = 'user' THEN 1 ELSE 0 END) AS user_messages,
         SUM(CASE WHEN type = 'user:message' AND json_extract(payload, '$.sender') != 'user' THEN 1 ELSE 0 END) AS injected,
         COUNT(DISTINCT CASE WHEN type = 'agent:event' AND json_extract(payload, '$.kind') = 'message:text'
                             THEN json_extract(payload, '$.messageId') END) AS agent_messages,
         SUM(CASE WHEN type = 'agent:event' AND json_extract(payload, '$.kind') = 'tool:call'
                   AND json_extract(payload, '$.name') IN (${QUESTION_TOOLS.map(() => '?').join(', ')})
                  THEN 1 ELSE 0 END) AS questions
       FROM ws_events WHERE workspace_id = ? AND json_valid(payload)`,
    )
    .get(...QUESTION_TOOLS, workspaceId) as {
    user_messages: number | null
    injected: number | null
    agent_messages: number
    questions: number | null
  }

  return {
    sessions: sessions.count,
    durationMs: Math.round(sessions.duration_ms),
    userMessages: messages.user_messages ?? 0,
    injectedPrompts: messages.injected ?? 0,
    agentMessages: messages.agent_messages,
    questions: messages.questions ?? 0,
    toolCalls: metrics.tool_calls,
    errors: metrics.errors,
    inputTokens: metrics.input_tokens,
    outputTokens: metrics.output_tokens,
  }
}
