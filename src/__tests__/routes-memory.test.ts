import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { listContextRecords } = vi.hoisted(() => ({ listContextRecords: vi.fn(() => []) }))

vi.mock('../server/services/memory-service.js', async () => {
  const actual = await vi.importActual<typeof import('../server/services/memory-service.js')>(
    '../server/services/memory-service.js',
  )
  return {
    ...actual,
    MemoryNotFoundError: class MemoryNotFoundError extends Error {},
    MemoryConflictError: class MemoryConflictError extends Error {},
    resolveMemoryScope: vi.fn(),
    listMemoryScopes: vi.fn(() => ({ items: [] })),
    createMemory: vi.fn(),
    updateMemory: vi.fn(),
    listMemories: vi.fn(() => ({ items: [], totalCount: 0 })),
    deleteMemory: vi.fn(),
    promoteMemory: vi.fn(),
    listMemoryProposals: vi.fn(() => []),
    approveMemoryProposal: vi.fn(),
    rejectMemoryProposal: vi.fn(),
    previewMemoryClear: vi.fn(),
    clearMemoryScope: vi.fn(),
    listMemoryOperations: vi.fn(() => ({ items: [] })),
    listWorkspaceMemoryOperations: vi.fn(() => ({ items: [] })),
  }
})

vi.mock('../server/services/memory-context-service.js', () => ({ listMemoryContextRecords: listContextRecords }))

import { getDb } from '../server/db/index.js'
import router from '../server/routes/memory.js'
import { allocateMemoryConversationKey, createMemoryCapability } from '../server/services/memory-agent-runtime.js'
import { getInternalMemoryBudgetContext } from '../server/services/memory-budget-service.js'
import * as memoryService from '../server/services/memory-service.js'
import { createIdleSession, createWorkspace } from '../server/services/workspace-service.js'
import { resetDb } from './helpers/reset-db.js'

const app = new Hono()
app.route('/api/memory', router)

const entry = {
  id: 'entry-1',
  scopeId: 'scope-1',
  key: 'preference.editor',
  title: 'Editor',
  body: 'Use Vim',
  revision: 1,
  actor: { kind: 'human' as const },
  createdAt: '2026-10-05T00:00:00.000Z',
  updatedAt: '2026-10-05T00:00:00.000Z',
}

beforeEach(() => vi.clearAllMocks())

describe('memory HTTP routes', () => {
  it('lists persisted scopes, including persisted-only scopes from the service', async () => {
    vi.mocked(memoryService.listMemoryScopes).mockReturnValue({
      items: [{ id: 'scope-p', level: 'project', revision: 0, generation: 0 }],
    })
    const response = await app.request('/api/memory/scopes')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ items: [{ id: 'scope-p', level: 'project', revision: 0, generation: 0 }] })
    expect(memoryService.listMemoryScopes).toHaveBeenCalledWith({ cursor: undefined, limit: undefined })
  })

  it('validates create JSON and passes only a human actor to the service', async () => {
    expect(
      (
        await app.request('/api/memory/entries', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{',
        })
      ).status,
    ).toBe(400)
    const response = await app.request('/api/memory/entries', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scopeId: 'scope-1',
        key: 'preference.editor',
        title: 'Editor',
        body: 'Use Vim',
        actor: { kind: 'internal-agent' },
      }),
    })
    expect(response.status).toBe(201)
    expect(memoryService.createMemory).toHaveBeenCalledWith({
      scopeId: 'scope-1',
      key: 'preference.editor',
      title: 'Editor',
      body: 'Use Vim',
      actor: { kind: 'human' },
    })
  })

  it('rejects an oversized note before calling the service', async () => {
    const response = await app.request('/api/memory/entries', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scopeId: 'scope-1', key: 'too-big', title: 'Too big', body: 'x'.repeat(2001) }),
    })
    expect(response.status).toBe(413)
    expect(memoryService.createMemory).not.toHaveBeenCalled()
  })

  it('supports entry pagination and search on an exact scope', async () => {
    vi.mocked(memoryService.listMemories).mockReturnValue({ items: [entry], nextCursor: '10', totalCount: 11 })
    const response = await app.request('/api/memory/entries?scopeId=scope-1&cursor=5&limit=5&query=Vim')
    expect(response.status).toBe(200)
    expect(memoryService.listMemories).toHaveBeenCalledWith({ scopeId: 'scope-1', cursor: '5', limit: 5, query: 'Vim' })
  })

  it('maps an entry/scope mismatch to 404', async () => {
    vi.mocked(memoryService.updateMemory).mockImplementation(() => {
      throw new memoryService.MemoryNotFoundError()
    })
    const response = await app.request('/api/memory/entries/entry-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scopeId: 'other-scope', expectedRevision: 1, key: 'a', title: 'A', body: 'B' }),
    })
    expect(response.status).toBe(404)
  })

  it('maps stale revisions to 409 and leaves conflict policy in the service', async () => {
    vi.mocked(memoryService.updateMemory).mockImplementation(() => {
      throw new memoryService.MemoryConflictError()
    })
    const response = await app.request('/api/memory/entries/entry-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scopeId: 'scope-1', expectedRevision: 1, key: 'a', title: 'A', body: 'B' }),
    })
    expect(response.status).toBe(409)
  })

  it('allows a partial PATCH and forwards only the fields supplied', async () => {
    vi.mocked(memoryService.updateMemory).mockReturnValue({ ...entry, title: 'Renamed', revision: 2 })
    const response = await app.request('/api/memory/entries/entry-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scopeId: 'scope-1', expectedRevision: 1, title: 'Renamed' }),
    })
    expect(response.status).toBe(200)
    expect(memoryService.updateMemory).toHaveBeenCalledWith({
      scopeId: 'scope-1',
      entryId: 'entry-1',
      expectedRevision: 1,
      title: 'Renamed',
      actor: { kind: 'human' },
    })
  })

  it('deletes by exact scope and expected revision without returning memory content', async () => {
    const response = await app.request('/api/memory/entries/entry-1', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scopeId: 'scope-1', expectedRevision: 1 }),
    })
    expect(response.status).toBe(204)
    expect(await response.text()).toBe('')
    expect(memoryService.deleteMemory).toHaveBeenCalledWith({
      scopeId: 'scope-1',
      entryId: 'entry-1',
      expectedRevision: 1,
      actor: { kind: 'human' },
    })
  })

  it('promotes by copying an entry into an explicit target scope', async () => {
    vi.mocked(memoryService.promoteMemory).mockReturnValue({ ...entry, id: 'entry-copy', scopeId: 'scope-target' })
    const response = await app.request('/api/memory/entries/entry-1/promote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceScopeId: 'scope-1', targetScopeId: 'scope-target' }),
    })
    expect(response.status).toBe(201)
    expect(memoryService.promoteMemory).toHaveBeenCalledWith({
      sourceScopeId: 'scope-1',
      entryId: 'entry-1',
      targetScopeId: 'scope-target',
      actor: { kind: 'human' },
    })
  })

  it('keeps proposal approval and rejection on the human route surface', async () => {
    vi.mocked(memoryService.listMemoryProposals).mockReturnValue([])
    expect((await app.request('/api/memory/proposals?scopeId=scope-1')).status).toBe(200)
    expect(memoryService.listMemoryProposals).toHaveBeenCalledWith('scope-1')
    expect((await app.request('/api/memory/proposals/proposal-1/approve', { method: 'POST' })).status).toBe(200)
    expect(memoryService.approveMemoryProposal).toHaveBeenCalledWith('proposal-1', { kind: 'human' })
    expect((await app.request('/api/memory/proposals/proposal-2/reject', { method: 'POST' })).status).toBe(204)
    expect(memoryService.rejectMemoryProposal).toHaveBeenCalledWith('proposal-2', { kind: 'human' })
  })

  it('previews clear and requires the preview revision to clear', async () => {
    vi.mocked(memoryService.previewMemoryClear).mockReturnValue({
      scope: { id: 'scope-1', level: 'global', revision: 4, generation: 2 },
      entries: 3,
      proposals: 1,
      revision: 4,
      generation: 2,
    })
    const preview = await app.request('/api/memory/scopes/scope-1/clear-preview')
    expect(preview.status).toBe(200)
    expect((await preview.json()).entries).toBe(3)
    vi.mocked(memoryService.clearMemoryScope).mockImplementation(() => {
      throw new memoryService.MemoryConflictError()
    })
    const clear = await app.request('/api/memory/scopes/scope-1/clear', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 3 }),
    })
    expect(clear.status).toBe(409)
  })

  it('rejects unknown workspaces and does not fabricate context records', async () => {
    vi.mocked(memoryService.listMemoryScopes).mockImplementation(() => {
      throw new memoryService.MemoryNotFoundError()
    })
    const response = await app.request('/api/memory/workspaces/missing/view')
    expect(response.status).toBe(404)
    expect(memoryService.listMemories).not.toHaveBeenCalled()
  })

  it('returns only applicable workspace memory and selected-session context records', async () => {
    vi.mocked(memoryService.listMemoryScopes).mockReturnValue({
      items: [
        { id: 'global', level: 'global', revision: 0, generation: 0 },
        { id: 'project', level: 'project', revision: 0, generation: 0 },
        { id: 'workspace', level: 'workspace', revision: 0, generation: 0 },
      ],
    })
    vi.mocked(memoryService.listMemories).mockReturnValue({ items: [entry], totalCount: 1 })
    listContextRecords.mockReturnValue([
      { id: 'ctx-1', sessionId: 'session-1', state: 'initialized', entryStates: [] },
    ] as never)
    const response = await app.request('/api/memory/workspaces/ws-1/view?sessionId=session-1')
    expect(response.status).toBe(200)
    const view = await response.json()
    expect(view.scopes.map((scope: { id: string }) => scope.id)).toEqual(['global', 'project', 'workspace'])
    expect(view.entries).toEqual([entry])
    expect(view.contexts).toEqual([{ id: 'ctx-1', sessionId: 'session-1', state: 'initialized', entryStates: [] }])
    expect(listContextRecords).toHaveBeenCalledWith('ws-1', 'session-1')
    expect(memoryService.listMemories).toHaveBeenCalledWith({ workspaceId: 'ws-1' })
  })

  it('returns exact scope generations and revisions to an internal MCP caller', async () => {
    await resetDb()
    const workspace = createWorkspace({
      name: 'Memory scope catalogue',
      projectPath: '/tmp/memory-scope-catalogue',
      sourceBranch: 'main',
      workingBranch: 'test',
    })
    const session = createIdleSession(workspace.id)
    const conversationKey = allocateMemoryConversationKey({ sessionId: session.id, engine: 'claude-code' })
    const capability = createMemoryCapability({
      dispatchId: 'memory-scope-catalogue-test',
      workspaceId: workspace.id,
      sessionId: session.id,
      engine: 'claude-code',
      conversationKey,
      readOnly: false,
    })
    vi.mocked(memoryService.listMemoryScopes).mockReturnValue({
      items: [
        {
          id: 'scope-project',
          level: 'project',
          projectPath: '/tmp/memory-scope-catalogue',
          revision: 7,
          generation: 3,
        },
      ],
    })

    const response = await app.request('/api/memory/agent/list_memory_scopes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Kobo-Memory-Session': capability.token },
      body: '{}',
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      items: [
        {
          id: 'scope-project',
          level: 'project',
          revision: 7,
          generation: 3,
        },
      ],
    })
  })

  it('lists the journal across only a requested workspace with a stable cursor', async () => {
    vi.mocked(memoryService.listWorkspaceMemoryOperations).mockReturnValue({
      items: [{ ...entry, id: 1 }] as never,
      nextCursor: '90',
    })
    const response = await app.request('/api/memory/operations?workspaceId=ws-1&afterCursor=120&limit=10')
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ nextCursor: '90' })
    expect(memoryService.listWorkspaceMemoryOperations).toHaveBeenCalledWith('ws-1', { cursor: '120', limit: 10 })
    expect(memoryService.listMemoryOperations).not.toHaveBeenCalled()
  })

  it('charges bounded internal MCP errors and does not spend again after exhaustion', async () => {
    await resetDb()
    const workspace = createWorkspace({
      name: 'Internal memory budget error',
      projectPath: '/tmp/internal-memory-budget-error',
      sourceBranch: 'main',
      workingBranch: 'test',
    })
    const session = createIdleSession(workspace.id)
    const conversationKey = allocateMemoryConversationKey({ sessionId: session.id, engine: 'claude-code' })
    const capability = createMemoryCapability({
      dispatchId: 'memory-budget-error-test',
      workspaceId: workspace.id,
      sessionId: session.id,
      engine: 'claude-code',
      conversationKey,
      readOnly: false,
    })
    const ledger = getInternalMemoryBudgetContext(conversationKey)
    const chargedError = await app.request('/api/memory/agent/read_memory', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Kobo-Memory-Session': capability.token,
      },
      body: JSON.stringify({ scope_id: 'missing-scope', entry_id: 'missing-entry', forged_actor: 'human' }),
    })
    const chargedResult = await chargedError.json()
    expect(chargedError.status).toBe(400)
    expect(chargedResult).toMatchObject({ error: expect.any(String), budget: { estimatedTokens: expect.any(Number) } })
    expect(chargedResult.budget.remainingTokens).toBeLessThan(6000)

    getDb().prepare('UPDATE memory_budget_contexts SET cumulative_estimated_tokens = 5500 WHERE id = ?').run(ledger.id)

    const exhaustedReplies: Array<Record<string, unknown>> = []
    const suppressedReplies: Array<Record<string, unknown>> = []
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await app.request('/api/memory/agent/read_memory', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Kobo-Memory-Session': capability.token,
        },
        body: JSON.stringify({ scope_id: 'missing-scope', entry_id: 'missing-entry' }),
      })
      const result = await response.json()
      expect(response.status).toBe(200)
      expect(JSON.stringify(result).length).toBeLessThan(500)
      if (attempt === 0) {
        exhaustedReplies.push(result)
        expect(result).toMatchObject({ budgetExhausted: true, remainingTokens: 0 })
      } else {
        suppressedReplies.push(result)
        expect(result).toEqual({ budgetExhausted: true, memoryOutputSuppressed: true })
      }
    }

    const finalLedger = getDb()
      .prepare('SELECT cumulative_estimated_tokens AS total, delivered_json FROM memory_budget_contexts WHERE id = ?')
      .get(ledger.id) as { total: number; delivered_json: string }
    expect(finalLedger.total).toBeGreaterThan(5500)
    expect(finalLedger.total).toBeLessThanOrEqual(6000)
    expect(
      JSON.parse(finalLedger.delivered_json).filter((item: { kind?: string }) => item.kind === 'budget-denial'),
    ).toHaveLength(1)
    expect(exhaustedReplies).toHaveLength(1)
    expect(suppressedReplies).toHaveLength(2)
  })

  it('passes operation journal pagination through without exposing bodies', async () => {
    vi.mocked(memoryService.listMemoryOperations).mockReturnValue({
      items: [
        { id: 1, scopeId: 'scope-1', kind: 'deleted', actor: { kind: 'human' }, createdAt: '2026-10-05T00:00:00.000Z' },
      ],
    })
    const response = await app.request('/api/memory/operations?scopeId=scope-1&workspaceId=ws-1&afterCursor=8&limit=12')
    expect(response.status).toBe(200)
    expect(memoryService.listMemoryOperations).toHaveBeenCalledWith({
      scopeId: 'scope-1',
      workspaceId: 'ws-1',
      cursor: '8',
      limit: 12,
    })
    expect(await response.text()).not.toContain('body')
  })
})
