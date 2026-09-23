import type Database from 'better-sqlite3'
import { nanoid } from 'nanoid'
import type { TaskRole, TaskVerification } from '../../shared/task-verification.js'

export interface TaskRecord {
  id: string
  workspace_id: string
  title: string
  status: string
  is_acceptance_criterion: number
  sort_order: number
  role: TaskRole
  verification: string | null
  created_at: string
  updated_at: string
}

export interface CreateTaskMutation {
  title: string
  isAcceptanceCriterion?: boolean
  sortOrder?: number
  afterTaskId?: string
  role?: TaskRole
}

export interface UpdateTaskMutation {
  title?: string
  status?: string
  isAcceptanceCriterion?: boolean
  sortOrder?: number
  afterTaskId?: string
  verification?: unknown
}

export class TaskValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TaskValidationError'
  }
}

function validateVerification(input: unknown, requirePassed: boolean): TaskVerification {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TaskValidationError('Task verification is required before marking an auto-loop task done')
  }
  const proof = input as Partial<TaskVerification>
  if (
    typeof proof.method !== 'string' ||
    !proof.method.trim() ||
    typeof proof.summary !== 'string' ||
    !proof.summary.trim() ||
    !Array.isArray(proof.checks) ||
    proof.checks.length === 0 ||
    proof.checks.some(
      (check) =>
        !check ||
        typeof check.name !== 'string' ||
        !check.name.trim() ||
        !['passed', 'failed', 'not_run'].includes(check.status) ||
        (requirePassed && check.status !== 'passed'),
    )
  ) {
    throw new TaskValidationError(
      'Task verification requires a method, summary and named checks; every check must have passed before completion',
    )
  }
  return {
    method: proof.method.trim(),
    summary: proof.summary.trim(),
    checks: proof.checks.map((check) => ({ name: check.name.trim(), status: check.status })),
  }
}

function validateOrder(input: { sortOrder?: number; afterTaskId?: string }): void {
  if (input.sortOrder !== undefined && (!Number.isSafeInteger(input.sortOrder) || input.sortOrder < 0)) {
    throw new TaskValidationError('sort_order must be a non-negative safe integer')
  }
  if (input.afterTaskId !== undefined && (typeof input.afterTaskId !== 'string' || !input.afterTaskId)) {
    throw new TaskValidationError('after_task_id must be a non-empty task id')
  }
  if (input.sortOrder !== undefined && input.afterTaskId !== undefined) {
    throw new TaskValidationError('Provide either sort_order or after_task_id, not both')
  }
  if (
    'isAcceptanceCriterion' in input &&
    input.isAcceptanceCriterion !== undefined &&
    typeof input.isAcceptanceCriterion !== 'boolean'
  ) {
    throw new TaskValidationError('is_acceptance_criterion must be a boolean')
  }
}

/** Task-list changes make the previous final review obsolete, even while the loop is paused. */
export function invalidateTaskFinalization(db: Database.Database, workspaceId: string, verifiedTaskId = ''): void {
  db.prepare(`UPDATE tasks SET status = 'pending', verification = NULL, updated_at = ?
    WHERE workspace_id = ? AND role = 'finalization' AND status = 'done' AND id <> ?`).run(
    new Date().toISOString(),
    workspaceId,
    verifiedTaskId,
  )
}

function readTask(db: Database.Database, workspaceId: string, taskId: string): TaskRecord {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND workspace_id = ?').get(taskId, workspaceId) as
    | TaskRecord
    | undefined
  if (!task) throw new Error(`Task '${taskId}' not found in workspace '${workspaceId}'`)
  return task
}

/** Insert/move after an existing sibling and normalize positions within the caller's transaction. */
function moveAfter(db: Database.Database, workspaceId: string, taskId: string, afterTaskId: string): boolean {
  readTask(db, workspaceId, afterTaskId)
  if (taskId === afterTaskId) throw new TaskValidationError('A task cannot be placed after itself')
  const tasks = db
    .prepare('SELECT id, sort_order FROM tasks WHERE workspace_id = ? ORDER BY sort_order, rowid')
    .all(workspaceId) as Array<{ id: string; sort_order: number }>
  const ordered = tasks.filter((task) => task.id !== taskId)
  ordered.splice(ordered.findIndex((task) => task.id === afterTaskId) + 1, 0, tasks.find((task) => task.id === taskId)!)
  const changed = tasks.some((task, index) => task.id !== ordered[index]?.id)
  if (!changed) return false
  const update = db.prepare('UPDATE tasks SET sort_order = ?, updated_at = ? WHERE id = ?')
  const now = new Date().toISOString()
  ordered.forEach((task, index) => {
    update.run(index, now, task.id)
  })
  return true
}

export function createTaskRecord(db: Database.Database, workspaceId: string, input: CreateTaskMutation): TaskRecord {
  if (typeof input.title !== 'string' || !input.title.trim()) throw new TaskValidationError('title is required')
  validateOrder(input)
  if (input.role !== undefined && input.role !== 'work' && input.role !== 'finalization') {
    throw new TaskValidationError('Task role must be work or finalization')
  }
  return db
    .transaction(() => {
      if (!db.prepare('SELECT 1 FROM workspaces WHERE id = ?').get(workspaceId)) {
        throw new Error(`Workspace '${workspaceId}' not found`)
      }
      if (input.afterTaskId !== undefined) readTask(db, workspaceId, input.afterTaskId)
      const title = input.title.trim()
      const role = input.role ?? (title.startsWith('[FINAL] ') ? 'finalization' : 'work')
      const max = (
        db
          .prepare('SELECT COALESCE(MAX(sort_order), -1) AS value FROM tasks WHERE workspace_id = ?')
          .get(workspaceId) as { value: number }
      ).value
      const order = input.sortOrder ?? max + 1
      const now = new Date().toISOString()
      if (input.sortOrder !== undefined) {
        db.prepare('UPDATE tasks SET sort_order = sort_order + 1 WHERE workspace_id = ? AND sort_order >= ?').run(
          workspaceId,
          order,
        )
      }
      const id = nanoid()
      db.prepare(`INSERT INTO tasks (id, workspace_id, title, status, is_acceptance_criterion, sort_order, role, verification, created_at, updated_at)
      VALUES (?, ?, ?, 'pending', ?, ?, ?, NULL, ?, ?)`).run(
        id,
        workspaceId,
        title,
        input.isAcceptanceCriterion ? 1 : 0,
        order,
        role,
        now,
        now,
      )
      if (input.afterTaskId !== undefined) moveAfter(db, workspaceId, id, input.afterTaskId)
      if (role === 'work') invalidateTaskFinalization(db, workspaceId)
      return readTask(db, workspaceId, id)
    })
    .immediate()
}

export function updateTaskRecord(
  db: Database.Database,
  workspaceId: string,
  taskId: string,
  input: UpdateTaskMutation,
): TaskRecord {
  validateOrder(input)
  if (input.title !== undefined && (typeof input.title !== 'string' || !input.title.trim())) {
    throw new TaskValidationError('Task title cannot be empty')
  }
  if (input.status !== undefined && !['pending', 'in_progress', 'done'].includes(input.status)) {
    throw new TaskValidationError(`Invalid status '${input.status}'. Must be one of: pending, in_progress, done`)
  }
  if (
    !['title', 'status', 'isAcceptanceCriterion', 'sortOrder', 'afterTaskId', 'verification'].some(
      (key) => input[key as keyof UpdateTaskMutation] !== undefined,
    )
  ) {
    throw new TaskValidationError(
      'No fields to update (provide title, status, is_acceptance_criterion, order, or verification)',
    )
  }
  return db
    .transaction(() => {
      const task = readTask(db, workspaceId, taskId)
      const autoLoop =
        (db.prepare('SELECT auto_loop FROM workspaces WHERE id = ?').get(workspaceId) as { auto_loop: number })
          .auto_loop === 1
      const title = input.title?.trim() ?? task.title
      const isAC =
        input.isAcceptanceCriterion === undefined ? task.is_acceptance_criterion : Number(input.isAcceptanceCriterion)
      const scopeChanged = title !== task.title || isAC !== task.is_acceptance_criterion
      const status =
        input.status ??
        (scopeChanged && task.status === 'done' && (autoLoop || task.role === 'finalization') ? 'pending' : task.status)
      const completing =
        status === 'done' && (input.status === 'done' || input.verification !== undefined || scopeChanged)
      let verification = scopeChanged || status !== 'done' ? null : task.verification
      if (input.verification !== undefined)
        verification = JSON.stringify(validateVerification(input.verification, completing))
      if (completing && autoLoop && input.verification === undefined) validateVerification(undefined, true)
      if (
        completing &&
        task.role === 'finalization' &&
        db
          .prepare("SELECT 1 FROM tasks WHERE workspace_id = ? AND role = 'work' AND status <> 'done' LIMIT 1")
          .get(workspaceId)
      ) {
        throw new TaskValidationError(
          'Finalization cannot be completed while work tasks or acceptance criteria are pending',
        )
      }
      if (
        completing &&
        task.role === 'finalization' &&
        db
          .prepare(
            "SELECT 1 FROM auto_loop_messages WHERE workspace_id = ? AND state IN ('pending', 'unknown') LIMIT 1",
          )
          .get(workspaceId)
      ) {
        throw new TaskValidationError(
          'Finalization cannot be completed while user instructions are pending or their delivery is unknown',
        )
      }
      let orderChanged = false
      if (input.afterTaskId !== undefined) orderChanged = moveAfter(db, workspaceId, taskId, input.afterTaskId)
      if (input.sortOrder !== undefined && input.sortOrder !== task.sort_order) {
        // Moving to an occupied position shifts the intervening siblings only.
        if (input.sortOrder < task.sort_order) {
          db.prepare(
            'UPDATE tasks SET sort_order = sort_order + 1 WHERE workspace_id = ? AND id <> ? AND sort_order >= ? AND sort_order < ?',
          ).run(workspaceId, taskId, input.sortOrder, task.sort_order)
        } else {
          db.prepare(
            'UPDATE tasks SET sort_order = sort_order - 1 WHERE workspace_id = ? AND id <> ? AND sort_order > ? AND sort_order <= ?',
          ).run(workspaceId, taskId, task.sort_order, input.sortOrder)
        }
        db.prepare('UPDATE tasks SET sort_order = ? WHERE id = ?').run(input.sortOrder, taskId)
        orderChanged = true
      }
      db.prepare(
        'UPDATE tasks SET title = ?, status = ?, is_acceptance_criterion = ?, verification = ?, updated_at = ? WHERE id = ?',
      ).run(title, status, isAC, verification, new Date().toISOString(), taskId)
      if (scopeChanged || orderChanged || (task.status === 'done' && status !== 'done')) {
        // Fresh evidence supplied with this exact edit validates its new scope;
        // all other completed finalizations still describe the previous state.
        invalidateTaskFinalization(db, workspaceId, completing && input.verification !== undefined ? taskId : '')
      }
      return readTask(db, workspaceId, taskId)
    })
    .immediate()
}

export function deleteTaskRecord(db: Database.Database, workspaceId: string, taskId: string): void {
  db.transaction(() => {
    const task = readTask(db, workspaceId, taskId)
    db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId)
    if (task.role === 'work') invalidateTaskFinalization(db, workspaceId)
  }).immediate()
}
