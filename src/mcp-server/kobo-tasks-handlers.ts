import fs from 'node:fs'
import path from 'node:path'
import type Database from 'better-sqlite3'
import { nanoid } from 'nanoid'
import * as settingsService from '../server/services/settings-service.js'
import { slugifyProjectName } from '../server/utils/project-slug.js'
import { resolveWorkspaceWorktreePath } from '../server/utils/worktree-paths.js'

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

interface TaskRow {
  id: string
  title: string
  status: string
  is_acceptance_criterion: number
}

function rowToDto(row: TaskRow): TaskDto {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    is_acceptance_criterion: row.is_acceptance_criterion === 1,
  }
}

/** Return all tasks for a workspace, ordered by sort_order. */
export function listTasksHandler(db: Database.Database, workspaceId: string): TaskDto[] {
  const rows = db
    .prepare(
      'SELECT id, title, status, is_acceptance_criterion FROM tasks WHERE workspace_id = ? ORDER BY sort_order ASC',
    )
    .all(workspaceId) as TaskRow[]
  return rows.map(rowToDto)
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

/** Set a task's status to "done" and return the updated task. */
export function markTaskDoneHandler(db: Database.Database, workspaceId: string, taskId: string): MarkDoneResult {
  const now = new Date().toISOString()
  const result = db
    .prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ? AND workspace_id = ?')
    .run('done', now, taskId, workspaceId)

  if (result.changes === 0) {
    throw new Error(`Task '${taskId}' not found in workspace '${workspaceId}'`)
  }

  const row = db
    .prepare('SELECT id, title, status, is_acceptance_criterion FROM tasks WHERE id = ?')
    .get(taskId) as TaskRow
  return { success: true, task: rowToDto(row) }
}

/** Create a new task appended at the end of the workspace's task list. */
export function createTaskHandler(
  db: Database.Database,
  workspaceId: string,
  data: { title: string; is_acceptance_criterion?: boolean },
): TaskDto {
  if (!data.title?.trim()) {
    throw new Error('title is required')
  }

  // Verify workspace exists
  const ws = db.prepare('SELECT id FROM workspaces WHERE id = ?').get(workspaceId) as { id: string } | undefined
  if (!ws) {
    throw new Error(`Workspace '${workspaceId}' not found`)
  }

  const id = nanoid()
  const now = new Date().toISOString()
  const isAC = data.is_acceptance_criterion ? 1 : 0

  // Append at the end: max(sort_order) + 1
  const maxRow = db
    .prepare('SELECT COALESCE(MAX(sort_order), -1) AS max FROM tasks WHERE workspace_id = ?')
    .get(workspaceId) as { max: number }
  const sortOrder = maxRow.max + 1

  db.prepare(
    'INSERT INTO tasks (id, workspace_id, title, status, is_acceptance_criterion, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(id, workspaceId, data.title.trim(), 'pending', isAC, sortOrder, now, now)

  const row = db.prepare('SELECT id, title, status, is_acceptance_criterion FROM tasks WHERE id = ?').get(id) as TaskRow
  return rowToDto(row)
}

/** Update one or more fields of an existing task (title, status, or acceptance criterion flag). */
export function updateTaskHandler(
  db: Database.Database,
  workspaceId: string,
  taskId: string,
  data: { title?: string; status?: string; is_acceptance_criterion?: boolean },
): TaskDto {
  // Verify task belongs to workspace
  const existing = db.prepare('SELECT id FROM tasks WHERE id = ? AND workspace_id = ?').get(taskId, workspaceId) as
    | { id: string }
    | undefined
  if (!existing) {
    throw new Error(`Task '${taskId}' not found in workspace '${workspaceId}'`)
  }

  const sets: string[] = []
  const values: unknown[] = []

  if (data.title !== undefined) {
    if (!data.title.trim()) throw new Error('title cannot be empty')
    sets.push('title = ?')
    values.push(data.title.trim())
  }
  if (data.status !== undefined) {
    if (!(VALID_TASK_STATUSES as readonly string[]).includes(data.status)) {
      throw new Error(`Invalid status '${data.status}'. Must be one of: ${VALID_TASK_STATUSES.join(', ')}`)
    }
    sets.push('status = ?')
    values.push(data.status)
  }
  if (data.is_acceptance_criterion !== undefined) {
    sets.push('is_acceptance_criterion = ?')
    values.push(data.is_acceptance_criterion ? 1 : 0)
  }

  if (sets.length === 0) {
    throw new Error('No fields to update (provide title, status, or is_acceptance_criterion)')
  }

  sets.push('updated_at = ?')
  values.push(new Date().toISOString())
  values.push(taskId)

  db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...values)

  const row = db
    .prepare('SELECT id, title, status, is_acceptance_criterion FROM tasks WHERE id = ?')
    .get(taskId) as TaskRow
  return rowToDto(row)
}

/** Permanently delete a task from a workspace. */
export function deleteTaskHandler(
  db: Database.Database,
  workspaceId: string,
  taskId: string,
): { success: true; task_id: string } {
  const result = db.prepare('DELETE FROM tasks WHERE id = ? AND workspace_id = ?').run(taskId, workspaceId)
  if (result.changes === 0) {
    throw new Error(`Task '${taskId}' not found in workspace '${workspaceId}'`)
  }
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

  const global = parsed.global ?? null
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
      'SELECT id, name, project_path, source_branch, working_branch, worktree_path, status, notion_url, notion_page_id, model, dev_server_status, has_unread, auto_loop, auto_loop_ready, created_at, updated_at FROM workspaces WHERE id = ?',
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

// ── Documents ────────────────────────────────────────────────────────────────

/** Directories (relative to the worktree root) scanned for AI-generated docs. */
export const DOCUMENT_DIRS = ['docs/plans', 'docs/superpowers', '.ai/thoughts'] as const

/** Depth cap to keep recursion bounded even on pathological symlink loops. */
const DOC_MAX_DEPTH = 8

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
    let stat: ReturnType<typeof fs.statSync>
    try {
      stat = fs.statSync(absEntry)
    } catch {
      continue
    }
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
    walkMarkdownFiles(absDir, dir, documents)
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
  return { path: normalized, content: fs.readFileSync(abs, 'utf-8') }
}

/**
 * Append a thought / decision / note to `.ai/thoughts/<YYYY-MM-DD>-<slug>.md`.
 * Creates the directory if missing. Returns the path (worktree-relative) of
 * the file actually written — useful for the agent to reference it in chat.
 */
export function logThoughtHandler(
  worktreePath: string,
  data: { title: string; content: string; tag?: string },
): { path: string } {
  const title = data.title?.trim()
  if (!title) throw new Error('title is required')
  const content = data.content?.trim()
  if (!content) throw new Error('content is required')

  const thoughtsDir = path.join(worktreePath, '.ai', 'thoughts')
  fs.mkdirSync(thoughtsDir, { recursive: true })

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
  const filename = `${date}-${slug}${tagSuffix}.md`
  const abs = path.join(thoughtsDir, filename)
  const relPath = `.ai/thoughts/${filename}`

  const header = `# ${title}\n\n_${new Date().toISOString()}_${data.tag ? ` · tag: \`${data.tag}\`` : ''}\n\n`
  fs.writeFileSync(abs, header + content + (content.endsWith('\n') ? '' : '\n'), 'utf-8')

  return { path: relPath }
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
