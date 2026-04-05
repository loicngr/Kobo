import { nanoid } from 'nanoid'
import { getDb } from '../db/index.js'

export type WorkspaceStatus =
  | 'created'
  | 'extracting'
  | 'brainstorming'
  | 'executing'
  | 'completed'
  | 'idle'
  | 'error'
  | 'quota'

export type TaskStatus = 'pending' | 'in_progress' | 'done'

export interface Workspace {
  id: string
  name: string
  projectPath: string
  sourceBranch: string
  workingBranch: string
  status: WorkspaceStatus
  notionUrl: string | null
  notionPageId: string | null
  model: string
  devServerStatus: string
  archivedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface Task {
  id: string
  workspaceId: string
  title: string
  status: TaskStatus
  isAcceptanceCriterion: boolean
  sortOrder: number
  createdAt: string
  updatedAt: string
}

export interface WorkspaceWithTasks extends Workspace {
  tasks: Task[]
}

export interface CreateWorkspaceInput {
  name: string
  projectPath: string
  sourceBranch: string
  workingBranch: string
  notionUrl?: string
  notionPageId?: string
  model?: string
}

export interface CreateTaskInput {
  title: string
  isAcceptanceCriterion?: boolean
  sortOrder?: number
}

// Valid status transitions
const VALID_TRANSITIONS: Record<WorkspaceStatus, WorkspaceStatus[]> = {
  created: ['extracting', 'brainstorming', 'idle', 'error'],
  extracting: ['brainstorming', 'idle', 'error'],
  brainstorming: ['executing', 'completed', 'idle', 'error'],
  executing: ['completed', 'idle', 'error', 'quota'],
  completed: ['idle', 'executing'],
  idle: ['executing', 'brainstorming', 'extracting', 'error'],
  error: ['idle', 'executing', 'brainstorming', 'extracting'],
  quota: ['idle', 'executing'],
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
  archived_at: string | null
  created_at: string
  updated_at: string
}

interface TaskRow {
  id: string
  workspace_id: string
  title: string
  status: string
  is_acceptance_criterion: number
  sort_order: number
  created_at: string
  updated_at: string
}

function mapWorkspace(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    name: row.name,
    projectPath: row.project_path,
    sourceBranch: row.source_branch,
    workingBranch: row.working_branch,
    status: row.status as WorkspaceStatus,
    notionUrl: row.notion_url,
    notionPageId: row.notion_page_id,
    model: row.model,
    devServerStatus: row.dev_server_status,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapTask(row: TaskRow): Task {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    title: row.title,
    status: row.status as TaskStatus,
    isAcceptanceCriterion: row.is_acceptance_criterion === 1,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function createWorkspace(data: CreateWorkspaceInput): Workspace {
  const db = getDb()
  const now = new Date().toISOString()
  const id = nanoid()

  db.prepare(`
    INSERT INTO workspaces (id, name, project_path, source_branch, working_branch, status, notion_url, notion_page_id, model, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'created', ?, ?, ?, ?, ?)
  `).run(
    id,
    data.name,
    data.projectPath,
    data.sourceBranch,
    data.workingBranch,
    data.notionUrl ?? null,
    data.notionPageId ?? null,
    data.model ?? 'claude-opus-4-6',
    now,
    now,
  )

  return getWorkspace(id) as Workspace
}

export function getWorkspace(id: string): Workspace | null {
  const db = getDb()
  const row = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as WorkspaceRow | undefined
  return row ? mapWorkspace(row) : null
}

export function listWorkspaces(includeArchived = false): Workspace[] {
  const db = getDb()
  const sql = includeArchived
    ? 'SELECT * FROM workspaces ORDER BY updated_at DESC'
    : 'SELECT * FROM workspaces WHERE archived_at IS NULL ORDER BY updated_at DESC'
  const rows = db.prepare(sql).all() as WorkspaceRow[]
  return rows.map(mapWorkspace)
}

export function listArchivedWorkspaces(): Workspace[] {
  const db = getDb()
  const rows = db
    .prepare('SELECT * FROM workspaces WHERE archived_at IS NOT NULL ORDER BY archived_at DESC')
    .all() as WorkspaceRow[]
  return rows.map(mapWorkspace)
}

export function updateWorkspaceStatus(id: string, status: WorkspaceStatus): Workspace {
  const db = getDb()
  const workspace = getWorkspace(id)

  if (!workspace) {
    throw new Error(`Workspace '${id}' not found`)
  }

  const allowedTransitions = VALID_TRANSITIONS[workspace.status]
  if (!allowedTransitions.includes(status)) {
    throw new Error(
      `Invalid status transition from '${workspace.status}' to '${status}'. Allowed: ${allowedTransitions.join(', ')}`,
    )
  }

  const now = new Date().toISOString()
  db.prepare('UPDATE workspaces SET status = ?, updated_at = ? WHERE id = ?').run(status, now, id)

  return getWorkspace(id) as Workspace
}

export function updateWorkspaceName(id: string, name: string): Workspace {
  const db = getDb()
  const now = new Date().toISOString()
  db.prepare('UPDATE workspaces SET name = ?, updated_at = ? WHERE id = ?').run(name, now, id)
  return getWorkspace(id) as Workspace
}

export function updateDevServerStatus(id: string, status: string): void {
  const db = getDb()
  db.prepare('UPDATE workspaces SET dev_server_status = ? WHERE id = ?').run(status, id)
}

export function deleteWorkspace(id: string): void {
  const db = getDb()
  db.prepare('DELETE FROM workspaces WHERE id = ?').run(id)
}

export function createTask(workspaceId: string, data: CreateTaskInput): Task {
  const db = getDb()

  // I2: explicit workspace existence check before INSERT
  const exists = db.prepare('SELECT 1 FROM workspaces WHERE id = ?').get(workspaceId)
  if (!exists) {
    throw new Error(`Workspace not found: '${workspaceId}'`)
  }

  const now = new Date().toISOString()
  const id = nanoid()

  db.prepare(`
    INSERT INTO tasks (id, workspace_id, title, status, is_acceptance_criterion, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)
  `).run(id, workspaceId, data.title, data.isAcceptanceCriterion ? 1 : 0, data.sortOrder ?? 0, now, now)

  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow
  return mapTask(row)
}

export function listTasks(workspaceId: string): Task[] {
  const db = getDb()
  const rows = db
    .prepare('SELECT * FROM tasks WHERE workspace_id = ? ORDER BY sort_order ASC')
    .all(workspaceId) as TaskRow[]
  return rows.map(mapTask)
}

export function updateTaskStatus(taskId: string, status: TaskStatus): Task {
  const db = getDb()
  const now = new Date().toISOString()
  db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?').run(status, now, taskId)
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as TaskRow | undefined
  if (!row) {
    throw new Error(`Task '${taskId}' not found`)
  }
  return mapTask(row)
}

export function updateTaskTitle(taskId: string, title: string): Task {
  if (!title?.trim()) {
    throw new Error('Task title cannot be empty')
  }
  const db = getDb()
  const now = new Date().toISOString()
  const result = db.prepare('UPDATE tasks SET title = ?, updated_at = ? WHERE id = ?').run(title.trim(), now, taskId)
  if (result.changes === 0) {
    throw new Error(`Task '${taskId}' not found`)
  }
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as TaskRow
  return mapTask(row)
}

export function deleteTask(taskId: string): void {
  const db = getDb()
  db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId)
}

export function getWorkspaceWithTasks(id: string): WorkspaceWithTasks | null {
  const workspace = getWorkspace(id)
  if (!workspace) return null
  const tasks = listTasks(id)
  return { ...workspace, tasks }
}

export function archiveWorkspace(id: string): Workspace {
  const db = getDb()
  const workspace = getWorkspace(id)
  if (!workspace) {
    throw new Error(`Workspace '${id}' not found`)
  }
  if (workspace.archivedAt) {
    throw new Error(`Workspace '${id}' is already archived`)
  }

  const now = new Date().toISOString()
  db.prepare('UPDATE workspaces SET archived_at = ?, updated_at = ? WHERE id = ?').run(now, now, id)
  return getWorkspace(id) as Workspace
}

export function unarchiveWorkspace(id: string): Workspace {
  const db = getDb()
  const workspace = getWorkspace(id)
  if (!workspace) {
    throw new Error(`Workspace '${id}' not found`)
  }
  if (!workspace.archivedAt) {
    throw new Error(`Workspace '${id}' is not archived`)
  }

  const now = new Date().toISOString()
  db.prepare('UPDATE workspaces SET archived_at = NULL, updated_at = ? WHERE id = ?').run(now, id)
  return getWorkspace(id) as Workspace
}

// ── Agent Sessions ────────────────────────────────────────────────────────────

export interface AgentSession {
  id: string
  workspaceId: string
  pid: number | null
  claudeSessionId: string | null
  status: string
  startedAt: string
  endedAt: string | null
}

interface AgentSessionRow {
  id: string
  workspace_id: string
  pid: number | null
  claude_session_id: string | null
  status: string
  started_at: string
  ended_at: string | null
}

function mapSession(row: AgentSessionRow): AgentSession {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    pid: row.pid,
    claudeSessionId: row.claude_session_id,
    status: row.status,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  }
}

export function listSessions(workspaceId: string): AgentSession[] {
  const db = getDb()
  const rows = db
    .prepare('SELECT * FROM agent_sessions WHERE workspace_id = ? ORDER BY started_at DESC')
    .all(workspaceId) as AgentSessionRow[]
  return rows.map(mapSession)
}

export function getLatestSession(workspaceId: string): AgentSession | null {
  const db = getDb()
  const row = db
    .prepare('SELECT * FROM agent_sessions WHERE workspace_id = ? ORDER BY started_at DESC LIMIT 1')
    .get(workspaceId) as AgentSessionRow | undefined
  return row ? mapSession(row) : null
}
