import { getDb } from '../db/index.js'

// Preserve legacy last-use ordering until a session is started or restored.
export const SESSION_RECENCY_ORDER =
  'activation_order DESC, MAX(started_at, COALESCE(ended_at, started_at)) DESC, started_at DESC'

/** Make a conversation current without changing its execution history or starting an agent. */
export function activateSession(workspaceId: string, sessionId: string): void {
  getDb()
    .prepare(`UPDATE agent_sessions SET activation_order =
      (SELECT COALESCE(MAX(activation_order), 0) + 1 FROM agent_sessions WHERE workspace_id = ?)
      WHERE workspace_id = ? AND id = ? AND status != 'idle'`)
    .run(workspaceId, workspaceId, sessionId)
}
