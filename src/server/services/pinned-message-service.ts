import { nanoid } from 'nanoid'
import type {
  PinnedEvent,
  PinnedMessage,
  PinnedMessageDetail,
  PinnedMessagesPage,
} from '../../shared/pinned-messages.js'
import { getDb } from '../db/index.js'
import { broadcastAll } from './websocket-service.js'

const MAX_EVENTS = 20_000
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024

export class PinnedMessageError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 404 | 413 = 400,
  ) {
    super(message)
  }
}

interface SessionRow {
  id: string
  engine_session_id: string | null
}
interface EventRow {
  id: string
  workspace_id: string
  session_id: string | null
  type: string
  payload: string
  created_at: string
}
interface PinRow {
  id: string
  workspace_id: string
  workspace_name: string
  session_id: string | null
  session_name: string | null
  event_id: string
  item_keys: string
  speaker: 'user' | 'agent'
  preview: string
  message_created_at: string
  created_at: string
  archived: number
  source_available: number
}

const summarySelect = `SELECT p.id, p.workspace_id, w.name AS workspace_name, p.session_id, s.name AS session_name,
  p.event_id, p.item_keys, p.speaker, p.preview, p.message_created_at, p.created_at,
  (w.archived_at IS NOT NULL) AS archived,
  NOT EXISTS (SELECT 1 FROM json_each(p.event_ids) ids WHERE NOT EXISTS (
    SELECT 1 FROM ws_events e WHERE e.id = ids.value AND e.workspace_id = p.workspace_id
  )) AS source_available
  FROM pinned_messages p JOIN workspaces w ON w.id = p.workspace_id
  LEFT JOIN agent_sessions s ON s.id = p.session_id`

function summary(row: PinRow): PinnedMessage {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    workspaceName: row.workspace_name,
    sessionId: row.session_id,
    sessionName: row.session_name,
    eventId: row.event_id,
    itemKeys: JSON.parse(row.item_keys),
    speaker: row.speaker,
    preview: row.preview,
    messageCreatedAt: row.message_created_at,
    createdAt: row.created_at,
    archived: Boolean(row.archived),
    sourceAvailable: Boolean(row.source_available),
  }
}

function readSummary(id: string): PinnedMessage {
  const row = getDb().prepare(`${summarySelect} WHERE p.id = ?`).get(id) as PinRow | undefined
  if (!row) throw new PinnedMessageError(`Pinned message '${id}' not found`, 404)
  return summary(row)
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value
}

function canonicalSession(tag: string | null, sessions: SessionRow[]): string | null {
  if (tag === null) return sessions[0]?.id ?? null
  const session = sessions.find((s) => s.id === tag) ?? sessions.find((s) => s.engine_session_id === tag)
  if (!session) throw new PinnedMessageError('Event session does not belong to this workspace')
  return session.id
}

function parseEvent(row: EventRow, sessionId: string | null): PinnedEvent {
  let payload: unknown
  try {
    payload = JSON.parse(row.payload)
  } catch {
    throw new PinnedMessageError('Invalid persisted event payload')
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload))
    throw new PinnedMessageError('Invalid persisted event payload')
  if (row.type !== 'user:message' && row.type !== 'agent:event')
    throw new PinnedMessageError('Only visible conversation messages can be pinned')
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    sessionId,
    type: row.type,
    payload: payload as Record<string, unknown>,
    createdAt: row.created_at,
  }
}

function itemKey(event: PinnedEvent): string {
  const p = event.payload
  if (event.type === 'user:message') {
    if (
      typeof p.content !== 'string' ||
      ['system-prompt', 'setup', 'cleanup', 'archive'].includes(String(p.sender)) ||
      String(p.sender).startsWith('hook:')
    )
      throw new PinnedMessageError('Only user and agent cards can be pinned')
    return `user:${event.id}`
  }
  switch (p.kind) {
    case 'message:text':
    case 'message:end':
      if (!validId(p.messageId)) break
      return `text:${p.messageId}`
    case 'message:thinking':
      if (!validId(p.messageId)) break
      return `thinking:${p.messageId}:${event.id}`
    case 'tool:call':
    case 'tool:result':
      if (!validId(p.toolCallId)) break
      return `tool:${p.toolCallId}`
    case 'error':
      if (typeof p.message !== 'string' || p.category === 'quota') break
      // Match the renderer's exclusion of historical CLI warnings.
      // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes by design
      if (p.category === 'other' && /^warning:/i.test(p.message.replace(/\u001b\[\d+m/g, '').trim())) break
      return `error:${event.id}`
  }
  throw new PinnedMessageError('Only visible conversation messages can be pinned')
}

function previewOf(events: PinnedEvent[]): string {
  const text =
    events
      .map((e) =>
        e.type === 'user:message'
          ? e.payload.content
          : e.payload.kind === 'message:text'
            ? e.payload.text
            : e.payload.kind === 'error'
              ? e.payload.message
              : '',
      )
      .join('') ||
    events
      .map((e) =>
        e.payload.kind === 'tool:call' ? e.payload.name : e.payload.kind === 'message:thinking' ? e.payload.text : '',
      )
      .join(' ')
  return text
    .slice(0, 4096)
    .replace(/<[^>]*>/g, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(^|\n)\s{0,3}(?:#{1,6}\s+|>\s*|[-*+]\s+)/g, '$1')
    .replace(/[`*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 280)
}

export function createPinnedMessage(input: unknown): PinnedMessage {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new PinnedMessageError('Expected an object')
  const { workspaceId, eventIds, sessionId: requestedSession } = input as Record<string, unknown>
  if (
    Object.keys(input).some((k) => !['workspaceId', 'eventIds', 'sessionId'].includes(k)) ||
    !validId(workspaceId) ||
    (requestedSession !== undefined && requestedSession !== null && !validId(requestedSession)) ||
    !Array.isArray(eventIds) ||
    !eventIds.length ||
    eventIds.some((id) => !validId(id))
  )
    throw new PinnedMessageError('Invalid workspaceId, sessionId or eventIds')
  if (eventIds.length > MAX_EVENTS) throw new PinnedMessageError('Too many selected events', 413)
  const ids = [...new Set(eventIds as string[])]
  const db = getDb()
  let created = false
  const pin = db.transaction(() => {
    if (!db.prepare('SELECT 1 FROM workspaces WHERE id = ?').get(workspaceId))
      throw new PinnedMessageError(`Workspace '${workspaceId}' not found`, 404)
    const sessions = db
      .prepare('SELECT id, engine_session_id FROM agent_sessions WHERE workspace_id = ? ORDER BY started_at, rowid')
      .all(workspaceId) as SessionRow[]
    const selected: PinnedEvent[] = []
    let selectedBytes = 0
    for (const row of db
      .prepare(
        'SELECT * FROM ws_events WHERE workspace_id = ? AND id IN (SELECT value FROM json_each(?)) ORDER BY rowid',
      )
      .iterate(workspaceId, JSON.stringify(ids)) as Iterable<EventRow>) {
      selectedBytes += Buffer.byteLength(row.payload)
      if (selectedBytes > MAX_SNAPSHOT_BYTES) throw new PinnedMessageError('Pinned snapshot exceeds 8 MiB', 413)
      selected.push(parseEvent(row, canonicalSession(row.session_id, sessions)))
    }
    if (selected.length !== ids.length)
      throw new PinnedMessageError('Selected events are missing or belong to another workspace', 404)
    const sessionId = selected[0].sessionId
    if (
      selected.some((e) => e.sessionId !== sessionId) ||
      (requestedSession !== undefined && canonicalSession(requestedSession as string | null, sessions) !== sessionId)
    )
      throw new PinnedMessageError('Selected events must belong to the same session')
    const speaker = selected[0].type === 'user:message' ? 'user' : 'agent'
    if (selected.some((e) => (e.type === 'user:message' ? 'user' : 'agent') !== speaker))
      throw new PinnedMessageError('Selected events must belong to the same speaker')
    const keys = selected.map(itemKey)
    const existing = db
      .prepare(`SELECT p.id FROM pinned_messages p WHERE workspace_id = ? AND session_id IS ?
      AND EXISTS (SELECT 1 FROM json_each(p.item_keys) k WHERE k.value IN (SELECT value FROM json_each(?)))
      ORDER BY created_at, id LIMIT 1`)
      .get(workspaceId, sessionId, JSON.stringify(keys)) as { id: string } | undefined
    if (existing) return readSummary(existing.id)

    const textIds = selected
      .filter((e) => e.payload.kind === 'message:text' || e.payload.kind === 'message:end')
      .map((e) => e.payload.messageId)
    const toolIds = selected
      .filter((e) => e.payload.kind === 'tool:call' || e.payload.kind === 'tool:result')
      .map((e) => e.payload.toolCallId)
    const session = sessions.find((s) => s.id === sessionId)
    const sessionTags = session ? [session.id, ...(session.engine_session_id ? [session.engine_session_id] : [])] : []
    const includeNull = sessionId === (sessions[0]?.id ?? null)
    const events: PinnedEvent[] = []
    let bytes = 2
    // Expand logical text/tool fragments across pagination boundaries, without retaining unrelated turns.
    const rows = db
      .prepare(`SELECT * FROM ws_events WHERE workspace_id = ?
      AND (session_id IN (SELECT value FROM json_each(?)) OR (? AND session_id IS NULL))
      AND (id IN (SELECT value FROM json_each(?)) OR (type = 'agent:event' AND json_valid(payload) AND (
        (json_extract(payload,'$.kind') IN ('message:text','message:end') AND json_extract(payload,'$.messageId') IN (SELECT value FROM json_each(?)))
        OR (json_extract(payload,'$.kind') IN ('tool:call','tool:result') AND json_extract(payload,'$.toolCallId') IN (SELECT value FROM json_each(?)))
      ))) ORDER BY rowid`)
      .iterate(
        workspaceId,
        JSON.stringify(sessionTags),
        includeNull ? 1 : 0,
        JSON.stringify(ids),
        JSON.stringify(textIds),
        JSON.stringify(toolIds),
      ) as Iterable<EventRow>
    for (const row of rows) {
      if (events.length >= MAX_EVENTS || Buffer.byteLength(row.payload) + bytes > MAX_SNAPSHOT_BYTES)
        throw new PinnedMessageError('Pinned snapshot exceeds its size limit', 413)
      const event = parseEvent(row, sessionId)
      itemKey(event)
      bytes += Buffer.byteLength(JSON.stringify(event)) + (events.length ? 1 : 0)
      if (bytes > MAX_SNAPSHOT_BYTES) throw new PinnedMessageError('Pinned snapshot exceeds 8 MiB', 413)
      events.push(event)
    }
    if (
      !events.some((e) => e.type === 'user:message' || !['message:end', 'tool:result'].includes(String(e.payload.kind)))
    )
      throw new PinnedMessageError('No visible source message remains')
    const id = nanoid()
    db.prepare(
      `INSERT INTO pinned_messages (id,workspace_id,session_id,event_id,event_ids,item_keys,speaker,preview,message_created_at,created_at,snapshot) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      id,
      workspaceId,
      sessionId,
      events[0].id,
      JSON.stringify(events.map((e) => e.id)),
      JSON.stringify([...new Set(events.map(itemKey))]),
      speaker,
      previewOf(events),
      events[0].createdAt,
      new Date().toISOString(),
      JSON.stringify(events),
    )
    created = true
    return readSummary(id)
  })()
  if (created) broadcastAll('pins:changed', { workspaceId })
  return pin
}

export function listPinnedMessages(
  options: { workspaceId?: string; limit?: number; offset?: number } = {},
): PinnedMessagesPage {
  const { workspaceId, limit = 50, offset = 0 } = options
  if (
    (workspaceId !== undefined && !validId(workspaceId)) ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    !Number.isSafeInteger(offset) ||
    offset < 0
  )
    throw new PinnedMessageError('Invalid workspaceId or pagination')
  const rows = getDb()
    .prepare(
      `${summarySelect} ${workspaceId ? 'WHERE p.workspace_id = ?' : ''} ORDER BY p.created_at DESC, p.id DESC LIMIT ? OFFSET ?`,
    )
    .all(...(workspaceId ? [workspaceId] : []), limit + 1, offset) as PinRow[]
  return { pins: rows.slice(0, limit).map(summary), hasMore: rows.length > limit }
}

export function getPinnedMessage(id: string): PinnedMessageDetail {
  const pin = readSummary(id)
  const row = getDb().prepare('SELECT snapshot FROM pinned_messages WHERE id = ?').get(id) as { snapshot: string }
  return { pin, events: JSON.parse(row.snapshot) }
}

export function deletePinnedMessage(id: string): void {
  const row = getDb().prepare('DELETE FROM pinned_messages WHERE id = ? RETURNING workspace_id').get(id) as
    | { workspace_id: string }
    | undefined
  if (row) broadcastAll('pins:changed', { workspaceId: row.workspace_id })
}
