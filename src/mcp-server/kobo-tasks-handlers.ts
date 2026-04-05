import type Database from 'better-sqlite3'

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
