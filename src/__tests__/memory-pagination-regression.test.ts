import { Hono } from 'hono'
import { beforeEach, describe, expect, it } from 'vitest'
import router from '../server/routes/memory.js'
import { allocateMemoryConversationKey, createMemoryCapability } from '../server/services/memory-agent-runtime.js'
import { executeMemoryMcpTool } from '../server/services/memory-mcp-service.js'
import { createMemory, resolveMemoryScope } from '../server/services/memory-service.js'
import { createIdleSession, createWorkspace } from '../server/services/workspace-service.js'
import { prepareMemoryToolEnvelope } from '../server/utils/memory-token-budget.js'
import { validateMemoryToolArguments } from '../shared/memory-tools.js'
import { resetDb } from './helpers/reset-db.js'

const app = new Hono().route('/api/memory', router)
const items = Array.from({ length: 5 }, (_, i) => ({
  id: `entry-${i}`,
  scopeId: 's'.repeat(21),
  key: `note-${i}`,
  title: `Note ${i}`,
  revision: 1,
}))
const receipt = {
  memory_context_id: 'c'.repeat(32),
  budget: { estimatedTokens: 1000, remainingTokens: 6000, exhausted: false },
}

describe('memory MCP pagination regressions', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('provides a continuation when a last offset page is truncated', () => {
    const output = prepareMemoryToolEnvelope({ items, totalCount: 5, ...receipt })
    const kept = output.data.items as unknown[]
    expect(kept.length).toBeGreaterThan(0)
    expect(kept.length).toBeLessThan(5)
    expect(output.data.nextCursor).toBe(String(kept.length))
  })

  it('preserves the starting offset on a truncated last page', () => {
    const output = prepareMemoryToolEnvelope({ items, totalCount: 15, ...receipt }, { pageOffset: 10 })
    expect(output.data.nextCursor).toBe(String(10 + (output.data.items as unknown[]).length))
  })

  it('uses the last returned numeric operation id even on a truncated last page', () => {
    const output = prepareMemoryToolEnvelope({
      items: items.map((item, i) => ({ ...item, id: 95 - i * 3 })),
      ...receipt,
    })
    const kept = output.data.items as Array<{ id: number }>
    expect(kept.length).toBeGreaterThan(0)
    expect(output.data.nextCursor).toBe(String(kept.at(-1)!.id))
  })

  it('keeps navigable identity when a single maximum-size metadata item cannot fit', () => {
    const largeItems = Array.from({ length: 3 }, (_, i) => ({
      id: `entry-${i}`,
      scopeId: 's'.repeat(21),
      key: 'k'.repeat(80),
      title: '漢'.repeat(160),
      revision: 1,
    }))
    let offset = 10
    const seen: string[] = []
    for (let attempts = 0; attempts < 3 && offset < 13; attempts++) {
      const output = prepareMemoryToolEnvelope(
        { items: largeItems.slice(offset - 10), ...receipt },
        { pageOffset: offset },
      )
      const kept = output.data.items as Array<{ id: string; scopeId: string; revision: number }>
      expect(kept.length).toBeGreaterThan(0)
      expect(kept[0]).toMatchObject({ scopeId: 's'.repeat(21), revision: 1 })
      seen.push(...kept.map((item) => item.id))
      offset += kept.length
      if (offset < 13) expect(output.data.nextCursor).toBe(String(offset))
      expect(output.estimatedTokens).toBeLessThanOrEqual(1000)
    }
    expect(seen).toEqual(['entry-0', 'entry-1', 'entry-2'])
  })

  it('accepts internal scope pagination', () => {
    expect(validateMemoryToolArguments('list_memory_scopes', { cursor: '1', limit: 1 })).toEqual({
      cursor: '1',
      limit: 1,
    })
  })

  it('preserves body fragments and navigation when read metadata alone exceeds the limit', () => {
    const entry = {
      id: 'entry-1',
      scopeId: 's'.repeat(21),
      key: 'k'.repeat(80),
      title: '漢'.repeat(160),
      revision: 1,
      body: '🙂'.repeat(40),
      offset: 40,
      totalCodePoints: 120,
      truncated: true,
      nextCursor: '1.80',
    }
    const output = prepareMemoryToolEnvelope({ entry, ...receipt })
    expect(output.data.entry).toMatchObject({
      id: entry.id,
      scopeId: entry.scopeId,
      revision: 1,
      offset: 40,
      totalCodePoints: 120,
      truncated: true,
    })
    const fragment = output.data.entry as { body: string; nextCursor: string }
    expect([...fragment.body].length).toBeGreaterThan(0)
    expect(entry.body.startsWith(fragment.body)).toBe(true)
    expect(fragment.nextCursor).toBe(`1.${40 + [...fragment.body].length}`)
    expect(output.estimatedTokens).toBeLessThanOrEqual(1000)
  })

  it('discovers all three internal scopes even for long project paths', async () => {
    const workspace = createWorkspace({
      name: 'Scope discovery',
      projectPath: `/tmp/${'project/'.repeat(30)}`,
      sourceBranch: 'main',
      workingBranch: 'test',
    })
    const session = createIdleSession(workspace.id)
    const capability = createMemoryCapability({
      workspaceId: workspace.id,
      sessionId: session.id,
      engine: 'claude-code',
      dispatchId: 'pagination-test',
      readOnly: false,
      conversationKey: allocateMemoryConversationKey({ sessionId: session.id, engine: 'claude-code' }),
    })
    const response = await app.request('/api/memory/agent/list_memory_scopes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Kobo-Memory-Session': capability.token },
      body: '{}',
    })
    const data = await response.json()
    expect(data.items.map((scope: { level: string }) => scope.level)).toEqual(['global', 'project', 'workspace'])
    const second = await app.request('/api/memory/agent/list_memory_scopes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Kobo-Memory-Session': capability.token },
      body: JSON.stringify({ cursor: '1', limit: 1 }),
    })
    expect(await second.json()).toMatchObject({ items: [{ level: 'project' }], nextCursor: '2' })

    const scope = resolveMemoryScope({ level: 'workspace', workspaceId: workspace.id })
    for (let i = 0; i < 8; i++)
      createMemory({ scopeId: scope.id, key: `note-${i}`, title: `Note ${i}`, body: 'Body', actor: { kind: 'human' } })
    for (const tool of ['list_memories', 'search_memories']) {
      const response = await app.request(`/api/memory/agent/${tool}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Kobo-Memory-Session': capability.token },
        body: JSON.stringify({
          scope_id: scope.id,
          cursor: '3',
          ...(tool === 'search_memories' ? { query: 'Note' } : {}),
        }),
      })
      const page = await response.json()
      expect(page.items.length).toBeGreaterThan(0)
      expect(page.items.length).toBeLessThan(5)
      expect(page.nextCursor).toBe(String(3 + page.items.length))
    }
  })

  it('carries a nonzero requested offset through the external MCP reply', () => {
    const scope = resolveMemoryScope({ level: 'global' })
    for (let i = 0; i < 8; i++)
      createMemory({ scopeId: scope.id, key: `note-${i}`, title: `Note ${i}`, body: 'Body', actor: { kind: 'human' } })
    const data = executeMemoryMcpTool(
      'list_memories',
      { scope_id: scope.id, cursor: '3' },
      { kind: 'mcp', clientName: 'Pagination', transport: 'http' },
    ) as { items: unknown[]; nextCursor?: string }
    expect(data.items.length).toBeGreaterThan(0)
    expect(data.items.length).toBeLessThan(5)
    expect(data.nextCursor).toBe(String(3 + data.items.length))
  })
})
