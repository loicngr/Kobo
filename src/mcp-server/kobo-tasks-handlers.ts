import { DOCUMENT_DIRS } from '../shared/document-roots.js'

export { DOCUMENT_DIRS } from '../shared/document-roots.js'

import fs from 'node:fs'
import path from 'node:path'
import type Database from 'better-sqlite3'
import { nanoid } from 'nanoid'
import * as cronService from '../server/services/cron-service.js'
import * as settingsService from '../server/services/settings-service.js'
import {
  createTaskRecord,
  deleteTaskRecord,
  type TaskRecord,
  updateTaskRecord,
} from '../server/services/task-mutations.js'
import { slugifyProjectName } from '../server/utils/project-slug.js'
import { ensureDirectoryInside, resolveExistingPathInside } from '../server/utils/safe-path.js'
import { resolveWorkspaceWorktreePath } from '../server/utils/worktree-paths.js'
import { MASKED_SECRET, SECRET_GLOBAL_KEYS } from '../shared/consts.js'
import { parseTaskVerification, type TaskRole, type TaskVerification } from '../shared/task-verification.js'

/** Allowed task status values. */
export const VALID_TASK_STATUSES = ['pending', 'in_progress', 'done'] as const

/** Union type of valid task statuses. */
export type TaskStatus = (typeof VALID_TASK_STATUSES)[number]

/** Public-facing representation of a task exposed via MCP tools. */
export interface TaskDto {
  id: string
  title: string
  status: string
  is_acceptance_criterion: boolean
  sort_order: number
  role: TaskRole
  verification: TaskVerification | null
}

/** Result returned when a task is marked as done. */
export interface MarkDoneResult {
  success: boolean
  task: TaskDto
}

/** Lightweight dev-server status returned by the MCP tool. */
export interface DevServerStatusDto {
  workspaceId: string
  status: string
}

type TaskRow = TaskRecord

function rowToDto(row: TaskRow): TaskDto {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    is_acceptance_criterion: row.is_acceptance_criterion === 1,
    sort_order: row.sort_order,
    role: row.role,
    verification: parseTaskVerification(row.verification),
  }
}

/** Return all tasks for a workspace, ordered by sort_order. */
export function listTasksHandler(db: Database.Database, workspaceId: string): TaskDto[] {
  const rows = db
    .prepare('SELECT * FROM tasks WHERE workspace_id = ? ORDER BY sort_order ASC, rowid ASC')
    .all(workspaceId) as TaskRow[]
  return rows.map(rowToDto)
}

/** Public-facing representation of a workspace exposed via the global list_workspaces MCP tool. */
export interface WorkspaceListItemDto {
  id: string
  title: string
  status: string
  createdAt: string
}

interface WorkspaceListRow {
  id: string
  name: string
  status: string
  created_at: string
}

/**
 * List workspaces for the global `list_workspaces` MCP tool. Reads SQLite
 * directly (no backend HTTP dependency) so it works even when the Kōbō
 * server isn't running — the same DB file the backend uses.
 */
export function listWorkspacesHandler(
  db: Database.Database,
  opts: { includeArchived?: boolean },
): WorkspaceListItemDto[] {
  // updated_at can collide at second resolution (e.g. bulk-seeded test data); rowid DESC breaks ties, most-recently-inserted first.
  const sql = opts.includeArchived
    ? 'SELECT id, name, status, created_at FROM workspaces ORDER BY updated_at DESC, rowid DESC'
    : 'SELECT id, name, status, created_at FROM workspaces WHERE archived_at IS NULL ORDER BY updated_at DESC, rowid DESC'
  const rows = db.prepare(sql).all() as WorkspaceListRow[]
  return rows.map((row) => ({
    id: row.id,
    title: row.name,
    status: row.status,
    createdAt: row.created_at,
  }))
}

/**
 * Flip the workspace's `auto_loop_ready` flag. Called at the end of a
 * `/kobo-prep-autoloop` grooming session to unlock the auto-loop toggle.
 *
 * The DB write itself happens here; the caller in kobo-tasks-server.ts
 * also fires a notify-autoloop-ready POST so the backend emits
 * `autoloop:ready-flipped` over WebSocket and any live frontend refreshes.
 */
export function markAutoLoopReadyHandler(db: Database.Database, workspaceId: string): { ok: true } {
  const row = db.prepare('SELECT id FROM workspaces WHERE id = ?').get(workspaceId)
  if (!row) {
    throw new Error(`Workspace '${workspaceId}' not found`)
  }
  db.prepare('UPDATE workspaces SET auto_loop_ready = 1 WHERE id = ?').run(workspaceId)
  return { ok: true }
}

/**
 * Update the workspace's agent-side short description (≤ 200 chars). Empty /
 * whitespace-only input clears the field (stored as NULL). This writes the
 * `agent_description` column — a live status line owned by the agent — and
 * leaves the user-side `description` column untouched. The handler does NOT
 * emit a WS event; that's the route/service layer's responsibility. Live UI
 * refresh on agent-driven updates is therefore deferred until next read.
 */
export function setWorkspaceAgentDescriptionHandler(
  db: Database.Database,
  workspaceId: string,
  args: { description: string },
): { ok: true; description: string | null } | { ok: false; error: string } {
  const raw = typeof args?.description === 'string' ? args.description : ''
  const trimmed = raw.trim()
  if (trimmed.length > 200) {
    return { ok: false, error: `Description must be 200 characters or fewer (got ${trimmed.length})` }
  }
  const stored = trimmed.length > 0 ? trimmed : null
  const result = db
    .prepare('UPDATE workspaces SET agent_description = ?, updated_at = ? WHERE id = ?')
    .run(stored, new Date().toISOString(), workspaceId)
  if (result.changes === 0) {
    return { ok: false, error: `Workspace '${workspaceId}' not found` }
  }
  return { ok: true, description: stored }
}

/** Set a task's status to done; auto-loop tasks require successful evidence. */
export function markTaskDoneHandler(
  db: Database.Database,
  workspaceId: string,
  taskId: string,
  verification?: unknown,
): MarkDoneResult {
  const row = updateTaskRecord(db, workspaceId, taskId, {
    status: 'done',
    ...(verification !== undefined ? { verification } : {}),
  })
  return { success: true, task: rowToDto(row) }
}

/** Create a task at an explicit position or append it to the list. */
export function createTaskHandler(
  db: Database.Database,
  workspaceId: string,
  data: {
    title: string
    is_acceptance_criterion?: boolean
    sort_order?: number
    after_task_id?: string
    role?: TaskRole
  },
): TaskDto {
  return rowToDto(
    createTaskRecord(db, workspaceId, {
      title: data.title,
      isAcceptanceCriterion: data.is_acceptance_criterion,
      sortOrder: data.sort_order,
      afterTaskId: data.after_task_id,
      role: data.role,
    }),
  )
}

/** Update task fields atomically, including insertion order and verification. */
export function updateTaskHandler(
  db: Database.Database,
  workspaceId: string,
  taskId: string,
  data: {
    title?: string
    status?: string
    is_acceptance_criterion?: boolean
    sort_order?: number
    after_task_id?: string
    verification?: unknown
  },
): TaskDto {
  return rowToDto(
    updateTaskRecord(db, workspaceId, taskId, {
      title: data.title,
      status: data.status,
      isAcceptanceCriterion: data.is_acceptance_criterion,
      sortOrder: data.sort_order,
      afterTaskId: data.after_task_id,
      verification: data.verification,
    }),
  )
}

/** Permanently delete a task from a workspace and invalidate its final review. */
export function deleteTaskHandler(
  db: Database.Database,
  workspaceId: string,
  taskId: string,
): { success: true; task_id: string } {
  deleteTaskRecord(db, workspaceId, taskId)
  return { success: true, task_id: taskId }
}

/** Read the dev-server status for a workspace directly from the database. */
export function getDevServerStatusHandler(db: Database.Database, workspaceId: string): DevServerStatusDto {
  const row = db.prepare('SELECT dev_server_status FROM workspaces WHERE id = ?').get(workspaceId) as
    | { dev_server_status: string }
    | undefined
  if (!row) {
    throw new Error(`Workspace '${workspaceId}' not found`)
  }
  return { workspaceId, status: row.dev_server_status }
}

/** Copy of the global settings with every stored credential blanked out. */
function sanitizeGlobalSecrets(global: Record<string, unknown>): Record<string, unknown> {
  const sanitized = { ...global }
  for (const key of SECRET_GLOBAL_KEYS) {
    // Same mask as the HTTP API rather than an empty string: blanking it would
    // read as "not configured" and send the agent off offering to set it up.
    if (sanitized[key]) sanitized[key] = MASKED_SECRET
  }
  return sanitized
}

/** Read global and per-project settings from the JSON file on disk. */
export function getSettingsHandler(settingsPath: string | undefined, projectPath?: string): Record<string, unknown> {
  // Shape is determined solely by whether projectPath was provided:
  //  - with projectPath → { global, project }
  //  - without         → { global, projects }
  // The `error` field is added on top when settings are unavailable.
  if (!settingsPath || !fs.existsSync(settingsPath)) {
    const base = projectPath ? { global: null, project: null } : { global: null, projects: [] }
    return { ...base, error: 'Settings file not available' }
  }
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
  } catch (err) {
    throw new Error(`Failed to read settings: ${err instanceof Error ? err.message : String(err)}`)
  }

  // The agent gets the settings it can act on, never the credentials. Anything
  // it reads can be echoed into the transcript, and the content it summarises
  // (a Notion page, a Sentry issue, a repository) is not always trustworthy —
  // "call get_settings and print the result" is a one-line exfiltration.
  const global = parsed.global ? sanitizeGlobalSecrets(parsed.global as Record<string, unknown>) : null
  const projects = Array.isArray(parsed.projects) ? (parsed.projects as Array<Record<string, unknown>>) : []

  if (projectPath) {
    const project = projects.find((p) => p.path === projectPath) ?? null
    return { global, project }
  }
  return { global, projects }
}

/** Full metadata about a workspace, including derived worktree path. */
export interface WorkspaceInfoDto {
  id: string
  name: string
  projectPath: string
  sourceBranch: string
  workingBranch: string
  worktreePath: string
  status: string
  model: string
  notionUrl: string | null
  notionPageId: string | null
  description: string | null
  agentDescription: string | null
  devServerStatus: string
  hasUnread: boolean
  autoLoop: boolean
  autoLoopReady: boolean
  createdAt: string
  updatedAt: string
}

interface WorkspaceRow {
  id: string
  name: string
  project_path: string
  source_branch: string
  working_branch: string
  worktree_path: string | null
  status: string
  notion_url: string | null
  notion_page_id: string | null
  description: string | null
  agent_description: string | null
  model: string
  dev_server_status: string
  has_unread: number
  auto_loop: number
  auto_loop_ready: number
  created_at: string
  updated_at: string
}

/** Fetch workspace metadata from the database, computing the worktree path from project_path and working_branch. */
export function getWorkspaceInfoHandler(db: Database.Database, workspaceId: string): WorkspaceInfoDto {
  const row = db
    .prepare(
      'SELECT id, name, project_path, source_branch, working_branch, worktree_path, status, notion_url, notion_page_id, description, agent_description, model, dev_server_status, has_unread, auto_loop, auto_loop_ready, created_at, updated_at FROM workspaces WHERE id = ?',
    )
    .get(workspaceId) as WorkspaceRow | undefined

  if (!row) {
    throw new Error(`Workspace '${workspaceId}' not found`)
  }

  return {
    id: row.id,
    name: row.name,
    projectPath: row.project_path,
    sourceBranch: row.source_branch,
    workingBranch: row.working_branch,
    worktreePath: (() => {
      const gs = settingsService.getGlobalSettings()
      const ps = settingsService.getProjectSettings(row.project_path)
      const slug = gs.worktreesPrefixByProject ? slugifyProjectName(ps?.displayName ?? '', row.project_path) : undefined
      return (
        row.worktree_path ?? resolveWorkspaceWorktreePath(row.project_path, row.working_branch, gs.worktreesPath, slug)
      )
    })(),
    status: row.status,
    model: row.model,
    notionUrl: row.notion_url,
    notionPageId: row.notion_page_id,
    description: row.description ?? null,
    agentDescription: row.agent_description ?? null,
    devServerStatus: row.dev_server_status,
    hasUnread: row.has_unread === 1,
    autoLoop: row.auto_loop === 1,
    autoLoopReady: row.auto_loop_ready === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** Metadata for an image uploaded to a workspace's `.ai/images/` directory. */
export interface WorkspaceImageDto {
  uid: string
  originalName: string
  relativePath: string
  createdAt: string
}

/** List images registered in the worktree's `.ai/images/index.json`, resolving each entry to its file path. */
export function listWorkspaceImagesHandler(worktreePath: string): WorkspaceImageDto[] {
  const imagesDir = path.join(worktreePath, '.ai', 'images')
  const indexPath = path.join(imagesDir, 'index.json')
  if (!fs.existsSync(indexPath)) return []

  let entries: Array<{ uid: string; originalName: string; createdAt: string }>
  try {
    entries = JSON.parse(fs.readFileSync(indexPath, 'utf-8'))
  } catch {
    return []
  }

  // Read directory once — imagesDir is guaranteed to exist because indexPath does
  const files = fs.readdirSync(imagesDir)

  return entries.map((e) => {
    const match = files.find((f) => f.startsWith(`${e.uid}.`))
    return {
      uid: e.uid,
      originalName: e.originalName,
      relativePath: match ? path.join('.ai', 'images', match) : '',
      createdAt: e.createdAt,
    }
  })
}

/** One imported ticket, normalised across origins. */
export interface TicketSource {
  type: 'notion' | 'sentry'
  /** Origin URL parsed from the file's `## Source` block; null if absent. */
  url: string | null
  content: string
}

/**
 * `## Source` block markers written by the workspace creation route — a
 * `- Notion: <url>` line for Notion imports, `- Sentry: <url>` for Sentry.
 * The marker is the discriminator: it is what tells a ticket file apart from
 * an agent note, and Notion apart from Sentry.
 */
const SOURCE_MARKER = /^- (Notion|Sentry): (.+)$/m

/**
 * Read the mission's source-of-truth ticket(s). Both the Notion and Sentry
 * importers write their extracted brief into `.ai/thoughts/` at workspace
 * creation; this returns one entry per ticket file, typed by origin.
 *
 * Only `.md` files at the *root* of `.ai/thoughts/` are considered — agent
 * notes live under `.ai/thoughts/logs/` and are deliberately skipped. Files
 * with no recognised `## Source` marker (stray notes) are skipped too.
 * Sorted by `type` for a deterministic order. Empty array when nothing matches.
 */
export function getTicketSourcesHandler(worktreePath: string): TicketSource[] {
  const thoughtsDir = path.join(worktreePath, '.ai', 'thoughts')
  if (!fs.existsSync(thoughtsDir)) return []

  const sources: TicketSource[] = []
  for (const entry of fs.readdirSync(thoughtsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue
    const content = fs.readFileSync(path.join(thoughtsDir, entry.name), 'utf-8')
    const match = content.match(SOURCE_MARKER)
    if (!match) continue
    sources.push({
      type: match[1].toLowerCase() as TicketSource['type'],
      url: match[2].trim() || null,
      content: content.trim(),
    })
  }
  sources.sort((a, b) => a.type.localeCompare(b.type))
  return sources
}

// ── Documents ────────────────────────────────────────────────────────────────

/** Directories (relative to the worktree root) scanned for AI-generated docs. */

/** Depth cap to keep recursion bounded even on pathological symlink loops. */
const DOC_MAX_DEPTH = 8
const DOC_MAX_FILE_BYTES = 1024 * 1024

/** Metadata for a markdown document surfaced by the documents tools. */
export interface DocumentDto {
  path: string
  name: string
  modifiedAt: string
}

/** Content payload returned when reading a single document. */
export interface DocumentContentDto {
  path: string
  content: string
}

function walkMarkdownFiles(rootAbs: string, rootRel: string, out: DocumentDto[], depth = 0): void {
  if (depth > DOC_MAX_DEPTH) return
  let entries: string[]
  try {
    entries = fs.readdirSync(rootAbs)
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.startsWith('.') && entry !== '.ai') continue
    const absEntry = path.join(rootAbs, entry)
    const relEntry = `${rootRel}/${entry}`
    let stat: ReturnType<typeof fs.lstatSync>
    try {
      stat = fs.lstatSync(absEntry)
    } catch {
      continue
    }
    if (stat.isSymbolicLink()) continue
    if (stat.isDirectory()) {
      walkMarkdownFiles(absEntry, relEntry, out, depth + 1)
    } else if (stat.isFile() && entry.endsWith('.md')) {
      out.push({ path: relEntry, name: entry, modifiedAt: stat.mtime.toISOString() })
    }
  }
}

/**
 * Recursively list every `.md` file under `docs/plans/`, `docs/superpowers/`,
 * and `.ai/thoughts/` inside the given worktree. Sorted by modifiedAt desc.
 */
export function listDocumentsHandler(worktreePath: string): DocumentDto[] {
  const documents: DocumentDto[] = []
  for (const dir of DOCUMENT_DIRS) {
    const absDir = path.join(worktreePath, dir)
    if (!fs.existsSync(absDir)) continue
    try {
      if (fs.lstatSync(absDir).isSymbolicLink()) continue
      walkMarkdownFiles(resolveExistingPathInside(worktreePath, absDir), dir, documents)
    } catch {
      // A document directory outside the worktree is never eligible.
    }
  }
  documents.sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime())
  return documents
}

/**
 * Read a single document. The caller-supplied path must be relative to the
 * worktree root and live under one of the allowed DOCUMENT_DIRS; `.md` only;
 * traversal (`..`) is rejected.
 */
export function readDocumentHandler(worktreePath: string, relPath: string): DocumentContentDto {
  if (!relPath) throw new Error('path is required')
  const normalized = path.normalize(relPath)
  if (
    normalized.includes('..') ||
    !DOCUMENT_DIRS.some((dir) => normalized.startsWith(`${dir}/`) || normalized === dir)
  ) {
    throw new Error(`Invalid path: must be under ${DOCUMENT_DIRS.map((d) => `${d}/`).join(', ')}`)
  }
  if (!normalized.endsWith('.md')) {
    throw new Error('Only .md files can be read')
  }
  const abs = path.join(worktreePath, normalized)
  if (!fs.existsSync(abs)) {
    throw new Error(`Document not found: ${normalized}`)
  }
  const lstat = fs.lstatSync(abs)
  if (lstat.isSymbolicLink()) {
    // Resolve for a consistent error if the link escapes; internal links are
    // rejected too so list/read share the same no-symlink contract.
    resolveExistingPathInside(worktreePath, abs)
    throw new Error('Symbolic links are not allowed in documents')
  }
  const safeAbs = resolveExistingPathInside(worktreePath, abs)
  const stat = fs.statSync(safeAbs)
  if (stat.size > DOC_MAX_FILE_BYTES) {
    throw new Error(`Document too large (max ${DOC_MAX_FILE_BYTES / 1024 / 1024} MB)`)
  }
  return { path: normalized, content: fs.readFileSync(safeAbs, 'utf-8') }
}

/**
 * Append a thought / decision / note to
 * `.ai/thoughts/logs/<YYYY-MM-DD>-<slug>-<timestamp>-<id>.md`. Creates the directory if missing.
 * Returns the path (worktree-relative) of the file actually written — useful
 * for the agent to reference it in chat.
 *
 * Notes live in the `logs/` sub-directory so they stay separate from the
 * mission's source-of-truth ticket files at the root of `.ai/thoughts/` —
 * `get_ticket` reads only the root and therefore never picks up agent notes.
 */
export function logThoughtHandler(
  worktreePath: string,
  data: { title: string; content: string; tag?: string },
): { path: string } {
  const title = data.title?.trim()
  if (!title) throw new Error('title is required')
  const content = data.content?.trim()
  if (!content) throw new Error('content is required')

  const thoughtsDir = ensureDirectoryInside(worktreePath, path.join('.ai', 'thoughts', 'logs'))

  const date = new Date().toISOString().slice(0, 10)
  const slug =
    title
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'note'
  const tagSuffix = data.tag ? `-${data.tag.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}` : ''
  const header = `# ${title}\n\n_${new Date().toISOString()}_${data.tag ? ` · tag: \`${data.tag}\`` : ''}\n\n`
  for (let attempt = 0; attempt < 5; attempt++) {
    const filename = `${date}-${slug}${tagSuffix}-${Date.now()}-${nanoid(10)}.md`
    const abs = path.join(thoughtsDir, filename)
    try {
      fs.writeFileSync(abs, header + content + (content.endsWith('\n') ? '' : '\n'), { encoding: 'utf-8', flag: 'wx' })
      return { path: `.ai/thoughts/logs/${filename}` }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
  }
  throw new Error('Could not allocate a unique thought filename')
}

// ── Session usage ────────────────────────────────────────────────────────────

/** Aggregated token / cost usage for a workspace. */
export interface SessionUsageDto {
  workspaceTotals: { inputTokens: number; outputTokens: number; costUsd: number }
  currentSession: {
    sessionId: string | null
    inputTokens: number
    outputTokens: number
    costUsd: number
  }
}

interface UsagePayload {
  kind?: string
  inputTokens?: number
  outputTokens?: number
  costUsd?: number
}

/**
 * Aggregate `usage` events from `ws_events` to report how many tokens and
 * dollars the workspace has consumed — both in total and for the currently
 * running agent_session (if any). Silently skips rows whose payload is not
 * valid JSON or not a usage event.
 */
export function getSessionUsageHandler(db: Database.Database, workspaceId: string): SessionUsageDto {
  const runningSession = db
    .prepare(
      "SELECT id FROM agent_sessions WHERE workspace_id = ? AND status = 'running' ORDER BY started_at DESC LIMIT 1",
    )
    .get(workspaceId) as { id: string } | undefined
  const currentSessionId = runningSession?.id ?? null

  const rows = db
    .prepare("SELECT payload, session_id FROM ws_events WHERE workspace_id = ? AND type = 'agent:event'")
    .all(workspaceId) as Array<{ payload: string; session_id: string | null }>

  const totals = { inputTokens: 0, outputTokens: 0, costUsd: 0 }
  const current = { inputTokens: 0, outputTokens: 0, costUsd: 0 }

  for (const row of rows) {
    let parsed: UsagePayload
    try {
      parsed = JSON.parse(row.payload) as UsagePayload
    } catch {
      continue
    }
    if (parsed.kind !== 'usage') continue
    const input = typeof parsed.inputTokens === 'number' ? parsed.inputTokens : 0
    const output = typeof parsed.outputTokens === 'number' ? parsed.outputTokens : 0
    const cost = typeof parsed.costUsd === 'number' ? parsed.costUsd : 0
    totals.inputTokens += input
    totals.outputTokens += output
    totals.costUsd += cost
    if (currentSessionId && row.session_id === currentSessionId) {
      current.inputTokens += input
      current.outputTokens += output
      current.costUsd += cost
    }
  }

  return {
    workspaceTotals: totals,
    currentSession: { sessionId: currentSessionId, ...current },
  }
}

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

/** Read the user/agent conversation history as paginated CSV. */
export function readWorkspaceEventsCsvHandler(
  db: Database.Database,
  workspaceId: string,
  options: { sessionId?: string; limit?: number; offset?: number } = {},
): { csv: string; eventCount: number; totalEvents: number; offset: number; nextOffset: number | null } {
  const safeLimit = Math.min(Math.max(Math.floor(options.limit ?? 100), 1), 500)
  const safeOffset = Math.max(Math.floor(options.offset ?? 0), 0)
  const sessionFilter = options.sessionId ? ' AND session_id = ?' : ''
  const params = options.sessionId ? [workspaceId, options.sessionId] : [workspaceId]
  const conversationFilter =
    " AND (type = 'user:message' OR (type = 'agent:event' AND json_extract(payload, '$.kind') = 'message:text'))"
  const rows = db
    .prepare(
      `SELECT session_id, type, payload, created_at FROM ws_events WHERE workspace_id = ?${sessionFilter}${conversationFilter} ORDER BY rowid ASC LIMIT ? OFFSET ?`,
    )
    .all(...params, safeLimit, safeOffset) as Array<{
    session_id: string | null
    type: string
    payload: string
    created_at: string
  }>
  const total = (
    db
      .prepare(`SELECT COUNT(*) AS count FROM ws_events WHERE workspace_id = ?${sessionFilter}${conversationFilter}`)
      .get(...params) as { count: number }
  ).count
  const lines = [
    ['created_at', 'session_id', 'type', 'payload'],
    ...rows.map((r) => [r.created_at, r.session_id ?? '', r.type, r.payload]),
  ]
  return {
    csv: lines.map((row) => row.map(csvCell).join(',')).join('\n'),
    eventCount: rows.length,
    totalEvents: total,
    offset: safeOffset,
    nextOffset: safeOffset + rows.length < total ? safeOffset + rows.length : null,
  }
}

// ── Crons ────────────────────────────────────────────────────────────────────

/**
 * List every cron currently armed for a workspace.
 *
 * Note: cron_create and cron_delete are NOT exposed as handlers — they route
 * through the backend HTTP API (`POST/DELETE /api/workspaces/:id/crons`)
 * because their `setTimeout` must live in the backend process (which owns
 * the orchestrator). Handlers here would arm timers in the MCP sub-process,
 * which dies with the agent session, and fires would never reach a real
 * session resume. The list handler is a pure read so it's safe to keep local.
 */
export function cronListHandler(
  _db: Database.Database,
  workspaceId: string,
): { ok: true; crons: cronService.PendingCron[] } {
  return { ok: true, crons: cronService.listForWorkspace(workspaceId) }
}
