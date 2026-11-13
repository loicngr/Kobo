import type { SlackQuestionMirror } from '../../../shared/slack-question-mirror.js'
import { type MessageSource, parseMessageSource } from '../../../shared/workspace-message-types.js'
import { getDb } from '../../db/index.js'
import type { CollectedAnswer } from './slack-questions.js'

export type SlackQuestionKind = 'question' | 'permission' | 'secret'
export type SlackQuestionState = 'posting' | 'open' | 'submitting' | 'answered' | 'closed' | 'notified'

export interface SlackQuestionKey {
  workspaceId: string
  sessionId: string
  toolCallId: string
}

export interface SlackQuestionRow extends SlackQuestionKey {
  kind: SlackQuestionKind
  channelId: string
  threadTs: string | null
  messageTs: string | null
  messageText: string
  questionIndex: number
  answers: CollectedAnswer[]
  state: SlackQuestionState
}

interface DbRow {
  workspace_id: string
  session_id: string
  tool_call_id: string
  kind: SlackQuestionKind
  channel_id: string
  thread_ts: string | null
  message_ts: string | null
  message_text: string
  question_index: number
  answers: string
  state: SlackQuestionState
}

function parseAnswers(raw: string): CollectedAnswer[] {
  try {
    const value = JSON.parse(raw) as unknown
    return Array.isArray(value) ? (value as CollectedAnswer[]) : []
  } catch {
    return []
  }
}

const toRow = (r: DbRow): SlackQuestionRow => ({
  workspaceId: r.workspace_id,
  sessionId: r.session_id,
  toolCallId: r.tool_call_id,
  kind: r.kind,
  channelId: r.channel_id,
  threadTs: r.thread_ts,
  messageTs: r.message_ts,
  messageText: r.message_text,
  questionIndex: r.question_index,
  answers: parseAnswers(r.answers),
  state: r.state,
})

const KEY = 'workspace_id = ? AND session_id = ? AND tool_call_id = ?'
const keyArgs = (k: SlackQuestionKey) => [k.workspaceId, k.sessionId, k.toolCallId]
const now = () => new Date().toISOString()

export function setWorkspaceSlackQuestionMirror(workspaceId: string, mode: SlackQuestionMirror): void {
  const changes = getDb()
    .prepare('UPDATE workspaces SET slack_question_mirror = ? WHERE id = ?')
    .run(mode, workspaceId).changes
  if (!changes) throw new Error(`Workspace '${workspaceId}' not found`)
}

/** The Slack source of the newest human message of a session, if it came from Slack. */
export function lastUserMessageSource(workspaceId: string, sessionId: string): MessageSource | undefined {
  const r = getDb()
    .prepare(
      `SELECT payload FROM ws_events WHERE workspace_id = ? AND session_id = ? AND type = 'user:message'
       AND json_extract(payload, '$.sender') = 'user' ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(workspaceId, sessionId) as { payload: string } | undefined
  if (!r) return undefined
  try {
    return parseMessageSource((JSON.parse(r.payload) as { source?: unknown }).source)
  } catch {
    return undefined
  }
}

/** Reserves the single mirror row of a tool call. False when it was already mirrored (or is being). */
export function reserveSlackQuestion(
  key: SlackQuestionKey,
  kind: SlackQuestionKind,
  channelId: string,
  threadTs: string | null,
): boolean {
  const t = now()
  return (
    getDb()
      .prepare(
        `INSERT OR IGNORE INTO slack_questions (workspace_id, session_id, tool_call_id, kind, channel_id, thread_ts, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'posting', ?, ?)`,
      )
      .run(...keyArgs(key), kind, channelId, threadTs, t, t).changes === 1
  )
}

/** posting -> open (a question) or notified (a notice), once the Slack message exists. */
export function publishSlackQuestion(
  key: SlackQuestionKey,
  threadTs: string,
  messageTs: string,
  messageText: string,
  state: 'open' | 'notified',
): boolean {
  return (
    getDb()
      .prepare(
        `UPDATE slack_questions SET thread_ts = ?, message_ts = ?, message_text = ?, state = ?, updated_at = ?
         WHERE ${KEY} AND state = 'posting'`,
      )
      .run(threadTs, messageTs, messageText, state, now(), ...keyArgs(key)).changes === 1
  )
}

/** A failed post releases the reservation, so the next evaluation can post it again. */
export function dropSlackQuestionReservation(key: SlackQuestionKey): void {
  getDb()
    .prepare(`DELETE FROM slack_questions WHERE ${KEY} AND state = 'posting'`)
    .run(...keyArgs(key))
}

export function getSlackQuestion(key: SlackQuestionKey): SlackQuestionRow | undefined {
  const r = getDb()
    .prepare(`SELECT * FROM slack_questions WHERE ${KEY}`)
    .get(...keyArgs(key)) as DbRow | undefined
  return r && toRow(r)
}

export function getSlackQuestionByMessage(channelId: string, messageTs: string): SlackQuestionRow | undefined {
  const r = getDb()
    .prepare("SELECT * FROM slack_questions WHERE channel_id = ? AND message_ts = ? AND kind = 'question'")
    .get(channelId, messageTs) as DbRow | undefined
  return r && toRow(r)
}

export function getOpenSlackQuestionInThread(
  workspaceId: string,
  channelId: string,
  threadTs: string,
): SlackQuestionRow | undefined {
  // A row without message_ts has its next question being posted: nothing can answer it yet.
  const r = getDb()
    .prepare(
      `SELECT * FROM slack_questions WHERE workspace_id = ? AND channel_id = ? AND thread_ts = ? AND state = 'open'
       AND kind = 'question' AND message_ts IS NOT NULL ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(workspaceId, channelId, threadTs) as DbRow | undefined
  return r && toRow(r)
}

export function listOpenSlackQuestions(workspaceId: string): SlackQuestionRow[] {
  return (
    getDb()
      .prepare("SELECT * FROM slack_questions WHERE workspace_id = ? AND state = 'open'")
      .all(workspaceId) as DbRow[]
  ).map(toRow)
}

/** Workspaces the periodic pass must look at: mirroring enabled, or a question still shown. */
export function listSlackQuestionWorkspaces(): string[] {
  return (
    getDb()
      .prepare(
        `SELECT id FROM workspaces WHERE slack_channel_id IS NOT NULL AND slack_question_mirror != 'never'
         UNION SELECT workspace_id FROM slack_questions WHERE state = 'open'`,
      )
      .all() as { id: string }[]
  ).map((r) => r.id)
}

/**
 * Compare-and-set of one answer: accepted only while the row is open on question `index` shown by
 * `messageTs`. Of two racing answers only one statement can match. The last answer moves the row
 * to `submitting`, so the tool call is submitted by that single winner. Any other answer clears
 * `message_ts` until the next question is on screen, so nothing can be claimed in between.
 */
export function claimSlackQuestionAnswer(row: SlackQuestionRow, answer: CollectedAnswer, last: boolean): boolean {
  if (!row.messageTs) return false
  return (
    getDb()
      .prepare(
        `UPDATE slack_questions SET answers = ?, question_index = ?, state = ?, updated_at = ?,
           message_ts = CASE WHEN ? THEN message_ts ELSE NULL END
         WHERE ${KEY} AND state = 'open' AND question_index = ? AND message_ts = ?`,
      )
      .run(
        JSON.stringify([...row.answers, answer]),
        row.questionIndex + 1,
        last ? 'submitting' : 'open',
        now(),
        last ? 1 : 0,
        ...keyArgs(row),
        row.questionIndex,
        row.messageTs,
      ).changes === 1
  )
}

/** The next question of the tool call is now on screen. */
export function showNextSlackQuestion(key: SlackQuestionKey, index: number, messageTs: string, text: string): boolean {
  return (
    getDb()
      .prepare(
        `UPDATE slack_questions SET message_ts = ?, message_text = ?, updated_at = ?
         WHERE ${KEY} AND state = 'open' AND question_index = ? AND message_ts IS NULL`,
      )
      .run(messageTs, text, now(), ...keyArgs(key), index).changes === 1
  )
}

/** open (or submitting) -> a terminal state. False when someone else already closed the row. */
export function closeSlackQuestion(
  key: SlackQuestionKey,
  from: 'open' | 'submitting',
  to: 'answered' | 'closed',
): boolean {
  return (
    getDb()
      .prepare(`UPDATE slack_questions SET state = ?, updated_at = ? WHERE ${KEY} AND state = ?`)
      .run(to, now(), ...keyArgs(key), from).changes === 1
  )
}

/**
 * Pending inputs live in memory only: every unfinished row belongs to a previous process. Returns
 * the rows that still showed controls so their message can say so.
 */
export function closeStaleSlackQuestions(): SlackQuestionRow[] {
  const db = getDb()
  return db.transaction(() => {
    const open = (db.prepare("SELECT * FROM slack_questions WHERE state = 'open'").all() as DbRow[]).map(toRow)
    db.prepare(
      "UPDATE slack_questions SET state = 'closed', updated_at = ? WHERE state IN ('posting', 'open', 'submitting')",
    ).run(now())
    return open
  })()
}
