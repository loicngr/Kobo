import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runMigrations } from '../server/db/migrations.js'
import { computeWorkspaceActivityStats } from '../server/services/comparison-stats-service.js'

let db: Database.Database
let seq = 0

function event(workspaceId: string, sessionId: string | null, type: string, payload: unknown): void {
  db.prepare(
    'INSERT INTO ws_events (id, workspace_id, type, payload, session_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(`e${++seq}`, workspaceId, type, JSON.stringify(payload), sessionId, '2026-01-01T10:00:00.000Z')
}

beforeEach(() => {
  db = new Database(':memory:')
  runMigrations(db)
  for (const id of ['w1', 'w2']) {
    db.prepare(
      `INSERT INTO workspaces (id, name, project_path, source_branch, working_branch, created_at, updated_at)
       VALUES (?, ?, '/tmp/p', 'main', ?, '2026-01-01', '2026-01-01')`,
    ).run(id, id, `feat-${id}`)
  }
  db.prepare(
    `INSERT INTO agent_sessions (id, workspace_id, status, started_at, ended_at)
     VALUES ('s1', 'w1', 'completed', '2026-01-01T10:00:00.000Z', '2026-01-01T10:10:00.000Z'),
            ('s2', 'w1', 'running', '2026-01-01T10:20:00.000Z', NULL),
            ('s9', 'w2', 'completed', '2026-01-01T10:00:00.000Z', '2026-01-01T10:01:00.000Z')`,
  ).run()
})

afterEach(() => db.close())

describe('computeWorkspaceActivityStats', () => {
  it('counts sessions and adds up only the durations that have ended', () => {
    const stats = computeWorkspaceActivityStats(db, 'w1')

    expect(stats.sessions).toBe(2)
    expect(stats.durationMs).toBe(10 * 60_000)
  })

  it('separates what the user typed from the prompts Kōbō injected', () => {
    event('w1', 's1', 'user:message', { content: 'hi', sender: 'user' })
    event('w1', 's1', 'user:message', { content: 'again', sender: 'user' })
    event('w1', 's1', 'user:message', { content: 'iteration 2', sender: 'system-prompt' })

    const stats = computeWorkspaceActivityStats(db, 'w1')

    expect(stats.userMessages).toBe(2)
    expect(stats.injectedPrompts).toBe(1)
  })

  it('counts one agent message per messageId, not one per streamed delta', () => {
    // Codex streams 50-200 `message:text` events per message; Claude about
    // one per block. Counting events would make Codex look five times
    // chattier for the same answer.
    for (let i = 0; i < 40; i++)
      event('w1', 's1', 'agent:event', { kind: 'message:text', messageId: 'm1', text: 'x', streaming: true })
    event('w1', 's1', 'agent:event', { kind: 'message:text', messageId: 'm2', text: 'done', streaming: false })
    event('w1', 's1', 'agent:event', { kind: 'message:thinking', messageId: 'm3', text: 'hmm' })

    expect(computeWorkspaceActivityStats(db, 'w1').agentMessages).toBe(2)
  })

  it('counts questions from the tool call, which survives the purge of the answered request', () => {
    event('w1', 's1', 'agent:event', {
      kind: 'tool:call',
      messageId: 'm',
      toolCallId: 't1',
      name: 'AskUserQuestion',
      input: {},
    })
    event('w1', 's1', 'agent:event', {
      kind: 'tool:call',
      messageId: 'm',
      toolCallId: 't2',
      name: 'request_user_input',
      input: {},
    })
    event('w1', 's1', 'agent:event', { kind: 'tool:call', messageId: 'm', toolCallId: 't3', name: 'Bash', input: {} })

    const stats = computeWorkspaceActivityStats(db, 'w1')

    expect(stats.questions).toBe(2)
    expect(stats.toolCalls).toBe(3)
  })

  it('sums tokens and errors over every session of the workspace', () => {
    event('w1', 's1', 'agent:event', { kind: 'usage', inputTokens: 100, outputTokens: 10 })
    event('w1', 's2', 'agent:event', { kind: 'usage', inputTokens: 50, outputTokens: 5 })
    event('w1', 's2', 'agent:event', { kind: 'error', category: 'other', message: 'boom' })

    const stats = computeWorkspaceActivityStats(db, 'w1')

    expect(stats.inputTokens).toBe(150)
    expect(stats.outputTokens).toBe(15)
    expect(stats.errors).toBe(1)
  })

  it('never mixes two workspaces up, even siblings of one comparison', () => {
    event('w2', 's9', 'user:message', { content: 'other', sender: 'user' })
    event('w2', 's9', 'agent:event', {
      kind: 'tool:call',
      messageId: 'm',
      toolCallId: 't',
      name: 'AskUserQuestion',
      input: {},
    })

    const stats = computeWorkspaceActivityStats(db, 'w1')

    expect(stats.userMessages).toBe(0)
    expect(stats.questions).toBe(0)
  })

  it('returns zeros, not nulls, for a workspace with no history yet', () => {
    expect(computeWorkspaceActivityStats(db, 'w2')).toMatchObject({
      userMessages: 0,
      agentMessages: 0,
      questions: 0,
      toolCalls: 0,
      errors: 0,
      inputTokens: 0,
      outputTokens: 0,
    })
  })
})
