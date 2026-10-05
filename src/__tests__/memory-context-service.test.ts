import { afterEach, describe, expect, it } from 'vitest'
import { getDb } from '../server/db/index.js'
import { allocateMemoryConversationKey } from '../server/services/memory-agent-runtime.js'
import {
  buildMemoryContext,
  listMemoryContextRecords,
  markMemoryContextFailed,
  markMemoryContextInitialized,
  markMemoryContextSubmitted,
  reconcileMemoryContextsOnStartup,
} from '../server/services/memory-context-service.js'
import { createMemory, deleteMemory, resolveMemoryScope, updateMemory } from '../server/services/memory-service.js'
import { createIdleSession, createWorkspace } from '../server/services/workspace-service.js'
import { resetDb } from './helpers/reset-db.js'

describe('bounded memory launch context', () => {
  afterEach(async () => {
    await resetDb()
  })

  it('lists bounded session contexts and reveals text only for matching live revisions', async () => {
    await resetDb()
    const workspace = createWorkspace({
      name: 'Context history',
      projectPath: '/tmp/context-history',
      sourceBranch: 'main',
      workingBranch: 'feature/context-history',
    })
    const session = createIdleSession(workspace.id)
    const otherWorkspace = createWorkspace({
      name: 'Other context',
      projectPath: '/tmp/other-context',
      sourceBranch: 'main',
      workingBranch: 'feature/other-context',
    })
    const otherSession = createIdleSession(otherWorkspace.id)
    const scope = resolveMemoryScope({ level: 'workspace', workspaceId: workspace.id })
    const unchanged = createMemory({
      scopeId: scope.id,
      key: 'unchanged',
      title: 'Unchanged',
      body: 'Still current',
      actor: { kind: 'human' },
    })
    const changed = createMemory({
      scopeId: scope.id,
      key: 'changed',
      title: 'Changed',
      body: 'Old transmitted body',
      actor: { kind: 'human' },
    })
    const deleted = createMemory({
      scopeId: scope.id,
      key: 'deleted',
      title: 'Deleted',
      body: 'Deleted transmitted body',
      actor: { kind: 'human' },
    })
    const conversationKey = allocateMemoryConversationKey({ sessionId: session.id, engine: 'claude-code' })
    const context = buildMemoryContext({
      workspaceId: workspace.id,
      sessionId: session.id,
      engine: 'claude-code',
      dispatchId: 'context-history-dispatch',
      conversationKey,
      resume: false,
    })
    markMemoryContextSubmitted(context.recordId)
    updateMemory({
      scopeId: scope.id,
      entryId: changed.id,
      expectedRevision: 1,
      body: 'New current body',
      actor: { kind: 'human' },
    })
    deleteMemory({ scopeId: scope.id, entryId: deleted.id, expectedRevision: 1, actor: { kind: 'human' } })

    const records = listMemoryContextRecords(workspace.id, session.id)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      id: context.recordId,
      state: 'submitted',
      sessionId: session.id,
      engine: 'claude-code',
      omittedCount: context.omittedCount,
      estimatedTokens: context.estimatedTokens,
      limitTokens: 6000,
    })
    expect(records[0]?.entryStates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: unchanged.id, state: 'current', title: 'Unchanged', body: 'Still current' }),
        expect.objectContaining({ id: changed.id, state: 'changed' }),
        expect.objectContaining({ id: deleted.id, state: 'deleted' }),
      ]),
    )
    expect(JSON.stringify(records)).not.toContain('Old transmitted body')
    expect(JSON.stringify(records)).not.toContain('Deleted transmitted body')
    expect(listMemoryContextRecords(workspace.id, otherSession.id)).toEqual([])
  })

  it('selects applicable entries deterministically without journalizing an agent read', async () => {
    await resetDb()
    const workspace = createWorkspace({
      name: 'Context test',
      projectPath: '/tmp/context-test',
      sourceBranch: 'main',
      workingBranch: 'feature/context-test',
    })
    const session = createIdleSession(workspace.id)
    const conversationKey = allocateMemoryConversationKey({ sessionId: session.id, engine: 'claude-code' })
    const global = resolveMemoryScope({ level: 'global' })
    const project = resolveMemoryScope({ level: 'project', projectPath: workspace.projectPath })
    const local = resolveMemoryScope({ level: 'workspace', workspaceId: workspace.id })
    for (const [scope, key, body] of [
      [global, 'preference', 'Prefer concise answers.'],
      [project, 'runtime', 'The application uses SQLite.'],
      [local, 'decision', 'The cache is intentionally disabled.'],
    ] as const) {
      createMemory({ scopeId: scope.id, key, title: key, body, actor: { kind: 'human' } })
    }

    const context = buildMemoryContext({
      workspaceId: workspace.id,
      sessionId: session.id,
      engine: 'claude-code',
      dispatchId: 'dispatch-first',
      conversationKey,
      resume: false,
    })

    expect(context.prompt).toContain('The cache is intentionally disabled.')
    expect(context.prompt).toContain('The application uses SQLite.')
    expect(context.prompt).toContain('Prefer concise answers.')
    expect(context.entryRevisions).toHaveLength(3)
    expect(context.omittedCount).toBe(0)
    expect(context.payloadBytes).toBeLessThanOrEqual(6000)
    expect(context.estimatedTokens).toBeLessThanOrEqual(1000)
    expect(getDb().prepare("SELECT count(*) AS n FROM memory_operations WHERE operation = 'read'").get()).toEqual({
      n: 0,
    })
  })

  it('does not include proposals and records metadata-only dispatch lifecycle', async () => {
    await resetDb()
    const workspace = createWorkspace({
      name: 'Context proposal',
      projectPath: '/tmp/context-proposal',
      sourceBranch: 'main',
      workingBranch: 'feature/context-proposal',
    })
    const session = createIdleSession(workspace.id)
    const conversationKey = allocateMemoryConversationKey({ sessionId: session.id, engine: 'codex' })
    const global = resolveMemoryScope({ level: 'global' })
    getDb()
      .prepare(`INSERT INTO memory_proposals
      (id, scope_id, memory_key, title, body, generation, actor_kind, created_at, updated_at)
      VALUES ('proposal-only', ?, 'secret', 'Proposal', 'Must not leak into prompt', 0, 'human', ?, ?)`)
      .run(global.id, new Date().toISOString(), new Date().toISOString())

    const context = buildMemoryContext({
      workspaceId: workspace.id,
      sessionId: session.id,
      engine: 'codex',
      dispatchId: 'dispatch-lifecycle',
      conversationKey,
      resume: false,
    })

    expect(context.prompt).not.toContain('Must not leak into prompt')
    expect(context.recordId).toBeTruthy()
    markMemoryContextSubmitted(context.recordId)
    markMemoryContextInitialized(context.recordId)
    const row = getDb()
      .prepare('SELECT state, entry_revisions_json, budget_context_id, budget_epoch FROM memory_contexts WHERE id = ?')
      .get(context.recordId)
    expect(row).toEqual({
      state: 'initialized',
      entry_revisions_json: '[]',
      budget_context_id: context.budgetContextId,
      budget_epoch: context.budgetEpoch,
    })
    expect(JSON.stringify(row)).not.toContain('Proposal')
  })

  it('uses stable labeled excerpts and reports every omitted entry within the full prompt budget', async () => {
    await resetDb()
    const workspace = createWorkspace({
      name: 'Context budget',
      projectPath: '/tmp/context-budget',
      sourceBranch: 'main',
      workingBranch: 'feature/context-budget',
    })
    const session = createIdleSession(workspace.id)
    const conversationKey = allocateMemoryConversationKey({ sessionId: session.id, engine: 'claude-code' })
    const scope = resolveMemoryScope({ level: 'workspace', workspaceId: workspace.id })
    for (let index = 0; index < 8; index++) {
      createMemory({
        scopeId: scope.id,
        key: `fact-${index}`,
        title: `Fact ${index}`,
        body: `${index}: ${'durable detail '.repeat(100)}`,
        actor: { kind: 'human' },
      })
    }

    const first = buildMemoryContext({
      workspaceId: workspace.id,
      sessionId: session.id,
      engine: 'claude-code',
      dispatchId: 'budget-first',
      conversationKey,
      resume: false,
    })
    const second = buildMemoryContext({
      workspaceId: workspace.id,
      sessionId: session.id,
      engine: 'claude-code',
      dispatchId: 'budget-second',
      conversationKey,
      resume: false,
    })

    expect(first.prompt).toBe(second.prompt)
    expect(first.prompt).toContain('extrait partiel')
    expect(first.omittedCount).toBe(8 - first.entryRevisions.length)
    expect(first.omittedCount).toBeGreaterThan(0)
    expect(first.estimatedTokens).toBeLessThanOrEqual(1000)
    expect(first.payloadBytes).toBeLessThanOrEqual(6000)
  })

  it('does not replay unchanged entries that appeared in any earlier resume dispatch in the epoch', async () => {
    await resetDb()
    const workspace = createWorkspace({
      name: 'Multi resume',
      projectPath: '/tmp/multi-resume',
      sourceBranch: 'main',
      workingBranch: 'feature/multi-resume',
    })
    const session = createIdleSession(workspace.id)
    const conversationKey = allocateMemoryConversationKey({ sessionId: session.id, engine: 'claude-code' })
    const scope = resolveMemoryScope({ level: 'workspace', workspaceId: workspace.id })
    createMemory({
      scopeId: scope.id,
      key: 'first',
      title: 'First',
      body: 'Sent on first dispatch.',
      actor: { kind: 'human' },
    })
    buildMemoryContext({
      workspaceId: workspace.id,
      sessionId: session.id,
      engine: 'claude-code',
      dispatchId: 'first',
      conversationKey,
      resume: false,
    })
    createMemory({
      scopeId: scope.id,
      key: 'second',
      title: 'Second',
      body: 'Sent on second dispatch.',
      actor: { kind: 'human' },
    })
    const second = buildMemoryContext({
      workspaceId: workspace.id,
      sessionId: session.id,
      engine: 'claude-code',
      dispatchId: 'second',
      conversationKey,
      resume: true,
    })
    const third = buildMemoryContext({
      workspaceId: workspace.id,
      sessionId: session.id,
      engine: 'claude-code',
      dispatchId: 'third',
      conversationKey,
      resume: true,
    })

    expect(second.prompt).toContain('Sent on second dispatch.')
    expect(second.prompt).not.toContain('Sent on first dispatch.')
    expect(third.prompt).not.toContain('Sent on first dispatch.')
    expect(third.prompt).not.toContain('Sent on second dispatch.')
    expect(third.entryRevisions).toEqual([])
  })

  it('recalls only changed facts on native resume and adds mode guidance to read-only launches', async () => {
    await resetDb()
    const workspace = createWorkspace({
      name: 'Context resume',
      projectPath: '/tmp/context-resume',
      sourceBranch: 'main',
      workingBranch: 'feature/context-resume',
    })
    const session = createIdleSession(workspace.id)
    const conversationKey = allocateMemoryConversationKey({ sessionId: session.id, engine: 'codex' })
    const scope = resolveMemoryScope({ level: 'workspace', workspaceId: workspace.id })
    const unchanged = createMemory({
      scopeId: scope.id,
      key: 'unchanged',
      title: 'Still',
      body: 'Same.',
      actor: { kind: 'human' },
    })
    const changed = createMemory({
      scopeId: scope.id,
      key: 'changed',
      title: 'Changed',
      body: 'Old.',
      actor: { kind: 'human' },
    })
    const first = buildMemoryContext({
      workspaceId: workspace.id,
      sessionId: session.id,
      engine: 'codex',
      dispatchId: 'resume-first',
      conversationKey,
      resume: false,
    })
    markMemoryContextSubmitted(first.recordId)
    markMemoryContextInitialized(first.recordId)
    updateMemory({
      scopeId: scope.id,
      entryId: changed.id,
      expectedRevision: 1,
      body: 'Updated.',
      actor: { kind: 'human' },
    })
    createMemory({
      scopeId: scope.id,
      key: 'new-fact',
      title: 'New',
      body: 'Added.',
      actor: { kind: 'human' },
    })

    const resumed = buildMemoryContext({
      workspaceId: workspace.id,
      sessionId: session.id,
      engine: 'codex',
      dispatchId: 'resume-second',
      conversationKey,
      resume: true,
      readOnly: true,
      mode: 'manual',
    })

    expect(resumed.prompt).toContain('Updated.')
    expect(resumed.prompt).toContain('Added.')
    expect(resumed.prompt).not.toContain(unchanged.body)
    expect(resumed.prompt).toContain('Mode manual')
    expect(resumed.prompt).toContain('Read-only launch')
    expect(resumed.prompt).toContain('Conversation reprise')
  })

  it('marks leftover submissions unknown on restart and keeps failures dispatch-scoped', async () => {
    await resetDb()
    const workspace = createWorkspace({
      name: 'Context state',
      projectPath: '/tmp/context-state',
      sourceBranch: 'main',
      workingBranch: 'feature/context-state',
    })
    const session = createIdleSession(workspace.id)
    const firstKey = allocateMemoryConversationKey({ sessionId: session.id, engine: 'claude-code' })
    const secondKey = allocateMemoryConversationKey({ sessionId: session.id, engine: 'claude-code' })
    const first = buildMemoryContext({
      workspaceId: workspace.id,
      sessionId: session.id,
      engine: 'claude-code',
      dispatchId: 'dispatch-unknown',
      conversationKey: firstKey,
      resume: false,
    })
    const second = buildMemoryContext({
      workspaceId: workspace.id,
      sessionId: session.id,
      engine: 'claude-code',
      dispatchId: 'dispatch-failure',
      conversationKey: secondKey,
      resume: false,
    })
    markMemoryContextSubmitted(first.recordId)
    markMemoryContextSubmitted(second.recordId)
    markMemoryContextFailed(second.recordId)

    expect(reconcileMemoryContextsOnStartup()).toBe(1)
    expect(reconcileMemoryContextsOnStartup()).toBe(0)
    const states = getDb().prepare('SELECT dispatch_id, state FROM memory_contexts ORDER BY dispatch_id').all()
    expect(states).toEqual([
      { dispatch_id: 'dispatch-failure', state: 'failed' },
      { dispatch_id: 'dispatch-unknown', state: 'unknown' },
    ])
  })
})
