import type { QueuedAutoLoopMessage } from '../../shared/auto-loop-types.js'
import type { MessageSource } from '../../shared/workspace-message-types.js'
import { getDb } from '../db/index.js'
import { emitEphemeral } from './websocket-service.js'

export function listLoopMessages(workspaceId: string): QueuedAutoLoopMessage[] {
  return getDb()
    .prepare(`SELECT id,client_message_id AS clientMessageId,content,state,session_id AS sessionId,
    created_at AS createdAt FROM auto_loop_messages WHERE workspace_id=? AND state!='delivered' ORDER BY id`)
    .all(workspaceId) as QueuedAutoLoopMessage[]
}

export function hasLoopMessage(workspaceId: string, clientMessageId: string): boolean {
  return !!getDb()
    .prepare('SELECT 1 FROM auto_loop_messages WHERE workspace_id=? AND client_message_id=?')
    .get(workspaceId, clientMessageId)
}

export function enqueueLoopMessage(
  workspaceId: string,
  content: string,
  clientMessageId: string,
  source?: MessageSource,
): void {
  if (!content.trim() || !clientMessageId.trim()) throw new Error('Message content and clientMessageId are required')
  if (content.length > 100_000 || clientMessageId.length > 200) throw new Error('Message is too large')
  const db = getDb()
  db.transaction(() => {
    const existing = db
      .prepare('SELECT content,source FROM auto_loop_messages WHERE workspace_id=? AND client_message_id=?')
      .get(workspaceId, clientMessageId) as { content: string; source: string | null } | undefined
    const encodedSource = source ? JSON.stringify(source) : null
    if (existing) {
      if (existing.content !== content || existing.source !== encodedSource)
        throw new Error('Message identifier already used with different content')
      return
    }
    db.prepare(
      'INSERT INTO auto_loop_messages(workspace_id,client_message_id,content,source,created_at) VALUES (?,?,?,?,?)',
    ).run(workspaceId, clientMessageId, content, encodedSource, new Date().toISOString())
    // Instructions received after an earlier validation require a fresh final pass.
    db.prepare("UPDATE tasks SET status='pending',verification=NULL WHERE workspace_id=? AND role='finalization'").run(
      workspaceId,
    )
  })()
  emitEphemeral(workspaceId, 'autoloop:messages', {})
}

/** Claim before dispatch; an interrupted claim must never be replayed blindly. */
export function claimLoopMessages(workspaceId: string): QueuedAutoLoopMessage[] {
  return getDb().transaction(() => {
    const messages = listLoopMessages(workspaceId).filter((m) => m.state === 'pending')
    getDb()
      .prepare("UPDATE auto_loop_messages SET state='dispatching' WHERE workspace_id=? AND state='pending'")
      .run(workspaceId)
    return messages
  })()
}

export function bindLoopMessages(workspaceId: string, sessionId: string): void {
  getDb()
    .prepare(
      "UPDATE auto_loop_messages SET session_id=? WHERE workspace_id=? AND state='dispatching' AND session_id IS NULL",
    )
    .run(sessionId, workspaceId)
  emitEphemeral(workspaceId, 'autoloop:messages', {})
}

/** Return the number settled by this turn, excluding earlier deliveries on a resumed session. */
export function settleLoopMessages(workspaceId: string, sessionId: string | null, completed: boolean): number {
  if (!sessionId) return 0
  const result = getDb()
    .prepare("UPDATE auto_loop_messages SET state=? WHERE workspace_id=? AND session_id=? AND state='dispatching'")
    .run(completed ? 'delivered' : 'unknown', workspaceId, sessionId)
  emitEphemeral(workspaceId, 'autoloop:messages', {})
  return result.changes
}

export function recoverLoopMessages(workspaceId: string): void {
  getDb()
    .prepare("UPDATE auto_loop_messages SET state='unknown' WHERE workspace_id=? AND state='dispatching'")
    .run(workspaceId)
}

export function resolveLoopMessage(workspaceId: string, id: number, action: 'cancel' | 'acknowledge' | 'retry'): void {
  const row = getDb()
    .prepare('SELECT state FROM auto_loop_messages WHERE workspace_id=? AND id=?')
    .get(workspaceId, id) as { state: string } | undefined
  if (!row) throw new Error('Queued message not found')
  if (action === 'cancel' ? row.state !== 'pending' : row.state !== 'unknown')
    throw new Error('Message is already being delivered or has been resolved')
  getDb()
    .prepare('UPDATE auto_loop_messages SET state=?,session_id=NULL WHERE workspace_id=? AND id=?')
    .run(action === 'retry' ? 'pending' : 'delivered', workspaceId, id)
  emitEphemeral(workspaceId, 'autoloop:messages', {})
}
