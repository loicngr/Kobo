import { afterEach, describe, expect, it } from 'vitest'
import memoryRouter from '../server/routes/memory.js'
import {
  allocateMemoryConversationKey,
  createMemoryCapability,
  getMemoryCapability,
  type MemoryCapabilityDescriptor,
  revokeMemoryCapability,
} from '../server/services/memory-agent-runtime.js'
import { resetDb } from './helpers/reset-db.js'

const descriptor: MemoryCapabilityDescriptor = {
  dispatchId: 'dispatch-1',
  workspaceId: 'workspace-1',
  sessionId: 'session-1',
  engine: 'codex',
  conversationKey: 'test',
  readOnly: false,
}

const tokens: string[] = []
afterEach(() => {
  for (const token of tokens.splice(0)) revokeMemoryCapability(token)
})

describe('memory agent capability', () => {
  it('mints a random secret and binds only the backend launch identity', () => {
    const first = createMemoryCapability(descriptor)
    const second = createMemoryCapability({ ...descriptor, dispatchId: 'dispatch-2' })
    tokens.push(first.token, second.token)

    expect(first.token).not.toBe(second.token)
    expect(first.token).toMatch(/^[a-f0-9]{64}$/)
    expect(getMemoryCapability(first.token)).toEqual(descriptor)
  })

  it('recovers the persisted key on resume and allocates a new key for a fresh conversation', async () => {
    await resetDb()
    const { createWorkspace, createIdleSession } = await import('../server/services/workspace-service.js')
    const workspace = createWorkspace({
      name: 'Memory runtime',
      projectPath: '/tmp/memory-runtime',
      sourceBranch: 'main',
      workingBranch: 'feature/memory-runtime-test',
    })
    const session = createIdleSession(workspace.id)

    const firstLaunch = allocateMemoryConversationKey({
      sessionId: session.id,
      engine: 'claude-code',
      nativeConversationId: 'native-conversation-1',
    })
    const afterBackendRestart = allocateMemoryConversationKey({
      sessionId: session.id,
      engine: 'claude-code',
      nativeConversationId: 'native-conversation-1',
    })
    const freshOnSameSessionRow = allocateMemoryConversationKey({
      sessionId: session.id,
      engine: 'claude-code',
    })

    expect(afterBackendRestart).toBe(firstLaunch)
    expect(freshOnSameSessionRow).not.toBe(firstLaunch)
  })

  it('rejects missing, unknown and revoked capabilities', () => {
    const issued = createMemoryCapability(descriptor)
    tokens.push(issued.token)

    expect(getMemoryCapability(undefined)).toBeUndefined()
    expect(getMemoryCapability('not-a-secret')).toBeUndefined()
    revokeMemoryCapability(issued.token)
    expect(getMemoryCapability(issued.token)).toBeUndefined()
  })

  it('revokes exactly one dispatch, even when a native session id is reused', () => {
    const oldLaunch = createMemoryCapability(descriptor)
    const replacement = createMemoryCapability({ ...descriptor, dispatchId: 'dispatch-new' })
    tokens.push(oldLaunch.token, replacement.token)

    revokeMemoryCapability(oldLaunch.token)
    expect(getMemoryCapability(oldLaunch.token)).toBeUndefined()
    expect(getMemoryCapability(replacement.token)).toEqual({ ...descriptor, dispatchId: 'dispatch-new' })
  })

  it('rejects missing/forged provenance and denies writes on report-only launches', async () => {
    const reportOnly = createMemoryCapability({ ...descriptor, readOnly: true })
    tokens.push(reportOnly.token)
    const path = '/agent/remember'
    const body = JSON.stringify({
      scope_id: 'scope-1',
      expected_generation: 0,
      key: 'key',
      title: 'title',
      body: 'body',
    })

    const missing = await memoryRouter.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    })
    const forged = await memoryRouter.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Kobo-Memory-Session': reportOnly.token },
      body: JSON.stringify({
        scope_id: 'scope-1',
        expected_generation: 0,
        key: 'key',
        title: 'title',
        body: 'body',
        actor: { kind: 'human' },
      }),
    })
    const readOnly = await memoryRouter.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Kobo-Memory-Session': reportOnly.token },
      body,
    })
    const humanAction = await memoryRouter.request('/agent/delete_memory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Kobo-Memory-Session': reportOnly.token },
      body: '{}',
    })

    expect(missing.status).toBe(401)
    expect(forged.status).toBe(400)
    expect(readOnly.status).toBe(403)
    expect(humanAction.status).toBe(404)
  })

  it('applies an internal remember write independently of the exhausted retrieval budget', async () => {
    const { tmpDir } = await resetDb()
    const { _setSettingsPath } = await import('../server/services/settings-service.js')
    _setSettingsPath(`${tmpDir}/settings.json`)
    const { createWorkspace, createIdleSession } = await import('../server/services/workspace-service.js')
    const { getDb } = await import('../server/db/index.js')
    const workspace = createWorkspace({
      name: 'Memory budget',
      projectPath: '/tmp/memory-budget',
      sourceBranch: 'main',
      workingBranch: 'feature/memory-budget',
    })
    const session = createIdleSession(workspace.id)
    getDb().prepare("UPDATE agent_sessions SET engine = 'codex' WHERE id = ?").run(session.id)
    const conversationKey = allocateMemoryConversationKey({ sessionId: session.id, engine: 'codex' })
    const issued = createMemoryCapability({
      ...descriptor,
      workspaceId: workspace.id,
      sessionId: session.id,
      conversationKey,
    })
    tokens.push(issued.token)
    const ledgerId = getDb()
      .prepare('SELECT id FROM memory_budget_contexts WHERE conversation_key = ?')
      .get(conversationKey) as { id: string }
    getDb()
      .prepare('UPDATE memory_budget_contexts SET cumulative_estimated_tokens = 5_999 WHERE id = ?')
      .run(ledgerId.id)
    const { resolveMemoryScope } = await import('../server/services/memory-service.js')
    const scope = resolveMemoryScope({ level: 'workspace', workspaceId: workspace.id })

    const response = await memoryRouter.request('/agent/remember', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Kobo-Memory-Session': issued.token },
      body: JSON.stringify({
        scope_id: scope.id,
        expected_generation: 0,
        key: 'must.persist',
        title: 'Must persist',
        body: 'Saving does not require retrieval allowance.',
      }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ status: 'applied', budget: { chargedTokens: 0 } })
    expect(getDb().prepare('SELECT id FROM memory_entries WHERE scope_id = ?').all(scope.id)).toHaveLength(1)
  })
})
