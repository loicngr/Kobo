import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { closeDb, getDb } from '../server/db/index.js'
import { initSchema } from '../server/db/schema.js'
import sprintRoutes from '../server/routes/sprints.js'
import * as sprints from '../server/services/sprint-service.js'
import { createWorkspace, getWorkspace } from '../server/services/workspace-service.js'
import { reserveWorkspaceLifecycle } from '../server/utils/workspace-lifecycle-guard.js'

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kobo-sprint-'))
  const file = path.join(dir, 'db.sqlite')
  const db = new Database(file)
  initSchema(db)
  db.close()
  getDb(file)
})
afterEach(() => {
  closeDb()
  fs.rmSync(dir, { recursive: true, force: true })
})
it('manages sprints atomically and protects assigned workspaces', async () => {
  const first = sprints.createSprint(' First ')
  const second = sprints.createSprint('Second')
  expect(first.name).toBe('First')
  expect(sprints.renameSprint(first.id, 'Renamed').name).toBe('Renamed')
  expect(() => sprints.createSprint(' '.repeat(3))).toThrow()
  expect(() => sprints.reorderSprints([first.id])).toThrow()
  expect(() => sprints.reorderSprints([first.id, 'unknown'])).toThrow()
  expect(() => sprints.reorderSprints([first.id, first.id])).toThrow()
  expect(sprints.listSprints().map((s) => s.id)).toEqual([first.id, second.id])
  expect(sprints.reorderSprints([second.id, first.id]).map((s) => s.id)).toEqual([second.id, first.id])
  const workspace = createWorkspace({
    name: 'test',
    projectPath: '/tmp/repo',
    sourceBranch: 'main',
    workingBranch: 'branch',
  })
  await sprints.assignSprint(workspace.id, first.id)
  getDb()
    .prepare('UPDATE workspaces SET archived_at = ?, worktree_purged_at = ? WHERE id = ?')
    .run('archived', 'purged', workspace.id)
  const guard = reserveWorkspaceLifecycle(workspace.id)
  expect(() => sprints.deleteSprint(first.id)).toThrow()
  guard.release()
  expect(sprints.deleteSprint(first.id)).toEqual([workspace.id])
  expect(getWorkspace(workspace.id)).toMatchObject({
    sprintId: null,
    archivedAt: 'archived',
    worktreePurgedAt: 'purged',
  })
  await expect(sprints.assignSprint(workspace.id, 'missing')).rejects.toThrow()
})

it('validates sprint routes and rejects partial reorders', async () => {
  const create = await sprintRoutes.request('/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'First' }),
  })
  expect(create.status).toBe(201)
  const { sprint } = await create.json()
  const invalid = await sprintRoutes.request('/reorder', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: [] }),
  })
  expect(invalid.status).toBe(400)
  expect((await (await sprintRoutes.request('/')).json()).sprints.map((item: { id: string }) => item.id)).toEqual([
    sprint.id,
  ])
  expect(
    (
      await sprintRoutes.request(`/${sprint.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'X', unexpected: true }),
      })
    ).status,
  ).toBe(400)
  expect((await sprintRoutes.request(`/${sprint.id}`, { method: 'DELETE' })).status).toBe(200)
})
