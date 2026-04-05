import fs from 'node:fs'
import path from 'node:path'
import type Database from 'better-sqlite3'
import { nanoid } from 'nanoid'

export const VALID_TASK_STATUSES = ['pending', 'in_progress', 'done'] as const
export type TaskStatus = (typeof VALID_TASK_STATUSES)[number]

export interface TaskDto {
  id: string
  title: string
  status: string
  is_acceptance_criterion: boolean
}

export interface MarkDoneResult {
  success: boolean
  task: TaskDto
}

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

export function listTasksHandler(db: Database.Database, workspaceId: string): TaskDto[] {
  const rows = db
    .prepare(
      'SELECT id, title, status, is_acceptance_criterion FROM tasks WHERE workspace_id = ? ORDER BY sort_order ASC',
    )
    .all(workspaceId) as TaskRow[]
  return rows.map(rowToDto)
}

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

export function getDevServerStatusHandler(db: Database.Database, workspaceId: string): DevServerStatusDto {
  const row = db.prepare('SELECT dev_server_status FROM workspaces WHERE id = ?').get(workspaceId) as
    | { dev_server_status: string }
    | undefined
  if (!row) {
    throw new Error(`Workspace '${workspaceId}' not found`)
  }
  return { workspaceId, status: row.dev_server_status }
}

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

// ── Workspace info ─────────────────────────────────────────────────────────────

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
  createdAt: string
  updatedAt: string
}

interface WorkspaceRow {
  id: string
  name: string
  project_path: string
  source_branch: string
  working_branch: string
  status: string
  notion_url: string | null
  notion_page_id: string | null
  model: string
  dev_server_status: string
  created_at: string
  updated_at: string
}

export function getWorkspaceInfoHandler(db: Database.Database, workspaceId: string): WorkspaceInfoDto {
  const row = db
    .prepare(
      'SELECT id, name, project_path, source_branch, working_branch, status, notion_url, notion_page_id, model, dev_server_status, created_at, updated_at FROM workspaces WHERE id = ?',
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
    worktreePath: path.join(row.project_path, '.worktrees', row.working_branch),
    status: row.status,
    model: row.model,
    notionUrl: row.notion_url,
    notionPageId: row.notion_page_id,
    devServerStatus: row.dev_server_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

// ── Workspace images (read from .ai/images/index.json in worktree) ─────────────

export interface WorkspaceImageDto {
  uid: string
  originalName: string
  relativePath: string
  createdAt: string
}

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
