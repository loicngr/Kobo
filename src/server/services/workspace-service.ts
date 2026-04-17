import { nanoid } from 'nanoid'
import { getDb } from '../db/index.js'

/** Lifecycle states for a workspace. Transitions are validated against VALID_TRANSITIONS. */
export type WorkspaceStatus =
  | 'created'
  | 'extracting'
  | 'brainstorming'
  | 'executing'
  | 'completed'
  | 'idle'
  | 'error'
  | 'quota'

/** Lifecycle states for a task within a workspace. */
export type TaskStatus = 'pending' | 'in_progress' | 'done'

/** Controls how the agent handles permission requests. */
export type PermissionMode = 'auto-accept' | 'plan'

/** A workspace — the primary unit of work in Kobo. */
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
  reasoningEffort: string
  permissionMode: PermissionMode
  devServerStatus: string
  hasUnread: boolean
  archivedAt: string | null
  favoritedAt: string | null
  tags: string[]
  createdAt: string
  updatedAt: string
}

/** A sub-item of a workspace, optionally flagged as an acceptance criterion. */
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

/** A workspace with its associated tasks eagerly loaded. */
export interface WorkspaceWithTasks extends Workspace {
  tasks: Task[]
}

/** Input payload for creating a new workspace. */
export interface CreateWorkspaceInput {
  name: string
  projectPath: string
  sourceBranch: string
  workingBranch: string
  notionUrl?: string
  notionPageId?: string
  model?: string
  reasoningEffort?: string
  permissionMode?: string
}

/** Input payload for creating a new task. */
export interface CreateTaskInput {
  title: string
  isAcceptanceCriterion?: boolean
  sortOrder?: number
}

/** Allowed status transitions per current status. Enforced by updateWorkspaceStatus. */
const VALID_TRANSITIONS: Record<WorkspaceStatus, WorkspaceStatus[]> = {
  created: ['extracting', 'brainstorming', 'idle', 'error'],
  extracting: ['extracting', 'brainstorming', 'idle', 'error'],
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
  reasoning_effort: string
  permission_mode: string
  dev_server_status: string
  has_unread: number
  archived_at: string | null
  favorited_at: string | null
  tags: string | null
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
    reasoningEffort: row.reasoning_effort ?? 'auto',
    permissionMode: (row.permission_mode ?? 'auto-accept') as PermissionMode,
    devServerStatus: row.dev_server_status,
    hasUnread: row.has_unread === 1,
    archivedAt: row.archived_at,
    favoritedAt: row.favorited_at,
    tags: parseTags(row.tags),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** Parse the JSON-serialized tags column to a string[]. Returns [] on null/invalid. */
function parseTags(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((t): t is string => typeof t === 'string')
  } catch {
    return []
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

/** Insert a new workspace into the database and return it. */
export function createWorkspace(data: CreateWorkspaceInput): Workspace {
  const db = getDb()
  const now = new Date().toISOString()
  const id = nanoid()

  db.prepare(`
    INSERT INTO workspaces (id, name, project_path, source_branch, working_branch, status, notion_url, notion_page_id, model, reasoning_effort, permission_mode, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'created', ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    data.name,
    data.projectPath,
    data.sourceBranch,
    data.workingBranch,
    data.notionUrl ?? null,
    data.notionPageId ?? null,
    data.model ?? 'claude-opus-4-7',
    data.reasoningEffort ?? 'auto',
    data.permissionMode ?? 'auto-accept',
    now,
    now,
  )

  return getWorkspace(id) as Workspace
}

/** Fetch a single workspace by ID, or null if not found. */
export function getWorkspace(id: string): Workspace | null {
  const db = getDb()
  const row = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as WorkspaceRow | undefined
  return row ? mapWorkspace(row) : null
}

/** List all workspaces, optionally including archived ones. Ordered by most recently updated. */
export function listWorkspaces(includeArchived = false): Workspace[] {
  const db = getDb()
  const sql = includeArchived
    ? 'SELECT * FROM workspaces ORDER BY updated_at DESC'
    : 'SELECT * FROM workspaces WHERE archived_at IS NULL ORDER BY updated_at DESC'
  const rows = db.prepare(sql).all() as WorkspaceRow[]
  return rows.map(mapWorkspace)
}

/** List only archived workspaces, ordered by archive date descending. */
export function listArchivedWorkspaces(): Workspace[] {
  const db = getDb()
  const rows = db
    .prepare('SELECT * FROM workspaces WHERE archived_at IS NOT NULL ORDER BY archived_at DESC')
    .all() as WorkspaceRow[]
  return rows.map(mapWorkspace)
}

/** Transition a workspace to a new status, validating against VALID_TRANSITIONS. */
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

const WORKSPACE_NAME_MAX_LENGTH = 200

/** Update a workspace's display name. */
export function updateWorkspaceName(id: string, name: string): Workspace {
  // Strip control characters (incl. newlines) and collapse whitespace
  const noControl = Array.from(name, (c) => {
    const code = c.charCodeAt(0)
    return code < 32 || code === 127 ? ' ' : c
  }).join('')
  const sanitized = noControl.replace(/\s+/g, ' ').trim()
  if (!sanitized) {
    throw new Error('Workspace name cannot be empty')
  }
  if (sanitized.length > WORKSPACE_NAME_MAX_LENGTH) {
    throw new Error(`Workspace name cannot exceed ${WORKSPACE_NAME_MAX_LENGTH} characters`)
  }
  const db = getDb()
  const now = new Date().toISOString()
  const result = db.prepare('UPDATE workspaces SET name = ?, updated_at = ? WHERE id = ?').run(sanitized, now, id)
  if (result.changes === 0) {
    throw new Error(`Workspace '${id}' not found`)
  }
  return getWorkspace(id) as Workspace
}

/** Update the Claude model used by a workspace's agent. */
export function updateWorkspaceModel(id: string, model: string): Workspace {
  const db = getDb()
  const now = new Date().toISOString()
  const result = db.prepare('UPDATE workspaces SET model = ?, updated_at = ? WHERE id = ?').run(model, now, id)
  if (result.changes === 0) {
    throw new Error(`Workspace '${id}' not found`)
  }
  return getWorkspace(id) as Workspace
}

/** Update the reasoning effort used by a workspace's agent. */
export function updateWorkspaceReasoningEffort(id: string, reasoningEffort: string): Workspace {
  const db = getDb()
  const now = new Date().toISOString()
  const result = db
    .prepare('UPDATE workspaces SET reasoning_effort = ?, updated_at = ? WHERE id = ?')
    .run(reasoningEffort, now, id)
  if (result.changes === 0) {
    throw new Error(`Workspace '${id}' not found`)
  }
  return getWorkspace(id) as Workspace
}

/** Update the working branch for a workspace (e.g. after ticket ID injection). */
export function updateWorkingBranch(id: string, workingBranch: string): Workspace {
  const db = getDb()
  const now = new Date().toISOString()
  const result = db
    .prepare('UPDATE workspaces SET working_branch = ?, updated_at = ? WHERE id = ?')
    .run(workingBranch, now, id)
  if (result.changes === 0) {
    throw new Error(`Workspace '${id}' not found`)
  }
  return getWorkspace(id) as Workspace
}

/** Update the agent's permission mode (auto-accept vs plan/read-only). */
export function updateWorkspacePermissionMode(id: string, permissionMode: PermissionMode): Workspace {
  const db = getDb()
  const now = new Date().toISOString()
  const result = db
    .prepare('UPDATE workspaces SET permission_mode = ?, updated_at = ? WHERE id = ?')
    .run(permissionMode, now, id)
  if (result.changes === 0) {
    throw new Error(`Workspace '${id}' not found`)
  }
  return getWorkspace(id) as Workspace
}

/** Update the dev-server status column for a workspace. */
export function updateDevServerStatus(id: string, status: string): void {
  const db = getDb()
  db.prepare('UPDATE workspaces SET dev_server_status = ? WHERE id = ?').run(status, id)
}

/** Mark a workspace as read (has_unread = 0). */
export function markWorkspaceRead(id: string): void {
  const db = getDb()
  db.prepare('UPDATE workspaces SET has_unread = 0 WHERE id = ?').run(id)
}

/** Mark a workspace as unread (has_unread = 1). */
export function markWorkspaceUnread(id: string): void {
  const db = getDb()
  db.prepare('UPDATE workspaces SET has_unread = 1 WHERE id = ?').run(id)
}

/** Delete a workspace and cascade-delete its tasks. */
export function deleteWorkspace(id: string): void {
  const db = getDb()
  db.prepare('DELETE FROM workspaces WHERE id = ?').run(id)
}

/** Create a new task under a workspace. Throws if the workspace does not exist. */
export function createTask(workspaceId: string, data: CreateTaskInput): Task {
  const db = getDb()

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

/** Fetch a single task by ID scoped to a workspace, or null if not found. */
export function getTask(taskId: string, workspaceId: string): Task | null {
  const db = getDb()
  const row = db.prepare('SELECT * FROM tasks WHERE id = ? AND workspace_id = ?').get(taskId, workspaceId) as
    | TaskRow
    | undefined
  return row ? mapTask(row) : null
}

/** List all tasks for a workspace, ordered by sort_order ascending. */
export function listTasks(workspaceId: string): Task[] {
  const db = getDb()
  const rows = db
    .prepare('SELECT * FROM tasks WHERE workspace_id = ? ORDER BY sort_order ASC')
    .all(workspaceId) as TaskRow[]
  return rows.map(mapTask)
}

/** Update a task's status (pending, in_progress, done). */
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

/** Update a task's title. Throws if the title is empty or the task does not exist. */
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

/** Delete a task by ID. */
export function deleteTask(taskId: string): void {
  const db = getDb()
  db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId)
}

/** Fetch a workspace with all its tasks eagerly loaded. */
export function getWorkspaceWithTasks(id: string): WorkspaceWithTasks | null {
  const workspace = getWorkspace(id)
  if (!workspace) return null
  const tasks = listTasks(id)
  return { ...workspace, tasks }
}

/** Archive a workspace (set archived_at). Throws if already archived. */
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

/** Unarchive a workspace (clear archived_at), restoring its previous status. */
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

/** Mark a workspace as a favorite. Idempotent — refreshes the timestamp if already favorited. */
export function setFavorite(id: string): Workspace {
  const db = getDb()
  const now = new Date().toISOString()
  const result = db.prepare('UPDATE workspaces SET favorited_at = ?, updated_at = ? WHERE id = ?').run(now, now, id)
  if (result.changes === 0) {
    throw new Error(`Workspace '${id}' not found`)
  }
  return getWorkspace(id) as Workspace
}

/** Remove a workspace from favorites. Idempotent: safe to call on a non-favorite, though `updated_at` still refreshes. */
export function unsetFavorite(id: string): Workspace {
  const db = getDb()
  const now = new Date().toISOString()
  const result = db.prepare('UPDATE workspaces SET favorited_at = NULL, updated_at = ? WHERE id = ?').run(now, id)
  if (result.changes === 0) {
    throw new Error(`Workspace '${id}' not found`)
  }
  return getWorkspace(id) as Workspace
}

/** Maximum tag length (characters) and max number of tags per workspace. */
export const MAX_TAG_LENGTH = 50
export const MAX_WORKSPACE_TAGS = 50

/** Replace the workspace's tag list. Trims, dedupes, caps length per tag and count total. */
export function setWorkspaceTags(id: string, tags: string[]): Workspace {
  const normalized = Array.from(
    new Set(
      tags
        .map((t) => (typeof t === 'string' ? t.trim() : ''))
        .filter((t) => t.length > 0 && t.length <= MAX_TAG_LENGTH),
    ),
  ).slice(0, MAX_WORKSPACE_TAGS)
  const db = getDb()
  const now = new Date().toISOString()
  const result = db
    .prepare('UPDATE workspaces SET tags = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(normalized), now, id)
  if (result.changes === 0) {
    throw new Error(`Workspace '${id}' not found`)
  }
  return getWorkspace(id) as Workspace
}

// ── Agent Sessions ────────────────────────────────────────────────────────────

/** A persisted record of a Claude Code CLI invocation for a workspace. */
export interface AgentSession {
  id: string
  workspaceId: string
  pid: number | null
  claudeSessionId: string | null
  status: string
  startedAt: string
  endedAt: string | null
  name: string | null
}

interface AgentSessionRow {
  id: string
  workspace_id: string
  pid: number | null
  claude_session_id: string | null
  status: string
  started_at: string
  ended_at: string | null
  name: string | null
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
    name: row.name,
  }
}

/** List all agent sessions for a workspace, most recent first. */
export function listSessions(workspaceId: string): AgentSession[] {
  const db = getDb()
  const rows = db
    .prepare('SELECT * FROM agent_sessions WHERE workspace_id = ? ORDER BY started_at DESC')
    .all(workspaceId) as AgentSessionRow[]
  return rows.map(mapSession)
}

/** Get the most recent agent session for a workspace, or null if none exist. */
export function getLatestSession(workspaceId: string): AgentSession | null {
  const db = getDb()
  const row = db
    .prepare('SELECT * FROM agent_sessions WHERE workspace_id = ? ORDER BY started_at DESC LIMIT 1')
    .get(workspaceId) as AgentSessionRow | undefined
  return row ? mapSession(row) : null
}

/**
 * Return the "active" session for tagging events like push/pull/open-pr traces
 * or resumed chat messages. Skips idle sessions (never started) and prefers a
 * running session, falling back to the most recent session that has actually
 * been started (any non-idle status).
 */
export function getActiveSession(workspaceId: string): AgentSession | null {
  const db = getDb()
  // Prefer a running session first (the agent the user is actively interacting with)
  const running = db
    .prepare(
      "SELECT * FROM agent_sessions WHERE workspace_id = ? AND status = 'running' ORDER BY started_at DESC LIMIT 1",
    )
    .get(workspaceId) as AgentSessionRow | undefined
  if (running) return mapSession(running)
  // Otherwise the most recent non-idle session (completed, error, quota, etc.)
  const latestNonIdle = db
    .prepare(
      "SELECT * FROM agent_sessions WHERE workspace_id = ? AND status != 'idle' ORDER BY started_at DESC LIMIT 1",
    )
    .get(workspaceId) as AgentSessionRow | undefined
  return latestNonIdle ? mapSession(latestNonIdle) : null
}

/** Create an idle agent session (no Claude process yet) for a workspace. */
export function createIdleSession(workspaceId: string): AgentSession {
  const db = getDb()
  const id = nanoid()
  const now = new Date().toISOString()
  db.prepare('INSERT INTO agent_sessions (id, workspace_id, pid, status, started_at) VALUES (?, ?, NULL, ?, ?)').run(
    id,
    workspaceId,
    'idle',
    now,
  )
  return {
    id,
    workspaceId,
    pid: null,
    claudeSessionId: null,
    status: 'idle',
    startedAt: now,
    endedAt: null,
    name: null,
  }
}

/** Rename an agent session. Returns the updated session or null if not found. */
export function renameSession(sessionId: string, workspaceId: string, name: string): AgentSession | null {
  const db = getDb()
  const result = db
    .prepare('UPDATE agent_sessions SET name = ? WHERE id = ? AND workspace_id = ?')
    .run(name, sessionId, workspaceId)
  if (result.changes === 0) return null
  const row = db.prepare('SELECT * FROM agent_sessions WHERE id = ?').get(sessionId) as AgentSessionRow | undefined
  return row ? mapSession(row) : null
}
