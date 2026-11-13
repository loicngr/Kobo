import { getDb } from '../../db/index.js'

export type SlackMessageState = 'queued' | 'dispatching' | 'delivered' | 'rejected' | 'unknown' | 'context' | 'sent'

export interface SlackFileRef {
  id: string
  name: string
  mimetype: string
  size: number
  url: string
}

export interface SlackMessageRow {
  channelId: string
  ts: string
  threadTs: string
  workspaceId: string
  userId: string | null
  userName: string | null
  text: string
  direction: 'in' | 'out'
  state: SlackMessageState
  files: SlackFileRef[]
  createdAt: string
  /** Labels of the buttons on a bot message, in posting order. */
  buttons?: string[]
  /** Set on a bot message with buttons and on its click rows. */
  multiple?: boolean
  /** On a click row: the ts of the clicked bot message. The row ts is not a real Slack ts. */
  clickOf?: string
}

interface DbRow {
  channel_id: string
  ts: string
  thread_ts: string
  workspace_id: string
  user_id: string | null
  user_name: string | null
  text: string
  direction: 'in' | 'out'
  state: SlackMessageState
  files: string
  created_at: string
  buttons: string | null
  buttons_multiple: number
  click_of: string | null
}

function parseFiles(raw: string): SlackFileRef[] {
  try {
    const files = JSON.parse(raw) as unknown
    return Array.isArray(files) ? (files as SlackFileRef[]) : []
  } catch {
    return [] // a corrupt row must not stall the queue
  }
}

function parseLabels(raw: string): string[] {
  try {
    const labels = JSON.parse(raw) as unknown
    return Array.isArray(labels) ? labels.filter((l): l is string => typeof l === 'string') : []
  } catch {
    return []
  }
}

function toRow(r: DbRow): SlackMessageRow {
  return {
    channelId: r.channel_id,
    ts: r.ts,
    threadTs: r.thread_ts,
    workspaceId: r.workspace_id,
    userId: r.user_id,
    userName: r.user_name,
    text: r.text,
    direction: r.direction,
    state: r.state,
    files: parseFiles(r.files),
    createdAt: r.created_at,
    ...(r.buttons !== null ? { buttons: parseLabels(r.buttons) } : {}),
    ...(r.buttons !== null || r.click_of !== null ? { multiple: r.buttons_multiple === 1 } : {}),
    ...(r.click_of !== null ? { clickOf: r.click_of } : {}),
  }
}

/** Returns false when (channel, ts) is already stored. */
export function insertSlackMessage(row: Omit<SlackMessageRow, 'createdAt'>): boolean {
  const now = new Date().toISOString()
  return (
    getDb()
      .prepare(
        `INSERT OR IGNORE INTO slack_messages
         (channel_id, ts, thread_ts, workspace_id, user_id, user_name, text, direction, state, files, created_at, updated_at,
          buttons, buttons_multiple, click_of)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.channelId,
        row.ts,
        row.threadTs,
        row.workspaceId,
        row.userId,
        row.userName,
        row.text,
        row.direction,
        row.state,
        JSON.stringify(row.files),
        now,
        now,
        row.buttons ? JSON.stringify(row.buttons) : null,
        row.multiple ? 1 : 0,
        row.clickOf ?? null,
      ).changes === 1
  )
}

export function setSlackMessageState(channelId: string, ts: string, state: SlackMessageState): void {
  getDb()
    .prepare('UPDATE slack_messages SET state = ?, updated_at = ? WHERE channel_id = ? AND ts = ?')
    .run(state, new Date().toISOString(), channelId, ts)
}

export function getSlackMessageState(channelId: string, ts: string): SlackMessageState | undefined {
  const r = getDb().prepare('SELECT state FROM slack_messages WHERE channel_id = ? AND ts = ?').get(channelId, ts) as
    | { state: SlackMessageState }
    | undefined
  return r?.state
}

/**
 * queued -> dispatching, only while the row still belongs to the workspace and that workspace still
 * holds the channel. A false result means the message was rejected, expired or unlinked meanwhile.
 */
export function claimSlackMessageForDispatch(channelId: string, ts: string, workspaceId: string): boolean {
  return (
    getDb()
      .prepare(
        `UPDATE slack_messages SET state = 'dispatching', updated_at = ?
         WHERE channel_id = ? AND ts = ? AND workspace_id = ? AND state = 'queued'
         AND EXISTS (SELECT 1 FROM workspaces WHERE id = ? AND slack_channel_id = ?)`,
      )
      .run(new Date().toISOString(), channelId, ts, workspaceId, workspaceId, channelId).changes === 1
  )
}

/** dispatching -> delivered; never overwrites any other state. */
export function markSlackMessageDelivered(channelId: string, ts: string): boolean {
  return (
    getDb()
      .prepare(
        "UPDATE slack_messages SET state = 'delivered', updated_at = ? WHERE channel_id = ? AND ts = ? AND state = 'dispatching'",
      )
      .run(new Date().toISOString(), channelId, ts).changes === 1
  )
}

/**
 * Replaces a `context` row (stored from a thread fetch before its own event arrived) with the real
 * message. Returns false when the existing row is anything but `context`.
 */
export function promoteSlackContextMessage(row: Omit<SlackMessageRow, 'createdAt'>): boolean {
  const now = new Date().toISOString()
  return (
    getDb()
      .prepare(
        `UPDATE slack_messages SET thread_ts = ?, user_id = ?, user_name = ?, text = ?, direction = ?, state = ?,
         files = ?, created_at = ?, updated_at = ?
         WHERE channel_id = ? AND ts = ? AND workspace_id = ? AND state = 'context'`,
      )
      .run(
        row.threadTs,
        row.userId,
        row.userName,
        row.text,
        row.direction,
        row.state,
        JSON.stringify(row.files),
        now,
        now,
        row.channelId,
        row.ts,
        row.workspaceId,
      ).changes === 1
  )
}

export function isTrackedThread(channelId: string, threadTs: string): boolean {
  return (
    getDb()
      .prepare(
        `SELECT 1 FROM slack_messages WHERE channel_id = ? AND thread_ts = ?
         AND ((direction = 'in' AND state IN ('queued', 'dispatching', 'delivered')) OR (direction = 'out' AND state = 'sent'))
         LIMIT 1`,
      )
      .get(channelId, threadTs) !== undefined
  )
}

export function nextQueuedSlackMessage(workspaceId: string): SlackMessageRow | undefined {
  const r = getDb()
    .prepare("SELECT * FROM slack_messages WHERE workspace_id = ? AND state = 'queued' ORDER BY ts ASC LIMIT 1")
    .get(workspaceId) as DbRow | undefined
  return r && toRow(r)
}

export function countQueuedSlackMessages(workspaceId: string): number {
  const r = getDb()
    .prepare("SELECT COUNT(*) AS n FROM slack_messages WHERE workspace_id = ? AND state = 'queued'")
    .get(workspaceId) as { n: number }
  return r.n
}

export function listWorkspacesWithQueuedSlackMessages(): string[] {
  return (
    getDb().prepare("SELECT DISTINCT workspace_id FROM slack_messages WHERE state = 'queued'").all() as {
      workspace_id: string
    }[]
  ).map((r) => r.workspace_id)
}

/** A bot message of this channel that carries buttons. */
export function getSlackButtonMessage(
  channelId: string,
  ts: string,
): (SlackMessageRow & { buttons: string[]; multiple: boolean; answered: boolean }) | undefined {
  const r = getDb()
    .prepare(
      "SELECT * FROM slack_messages WHERE channel_id = ? AND ts = ? AND direction = 'out' AND buttons IS NOT NULL",
    )
    .get(channelId, ts) as (DbRow & { answered_at: string | null }) | undefined
  if (!r) return undefined
  return {
    ...toRow(r),
    buttons: parseLabels(r.buttons ?? '[]'),
    multiple: r.buttons_multiple === 1,
    answered: r.answered_at !== null,
  }
}

const LOST_CLICK = Symbol('lost click')

/**
 * Stores a click row for the bot message `messageTs`, only while that message still belongs to the
 * row workspace, the workspace still holds the channel and, for a single-answer message, it is not
 * answered yet. With `claimAnswer`, a single-answer message is answered by compare-and-set in the
 * same transaction: of two racing clicks only one can win. Returns false for a losing, repeated or
 * stale click; nothing is stored then.
 */
export function recordSlackClick(
  row: Omit<SlackMessageRow, 'createdAt'>,
  messageTs: string,
  claimAnswer: boolean,
): boolean {
  const db = getDb()
  const owned = `channel_id = ? AND ts = ? AND workspace_id = ? AND direction = 'out' AND buttons IS NOT NULL
    AND EXISTS (SELECT 1 FROM workspaces WHERE id = ? AND slack_channel_id = ?)`
  const params = [row.channelId, messageTs, row.workspaceId, row.workspaceId, row.channelId]
  try {
    return db.transaction(() => {
      const message = db
        .prepare(
          `SELECT buttons_multiple FROM slack_messages WHERE ${owned} AND (buttons_multiple = 1 OR answered_at IS NULL)`,
        )
        .get(...params) as { buttons_multiple: number } | undefined
      if (!message) return false
      if (!insertSlackMessage(row)) return false
      const claimed =
        message.buttons_multiple === 1 ||
        !claimAnswer ||
        db
          .prepare(`UPDATE slack_messages SET answered_at = ?, updated_at = ? WHERE ${owned} AND answered_at IS NULL`)
          .run(new Date().toISOString(), new Date().toISOString(), ...params).changes === 1
      if (!claimed) throw LOST_CLICK // rolls the click row back with the transaction
      return true
    })()
  } catch (err) {
    if (err === LOST_CLICK) return false
    throw err
  }
}

export function countThreadMessagesBefore(channelId: string, threadTs: string, ts: string): number {
  const r = getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM slack_messages WHERE channel_id = ? AND thread_ts = ? AND ts < ?
       AND state IN ('delivered', 'sent', 'context')`,
    )
    .get(channelId, threadTs, ts) as { n: number }
  return r.n
}

/**
 * Newest page of the rows an agent may read, returned oldest first. Inbound rows that were not
 * delivered (queued, dispatching, rejected, unknown) are excluded: the agent must not act on them.
 */
export function listSlackThread(
  channelId: string,
  threadTs: string,
  opts: { limit: number; before?: string },
): SlackMessageRow[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM slack_messages WHERE channel_id = ? AND thread_ts = ? AND (? IS NULL OR ts < ?)
       AND state IN ('delivered', 'sent', 'context')
       ORDER BY ts DESC LIMIT ?`,
    )
    .all(channelId, threadTs, opts.before ?? null, opts.before ?? null, opts.limit) as DbRow[]
  return rows.reverse().map(toRow)
}

function transition(from: SlackMessageState, to: SlackMessageState, extraWhere = '', params: unknown[] = []) {
  const db = getDb()
  return db.transaction(() => {
    const rows = db
      .prepare(`SELECT * FROM slack_messages WHERE state = ? ${extraWhere} ORDER BY ts ASC`)
      .all(from, ...params) as DbRow[]
    db.prepare(`UPDATE slack_messages SET state = ?, updated_at = ? WHERE state = ? ${extraWhere}`).run(
      to,
      new Date().toISOString(),
      from,
      ...params,
    )
    return rows.map((r) => toRow({ ...r, state: to }))
  })()
}

/** dispatching -> unknown (interrupted delivery is never replayed). */
export function reconcileSlackMessages(): SlackMessageRow[] {
  return transition('dispatching', 'unknown')
}

/** queued -> rejected for rows created before the cutoff. */
export function expireQueuedSlackMessages(olderThanIso: string): SlackMessageRow[] {
  return transition('queued', 'rejected', 'AND created_at < ?', [olderThanIso])
}

export function getWorkspaceIdForSlackChannel(channelId: string): string | undefined {
  const r = getDb().prepare('SELECT id FROM workspaces WHERE slack_channel_id = ?').get(channelId) as
    | { id: string }
    | undefined
  return r?.id
}

/**
 * Links (or unlinks with null) the workspace's Slack channel. Changing the channel returns the
 * rows that were queued for the previous one and drops all stored messages of the workspace.
 */
export function setWorkspaceSlackChannel(workspaceId: string, channelId: string | null): SlackMessageRow[] {
  const db = getDb()
  return db.transaction(() => {
    const current = db.prepare('SELECT slack_channel_id FROM workspaces WHERE id = ?').get(workspaceId) as
      | { slack_channel_id: string | null }
      | undefined
    if (!current) throw new Error(`Workspace '${workspaceId}' not found`)
    if (current.slack_channel_id === channelId) return []
    if (channelId) {
      const owner = getWorkspaceIdForSlackChannel(channelId)
      if (owner && owner !== workspaceId) throw new Error('Slack channel is already linked to another workspace')
    }
    const queued = (
      db
        .prepare("SELECT * FROM slack_messages WHERE workspace_id = ? AND state = 'queued' ORDER BY ts ASC")
        .all(workspaceId) as DbRow[]
    ).map(toRow)
    db.prepare('DELETE FROM slack_messages WHERE workspace_id = ?').run(workspaceId)
    db.prepare('UPDATE workspaces SET slack_channel_id = ? WHERE id = ?').run(channelId, workspaceId)
    return queued
  })()
}
