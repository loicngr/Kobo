import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import {
  type GroupMessageBatch,
  type GroupMessageRecipient,
  parseGroupMessageInput,
} from '../../shared/workspace-group-messages.js'
import type { MessageSource } from '../../shared/workspace-message-types.js'
import { getDb } from '../db/index.js'
import { isShuttingDown } from './agent/orchestrator.js'
import { broadcastPersistedEvent, persistWorkspaceEvent } from './websocket-service.js'
import { deliverWorkspaceMessage } from './workspace-message-service.js'
import { getWorkspace } from './workspace-service.js'

export class GroupMessageError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 409 | 503,
  ) {
    super(message)
  }
}
interface Row {
  fingerprint: string
  receipt_json: string
}
interface Job {
  batchId: string
  recipient: GroupMessageRecipient
  content: string
  source?: MessageSource
}
const jobs: Job[] = []
const active = new Set<Promise<void>>()
let stopping = false

export function getGroupMessageBatch(id: string): GroupMessageBatch | undefined {
  const row = getDb().prepare('SELECT receipt_json FROM workspace_message_batches WHERE id=?').get(id) as
    | Row
    | undefined
  return row ? (JSON.parse(row.receipt_json) as GroupMessageBatch) : undefined
}
function updateRecipient(id: string, workspaceId: string, state: GroupMessageRecipient['state'], error?: string): void {
  const batch = getGroupMessageBatch(id)
  if (!batch) throw new Error('Group message receipt is unavailable')
  const recipient = batch.recipients.find((item) => item.workspaceId === workspaceId)!
  recipient.state = state
  if (error) recipient.error = error.slice(0, 1000)
  else delete recipient.error
  batch.complete = batch.recipients.every((item) => item.state !== 'pending' && item.state !== 'sending')
  getDb().prepare('UPDATE workspace_message_batches SET receipt_json=? WHERE id=?').run(JSON.stringify(batch), id)
}

/** Persist before scheduling. Repeating an ID only observes its existing immutable request. */
export function startGroupMessageBatch(value: unknown, source?: MessageSource): GroupMessageBatch {
  let input: ReturnType<typeof parseGroupMessageInput>
  try {
    input = parseGroupMessageInput(value)
  } catch (error) {
    throw new GroupMessageError(error instanceof Error ? error.message : String(error), 400)
  }
  const fingerprint = createHash('sha256')
    .update(JSON.stringify([input.content, [...input.workspaceIds].sort(), source ?? null]))
    .digest('hex')
  const db = getDb()
  const result = db
    .transaction(() => {
      const row = db
        .prepare('SELECT fingerprint,receipt_json FROM workspace_message_batches WHERE id=?')
        .get(input.requestId) as Row | undefined
      if (row) {
        if (row.fingerprint !== fingerprint)
          throw new GroupMessageError(
            'This requestId was already used for different content, recipients or source',
            409,
          )
        return { fresh: false, batch: JSON.parse(row.receipt_json) as GroupMessageBatch }
      }
      if (stopping || isShuttingDown()) throw new GroupMessageError('Kōbō is shutting down', 503)
      const batch: GroupMessageBatch = {
        id: input.requestId,
        createdAt: new Date().toISOString(),
        complete: false,
        recipients: input.workspaceIds.map((workspaceId) => {
          const workspace = getWorkspace(workspaceId)
          const error = !workspace
            ? 'Workspace not found'
            : workspace.archivedAt || workspace.worktreePurgedAt
              ? 'Restore the workspace before sending a message'
              : undefined
          return {
            workspaceId,
            name: workspace?.name ?? workspaceId,
            delivery: workspace?.autoLoop ? 'next_iteration' : 'immediate',
            state: error ? 'rejected' : 'pending',
            ...(error ? { error } : {}),
          }
        }),
      }
      batch.complete = batch.recipients.every((item) => item.state === 'rejected')
      db.prepare('INSERT INTO workspace_message_batches(id,fingerprint,receipt_json,created_at) VALUES (?,?,?,?)').run(
        batch.id,
        fingerprint,
        JSON.stringify(batch),
        batch.createdAt,
      )
      return { fresh: true, batch }
    })
    .immediate()
  if (result.fresh) {
    for (const recipient of result.batch.recipients)
      if (recipient.state === 'pending')
        jobs.push({ batchId: result.batch.id, recipient, content: input.content, source })
    queueMicrotask(pump)
  }
  return result.batch
}

async function deliver(job: Job): Promise<void> {
  const { batchId, recipient } = job
  let dispatched = false
  let accepted = false
  try {
    updateRecipient(batchId, recipient.workspaceId, 'sending')
    await deliverWorkspaceMessage(
      recipient.workspaceId,
      {
        content: job.content,
        source: job.source,
        delivery: recipient.delivery,
        clientMessageId: `group-${createHash('sha256')
          .update(JSON.stringify([batchId, recipient.workspaceId]))
          .digest('hex')}`,
      },
      {
        beforeDispatch() {
          const workspace = getWorkspace(recipient.workspaceId)
          if (!workspace || !!workspace.autoLoop !== (recipient.delivery === 'next_iteration'))
            throw new Error('Auto-loop mode changed since submission; review the recipient before sending again')
          dispatched = true
        },
        persist(payload, sessionId) {
          const event = getDb().transaction(() => {
            const persisted = persistWorkspaceEvent(recipient.workspaceId, 'user:message', payload, sessionId)
            updateRecipient(batchId, recipient.workspaceId, recipient.delivery === 'next_iteration' ? 'queued' : 'sent')
            return persisted
          })()
          accepted = true
          broadcastPersistedEvent(event)
        },
      },
    )
    if (!accepted) throw new Error('Delivery completed without a durable receipt')
  } catch (error) {
    if (accepted) return
    updateRecipient(
      batchId,
      recipient.workspaceId,
      dispatched ? 'unknown' : 'rejected',
      error instanceof Error ? error.message : String(error),
    )
  }
}
function pump(): void {
  if (stopping) return
  while (active.size < 3 && jobs.length) {
    const job = jobs.shift()!
    const task = deliver(job)
      .catch((error) => console.error('[group-message] Receipt persistence failed:', error))
      .finally(() => {
        active.delete(task)
        pump()
      })
    active.add(task)
  }
}

/** Startup only: persisted uncertain work is never automatically dispatched again. */
export function reconcileGroupMessageBatches(db: Database.Database): void {
  stopping = false
  db.transaction(() => {
    const rows = db.prepare('SELECT id,receipt_json FROM workspace_message_batches').all() as Array<
      Row & { id: string }
    >
    for (const row of rows) {
      const batch = JSON.parse(row.receipt_json) as GroupMessageBatch
      if (batch.complete) continue
      for (const recipient of batch.recipients) {
        if (recipient.state === 'pending') {
          recipient.state = 'not_sent'
          recipient.error = 'Server stopped before delivery'
        } else if (recipient.state === 'sending') {
          recipient.state = 'unknown'
          recipient.error = 'Server stopped during delivery; inspect workspace history before sending again'
        }
      }
      batch.complete = true
      db.prepare('UPDATE workspace_message_batches SET receipt_json=? WHERE id=?').run(JSON.stringify(batch), row.id)
    }
  })()
}
export async function stopGroupMessageBatches(): Promise<void> {
  stopping = true
  for (const job of jobs.splice(0)) {
    try {
      updateRecipient(job.batchId, job.recipient.workspaceId, 'not_sent', 'Server stopped before delivery')
    } catch (error) {
      // Startup will reconcile the durable pending row; still drain active jobs before closing SQLite.
      console.error('[group-message] Could not persist shutdown receipt:', error)
    }
  }
  await Promise.allSettled([...active])
}
