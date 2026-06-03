import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initSchema } from '../server/db/schema.js'

let tmpDir: string
let dbPath: string

async function resetDb() {
  const { closeDb } = await import('../server/db/index.js')
  closeDb()
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'precompact-hook-test-'))
  dbPath = path.join(tmpDir, 'test.db')
  const db = new Database(dbPath)
  db.pragma('journal_mode=WAL')
  db.pragma('foreign_keys=ON')
  initSchema(db)
  db.close()
}

beforeEach(async () => {
  await resetDb()
  const { getDb } = await import('../server/db/index.js')
  getDb(dbPath)
})

afterEach(async () => {
  const { closeDb } = await import('../server/db/index.js')
  closeDb()
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

describe('buildPreCompactCustomInstructions', () => {
  it('returns an empty string when the workspace has no tasks or criteria', async () => {
    const { createWorkspace } = await import('../server/services/workspace-service.js')
    const { buildPreCompactCustomInstructions } = await import(
      '../server/services/agent/engines/claude-code/precompact-hook.js'
    )
    const ws = createWorkspace({
      name: 'Empty',
      projectPath: '/tmp/empty',
      sourceBranch: 'main',
      workingBranch: 'feature/empty',
    })
    expect(buildPreCompactCustomInstructions(ws.id)).toBe('')
  })

  it('includes the Tasks section when only todos exist', async () => {
    const { createWorkspace, createTask } = await import('../server/services/workspace-service.js')
    const { buildPreCompactCustomInstructions } = await import(
      '../server/services/agent/engines/claude-code/precompact-hook.js'
    )
    const ws = createWorkspace({
      name: 'Todos Only',
      projectPath: '/tmp/todos',
      sourceBranch: 'main',
      workingBranch: 'feature/todos',
    })
    createTask(ws.id, { title: 'Write docs', isAcceptanceCriterion: false })
    createTask(ws.id, { title: 'Add tests', isAcceptanceCriterion: false })
    const out = buildPreCompactCustomInstructions(ws.id)
    expect(out).toContain('Tasks:')
    expect(out).toContain('Write docs')
    expect(out).toContain('Add tests')
    expect(out).toContain('Todos Only')
    expect(out).not.toContain('Acceptance criteria:')
  })

  it('includes the Acceptance criteria section when only criteria exist', async () => {
    const { createWorkspace, createTask } = await import('../server/services/workspace-service.js')
    const { buildPreCompactCustomInstructions } = await import(
      '../server/services/agent/engines/claude-code/precompact-hook.js'
    )
    const ws = createWorkspace({
      name: 'Criteria Only',
      projectPath: '/tmp/criteria',
      sourceBranch: 'main',
      workingBranch: 'feature/criteria',
    })
    createTask(ws.id, { title: 'X compiles', isAcceptanceCriterion: true })
    createTask(ws.id, { title: 'Y passes', isAcceptanceCriterion: true })
    const out = buildPreCompactCustomInstructions(ws.id)
    expect(out).toContain('Acceptance criteria:')
    expect(out).toContain('X compiles')
    expect(out).toContain('Y passes')
    expect(out).not.toContain('Tasks:')
  })

  it('includes both sections when both kinds of tasks exist', async () => {
    const { createWorkspace, createTask } = await import('../server/services/workspace-service.js')
    const { buildPreCompactCustomInstructions } = await import(
      '../server/services/agent/engines/claude-code/precompact-hook.js'
    )
    const ws = createWorkspace({
      name: 'Mixed',
      projectPath: '/tmp/mixed',
      sourceBranch: 'main',
      workingBranch: 'feature/mixed',
    })
    createTask(ws.id, { title: 'Write X', isAcceptanceCriterion: false })
    createTask(ws.id, { title: 'Y passes', isAcceptanceCriterion: true })
    const out = buildPreCompactCustomInstructions(ws.id)
    expect(out).toContain('Tasks:')
    expect(out).toContain('Write X')
    expect(out).toContain('Acceptance criteria:')
    expect(out).toContain('Y passes')
    expect(out).toContain('Mixed')
  })
})

describe('buildCompactionSessionStartOutput', () => {
  it('returns an empty object for non-compact session sources', async () => {
    const { createWorkspace, createTask } = await import('../server/services/workspace-service.js')
    const { buildCompactionSessionStartOutput } = await import(
      '../server/services/agent/engines/claude-code/precompact-hook.js'
    )
    const ws = createWorkspace({
      name: 'Startup',
      projectPath: '/tmp/startup',
      sourceBranch: 'main',
      workingBranch: 'feature/startup',
    })
    createTask(ws.id, { title: 'Do X', isAcceptanceCriterion: false })
    // Even with tasks, a normal startup/resume/clear must NOT inject the reminder.
    expect(buildCompactionSessionStartOutput(ws.id, 'startup')).toEqual({})
    expect(buildCompactionSessionStartOutput(ws.id, 'resume')).toEqual({})
    expect(buildCompactionSessionStartOutput(ws.id, 'clear')).toEqual({})
  })

  it('returns an empty object on compact when there are no tasks or criteria', async () => {
    const { createWorkspace } = await import('../server/services/workspace-service.js')
    const { buildCompactionSessionStartOutput } = await import(
      '../server/services/agent/engines/claude-code/precompact-hook.js'
    )
    const ws = createWorkspace({
      name: 'Empty',
      projectPath: '/tmp/empty-compact',
      sourceBranch: 'main',
      workingBranch: 'feature/empty-compact',
    })
    expect(buildCompactionSessionStartOutput(ws.id, 'compact')).toEqual({})
  })

  it('returns a SessionStart hookSpecificOutput with the reminder on compact', async () => {
    const { createWorkspace, createTask } = await import('../server/services/workspace-service.js')
    const { buildCompactionSessionStartOutput } = await import(
      '../server/services/agent/engines/claude-code/precompact-hook.js'
    )
    const ws = createWorkspace({
      name: 'Compacting',
      projectPath: '/tmp/compacting',
      sourceBranch: 'main',
      workingBranch: 'feature/compacting',
    })
    createTask(ws.id, { title: 'Write X', isAcceptanceCriterion: false })
    createTask(ws.id, { title: 'Y passes', isAcceptanceCriterion: true })
    const out = buildCompactionSessionStartOutput(ws.id, 'compact')
    expect(out.hookSpecificOutput?.hookEventName).toBe('SessionStart')
    expect(out.hookSpecificOutput?.additionalContext).toContain('Write X')
    expect(out.hookSpecificOutput?.additionalContext).toContain('Y passes')
    expect(out.hookSpecificOutput?.additionalContext).toContain('Compacting')
  })
})
