import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serve } from '@hono/node-server'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Hono } from 'hono'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { closeDb, getDb } from '../server/db/index.js'
import { runMigrations } from '../server/db/migrations.js'
import mcp from '../server/routes/mcp.js'
import memory from '../server/routes/memory.js'
import {
  allocateMemoryConversationKey,
  createMemoryCapability,
  revokeMemoryCapability,
} from '../server/services/memory-agent-runtime.js'
import { executeMemoryMcpTool } from '../server/services/memory-mcp-service.js'
import { createMemory, listMemoryProposals, readMemory, resolveMemoryScope } from '../server/services/memory-service.js'
import { _setSettingsPath, updateGlobalSettings } from '../server/services/settings-service.js'
import { createIdleSession } from '../server/services/workspace-service.js'
import { estimateMemoryTokens } from '../server/utils/memory-token-budget.js'

let directory: string
const app = new Hono().route('/api/mcp', mcp).route('/api/memory', memory)

beforeEach(() => {
  closeDb()
  directory = mkdtempSync(join(tmpdir(), 'kobo-external-memory-mcp-'))
  _setSettingsPath(join(directory, 'settings.json'))
  const db = getDb(join(directory, 'test.db'))
  runMigrations(db)
  db.prepare(
    "INSERT INTO workspaces(id,name,project_path,source_branch,working_branch,created_at,updated_at) VALUES ('ws-1','one','/tmp/memory-project','main','feature',datetime('now'),datetime('now'))",
  ).run()
})

afterEach(() => {
  closeDb()
  rmSync(directory, { recursive: true, force: true })
})

function httpClient(clientName = 'Memory client') {
  const client = new Client({ name: clientName, version: '1' })
  const transport = new StreamableHTTPClientTransport(new URL('http://localhost/api/mcp'), {
    fetch: async (input, init) =>
      app.fetch(
        new Request(input, {
          ...init,
          headers: {
            ...Object.fromEntries(new Headers(init?.headers).entries()),
            'X-Kobo-Client-Name': encodeURIComponent(clientName),
            'X-Kobo-Client-Name-Encoding': 'uri',
          },
        }),
      ),
  })
  return { client, transport }
}

function textResult(result: unknown): unknown {
  const content =
    result && typeof result === 'object' && 'content' in result && Array.isArray(result.content)
      ? (result.content as Array<{ type: string; text?: string }>)
      : []
  const block = content.find((item) => item.type === 'text')
  return JSON.parse(block?.text ?? 'null')
}

it.each(['internal', 'external'] as const)(
  'bounds write receipts without spending the retrieval budget (%s)',
  async (transport) => {
    const scope = resolveMemoryScope({ level: 'workspace', workspaceId: 'ws-1' })
    const args = { scope_id: scope.id, expected_generation: 0, key: 'k'.repeat(80), title: 'Title', body: 'Fact' }
    let result: Record<string, unknown>
    if (transport === 'external') {
      result = executeMemoryMcpTool('remember', args, {
        kind: 'mcp',
        clientName: 'Budget regression',
        transport: 'http',
      }) as Record<string, unknown>
    } else {
      const session = createIdleSession('ws-1')
      const conversationKey = allocateMemoryConversationKey({ sessionId: session.id, engine: 'claude-code' })
      const capability = createMemoryCapability({
        dispatchId: 'receipt-regression',
        workspaceId: 'ws-1',
        sessionId: session.id,
        engine: 'claude-code',
        conversationKey,
        readOnly: false,
      })
      const response = await app.request('/api/memory/agent/remember', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Kobo-Memory-Session': capability.token },
        body: JSON.stringify(args),
      })
      expect(response.status).toBe(200)
      result = await response.json()
      revokeMemoryCapability(capability.token)
    }
    expect(result.status).toBe('applied')
    const text = JSON.stringify(result)
    const envelope =
      transport === 'external'
        ? { content: [{ type: 'text', text }], structuredContent: result }
        : { rest: text, content: [{ type: 'text', text }] }
    const cost = estimateMemoryTokens(JSON.stringify(envelope))
    const budget = result.budget as { estimatedTokens: number; chargedTokens: number }
    expect(budget.estimatedTokens).toBeGreaterThanOrEqual(cost)
    expect(budget.estimatedTokens).toBeLessThanOrEqual(1_000)
    expect(budget.chargedTokens).toBe(0)
    const ledger = getDb().prepare('SELECT cumulative_estimated_tokens AS total FROM memory_budget_contexts').get() as {
      total: number
    }
    expect(ledger.total).toBe(0)
  },
)

it.each([false, true])(
  'preserves exhausted-session permissions after reopening the database (readOnly=%s)',
  async (readOnly) => {
    const session = createIdleSession('ws-1')
    const conversationKey = allocateMemoryConversationKey({ sessionId: session.id, engine: 'claude-code' })
    getDb()
      .prepare(
        'UPDATE memory_budget_contexts SET cumulative_estimated_tokens = 6000, delivered_json = ? WHERE conversation_key = ?',
      )
      .run(JSON.stringify([{ kind: 'budget-denial', estimatedTokens: 500 }]), conversationKey)
    closeDb()
    getDb(join(directory, 'test.db'))
    const capability = createMemoryCapability({
      dispatchId: 'resumed-exhausted',
      workspaceId: 'ws-1',
      sessionId: session.id,
      engine: 'claude-code',
      conversationKey,
      readOnly,
    })
    try {
      const call = (name: string, args: Record<string, unknown>) =>
        app.request(`/api/memory/agent/${name}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Kobo-Memory-Session': capability.token },
          body: JSON.stringify(args),
        })
      const scopes = (await (await call('list_memory_scopes', {})).json()) as {
        items: Array<{ id: string; level: string; generation: number }>
      }
      const project = scopes.items.find((scope) => scope.level === 'project')!
      expect(project).toBeDefined()
      const result = await call('remember', {
        scope_id: project.id,
        expected_generation: project.generation,
        key: 'project-rule',
        title: 'Title',
        body: 'Durable project convention',
      })
      const receipt = await result.json()
      expect(result.status).toBe(readOnly ? 403 : 200)
      expect(receipt).toMatchObject(
        readOnly ? { error: 'This agent launch is read-only for memory' } : { status: 'proposed' },
      )
      expect(JSON.stringify(receipt)).not.toContain('Durable project convention')
      expect(listMemoryProposals(project.id)).toHaveLength(readOnly ? 0 : 1)
      const deniedRead = await (await call('list_memories', {})).json()
      expect(deniedRead).toMatchObject({ memoryOutputSuppressed: true })
      expect(
        getDb()
          .prepare('SELECT cumulative_estimated_tokens AS total FROM memory_budget_contexts WHERE conversation_key = ?')
          .get(conversationKey),
      ).toEqual({ total: 6000 })
    } finally {
      revokeMemoryCapability(capability.token)
    }
  },
)

it('rejects an agent write revoked while its request body was pending', async () => {
  const scope = resolveMemoryScope({ level: 'workspace', workspaceId: 'ws-1' })
  const session = createIdleSession('ws-1')
  const conversationKey = allocateMemoryConversationKey({ sessionId: session.id, engine: 'claude-code' })
  const capability = createMemoryCapability({
    dispatchId: 'revocation-regression',
    workspaceId: 'ws-1',
    sessionId: session.id,
    engine: 'claude-code',
    conversationKey,
    readOnly: false,
  })
  const body = JSON.stringify({
    scope_id: scope.id,
    expected_generation: 0,
    key: 'late',
    title: 'Late',
    body: 'Must not persist',
  })
  let release!: () => void
  const request = new Request('http://localhost/api/memory/agent/remember', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': String(Buffer.byteLength(body)),
      'X-Kobo-Memory-Session': capability.token,
    },
    body: new ReadableStream({
      start(controller) {
        release = () => {
          controller.enqueue(new TextEncoder().encode(body))
          controller.close()
        }
      },
    }),
    duplex: 'half',
  } as RequestInit)
  const pending = app.fetch(request)
  await new Promise<void>((resolve) => setImmediate(resolve))
  revokeMemoryCapability(capability.token)
  release()
  const response = await pending
  expect(response.status).toBe(401)
  expect(getDb().prepare('SELECT COUNT(*) AS count FROM memory_entries').get()).toEqual({ count: 0 })
})

it.each(['internal', 'external'] as const)(
  'bounds every repeated write receipt without blocking saves (%s)',
  async (transport) => {
    const scope = resolveMemoryScope({ level: 'workspace', workspaceId: 'ws-1' })
    const session = createIdleSession('ws-1')
    const conversationKey = allocateMemoryConversationKey({ sessionId: session.id, engine: 'claude-code' })
    const capability = createMemoryCapability({
      dispatchId: 'cumulative-write-test',
      workspaceId: 'ws-1',
      sessionId: session.id,
      engine: 'claude-code',
      conversationKey,
      readOnly: false,
    })
    let contextId: string | undefined
    let applied = 0
    try {
      for (let i = 0; i < 9; i++) {
        const args = { scope_id: scope.id, expected_generation: 0, key: `note-${i}`, title: 'Title', body: 'Fact' }
        let result: Record<string, unknown>
        if (transport === 'external') {
          result = executeMemoryMcpTool(
            'remember',
            { ...args, ...(contextId ? { memory_context_id: contextId } : {}) },
            { kind: 'mcp', clientName: 'Repeated writes', transport: 'http' },
          ) as Record<string, unknown>
          contextId ??= result.memory_context_id as string
        } else {
          result = await (
            await app.request('/api/memory/agent/remember', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'X-Kobo-Memory-Session': capability.token },
              body: JSON.stringify(args),
            })
          ).json()
        }
        if (result.status === 'applied') applied++
        if (!result.memoryOutputSuppressed) {
          const text = JSON.stringify(result)
          const emittedCost = estimateMemoryTokens(
            JSON.stringify(
              transport === 'external'
                ? { content: [{ type: 'text', text }], structuredContent: result }
                : { rest: text, content: [{ type: 'text', text }] },
            ),
          )
          expect(emittedCost).toBeLessThanOrEqual(1_000)
        }
      }
      expect(applied).toBe(9)
      expect(getDb().prepare('SELECT COUNT(*) AS count FROM memory_entries').get()).toEqual({ count: applied })
      const ledger = getDb()
        .prepare('SELECT SUM(cumulative_estimated_tokens) AS total FROM memory_budget_contexts')
        .get() as { total: number }
      expect(ledger.total).toBe(0)
    } finally {
      revokeMemoryCapability(capability.token)
    }
  },
)

it('serves bounded memory discovery and calls through the SDK HTTP transport, with mode-aware receipts and attribution', async () => {
  const { client, transport } = httpClient('Mémoire 🔧')
  const global = resolveMemoryScope({ level: 'global' })
  const project = resolveMemoryScope({ level: 'project', projectPath: '/tmp/memory-project' })
  const workspace = resolveMemoryScope({ level: 'workspace', workspaceId: 'ws-1' })
  try {
    await client.connect(transport)
    const names = (await client.listTools()).tools.map((tool) => tool.name)
    expect(names).toContain('remember')
    expect(names).toContain('list_memory_scopes')
    expect(names).not.toContain('delete_memory')
    expect(names).not.toContain('approve_memory_proposal')

    updateGlobalSettings({ memoryMode: 'manual' })
    const manual = await client.callTool({
      name: 'remember',
      arguments: {
        scope_id: workspace.id,
        expected_generation: 0,
        key: 'workspace.goal',
        title: 'Goal',
        body: 'Keep this scoped',
      },
    })
    expect(manual.isError).not.toBe(true)
    expect(textResult(manual)).toMatchObject({ status: 'denied', reason: 'Memory mode does not allow agent writes' })
    const memoryContextId = (textResult(manual) as { memory_context_id: string }).memory_context_id
    expect(memoryContextId).toHaveLength(32)

    updateGlobalSettings({ memoryMode: 'hybrid' })
    const applied = await client.callTool({
      name: 'remember',
      arguments: {
        memory_context_id: memoryContextId,
        scope_id: workspace.id,
        expected_generation: 0,
        key: 'workspace.goal',
        title: 'Goal',
        body: 'Keep this scoped',
      },
    })
    expect(textResult(applied)).toMatchObject({
      status: 'applied',
      entry: { scopeId: workspace.id, key: 'workspace.goal' },
    })
    expect(JSON.stringify(textResult(applied))).not.toContain('Keep this scoped')
    const createdEntryId = (textResult(applied) as { entry: { id: string } }).entry.id
    expect(readMemory({ scopeId: workspace.id, entryId: createdEntryId }).actor).toEqual({
      kind: 'external-mcp',
      clientName: 'Mémoire 🔧',
      transport: 'http',
    })
    const searched = await client.callTool({
      name: 'search_memories',
      arguments: { memory_context_id: memoryContextId, workspace_id: 'ws-1', query: 'Keep this scoped' },
    })
    expect(textResult(searched)).toMatchObject({ items: [{ id: createdEntryId, scopeId: workspace.id }] })
    const firstSearchRemaining = (textResult(searched) as { budget: { remainingTokens: number } }).budget
      .remainingTokens
    const repeatedSearch = await client.callTool({
      name: 'search_memories',
      arguments: { memory_context_id: memoryContextId, workspace_id: 'ws-1', query: 'Keep this scoped' },
    })
    expect(textResult(repeatedSearch)).toMatchObject({
      items: [{ id: createdEntryId, revision: 1, alreadyDelivered: true }],
    })
    expect(JSON.stringify(textResult(repeatedSearch))).not.toContain('workspace.goal')
    const knownContextError = await client.callTool({
      name: 'read_memory',
      arguments: { memory_context_id: memoryContextId, scope_id: workspace.id, entry_id: 'missing-entry-id' },
    })
    expect(knownContextError.isError).toBe(true)
    expect(textResult(knownContextError)).toMatchObject({
      memory_context_id: memoryContextId,
      error: expect.any(String),
    })
    expect(
      (textResult(knownContextError) as { budget: { remainingTokens: number } }).budget.remainingTokens,
    ).toBeLessThan(firstSearchRemaining)
    const metadataLedger = getDb()
      .prepare('SELECT delivered_json FROM memory_budget_contexts WHERE external_context_id = ?')
      .get(memoryContextId) as { delivered_json: string }
    expect(metadataLedger.delivered_json).toContain('"kind":"metadata"')
    expect(metadataLedger.delivered_json).not.toContain('Keep this scoped')
    const fullRead = await client.callTool({
      name: 'read_memory',
      arguments: { memory_context_id: memoryContextId, scope_id: workspace.id, entry_id: createdEntryId },
    })
    expect(textResult(fullRead)).toMatchObject({ entry: { body: 'Keep this scoped', revision: 1 } })
    const repeatedApply = await client.callTool({
      name: 'remember',
      arguments: {
        // The earlier context exercised several reads and errors. Use a fresh
        // conversation budget to test write idempotency independently of exhaustion.
        scope_id: workspace.id,
        expected_generation: 0,
        key: 'workspace.goal',
        title: 'Goal',
        body: 'Keep this scoped',
      },
    })
    expect(textResult(repeatedApply)).toMatchObject({
      status: 'applied',
      entry: { id: createdEntryId, key: 'workspace.goal' },
    })
    const writeContextId = (textResult(repeatedApply) as { memory_context_id: string }).memory_context_id
    expect(writeContextId).not.toBe(memoryContextId)
    expect(
      (textResult(repeatedApply) as { budget: { estimatedTokens: number } }).budget.estimatedTokens,
    ).toBeLessThanOrEqual(1_000)

    const proposed = await client.callTool({
      name: 'remember',
      arguments: {
        memory_context_id: writeContextId,
        scope_id: project.id,
        expected_generation: 0,
        key: 'project.convention',
        title: 'Convention',
        body: 'Prefer small focused changes',
      },
    })
    const receipt = textResult(proposed) as { proposalId: string; status: string }
    expect(receipt.status).toBe('proposed')
    expect(JSON.stringify(receipt)).not.toContain('Prefer small focused changes')
    const repeatedProposal = await client.callTool({
      name: 'remember',
      arguments: {
        memory_context_id: writeContextId,
        scope_id: project.id,
        expected_generation: 0,
        key: 'project.convention',
        title: 'Convention',
        body: 'Prefer small focused changes',
      },
    })
    expect(textResult(repeatedProposal)).toMatchObject({ status: 'proposed', proposalId: receipt.proposalId })
    expect(textResult(repeatedProposal)).toMatchObject({ budget: { chargedTokens: 0 } })
    expect(textResult(proposed)).toMatchObject({ budget: { chargedTokens: 0 } })
    const proposal = listMemoryProposals(project.id)[0]
    expect(proposal.id).toBe(receipt.proposalId)
    const approved = await app.request(`/api/memory/proposals/${proposal.id}/approve`, { method: 'POST' })
    expect(approved.status).toBe(200)
    const approvedEntry = (await approved.json()) as { id: string }
    const verifier = httpClient('Verifier')
    try {
      await verifier.client.connect(verifier.transport)
      const reread = await verifier.client.callTool({
        name: 'read_memory',
        arguments: { scope_id: project.id, entry_id: approvedEntry.id },
      })
      expect(textResult(reread)).toMatchObject({
        entry: { key: 'project.convention' },
        budget: { estimatedTokens: expect.any(Number) },
      })
    } finally {
      await verifier.client.close()
    }

    const scopes = await client.callTool({
      name: 'list_memory_scopes',
      // Discovery starts a separate cooperative context after the write/read
      // scenario above has consumed its bounded response allowance.
      arguments: { workspace_id: 'ws-1' },
    })
    const scopeContextId = (textResult(scopes) as { memory_context_id: string }).memory_context_id
    expect(textResult(scopes)).toMatchObject({
      items: [{ level: 'global' }, { level: 'project' }, { level: 'workspace' }],
    })
    const operations = await client.callTool({
      name: 'list_memory_operations',
      arguments: { workspace_id: 'ws-1', memory_context_id: scopeContextId },
    })
    expect(JSON.stringify(textResult(operations))).not.toContain('Keep this scoped')

    const forged = await client.callTool({
      name: 'remember',
      arguments: {
        scope_id: global.id,
        expected_generation: 0,
        key: 'forged.actor',
        title: 'Forged',
        body: 'No human actor accepted',
        actor: { kind: 'human' },
        session_id: 'pretend',
      },
    })
    expect(forged.isError).toBe(true)
  } finally {
    await client.close()
  }
})

it('applies an external remember write even when the retrieval budget is fully exhausted', () => {
  const scope = resolveMemoryScope({ level: 'workspace', workspaceId: 'ws-1' })
  const source = {
    kind: 'mcp' as const,
    clientName: 'Budget test',
    transport: 'http' as const,
  }
  const first = executeMemoryMcpTool('list_memory_scopes', { workspace_id: 'ws-1' }, source) as {
    memory_context_id: string
  }
  getDb()
    .prepare('UPDATE memory_budget_contexts SET cumulative_estimated_tokens = 6_000 WHERE external_context_id = ?')
    .run(first.memory_context_id)

  const result = executeMemoryMcpTool(
    'remember',
    {
      memory_context_id: first.memory_context_id,
      scope_id: scope.id,
      expected_generation: 0,
      key: 'must.persist',
      title: 'Must persist',
      body: 'Saving durable facts does not require retrieval budget.',
    },
    source,
  ) as { status: string }

  expect(result.status).toBe('applied')
  expect(getDb().prepare('SELECT id FROM memory_entries WHERE scope_id = ?').all(scope.id)).toHaveLength(1)
})

it('records only list metadata that survived the external response envelope', () => {
  const scope = resolveMemoryScope({ level: 'workspace', workspaceId: 'ws-1' })
  for (let index = 0; index < 60; index += 1) {
    createMemory({
      scopeId: scope.id,
      key: `entry-${index}`,
      title: `Long descriptive memory entry ${index}`,
      body: `Body ${index}`,
      actor: { kind: 'human' },
    })
  }
  const result = executeMemoryMcpTool(
    'list_memories',
    { workspace_id: 'ws-1', limit: 100 },
    { kind: 'mcp', clientName: 'Page client', transport: 'http' },
  ) as { memory_context_id: string; items: Array<{ id: string }> }
  const ledger = getDb()
    .prepare('SELECT delivered_json FROM memory_budget_contexts WHERE external_context_id = ?')
    .get(result.memory_context_id) as { delivered_json: string }
  const delivered = JSON.parse(ledger.delivered_json) as Array<{ entryId: string; kind: string }>
  expect(result.items.length).toBeLessThan(60)
  expect(delivered.map((item) => item.entryId)).toEqual(result.items.map((item) => item.id))
  expect(delivered.every((item) => item.kind === 'metadata')).toBe(true)
})

it('exposes external memory over global stdio without workspace or engine state', async () => {
  const listener = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 })
  if (!listener.listening) await new Promise<void>((resolve) => listener.once('listening', resolve))
  const address = listener.address()
  if (!address || typeof address === 'string') throw new Error('Missing test listener address')
  const client = new Client({ name: 'Agent 工房 🤖', version: '1' })
  try {
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ['--import', 'tsx', 'src/mcp-server/kobo-tasks-server.ts'],
        env: {
          PATH: process.env.PATH ?? '',
          KOBO_HOME: directory,
          KOBO_WORKSPACE_ID: '',
          KOBO_DB_PATH: getDb().name,
          KOBO_BACKEND_URL: `http://127.0.0.1:${address.port}`,
          KOBO_NETWORK_TOKEN: 'test-token',
          KOBO_MCP_CLIENT_NAME: 'Atelier ✨',
        },
        stderr: 'pipe',
      }),
    )
    const tools = (await client.listTools()).tools.map((tool) => tool.name)
    expect(tools).toContain('remember')
    expect(tools).toContain('list_memory_scopes')
    expect(tools).not.toContain('list_tasks')

    const scopes = await client.callTool({ name: 'list_memory_scopes', arguments: {} })
    const global = (textResult(scopes) as { items: Array<{ id: string; level: string }> }).items.find(
      (scope) => scope.level === 'global',
    )!
    updateGlobalSettings({ memoryMode: 'automatic' })
    const saved = await client.callTool({
      name: 'remember',
      arguments: {
        scope_id: global.id,
        expected_generation: 0,
        key: 'global.preference',
        title: 'Preference',
        body: 'MCP stdio is connected',
      },
    })
    expect(textResult(saved)).toMatchObject({ status: 'applied', entry: { key: 'global.preference' } })
    expect(
      readMemory({ scopeId: global.id, entryId: (textResult(saved) as { entry: { id: string } }).entry.id }).actor,
    ).toEqual({
      kind: 'external-mcp',
      clientName: 'Atelier ✨',
      transport: 'stdio',
    })
  } finally {
    await client.close()
    await new Promise<void>((resolve, reject) => listener.close((error) => (error ? reject(error) : resolve())))
  }
}, 15_000)

it('limits exhausted-budget receipts and hides the suppression marker from external MCP clients', async () => {
  const { client, transport } = httpClient('Finite denial client')
  try {
    await client.connect(transport)
    const initial = await client.callTool({ name: 'list_memory_scopes', arguments: {} })
    const contextId = (textResult(initial) as { memory_context_id: string }).memory_context_id
    getDb()
      .prepare('UPDATE memory_budget_contexts SET cumulative_estimated_tokens = 5500 WHERE external_context_id = ?')
      .run(contextId)

    const firstDenial = await client.callTool({
      name: 'list_memories',
      arguments: { memory_context_id: contextId, workspace_id: 'ws-1' },
    })
    expect(firstDenial.isError).toBe(true)
    expect(textResult(firstDenial)).toMatchObject({ memory_context_id: contextId, budgetExhausted: true })

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const suppressed = await client.callTool({
        name: 'list_memories',
        arguments: { memory_context_id: contextId, workspace_id: 'ws-1' },
      })
      expect(suppressed.isError).toBe(true)
      expect(suppressed.content).toEqual([])
      expect(JSON.stringify(suppressed)).not.toContain('memoryOutputSuppressed')
    }

    const ledger = getDb()
      .prepare(
        'SELECT cumulative_estimated_tokens, delivered_json FROM memory_budget_contexts WHERE external_context_id = ?',
      )
      .get(contextId) as { cumulative_estimated_tokens: number; delivered_json: string }
    expect(ledger.cumulative_estimated_tokens).toBeLessThanOrEqual(6_000)
    expect(
      JSON.parse(ledger.delivered_json).filter((item: { kind?: string }) => item.kind === 'budget-denial'),
    ).toHaveLength(1)
    const scopes = await client.callTool({
      name: 'list_memory_scopes',
      arguments: { memory_context_id: contextId, workspace_id: 'ws-1' },
    })
    expect(scopes.isError, JSON.stringify(scopes)).not.toBe(true)
    const workspaceScope = resolveMemoryScope({ level: 'workspace', workspaceId: 'ws-1' })
    const saved = await client.callTool({
      name: 'remember',
      arguments: {
        memory_context_id: contextId,
        scope_id: workspaceScope.id,
        expected_generation: 0,
        key: 'after-exhaustion',
        title: 'Title',
        body: 'Still saved',
      },
    })
    expect(saved.isError).not.toBe(true)
    expect(textResult(saved)).toMatchObject({ status: 'applied', budget: { chargedTokens: 0 } })
  } finally {
    await client.close()
  }
})

it('returns no MCP content from the workspace bridge after its denial allowance is spent', async () => {
  const listener = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 })
  if (!listener.listening) await new Promise<void>((resolve) => listener.once('listening', resolve))
  const address = listener.address()
  if (!address || typeof address === 'string') throw new Error('Missing test listener address')
  const session = createIdleSession('ws-1')
  const conversationKey = allocateMemoryConversationKey({ sessionId: session.id, engine: 'codex' })
  getDb().prepare("UPDATE agent_sessions SET engine = 'codex' WHERE id = ?").run(session.id)
  const capability = createMemoryCapability({
    dispatchId: 'workspace-budget-test',
    workspaceId: 'ws-1',
    sessionId: session.id,
    engine: 'codex',
    conversationKey,
    readOnly: false,
  })
  const ledger = getDb()
    .prepare('SELECT id FROM memory_budget_contexts WHERE conversation_key = ?')
    .get(conversationKey) as { id: string }
  getDb().prepare('UPDATE memory_budget_contexts SET cumulative_estimated_tokens = 5_500 WHERE id = ?').run(ledger.id)
  const client = new Client({ name: 'Workspace agent', version: '1' })
  try {
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ['--import', 'tsx', 'src/mcp-server/kobo-tasks-server.ts'],
        env: {
          PATH: process.env.PATH ?? '',
          KOBO_HOME: directory,
          KOBO_WORKSPACE_ID: 'ws-1',
          KOBO_DB_PATH: getDb().name,
          KOBO_BACKEND_URL: `http://127.0.0.1:${address.port}`,
          KOBO_NETWORK_TOKEN: 'test-token',
          KOBO_MEMORY_SESSION_TOKEN: capability.token,
        },
        stderr: 'pipe',
      }),
    )
    const first = await client.callTool({ name: 'list_memories', arguments: {} })
    expect(first.isError).toBe(true)
    expect(textResult(first)).toMatchObject({ budgetExhausted: true })

    const second = await client.callTool({ name: 'list_memories', arguments: {} })
    expect(second.isError).toBe(true)
    expect(second.content).toEqual([])
    expect(JSON.stringify(second)).not.toContain('memoryOutputSuppressed')
    getDb().prepare('UPDATE memory_budget_contexts SET cumulative_estimated_tokens = 6000 WHERE id = ?').run(ledger.id)
    const scopes = await client.callTool({ name: 'list_memory_scopes', arguments: {} })
    expect(scopes.isError, JSON.stringify(scopes)).not.toBe(true)
    const scope = resolveMemoryScope({ level: 'workspace', workspaceId: 'ws-1' })
    const args = {
      scope_id: scope.id,
      expected_generation: 0,
      key: 'after-exhaustion',
      title: 'Title',
      body: 'Still saved',
    }
    const saved = await client.callTool({ name: 'remember', arguments: args })
    expect(saved.isError).not.toBe(true)
    expect(textResult(saved)).toMatchObject({ status: 'applied', budget: { chargedTokens: 0 } })
    const repeated = await client.callTool({ name: 'remember', arguments: args })
    expect(textResult(repeated)).toMatchObject({ status: 'applied' })
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM memory_entries').get()).toEqual({ count: 1 })
    const conflict = await client.callTool({ name: 'remember', arguments: { ...args, expected_generation: 1 } })
    expect(conflict.isError).toBe(true)
    expect(JSON.stringify(conflict.content)).toContain('409')
    updateGlobalSettings({ memoryMode: 'manual' })
    const denied = await client.callTool({ name: 'remember', arguments: { ...args, key: 'manual-denied' } })
    expect(textResult(denied)).toMatchObject({ status: 'denied' })
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM memory_entries').get()).toEqual({ count: 1 })
    expect(
      getDb()
        .prepare('SELECT cumulative_estimated_tokens AS total FROM memory_budget_contexts WHERE id = ?')
        .get(ledger.id),
    ).toEqual({ total: 6000 })
  } finally {
    revokeMemoryCapability(capability.token)
    await client.close()
    await new Promise<void>((resolve, reject) => listener.close((error) => (error ? reject(error) : resolve())))
  }
}, 15_000)

it('keeps workspace-bound and handoff memory calls off the unrestricted external bridge', async () => {
  const backendRequests: string[] = []
  const guardedBackend = new Hono().all('*', async (context) => {
    backendRequests.push(context.req.path)
    return app.fetch(context.req.raw)
  })
  const listener = serve({ fetch: guardedBackend.fetch, hostname: '127.0.0.1', port: 0 })
  if (!listener.listening) await new Promise<void>((resolve) => listener.once('listening', resolve))
  const address = listener.address()
  if (!address || typeof address === 'string') throw new Error('Missing test listener address')
  const environment = {
    PATH: process.env.PATH ?? '',
    KOBO_HOME: directory,
    KOBO_WORKSPACE_ID: 'ws-1',
    KOBO_DB_PATH: getDb().name,
    KOBO_BACKEND_URL: `http://127.0.0.1:${address.port}`,
    KOBO_NETWORK_TOKEN: 'test-token',
  }
  const startClient = async (extraEnv: Record<string, string> = {}) => {
    const client = new Client({ name: 'Bound agent', version: '1' })
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', 'src/mcp-server/kobo-tasks-server.ts'],
      env: { ...environment, ...extraEnv },
      stderr: 'pipe',
    })
    await client.connect(transport)
    return client
  }
  try {
    const bound = await startClient()
    try {
      const tools = (await bound.listTools()).tools
      const rememberTool = tools.find((tool) => tool.name === 'remember')
      expect(rememberTool).toBeDefined()
      expect(rememberTool?.inputSchema.properties).not.toHaveProperty('workspace_id')
      const denied = await bound.callTool({
        name: 'remember',
        arguments: {
          scope_id: 'global-scope',
          expected_generation: 0,
          key: 'forged.external',
          title: 'Forged',
          body: 'Must stay capability-bound',
        },
      })
      expect(denied.isError).toBe(true)
      expect((denied.content as Array<{ text?: string }>)[0]?.text).toContain('launch capability')
      expect(backendRequests).toEqual([])
    } finally {
      await bound.close()
    }

    const handoff = await startClient({ KOBO_HANDOFF_ID: 'handoff-1', KOBO_HANDOFF_TOKEN: 'handoff-secret' })
    try {
      expect((await handoff.listTools()).tools.map((tool) => tool.name)).not.toContain('remember')
      const forged = await handoff.callTool({
        name: 'remember',
        arguments: {
          scope_id: 'global-scope',
          workspace_id: 'other-workspace',
          expected_generation: 0,
          key: 'forged.handoff',
          title: 'Forged',
          body: 'Handoff report turns are read-only',
          actor: { kind: 'human' },
          session_id: 'pretend-session',
        },
      })
      expect(forged.isError).toBe(true)
      expect((forged.content as Array<{ text?: string }>)[0]?.text).toContain('handoff report')
      expect(backendRequests).toEqual([])
    } finally {
      await handoff.close()
    }
  } finally {
    await new Promise<void>((resolve, reject) => listener.close((error) => (error ? reject(error) : resolve())))
  }
}, 15_000)

it('paginates the workspace journal globally across uneven scopes and filters legacy foreign-project rows', async () => {
  const { client, transport } = httpClient()
  const global = resolveMemoryScope({ level: 'global' })
  const project = resolveMemoryScope({ level: 'project', projectPath: '/tmp/memory-project' })
  const workspace = resolveMemoryScope({ level: 'workspace', workspaceId: 'ws-1' })
  for (let index = 0; index < 25; index += 1) {
    createMemory({
      scopeId: global.id,
      key: `global.${index}`,
      title: 'Global',
      body: `G${index}`,
      actor: { kind: 'human' },
    })
    createMemory({
      scopeId: project.id,
      key: `project.${index}`,
      title: 'Project',
      body: `P${index}`,
      actor: { kind: 'human' },
    })
  }
  createMemory({
    scopeId: workspace.id,
    key: 'workspace.only',
    title: 'Workspace',
    body: 'W',
    actor: { kind: 'human' },
  })
  const db = getDb()
  db.prepare(
    "INSERT INTO workspaces(id,name,project_path,source_branch,working_branch,created_at,updated_at) VALUES ('ws-foreign','foreign','/tmp/foreign-project','main','feature',datetime('now'),datetime('now'))",
  ).run()
  db.prepare(
    "INSERT INTO agent_sessions(id,workspace_id,status,engine,started_at) VALUES ('foreign-session','ws-foreign','completed','codex',datetime('now'))",
  ).run()
  const foreignOperationId = Number(
    db
      .prepare(`INSERT INTO memory_operations
      (scope_id,operation,actor_kind,source_workspace_id,source_session_id,source_engine,source_project_path,created_at)
      VALUES (?,'read','internal-agent','ws-foreign','foreign-session','codex',NULL,datetime('now'))`)
      .run(global.id).lastInsertRowid,
  )

  try {
    await client.connect(transport)
    const first = await client.callTool({
      name: 'list_memory_operations',
      arguments: { workspace_id: 'ws-1', limit: 50 },
    })
    const firstPage = textResult(first) as {
      items: Array<{ id: number }>
      nextCursor: string
      memory_context_id: string
      budget: { estimatedTokens: number }
    }
    expect(firstPage.items.length).toBeGreaterThan(0)
    expect(firstPage.items.length).toBeLessThan(50)
    expect(firstPage.nextCursor).toBe(String(firstPage.items.at(-1)?.id))
    expect(firstPage.items.some((operation) => operation.id === foreignOperationId)).toBe(false)

    const second = await client.callTool({
      name: 'list_memory_operations',
      arguments: {
        workspace_id: 'ws-1',
        cursor: firstPage.nextCursor,
        limit: 50,
        memory_context_id: firstPage.memory_context_id,
      },
    })
    const secondPage = textResult(second) as {
      items: Array<{ id: number }>
      nextCursor?: string
      budget: { estimatedTokens: number }
    }
    expect(secondPage.items.length).toBeGreaterThan(0)
    expect(secondPage.items[0]?.id).toBeLessThan(firstPage.items.at(-1)!.id)
    expect(new Set([...firstPage.items, ...secondPage.items].map((operation) => operation.id)).size).toBe(
      firstPage.items.length + secondPage.items.length,
    )
    expect(firstPage.budget.estimatedTokens).toBeLessThanOrEqual(1_000)
    expect(secondPage.budget.estimatedTokens).toBeLessThanOrEqual(1_000)
  } finally {
    await client.close()
  }
})

it('uses the transport-derived context and rejects caller identity or unsupported arguments', async () => {
  const result = executeMemoryMcpTool(
    'remember',
    { scope_id: 'bogus', expected_generation: 0, key: 'a', title: 'A', body: 'B', actor: { kind: 'human' } },
    { kind: 'mcp', clientName: 'External', transport: 'http' },
  ) as { __mcpError?: boolean; error?: string; memory_context_id?: string }
  expect(result).toMatchObject({ __mcpError: true, error: 'Unexpected argument: actor' })
  expect(result.memory_context_id).toBeDefined()
})
