import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { nanoid } from 'nanoid'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, getDb } from '../server/db/index.js'
import { buildEngineHandoff } from '../server/services/engine-handoff-service.js'
import { createWorkspace, type WorkspaceWithTasks } from '../server/services/workspace-service.js'
import { resetDb } from './helpers/reset-db.js'

let directory = ''
let workspace: WorkspaceWithTasks
beforeEach(async () => {
  directory = (await resetDb()).tmpDir
  execFileSync('git', ['init', '-q'], { cwd: directory })
  workspace = {
    ...createWorkspace({
      name: 'Handoff mission',
      projectPath: directory,
      sourceBranch: 'main',
      workingBranch: 'work',
      model: 'auto',
    }),
    tasks: [],
    worktreePath: directory,
  }
})
afterEach(() => {
  closeDb()
  fs.rmSync(directory, { recursive: true, force: true })
})

function event(type: string, payload: unknown, sessionId: string | null = 'source'): void {
  getDb()
    .prepare(
      'INSERT INTO ws_events (id, workspace_id, type, payload, session_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(nanoid(), workspace.id, type, JSON.stringify(payload), sessionId, new Date().toISOString())
}
function text(messageId: string, value: string, streaming = true, sessionId: string | null = 'source'): void {
  event('agent:event', { kind: 'message:text', messageId, text: value, streaming }, sessionId)
}

describe('engine handoff conversation', () => {
  it.each(['claude-code', 'codex'])('combines %s deltas and retains the latest user instruction', async (engine) => {
    event('user:message', { content: 'Preserve API compatibility.' })
    const fragments = ['First ', 'check ', 'the ', 'API ', 'contract ', 'before ', 'changing ', 'code.']
    for (const fragment of fragments) text('assistant-1', fragment)
    event('agent:event', { kind: 'message:end', messageId: 'assistant-1' })
    const handoff = await buildEngineHandoff(workspace, engine, 'codex', 'source')
    expect(handoff).toContain('Preserve API compatibility.')
    expect(handoff).toContain('First check the API contract before changing code.')
    expect(handoff.match(/Preserve API compatibility\./g)).toHaveLength(1)
  })

  it('pins the latest user instruction when more than six assistant messages follow', async () => {
    event('user:message', { content: 'Do not commit any changes.' })
    for (let i = 0; i < 9; i++) text(`message-${i}`, `Completed action ${i}.`, false)
    const handoff = await buildEngineHandoff(workspace, 'codex', 'claude-code', 'source')
    expect(handoff).toContain('Do not commit any changes.')
    expect(handoff).toContain('Completed action 8.')
    expect(handoff).not.toContain('Completed action 0.')
  })

  it('does not duplicate a completed snapshot after streaming deltas', async () => {
    text('message', 'Read ')
    text('message', 'the contract.')
    text('message', 'Read the contract.', false)
    const handoff = await buildEngineHandoff(workspace, 'claude-code', 'codex', 'source')
    expect(handoff.match(/Read the contract\./g)).toHaveLength(1)
    const conversation = handoff.split('## Recent conversation\n')[1]!.split('## Recover more context')[0]!
    expect(conversation.match(/Read /g)).toHaveLength(1)
  })

  it('preserves newer deltas following an earlier complete text block', async () => {
    text('message', 'Read ', false)
    text('message', 'the contract.')
    const handoff = await buildEngineHandoff(workspace, 'claude-code', 'codex', 'source')
    expect(handoff).toContain('Read the contract.')
  })

  it('keeps identical message ids in different sessions separate and honors the source filter', async () => {
    event('user:message', { content: 'Source-only constraint.' }, 'source')
    text('shared-id', 'Source answer.', true, 'source')
    event('user:message', { content: 'Other-session constraint.' }, 'other')
    text('shared-id', 'Other answer.', true, 'other')
    const filtered = await buildEngineHandoff(workspace, 'claude-code', 'codex', 'source')
    expect(filtered).toContain('Source-only constraint.')
    expect(filtered).toContain('Source answer.')
    expect(filtered).not.toContain('Other-session constraint.')
    const unfiltered = await buildEngineHandoff(workspace, 'claude-code', 'codex')
    expect(unfiltered).not.toContain('Source answer.Other answer.')
  })

  it('bounds conversation text while retaining the latest user instruction', async () => {
    event('user:message', { content: 'Keep the fix reversible.' })
    for (let i = 0; i < 6; i++) text(`large-${i}`, 'Repeated analysis. '.repeat(1_000), false)
    const handoff = await buildEngineHandoff(workspace, 'claude-code', 'codex', 'source')
    const conversation = handoff.split('## Recent conversation\n')[1]!.split('## Recover more context')[0]!
    expect(conversation.length).toBeLessThanOrEqual(12_500)
    expect(conversation).toContain('Keep the fix reversible.')
    expect(conversation).toMatch(/omitted|truncated/)
  })

  it('ignores malformed history payloads instead of failing the transfer', async () => {
    getDb()
      .prepare(
        'INSERT INTO ws_events (id, workspace_id, type, payload, session_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(nanoid(), workspace.id, 'agent:event', '{ broken json', 'source', new Date().toISOString())
    event('user:message', { content: 'Valid user request.' })
    const handoff = await buildEngineHandoff(workspace, 'claude-code', 'codex', 'source')
    expect(handoff).toContain('Valid user request.')
  })
})

it('reports failed Git reads as unavailable, without claiming a clean working tree', async () => {
  workspace.worktreePath = `${directory}/does-not-exist`
  const handoff = await buildEngineHandoff(workspace, 'claude-code', 'codex', 'source')
  expect(handoff).toContain('Git state unavailable')
  expect(handoff).not.toContain('No uncommitted changes detected.')
})
