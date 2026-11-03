import { rmSync } from 'node:fs'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeDb } from '../server/db/index.js'
import memoryRouter from '../server/routes/memory.js'
import { allocateMemoryConversationKey } from '../server/services/memory-agent-runtime.js'
import { createExternalMemoryBudgetContext, reserveMemoryBudget } from '../server/services/memory-budget-service.js'
import { buildMemoryContext } from '../server/services/memory-context-service.js'
import { executeMemoryMcpTool } from '../server/services/memory-mcp-service.js'
import { createMemory, listMemories, resolveMemoryScope } from '../server/services/memory-service.js'
import { _setSettingsPath, getMemoryLimits, updateGlobalSettings } from '../server/services/settings-service.js'
import { createIdleSession, createWorkspace } from '../server/services/workspace-service.js'
import { prepareMemoryToolEnvelope, sliceMemoryBodyFragment } from '../server/utils/memory-token-budget.js'
import { DEFAULT_MEMORY_LIMITS, resolveMemoryLimits } from '../shared/memory-limits.js'
import { resetDb } from './helpers/reset-db.js'

let dir: string
beforeEach(async () => {
  dir = (await resetDb()).tmpDir
  _setSettingsPath(`${dir}/settings.json`)
})
afterEach(() => {
  closeDb()
  rmSync(dir, { recursive: true, force: true })
})

describe('configurable memory limits', () => {
  it('keeps defaults, merges partial settings and rejects inconsistent patches without saving', () => {
    expect(getMemoryLimits()).toEqual(DEFAULT_MEMORY_LIMITS)
    updateGlobalSettings({ memoryLimits: resolveMemoryLimits({ conversationTokens: 9000 }) })
    expect(getMemoryLimits().conversationTokens).toBe(9000)
    expect(() => updateGlobalSettings({ memoryLimits: { ...getMemoryLimits(), pageSize: 101 } })).toThrow()
    expect(getMemoryLimits().pageSize).toBe(50)
    for (const value of [null, { unknown: 1 }, { fragmentChars: 0 }, { responseTokens: 2000 }, { bodyChars: 1.5 }]) {
      expect(() => resolveMemoryLimits(value)).toThrow()
    }
  })

  it('changes the active allowance without resetting consumed output', () => {
    const context = createExternalMemoryBudgetContext(undefined, 'test', 'http')
    expect(reserveMemoryBudget({ budgetContextId: context.id, estimatedTokens: 3000 }).accepted).toBe(true)
    updateGlobalSettings({ memoryLimits: { ...getMemoryLimits(), conversationTokens: 4000 } })
    expect(reserveMemoryBudget({ budgetContextId: context.id, estimatedTokens: 501 }).accepted).toBe(false)
    updateGlobalSettings({ memoryLimits: { ...getMemoryLimits(), conversationTokens: 8000 } })
    expect(reserveMemoryBudget({ budgetContextId: context.id, estimatedTokens: 1000 })).toMatchObject({
      accepted: true,
      remainingTokens: 3500,
    })
  })

  it('applies body, title and page limits to writes and reads without truncating stored notes', () => {
    const scope = resolveMemoryScope({ level: 'global' })
    const write = (key: string, body = 'abcdefghij') =>
      createMemory({
        scopeId: scope.id,
        key,
        title: 'Note',
        body,
        actor: { kind: 'human' },
      })
    write('first')
    write('second')
    updateGlobalSettings({
      memoryLimits: { ...getMemoryLimits(), bodyChars: 5, titleChars: 4, pageSize: 1, pageMaxSize: 2 },
    })
    expect(() => write('third')).toThrow()
    const page = listMemories({ scopeId: scope.id })
    expect(page.items).toHaveLength(1)
    expect(page.nextCursor).toBeDefined()
    expect(() => listMemories({ scopeId: scope.id, limit: 3 })).toThrow()
  })

  it('keeps exact unicode cursors when configured fragments must shrink to fit a response', () => {
    updateGlobalSettings({ memoryLimits: { ...getMemoryLimits(), fragmentChars: 300 } })
    const body = '🙂漢字'.repeat(200)
    const fragment = sliceMemoryBodyFragment({ body, revision: 1 })
    expect([...fragment.text!]).toHaveLength(300)
    const output = prepareMemoryToolEnvelope({
      entry: { body: fragment.text, offset: 0, revision: 1, nextCursor: fragment.nextCursor },
    })
    const entry = output.data.entry as { body: string; nextCursor: string }
    const next = sliceMemoryBodyFragment({ body, revision: 1, cursor: entry.nextCursor })
    expect(entry.body + next.text).toBe([...body].slice(0, [...entry.body].length + [...next.text!].length).join(''))
    expect(output.estimatedTokens).toBeLessThanOrEqual(getMemoryLimits().responseTokens)
  })
})

it('keeps all applicable scopes with one-item pages and applies larger bootstrap and MCP budgets', () => {
  const workspace = createWorkspace({
    name: 'Limits',
    projectPath: '/tmp/memory-limits',
    sourceBranch: 'main',
    workingBranch: 'feature/limits',
  })
  const session = createIdleSession(workspace.id)
  const key = allocateMemoryConversationKey({ sessionId: session.id, engine: 'codex' })
  updateGlobalSettings({
    memoryLimits: {
      ...getMemoryLimits(),
      bootstrapTokens: 4000,
      responseTokens: 3000,
      responseHardTokens: 3500,
      conversationTokens: 10000,
      fragmentChars: 500,
      pageSize: 1,
      pageMaxSize: 1,
    },
  })
  const scope = resolveMemoryScope({ level: 'workspace', workspaceId: workspace.id })
  const note = createMemory({
    scopeId: scope.id,
    key: 'large',
    title: 'Large note',
    body: 'x'.repeat(1500),
    actor: { kind: 'human' },
  })
  for (let index = 0; index < 5; index++)
    createMemory({
      scopeId: scope.id,
      key: `other-${index}`,
      title: 'Other note',
      body: 'y'.repeat(1500),
      actor: { kind: 'human' },
    })
  const context = buildMemoryContext({
    workspaceId: workspace.id,
    sessionId: session.id,
    engine: 'codex',
    conversationKey: key,
    dispatchId: 'configured',
    resume: false,
  })
  expect(context.prompt).toContain('Large note')
  expect(context.estimatedTokens).toBeGreaterThan(1000)
  expect(context.estimatedTokens).toBeLessThanOrEqual(4000)
  const output = executeMemoryMcpTool(
    'read_memory',
    { scope_id: scope.id, entry_id: note.id },
    { kind: 'mcp', clientName: 'Limits', transport: 'http' },
  )
  expect(output).toMatchObject({ entry: { body: 'x'.repeat(500), nextCursor: '1.500' } })
})

it.each(['bootstrapTokens', 'bootstrapBytes'] as const)(
  'starts without injection when %s cannot fit mandatory guidance',
  (field) => {
    updateGlobalSettings({ memoryLimits: { ...getMemoryLimits(), [field]: 256 } })
    const workspace = createWorkspace({
      name: 'Small budget',
      projectPath: '/tmp/small-budget',
      sourceBranch: 'main',
      workingBranch: 'test',
    })
    const session = createIdleSession(workspace.id)
    const conversationKey = allocateMemoryConversationKey({ sessionId: session.id, engine: 'codex' })
    const scope = resolveMemoryScope({ level: 'workspace', workspaceId: workspace.id })
    createMemory({
      scopeId: scope.id,
      key: 'note',
      title: 'Note',
      body: 'Still available through MCP',
      actor: { kind: 'human' },
    })
    const context = buildMemoryContext({
      workspaceId: workspace.id,
      sessionId: session.id,
      engine: 'codex',
      conversationKey,
      dispatchId: 'small',
      resume: false,
    })
    expect(context).toMatchObject({
      prompt: '',
      estimatedTokens: 0,
      payloadBytes: 0,
      omittedCount: 1,
      entryRevisions: [],
    })
    expect(listMemories({ scopeId: scope.id }).items).toHaveLength(1)
  },
)

it.each([true, false])(
  'accepts maximum escaped notes over HTTP with content length=%s and keeps request limits',
  async (contentLength) => {
    updateGlobalSettings({ memoryLimits: { ...getMemoryLimits(), bodyChars: 100000, titleChars: 1000 } })
    const scope = resolveMemoryScope({ level: 'global' })
    const app = new Hono().route('/api/memory', memoryRouter)
    const body = '\u0001'.repeat(100000)
    const payload = JSON.stringify({ scopeId: scope.id, key: 'large', title: 'x'.repeat(1000), body })
    const response = await app.request('/api/memory/entries', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(contentLength ? { 'Content-Length': String(Buffer.byteLength(payload)) } : {}),
      },
      body: payload,
    })
    expect(response.status).toBe(201)
    expect((await response.json()).body).toBe(body)
    const oversized = await app.request('/api/memory/entries', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scopeId: scope.id, key: 'oversized', title: 'Large', body: 'x'.repeat(700000) }),
    })
    expect(oversized.status).toBe(413)
    expect(listMemories({ scopeId: scope.id }).items).toHaveLength(1)
  },
)
