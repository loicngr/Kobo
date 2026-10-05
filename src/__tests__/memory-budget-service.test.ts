import { afterEach, describe, expect, it } from 'vitest'
import { closeDb, getDb } from '../server/db/index.js'
import { allocateMemoryConversationKey } from '../server/services/memory-agent-runtime.js'
import {
  createExternalMemoryBudgetContext,
  reserveMemoryBudget,
  reserveMemoryBudgetDenial,
} from '../server/services/memory-budget-service.js'
import { createIdleSession, createWorkspace } from '../server/services/workspace-service.js'
import { resetDb } from './helpers/reset-db.js'

describe('persistent memory output budget', () => {
  afterEach(async () => resetDb())

  it('charges internal bootstrap and output reservations atomically up to the epoch limit', async () => {
    await resetDb()
    const workspace = createWorkspace({
      name: 'Budget',
      projectPath: '/tmp/budget',
      sourceBranch: 'main',
      workingBranch: 'test',
    })
    const session = createIdleSession(workspace.id)
    const key = allocateMemoryConversationKey({ sessionId: session.id, engine: 'codex' })
    const ledger = getDb().prepare('SELECT id FROM memory_budget_contexts WHERE conversation_key = ?').get(key) as {
      id: string
    }
    expect(reserveMemoryBudget({ budgetContextId: ledger.id, estimatedTokens: 1_000 })).toMatchObject({
      accepted: true,
      remainingTokens: 4_500,
    })
    expect(reserveMemoryBudget({ budgetContextId: ledger.id, estimatedTokens: 4_501 }).accepted).toBe(false)
    expect(reserveMemoryBudget({ budgetContextId: ledger.id, estimatedTokens: 4_500 }).accepted).toBe(true)
    expect(reserveMemoryBudget({ budgetContextId: ledger.id, estimatedTokens: 1 }).accepted).toBe(false)
    expect(reserveMemoryBudgetDenial(ledger.id, 500)).toMatchObject({ responseAllowed: true })
    expect(reserveMemoryBudgetDenial(ledger.id, 500)).toMatchObject({ responseAllowed: false })
    expect(
      getDb()
        .prepare('SELECT cumulative_estimated_tokens AS total FROM memory_budget_contexts WHERE id = ?')
        .get(ledger.id),
    ).toEqual({ total: 6_000 })
  })

  it('only resolves external handles in the external namespace', async () => {
    await resetDb()
    const workspace = createWorkspace({
      name: 'External',
      projectPath: '/tmp/external-budget',
      sourceBranch: 'main',
      workingBranch: 'test',
    })
    const session = createIdleSession(workspace.id)
    const internalKey = allocateMemoryConversationKey({ sessionId: session.id, engine: 'claude-code' })
    const internal = getDb()
      .prepare('SELECT id FROM memory_budget_contexts WHERE conversation_key = ?')
      .get(internalKey) as { id: string }
    expect(() => createExternalMemoryBudgetContext(internal.id, 'client', 'http')).toThrow()
    const created = createExternalMemoryBudgetContext(undefined, 'client', 'http')
    expect(created.id).not.toBe(internal.id)
    expect(getDb().prepare('SELECT kind FROM memory_budget_contexts WHERE id = ?').get(created.id)).toEqual({
      kind: 'external',
    })
    expect(
      reserveMemoryBudget({
        budgetContextId: created.id,
        estimatedTokens: 200,
        delivery: {
          entryId: 'memory-id',
          revision: 2,
          kind: 'body-fragment',
          start: 0,
          end: 40,
        },
      }),
    ).toMatchObject({ accepted: true, remainingTokens: 5_300 })
    expect(createExternalMemoryBudgetContext(created.id, 'client', 'http').cumulativeEstimatedTokens).toBe(200)
    expect(() => createExternalMemoryBudgetContext(created.id, 'another client', 'http')).toThrow(/another/)
    const ledger = getDb()
      .prepare('SELECT delivered_json FROM memory_budget_contexts WHERE id = ?')
      .get(created.id) as { delivered_json: string }
    expect(ledger.delivered_json).toContain('memory-id')
    expect(ledger.delivered_json).not.toContain('secret note body')
  })

  it('serializes competing reservations against the last remaining allowance', async () => {
    await resetDb()
    const workspace = createWorkspace({
      name: 'Race',
      projectPath: '/tmp/race',
      sourceBranch: 'main',
      workingBranch: 'test',
    })
    const session = createIdleSession(workspace.id)
    const key = allocateMemoryConversationKey({ sessionId: session.id, engine: 'codex' })
    const ledger = getDb().prepare('SELECT id FROM memory_budget_contexts WHERE conversation_key = ?').get(key) as {
      id: string
    }
    getDb().prepare('UPDATE memory_budget_contexts SET cumulative_estimated_tokens = 5_300 WHERE id = ?').run(ledger.id)
    const results = await Promise.all([
      Promise.resolve().then(() => reserveMemoryBudget({ budgetContextId: ledger.id, estimatedTokens: 200 })),
      Promise.resolve().then(() => reserveMemoryBudget({ budgetContextId: ledger.id, estimatedTokens: 200 })),
    ])
    expect(results.filter((result) => result.accepted)).toHaveLength(1)
    expect(
      getDb()
        .prepare('SELECT cumulative_estimated_tokens AS total FROM memory_budget_contexts WHERE id = ?')
        .get(ledger.id),
    ).toEqual({ total: 5_500 })
  })

  it('allows only one concurrent denial and keeps the denial spent after reopening SQLite', async () => {
    const { dbPath } = await resetDb()
    const workspace = createWorkspace({
      name: 'Denial race',
      projectPath: '/tmp/denial-race',
      sourceBranch: 'main',
      workingBranch: 'test',
    })
    const session = createIdleSession(workspace.id)
    const key = allocateMemoryConversationKey({ sessionId: session.id, engine: 'codex' })
    const ledger = getDb().prepare('SELECT id FROM memory_budget_contexts WHERE conversation_key = ?').get(key) as {
      id: string
    }
    getDb().prepare('UPDATE memory_budget_contexts SET cumulative_estimated_tokens = 5_500 WHERE id = ?').run(ledger.id)

    const reservations = await Promise.all([
      Promise.resolve().then(() => reserveMemoryBudgetDenial(ledger.id, 500)),
      Promise.resolve().then(() => reserveMemoryBudgetDenial(ledger.id, 500)),
    ])
    expect(reservations.filter((reservation) => reservation.responseAllowed)).toHaveLength(1)
    expect(
      getDb()
        .prepare('SELECT cumulative_estimated_tokens AS total FROM memory_budget_contexts WHERE id = ?')
        .get(ledger.id),
    ).toEqual({ total: 6_000 })

    closeDb()
    getDb(dbPath)
    expect(reserveMemoryBudgetDenial(ledger.id, 1)).toMatchObject({ responseAllowed: false })
    const persisted = getDb()
      .prepare('SELECT delivered_json FROM memory_budget_contexts WHERE id = ?')
      .get(ledger.id) as {
      delivered_json: string
    }
    expect(
      JSON.parse(persisted.delivered_json).filter((item: { kind?: string }) => item.kind === 'budget-denial'),
    ).toHaveLength(1)
  })
})
