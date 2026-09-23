import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createTaskHandler,
  listTasksHandler,
  markTaskDoneHandler,
  updateTaskHandler,
} from '../mcp-server/kobo-tasks-handlers.js'
import { closeDb, getDb } from '../server/db/index.js'
import { initSchema } from '../server/db/schema.js'
import { createTask, createWorkspace, getTask, updateTaskStatus } from '../server/services/workspace-service.js'

vi.mock('../server/services/agent/orchestrator.js', () => ({
  startAgent: vi.fn(),
  hasController: vi.fn(() => false),
}))
vi.mock('../server/services/websocket-service.js', () => ({ emit: vi.fn(), emitEphemeral: vi.fn() }))

const proof = {
  method: 'automated tests',
  summary: 'The acceptance checks passed against the implementation.',
  checks: [{ name: 'npm test -- feature.test.ts', status: 'passed' as const }],
}

let home: string
let workspaceId: string
beforeEach(() => {
  closeDb()
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'kobo-task-verification-'))
  const db = getDb(path.join(home, 'test.db'))
  initSchema(db)
  workspaceId = createWorkspace({ name: 'Tasks', projectPath: home, sourceBranch: 'main', workingBranch: 'tasks' }).id
  db.prepare('UPDATE workspaces SET auto_loop = 1 WHERE id = ?').run(workspaceId)
})
afterEach(() => {
  closeDb()
  fs.rmSync(home, { recursive: true, force: true })
})

describe('auto-loop task verification', () => {
  it('rejects completion without evidence through both MCP tools and the HTTP service', () => {
    const task = createTask(workspaceId, { title: 'Deliver feature' })
    expect(() => markTaskDoneHandler(getDb(), workspaceId, task.id)).toThrow(/verification/i)
    expect(() => updateTaskHandler(getDb(), workspaceId, task.id, { status: 'done' })).toThrow(/verification/i)
    expect(() => updateTaskStatus(task.id, 'done')).toThrow(/verification/i)
    expect(getTask(task.id, workspaceId)?.status).toBe('pending')
  })

  it.each([
    { ...proof, checks: [] },
    { ...proof, method: ' ' },
    { ...proof, summary: '' },
    { ...proof, checks: [{ name: 'e2e', status: 'not_run' }] },
    { ...proof, checks: [{ name: 'e2e', status: 'failed' }] },
  ])('rejects incomplete or unsuccessful verification: %j', (verification) => {
    const task = createTask(workspaceId, { title: 'Deliver feature' })
    expect(() => markTaskDoneHandler(getDb(), workspaceId, task.id, verification)).toThrow(/verification/i)
    expect(getTask(task.id, workspaceId)?.status).toBe('pending')
  })

  it('persists structured evidence and returns it from HTTP and MCP reads', () => {
    const task = createTask(workspaceId, { title: 'Deliver feature' })
    updateTaskStatus(task.id, 'done', proof)
    expect(getTask(task.id, workspaceId)).toMatchObject({ status: 'done', role: 'work', verification: proof })
    expect(listTasksHandler(getDb(), workspaceId)[0]).toMatchObject({ verification: proof, sort_order: 0 })
  })

  it('preserves manual completion and legacy done tasks without fabricating evidence', () => {
    getDb().prepare('UPDATE workspaces SET auto_loop = 0 WHERE id = ?').run(workspaceId)
    const task = createTask(workspaceId, { title: 'Manual task' })
    updateTaskStatus(task.id, 'done')
    getDb().prepare('UPDATE workspaces SET auto_loop = 1 WHERE id = ?').run(workspaceId)
    expect(getTask(task.id, workspaceId)).toMatchObject({ status: 'done', verification: null })
  })

  it('keeps finalization open until work and acceptance criteria are completed', () => {
    const work = createTask(workspaceId, { title: 'Acceptance criterion', isAcceptanceCriterion: true })
    const final = createTaskHandler(getDb(), workspaceId, { title: '[FINAL] Validate delivery' })
    expect(final.role).toBe('finalization')
    expect(() => markTaskDoneHandler(getDb(), workspaceId, final.id, proof)).toThrow(/finalization.*pending/i)
    markTaskDoneHandler(getDb(), workspaceId, work.id, proof)
    expect(markTaskDoneHandler(getDb(), workspaceId, final.id, proof).task.status).toBe('done')
  })

  it.each(['pending', 'unknown'])('cannot close finalization while an instruction is %s', (state) => {
    const final = createTaskHandler(getDb(), workspaceId, { title: '[FINAL] Validate delivery' })
    getDb()
      .prepare(
        'INSERT INTO auto_loop_messages (workspace_id, client_message_id, content, state, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(workspaceId, 'queued-change', 'Include the missing acceptance criterion', state, new Date().toISOString())
    expect(() => markTaskDoneHandler(getDb(), workspaceId, final.id, proof)).toThrow(/instructions/i)
    expect(getTask(final.id, workspaceId)?.status).toBe('pending')
  })

  it.each(['create', 'reopen', 'title', 'criterion', 'order'] as const)(
    'invalidates finalization after a substantive %s mutation',
    (mutation) => {
      const work = createTaskHandler(getDb(), workspaceId, { title: 'Work' })
      const final = createTaskHandler(getDb(), workspaceId, { title: 'Review all checks', role: 'finalization' })
      markTaskDoneHandler(getDb(), workspaceId, work.id, proof)
      markTaskDoneHandler(getDb(), workspaceId, final.id, proof)
      if (mutation === 'create') createTaskHandler(getDb(), workspaceId, { title: 'Follow-up' })
      else
        updateTaskHandler(getDb(), workspaceId, work.id, {
          ...(mutation === 'reopen' ? { status: 'pending' } : {}),
          ...(mutation === 'title' ? { title: 'Changed scope' } : {}),
          ...(mutation === 'criterion' ? { is_acceptance_criterion: true } : {}),
          ...(mutation === 'order' ? { sort_order: 10 } : {}),
        })
      expect(getTask(final.id, workspaceId)).toMatchObject({ status: 'pending', verification: null })
    },
  )

  it('keeps an unchanged task and its completed finalization intact', () => {
    const work = createTaskHandler(getDb(), workspaceId, { title: 'Work' })
    const final = createTaskHandler(getDb(), workspaceId, { title: '[FINAL] Validate' })
    markTaskDoneHandler(getDb(), workspaceId, work.id, proof)
    markTaskDoneHandler(getDb(), workspaceId, final.id, proof)
    updateTaskHandler(getDb(), workspaceId, work.id, { title: 'Work', is_acceptance_criterion: false })
    expect(getTask(final.id, workspaceId)?.status).toBe('done')
  })

  it('accepts fresh verification when the finalization scope and completion are submitted together', () => {
    const final = createTaskHandler(getDb(), workspaceId, { title: '[FINAL] Validate' })
    const updated = updateTaskHandler(getDb(), workspaceId, final.id, {
      title: '[FINAL] Verify the revised scope',
      status: 'done',
      verification: proof,
    })
    expect(updated).toMatchObject({ status: 'done', verification: proof })
  })

  it('rolls back all fields when a combined edit cannot complete', () => {
    const work = createTask(workspaceId, { title: 'Original' })
    expect(() => updateTaskHandler(getDb(), workspaceId, work.id, { title: 'Changed', status: 'done' })).toThrow()
    expect(getTask(work.id, workspaceId)?.title).toBe('Original')
  })
})

describe('transactional task ordering', () => {
  it('inserts follow-up checks immediately after their parent and exposes deterministic order', () => {
    const a = createTaskHandler(getDb(), workspaceId, { title: 'Feature A' })
    const b = createTaskHandler(getDb(), workspaceId, { title: 'Feature B' })
    const e2e = createTaskHandler(getDb(), workspaceId, { title: '[E2E] Check A', after_task_id: a.id })
    expect(listTasksHandler(getDb(), workspaceId).map((task) => task.id)).toEqual([a.id, e2e.id, b.id])
    updateTaskHandler(getDb(), workspaceId, b.id, { after_task_id: a.id })
    expect(listTasksHandler(getDb(), workspaceId).map((task) => task.id)).toEqual([a.id, b.id, e2e.id])
  })

  it('rejects foreign insertion references without changing the task list', () => {
    createTaskHandler(getDb(), workspaceId, { title: 'Original' })
    const other = createWorkspace({ name: 'Other', projectPath: home, sourceBranch: 'main', workingBranch: 'other' })
    const foreign = createTask(other.id, { title: 'Foreign' })
    const before = listTasksHandler(getDb(), workspaceId)
    expect(() => createTaskHandler(getDb(), workspaceId, { title: 'Wrong', after_task_id: foreign.id })).toThrow(
      /not found/i,
    )
    expect(listTasksHandler(getDb(), workspaceId)).toEqual(before)
  })
})
