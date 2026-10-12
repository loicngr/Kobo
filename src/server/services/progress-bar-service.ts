import { createHash } from 'node:crypto'
import { nanoid } from 'nanoid'
import {
  type CreateProgressBarInput,
  type FinishProgressBarInput,
  PROGRESS_MAX_RETAINED,
  PROGRESS_MAX_RUNNING,
  type ProgressBar,
  type ProgressBarList,
  type ProgressOwner,
  type ProgressScope,
  type UpdateProgressBarInput,
} from '../../shared/progress-bars.js'
import { getDb } from '../db/index.js'
import { emitEphemeral } from './websocket-service.js'

export class ProgressBarError extends Error {
  constructor(
    public status: 400 | 403 | 404 | 409 | 429,
    public code: string,
    message: string,
    public retryAfterMs?: number,
  ) {
    super(message)
    this.name = 'ProgressBarError'
  }
}
interface StoredBar {
  id: string
  workspace_id: string
  session_id: string
  owner_kind: string
  owner_launch_id: string
  activity_key: string
  creation_fingerprint: string
  producer_fingerprint: string | null
  producer_updated_at: string | null
  label: string
  step: string | null
  current: number | null
  total: number | null
  status: ProgressBar['status']
  dismissed_at: string | null
  completed_at: string | null
  created_at: string
  updated_at: string
  revision: number
  sequence: number
}
function publicBar(row: StoredBar): ProgressBar {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
    label: row.label,
    step: row.step,
    current: row.current,
    total: row.total,
    status: row.status,
    dismissed: row.dismissed_at !== null,
    dismissedAt: row.dismissed_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revision: row.revision,
    sequence: row.sequence,
  }
}
function invalid(message: string): never {
  throw new ProgressBarError(400, 'invalid_input', message)
}
function text(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    invalid(`${name} must be nonempty text up to ${max} characters`)
  return value
}
function stepText(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || value.length > 500) invalid('step must be text up to 500 characters or null')
  return value
}
function pair(current: unknown, total: unknown): { current: number | null; total: number | null } {
  if (current === null && total === null) return { current: null, total: null }
  if (
    typeof current !== 'number' ||
    typeof total !== 'number' ||
    !Number.isFinite(current) ||
    !Number.isFinite(total) ||
    total <= 0 ||
    current < 0 ||
    current > total
  )
    invalid('current and total must be paired finite numbers with 0 <= current <= total and total > 0, or both null')
  return { current, total }
}
export function validateProgressScope(scope: ProgressScope): void {
  text(scope.workspaceId, 'workspaceId', 200)
  text(scope.sessionId, 'sessionId', 200)
  if (
    !getDb()
      .prepare('SELECT id FROM agent_sessions WHERE id=? AND workspace_id=?')
      .get(scope.sessionId, scope.workspaceId)
  )
    throw new ProgressBarError(
      404,
      'session_not_found',
      'Session does not belong to this workspace or no longer exists',
    )
}
function validateOwner(owner: ProgressOwner): void {
  validateProgressScope(owner)
  if (owner.kind !== 'internal' && owner.kind !== 'external') invalid('Invalid progress owner')
  if (owner.kind === 'internal') text(owner.launchId, 'launchId', 200)
}
function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}
function load(scope: ProgressScope, id: string, owner?: ProgressOwner): StoredBar {
  validateProgressScope(scope)
  text(id, 'progressId', 200)
  const row = getDb()
    .prepare('SELECT * FROM session_progress_bars WHERE id=? AND workspace_id=? AND session_id=?')
    .get(id, scope.workspaceId, scope.sessionId) as StoredBar | undefined
  if (!row) throw new ProgressBarError(404, 'progress_not_found', 'Progress bar does not exist in this session')
  if (owner?.kind === 'internal' && (row.owner_kind !== 'internal' || row.owner_launch_id !== owner.launchId))
    throw new ProgressBarError(403, 'progress_owner_mismatch', 'Progress bar belongs to another launch')
  return row
}
function mutate(operation: () => { row: StoredBar; changed: boolean }): ProgressBar {
  const result = getDb().transaction(operation)()
  const bar = publicBar(result.row)
  if (result.changed) emitEphemeral(bar.workspaceId, 'progress:changed', bar, bar.sessionId)
  return bar
}
export function createProgressBar(owner: ProgressOwner, input: CreateProgressBarInput): ProgressBar {
  return mutate(() => {
    validateOwner(owner)
    const normalized = {
      activityKey: text(input.activityKey, 'activityKey', 100),
      label: text(input.label, 'label', 200),
      step: stepText(input.step),
      ...(input.current === undefined && input.total === undefined
        ? { current: null, total: null }
        : pair(input.current, input.total)),
    }
    const hash = fingerprint(normalized),
      launch = owner.kind === 'internal' ? owner.launchId : ''
    const existing = getDb()
      .prepare(
        'SELECT * FROM session_progress_bars WHERE workspace_id=? AND session_id=? AND owner_kind=? AND owner_launch_id=? AND activity_key=?',
      )
      .get(owner.workspaceId, owner.sessionId, owner.kind, launch, normalized.activityKey) as StoredBar | undefined
    if (existing) {
      if (existing.creation_fingerprint !== hash)
        throw new ProgressBarError(
          409,
          'activity_key_conflict',
          'Activity key already used with different creation inputs',
        )
      return { row: existing, changed: false }
    }
    const counts = getDb()
      .prepare(
        "SELECT count(*) AS total,sum(status='running') AS running FROM session_progress_bars WHERE workspace_id=? AND session_id=?",
      )
      .get(owner.workspaceId, owner.sessionId) as { total: number; running: number }
    if (counts.total >= PROGRESS_MAX_RETAINED || counts.running >= PROGRESS_MAX_RUNNING)
      throw new ProgressBarError(
        409,
        'progress_limit',
        'Session progress bar limit reached; finish running activities or use another session',
      )
    const id = nanoid(),
      now = new Date().toISOString()
    getDb()
      .prepare(
        `INSERT INTO session_progress_bars(id,workspace_id,session_id,owner_kind,owner_launch_id,activity_key,creation_fingerprint,label,step,current,total,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,'running',?,?)`,
      )
      .run(
        id,
        owner.workspaceId,
        owner.sessionId,
        owner.kind,
        launch,
        normalized.activityKey,
        hash,
        normalized.label,
        normalized.step,
        normalized.current,
        normalized.total,
        now,
        now,
      )
    return { row: load(owner, id), changed: true }
  })
}
function update(
  owner: ProgressOwner,
  id: string,
  input: UpdateProgressBarInput | FinishProgressBarInput,
  terminal: boolean,
): ProgressBar {
  return mutate(() => {
    validateOwner(owner)
    const row = load(owner, id, owner)
    if (!Number.isSafeInteger(input.sequence) || input.sequence <= 0)
      invalid('sequence must be a positive safe integer')
    const normalized: Record<string, unknown> = { sequence: input.sequence, operation: terminal ? 'finish' : 'update' }
    if (input.step !== undefined) normalized.step = stepText(input.step)
    let progress = { current: row.current, total: row.total }
    if (terminal) {
      const outcome = (input as FinishProgressBarInput).outcome
      if (outcome !== 'succeeded' && outcome !== 'failed') invalid('outcome must be succeeded or failed')
      normalized.outcome = outcome
    } else {
      const running = input as UpdateProgressBarInput
      if (running.current !== undefined || running.total !== undefined) {
        progress = pair(running.current, running.total)
        normalized.current = progress.current
        normalized.total = progress.total
      }
    }
    const hash = fingerprint(normalized)
    if (input.sequence === row.sequence && hash === row.producer_fingerprint) return { row, changed: false }
    if (row.status !== 'running')
      throw new ProgressBarError(409, 'progress_terminal', 'Progress bar is terminal and cannot be changed')
    if (input.sequence <= row.sequence)
      throw new ProgressBarError(
        409,
        'sequence_conflict',
        'Progress sequence is stale or conflicts with an accepted report',
      )
    const now = new Date().toISOString()
    const retryAfter = row.producer_updated_at ? 1000 - (Date.now() - Date.parse(row.producer_updated_at)) : 0
    if (!terminal && retryAfter > 0)
      throw new ProgressBarError(
        429,
        'progress_rate_limited',
        `Progress update rate limit: retry after ${retryAfter}ms`,
        retryAfter,
      )
    getDb()
      .prepare(
        `UPDATE session_progress_bars SET step=?,current=?,total=?,status=?,completed_at=?,updated_at=?,revision=revision+1,sequence=?,producer_fingerprint=?,producer_updated_at=? WHERE id=?`,
      )
      .run(
        input.step === undefined ? row.step : stepText(input.step),
        progress.current,
        progress.total,
        terminal ? (input as FinishProgressBarInput).outcome : 'running',
        terminal ? now : null,
        now,
        input.sequence,
        hash,
        now,
        id,
      )
    return { row: load(owner, id), changed: true }
  })
}
export function updateProgressBar(owner: ProgressOwner, id: string, input: UpdateProgressBarInput): ProgressBar {
  return update(owner, id, input, false)
}
export function finishProgressBar(owner: ProgressOwner, id: string, input: FinishProgressBarInput): ProgressBar {
  return update(owner, id, input, true)
}
export function dismissProgressBar(scope: ProgressScope, id: string): ProgressBar {
  return mutate(() => {
    const row = load(scope, id)
    if (row.dismissed_at) return { row, changed: false }
    const now = new Date().toISOString()
    getDb()
      .prepare('UPDATE session_progress_bars SET dismissed_at=?,updated_at=?,revision=revision+1 WHERE id=?')
      .run(now, now, id)
    return { row: load(scope, id), changed: true }
  })
}
export function listProgressBars(input: ProgressScope & { limit?: number; offset?: number }): ProgressBarList {
  validateProgressScope(input)
  const limit = input.limit ?? 50,
    offset = input.offset ?? 0
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0)
    invalid('Invalid progress pagination: limit 1..100, nonnegative offset required')
  const rows = getDb()
    .prepare(
      'SELECT * FROM session_progress_bars WHERE workspace_id=? AND session_id=? ORDER BY created_at,id LIMIT ? OFFSET ?',
    )
    .all(input.workspaceId, input.sessionId, limit, offset) as StoredBar[]
  const { totalCount } = getDb()
    .prepare('SELECT count(*) AS totalCount FROM session_progress_bars WHERE workspace_id=? AND session_id=?')
    .get(input.workspaceId, input.sessionId) as { totalCount: number }
  return {
    items: rows.map(publicBar),
    totalCount,
    nextOffset: offset + rows.length < totalCount ? offset + rows.length : null,
    serverTime: new Date().toISOString(),
  }
}
export function interruptProgressBarsForLaunch(launchId: string): number {
  text(launchId, 'launchId', 200)
  const rows = getDb()
    .prepare(
      "SELECT * FROM session_progress_bars WHERE owner_kind='internal' AND owner_launch_id=? AND status='running'",
    )
    .all(launchId) as StoredBar[]
  for (const row of rows)
    mutate(() => {
      const now = new Date().toISOString()
      getDb()
        .prepare(
          "UPDATE session_progress_bars SET status='interrupted',completed_at=?,updated_at=?,revision=revision+1 WHERE id=?",
        )
        .run(now, now, row.id)
      return { row: load({ workspaceId: row.workspace_id, sessionId: row.session_id }, row.id), changed: true }
    })
  return rows.length
}
export function reconcileOrphanedProgressBars(activeLaunchIds: readonly string[] = []): number {
  const active = new Set(activeLaunchIds)
  const rows = getDb()
    .prepare(
      "SELECT DISTINCT owner_launch_id FROM session_progress_bars WHERE owner_kind='internal' AND status='running'",
    )
    .all() as { owner_launch_id: string }[]
  return rows.reduce(
    (total, row) => total + (active.has(row.owner_launch_id) ? 0 : interruptProgressBarsForLaunch(row.owner_launch_id)),
    0,
  )
}
