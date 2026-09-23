import { getDb } from '../db/index.js'

/** Hard cap on entries per workspace. The service trims after every insert. */
const MAX_HISTORY_ENTRIES = 200

/** Returns up to MAX_HISTORY_ENTRIES messages for the workspace, most recent first. */
export function listChatHistory(workspaceId: string): string[] {
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT message FROM workspace_chat_history
       WHERE workspace_id = ?
       ORDER BY id DESC
       LIMIT ${MAX_HISTORY_ENTRIES}`,
    )
    .all(workspaceId) as Array<{ message: string }>
  return rows.map((r) => r.message)
}

/**
 * Insert a message into the workspace's history, dedup against the latest
 * entry, and trim to MAX_HISTORY_ENTRIES. Whitespace-only messages are
 * ignored. Atomic via a transaction so the insert + trim are observed
 * together.
 */
export function pushChatHistory(workspaceId: string, message: string): void {
  if (!message?.trim()) return
  const db = getDb()
  db.transaction(() => {
    const latest = db
      .prepare('SELECT message FROM workspace_chat_history WHERE workspace_id = ? ORDER BY id DESC LIMIT 1')
      .get(workspaceId) as { message: string } | undefined
    if (latest?.message === message) return
    db.prepare('INSERT INTO workspace_chat_history (workspace_id, message) VALUES (?, ?)').run(workspaceId, message)
    db.prepare(
      `DELETE FROM workspace_chat_history
       WHERE workspace_id = ?
         AND id NOT IN (
           SELECT id FROM workspace_chat_history
           WHERE workspace_id = ?
           ORDER BY id DESC
           LIMIT ${MAX_HISTORY_ENTRIES}
         )`,
    ).run(workspaceId, workspaceId)
  })()
}
