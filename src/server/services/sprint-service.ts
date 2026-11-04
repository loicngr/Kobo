import { nanoid } from 'nanoid'
import { getDb } from '../db/index.js'
import { reserveWorkspaceLifecycle, withWorkspaceLifecycleGuard } from '../utils/workspace-lifecycle-guard.js'
import { broadcastAll } from './websocket-service.js'
import { getWorkspace } from './workspace-service.js'

type SprintRow = { id: string; name: string; sort_order: number; created_at: string; updated_at: string }
export type Sprint = { id: string; name: string; sortOrder: number; createdAt: string; updatedAt: string }
const map = (row: SprintRow): Sprint => ({
  id: row.id,
  name: row.name,
  sortOrder: row.sort_order,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})
export function validateSprintId(id: unknown): asserts id is string | null {
  if (id !== null && (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id))) throw new Error('Invalid sprint ID')
}
function validateName(name: unknown): string {
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 100) throw new Error('Invalid sprint name')
  return name.trim()
}
export function listSprints(): Sprint[] {
  return (getDb().prepare('SELECT * FROM sprints ORDER BY sort_order, id').all() as SprintRow[]).map(map)
}
export function requireSprint(id: unknown): asserts id is string | null {
  validateSprintId(id)
  if (id !== null && !getDb().prepare('SELECT 1 FROM sprints WHERE id = ?').get(id)) throw new Error('Sprint not found')
}
export function createSprint(name: unknown): Sprint {
  const validName = validateName(name)
  const db = getDb()
  const id = nanoid()
  const now = new Date().toISOString()
  db.prepare('INSERT INTO sprints VALUES (?, ?, (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM sprints), ?, ?)').run(
    id,
    validName,
    now,
    now,
  )
  const sprint = map(db.prepare('SELECT * FROM sprints WHERE id = ?').get(id) as SprintRow)
  broadcastAll('sprint:changed', { sprint, action: 'created' })
  return sprint
}
export function renameSprint(id: string, name: unknown): Sprint {
  requireSprint(id)
  const validName = validateName(name)
  const db = getDb()
  db.prepare('UPDATE sprints SET name = ?, updated_at = ? WHERE id = ?').run(validName, new Date().toISOString(), id)
  const sprint = map(db.prepare('SELECT * FROM sprints WHERE id = ?').get(id) as SprintRow)
  broadcastAll('sprint:changed', { sprint, action: 'updated' })
  return sprint
}
export function reorderSprints(ids: unknown): Sprint[] {
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string') || new Set(ids).size !== ids.length)
    throw new Error('Invalid sprint order')
  const db = getDb()
  db.transaction(() => {
    const existing = listSprints()
    if (ids.length !== existing.length || existing.some((sprint) => !ids.includes(sprint.id)))
      throw new Error('Invalid sprint order')
    const update = db.prepare('UPDATE sprints SET sort_order = ?, updated_at = ? WHERE id = ?')
    const now = new Date().toISOString()
    ids.forEach((id, index) => {
      update.run(index, now, id)
    })
  })()
  const sprints = listSprints()
  broadcastAll('sprint:changed', { sprints, action: 'reordered' })
  return sprints
}
export function deleteSprint(id: string): string[] {
  requireSprint(id)
  const db = getDb()
  const ids = (db.prepare('SELECT id FROM workspaces WHERE sprint_id = ?').all(id) as { id: string }[]).map(
    (row) => row.id,
  )
  const reservations: { release: () => void }[] = []
  try {
    for (const workspaceId of ids) reservations.push(reserveWorkspaceLifecycle(workspaceId))
    db.transaction(() => {
      db.prepare('DELETE FROM sprints WHERE id = ?').run(id)
    })()
  } finally {
    for (const reservation of reservations) reservation.release()
  }
  broadcastAll('sprint:changed', { action: 'deleted', sprintId: id, workspaceIds: ids })
  if (ids.length) broadcastAll('workspace:sprint-updated', { sprintId: null, workspaceIds: ids })
  return ids
}
export async function assignSprint(workspaceId: string, sprintId: unknown) {
  return withWorkspaceLifecycleGuard(workspaceId, async () => {
    requireSprint(sprintId)
    if (!getWorkspace(workspaceId)) throw new Error('Workspace not found')
    getDb()
      .prepare('UPDATE workspaces SET sprint_id = ?, updated_at = ? WHERE id = ?')
      .run(sprintId, new Date().toISOString(), workspaceId)
    const workspace = getWorkspace(workspaceId)!
    broadcastAll('workspace:sprint-updated', { workspaceIds: [workspaceId], sprintId })
    return workspace
  })
}
