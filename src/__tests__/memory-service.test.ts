import fs from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeDb, getDb } from '../server/db/index.js'
import { resetDb } from './helpers/reset-db.js'

const broadcastAll = vi.hoisted(() => vi.fn())
vi.mock('../server/services/websocket-service.js', () => ({ broadcastAll }))

let cleanup: (() => void) | undefined

function seedWorkspace(
  id: string,
  projectPath: string,
  archivedAt: string | null = null,
  purgedAt: string | null = null,
) {
  getDb()
    .prepare(`
    INSERT INTO workspaces (id, name, project_path, source_branch, working_branch, archived_at,
      worktree_purged_at, created_at, updated_at)
    VALUES (?, ?, ?, 'main', ?, ?, ?, '2026-01-01', '2026-01-01')
  `)
    .run(id, id, projectPath, `feature/${id}`, archivedAt, purgedAt)
}

function seedSession(id: string, workspaceId: string, engine: string | null = 'codex') {
  getDb()
    .prepare(`
    INSERT INTO agent_sessions (id, workspace_id, status, engine, started_at)
    VALUES (?, ?, 'running', ?, '2026-01-01')
  `)
    .run(id, workspaceId, engine)
}

describe('memory service', () => {
  beforeEach(async () => {
    const { tmpDir } = await resetDb()
    const settings = await import('../server/services/settings-service.js')
    settings._setSettingsPath(`${tmpDir}/settings.json`)
    cleanup = () => {
      closeDb()
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
    broadcastAll.mockReset()
  })

  afterEach(() => cleanup?.())

  it('reads only global, exact configured project, and exact workspace memory', async () => {
    seedWorkspace('ws-a1', '/repos/alpha/app', '2026-01-02', '2026-01-03')
    seedWorkspace('ws-a2', '/repos/alpha/app')
    seedWorkspace('ws-b', '/repos/beta/app')
    seedSession('session-a1', 'ws-a1')
    const memory = await import('../server/services/memory-service.js')
    const human = { kind: 'human' as const }

    const global = memory.resolveMemoryScope({ level: 'global' })
    const alpha = memory.resolveMemoryScope({ level: 'project', projectPath: '/repos/alpha/app/.' })
    const a1 = memory.resolveMemoryScope({ level: 'workspace', workspaceId: 'ws-a1' })
    const a2 = memory.resolveMemoryScope({ level: 'workspace', workspaceId: 'ws-a2' })
    const beta = memory.resolveMemoryScope({ level: 'project', projectPath: '/repos/beta/app' })

    await memory.createMemory({ scopeId: global.id, key: 'global', title: 'Global', body: 'global fact', actor: human })
    await memory.createMemory({ scopeId: alpha.id, key: 'project', title: 'Alpha', body: 'alpha fact', actor: human })
    await memory.createMemory({ scopeId: a1.id, key: 'workspace', title: 'A1', body: 'private fact', actor: human })
    await memory.createMemory({
      scopeId: a2.id,
      key: 'workspace',
      title: 'A2',
      body: 'other workspace fact',
      actor: human,
    })
    await memory.createMemory({ scopeId: beta.id, key: 'project', title: 'Beta', body: 'beta fact', actor: human })

    expect(memory.listMemories({ workspaceId: 'ws-a1' }).items.map((entry) => entry.body)).toEqual([
      'global fact',
      'alpha fact',
      'private fact',
    ])
    expect(memory.listMemories({ workspaceId: 'ws-a2' }).items.map((entry) => entry.body)).toEqual([
      'global fact',
      'alpha fact',
      'other workspace fact',
    ])
    expect(memory.listMemories({ workspaceId: 'ws-b' }).items.map((entry) => entry.body)).toEqual([
      'global fact',
      'beta fact',
    ])
    expect(memory.listMemories({ scopeId: a2.id }).items.map((entry) => entry.body)).toEqual(['other workspace fact'])
    expect(memory.listMemories({ scopeId: a1.id }).items.map((entry) => entry.body)).toEqual(['private fact'])
  })

  it('normalizes a configured path without consulting the filesystem or worktree path', async () => {
    seedWorkspace('ws-x', '/nonexistent/repo/../repo/project')
    const memory = await import('../server/services/memory-service.js')
    const resolved = memory.resolveMemoryScope({ level: 'project', projectPath: '/nonexistent/repo/project/.' })
    expect(resolved.projectPath).toBe('/nonexistent/repo/project')
    expect(memory.resolveMemoryScope({ level: 'workspace', workspaceId: 'ws-x' }).level).toBe('workspace')
  })

  it('validates, bounds pages and escaped search, and deduplicates an identical save', async () => {
    seedWorkspace('ws', '/repo')
    const memory = await import('../server/services/memory-service.js')
    const scope = memory.resolveMemoryScope({ level: 'workspace', workspaceId: 'ws' })
    const input = {
      scopeId: scope.id,
      key: 'rule-key',
      title: '  Rule  ',
      body: '  keep  100%  ',
      actor: { kind: 'human' as const },
    }
    const first = await memory.createMemory(input)
    const duplicate = await memory.createMemory(input)
    expect(duplicate.id).toBe(first.id)
    expect(() => memory.listMemories({ scopeId: scope.id, limit: 1000 })).toThrow()
    expect(memory.searchMemories({ scopeId: scope.id, query: '%' }).items).toHaveLength(1)
    expect(memory.searchMemories({ scopeId: scope.id, query: '100_' }).items).toEqual([])
    expect(memory.searchMemories({ scopeId: scope.id, query: '100%' }).items).toHaveLength(1)
    expect(() => memory.createMemory({ ...input, title: '  ', key: 'empty' })).toThrow()
    expect(() => memory.listMemories({ scopeId: scope.id, limit: -1 })).toThrow()
  })

  it('updates with compare-and-swap and rejects a stale revision', async () => {
    seedWorkspace('ws', '/repo')
    const memory = await import('../server/services/memory-service.js')
    const scope = memory.resolveMemoryScope({ level: 'workspace', workspaceId: 'ws' })
    const created = memory.createMemory({
      scopeId: scope.id,
      key: 'note',
      title: 'Before',
      body: 'before',
      actor: { kind: 'human' },
    })
    const updated = memory.updateMemory({
      scopeId: scope.id,
      entryId: created.id,
      expectedRevision: 1,
      key: 'note',
      title: 'After',
      body: 'after',
      actor: { kind: 'human' },
    })
    expect(updated).toMatchObject({ id: created.id, revision: 2, title: 'After' })
    expect(() =>
      memory.updateMemory({
        scopeId: scope.id,
        entryId: created.id,
        expectedRevision: 1,
        key: 'note',
        title: 'Stale',
        body: 'stale',
        actor: { kind: 'human' },
      }),
    ).toThrow(/changed/)
  })

  it('merges partial updates inside the revision compare-and-swap', async () => {
    seedWorkspace('ws', '/repo')
    const memory = await import('../server/services/memory-service.js')
    const scope = memory.resolveMemoryScope({ level: 'workspace', workspaceId: 'ws' })
    const created = memory.createMemory({
      scopeId: scope.id,
      key: 'note',
      title: 'Original title',
      body: 'Original body',
      actor: { kind: 'human' },
    })
    const updated = memory.updateMemory({
      scopeId: scope.id,
      entryId: created.id,
      expectedRevision: 1,
      title: 'Changed title',
      actor: { kind: 'human' },
    })
    expect(updated).toMatchObject({ key: 'note', title: 'Changed title', body: 'Original body', revision: 2 })
    expect(() =>
      memory.updateMemory({
        scopeId: scope.id,
        entryId: created.id,
        expectedRevision: 1,
        body: 'stale',
        actor: { kind: 'human' },
      }),
    ).toThrow(/changed/)
  })

  it('scopes project operation history to the viewing workspace project', async () => {
    seedWorkspace('ws-alpha', '/repos/alpha')
    seedWorkspace('ws-alpha-2', '/repos/alpha')
    seedWorkspace('ws-beta', '/repos/beta')
    seedSession('session-alpha', 'ws-alpha')
    seedSession('session-alpha-2', 'ws-alpha-2')
    seedSession('session-beta', 'ws-beta')
    const memory = await import('../server/services/memory-service.js')
    const alpha = memory.resolveMemoryScope({ level: 'project', projectPath: '/repos/alpha' })
    memory.createMemory({
      scopeId: alpha.id,
      key: 'alpha-rule',
      title: 'Alpha rule',
      body: 'shared with Alpha',
      actor: { kind: 'internal-agent', workspaceId: 'ws-alpha', sessionId: 'session-alpha', engine: 'codex' },
    })
    getDb()
      .prepare(`INSERT INTO memory_operations
      (scope_id, operation, actor_kind, source_workspace_id, source_session_id, source_engine, created_at)
      VALUES (?, 'read', 'internal-agent', 'ws-beta', 'session-beta', 'codex', '2026-10-05T00:00:00.000Z')`)
      .run(alpha.id)

    const visible = memory.listMemoryOperations({ scopeId: alpha.id, workspaceId: 'ws-alpha' })
    expect(visible.items).toHaveLength(1)
    expect(visible.items[0]?.actor).toMatchObject({ kind: 'internal-agent', workspaceId: 'ws-alpha' })
    const betaScope = memory.resolveMemoryScope({ level: 'project', projectPath: '/repos/beta' })
    expect(() => memory.listMemoryOperations({ scopeId: betaScope.id, workspaceId: 'ws-alpha' })).toThrow(
      /scope|workspace/i,
    )
    expect(() =>
      memory.listMemoryOperations({
        scopeId: alpha.id,
        workspaceId: 'ws-alpha',
        actor: { kind: 'internal-agent', workspaceId: 'ws-alpha-2', sessionId: 'session-alpha-2', engine: 'codex' },
      }),
    ).toThrow(/workspace|access/i)
  })

  it('filters global operations by the viewing project before pagination and retains deleted-source attribution', async () => {
    seedWorkspace('ws-alpha', '/repos/alpha')
    seedWorkspace('ws-alpha-2', '/repos/alpha')
    seedWorkspace('ws-beta', '/repos/beta')
    seedSession('session-alpha', 'ws-alpha')
    seedSession('session-alpha-2', 'ws-alpha-2')
    seedSession('session-beta', 'ws-beta')
    const memory = await import('../server/services/memory-service.js')
    const global = memory.resolveMemoryScope({ level: 'global' })
    memory.createMemory({
      scopeId: global.id,
      key: 'alpha-global',
      title: 'Alpha',
      body: 'visible in alpha view',
      actor: { kind: 'internal-agent', workspaceId: 'ws-alpha', sessionId: 'session-alpha', engine: 'codex' },
    })
    getDb()
      .prepare(`INSERT INTO memory_operations
      (scope_id, operation, actor_kind, source_workspace_id, source_session_id, source_engine, source_project_path, created_at)
      VALUES (?, 'read', 'internal-agent', 'ws-beta', 'session-beta', 'codex', '/repos/beta', '2026-10-05T00:00:00.000Z')`)
      .run(global.id)
    getDb().prepare("DELETE FROM workspaces WHERE id = 'ws-beta'").run()
    expect(
      getDb()
        .prepare(
          "SELECT source_workspace_id, source_project_path FROM memory_operations WHERE source_project_path = '/repos/beta'",
        )
        .get(),
    ).toEqual({ source_workspace_id: null, source_project_path: '/repos/beta' })

    const page = memory.listMemoryOperations({ scopeId: global.id, workspaceId: 'ws-alpha', limit: 1 })
    expect(page.items).toHaveLength(1)
    expect(page.items[0]?.actor).toMatchObject({ kind: 'internal-agent', workspaceId: 'ws-alpha' })
    expect(page.nextCursor).toBeUndefined()
  })

  it('records backend provenance and broadcasts only after the transaction commits', async () => {
    seedWorkspace('ws', '/repo')
    seedSession('session', 'ws')
    const memory = await import('../server/services/memory-service.js')
    const scope = memory.resolveMemoryScope({ level: 'workspace', workspaceId: 'ws' })
    const entry = await memory.createMemory({
      scopeId: scope.id,
      key: 'from-agent',
      title: 'Agent',
      body: 'remembered',
      actor: { kind: 'internal-agent', workspaceId: 'ws', sessionId: 'session', engine: 'codex' },
    })
    expect(entry.actor).toEqual({ kind: 'internal-agent', workspaceId: 'ws', sessionId: 'session', engine: 'codex' })
    expect(memory.listMemoryOperations({ scopeId: scope.id }).items).toMatchObject([
      { kind: 'created', actor: entry.actor },
    ])
    expect(broadcastAll).toHaveBeenCalledTimes(1)
    expect(getDb().prepare('SELECT count(*) AS count FROM memory_entries').get()).toEqual({ count: 1 })
  })

  it('rolls back entry and revision when operation insertion fails, without broadcasting', async () => {
    seedWorkspace('ws', '/repo')
    const memory = await import('../server/services/memory-service.js')
    const scope = memory.resolveMemoryScope({ level: 'workspace', workspaceId: 'ws' })
    getDb().exec(`CREATE TRIGGER fail_memory_operation BEFORE INSERT ON memory_operations
      BEGIN SELECT RAISE(ABORT, 'journal unavailable'); END`)

    expect(() =>
      memory.createMemory({
        scopeId: scope.id,
        key: 'will-rollback',
        title: 'Rollback',
        body: 'not saved',
        actor: { kind: 'human' },
      }),
    ).toThrow('journal unavailable')
    expect(getDb().prepare('SELECT count(*) AS count FROM memory_entries').get()).toEqual({ count: 0 })
    expect(getDb().prepare('SELECT revision FROM memory_scopes WHERE id = ?').get(scope.id)).toEqual({ revision: 0 })
    expect(broadcastAll).not.toHaveBeenCalled()
  })

  it('restricts an internal agent to global, its exact project and its exact workspace', async () => {
    seedWorkspace('ws-a', '/repos/a')
    seedWorkspace('ws-b', '/repos/b')
    seedSession('session-a', 'ws-a')
    const memory = await import('../server/services/memory-service.js')
    const actor = {
      kind: 'internal-agent' as const,
      workspaceId: 'ws-a',
      sessionId: 'session-a',
      engine: 'codex' as const,
    }
    const allowedProject = memory.resolveMemoryScope({ level: 'project', projectPath: '/repos/a' })
    const foreignProject = memory.resolveMemoryScope({ level: 'project', projectPath: '/repos/b' })
    const foreignWorkspace = memory.resolveMemoryScope({ level: 'workspace', workspaceId: 'ws-b' })
    expect(() =>
      memory.createMemory({
        scopeId: foreignProject.id,
        key: 'foreign',
        title: 'Foreign',
        body: 'not allowed',
        actor,
      }),
    ).toThrow(/scope|workspace|access/i)
    expect(() =>
      memory.createMemory({
        scopeId: foreignWorkspace.id,
        key: 'foreign',
        title: 'Foreign',
        body: 'not allowed',
        actor,
      }),
    ).toThrow(/scope|workspace|access/i)
    expect(() => memory.listMemories({ scopeId: foreignProject.id, actor })).toThrow(/scope|workspace|access/i)
    expect(() => memory.listMemories({ workspaceId: 'ws-b', actor })).toThrow(/scope|workspace|access/i)
    expect(() => memory.searchMemories({ scopeId: foreignProject.id, query: 'secret', actor })).toThrow(
      /scope|workspace|access/i,
    )
    expect(() => memory.readMemory({ scopeId: foreignProject.id, entryId: 'unknown', actor })).toThrow(
      /scope|workspace|access/i,
    )
    expect(() => memory.listMemoryOperations({ scopeId: foreignProject.id, actor })).toThrow(/scope|workspace|access/i)
    expect(() => memory.listMemoryScopes({ workspaceId: 'ws-b', actor })).toThrow(/another workspace/i)
    expect(memory.listMemoryScopes({ actor }).items.map((scope) => scope.level)).toEqual([
      'global',
      'project',
      'workspace',
    ])
    expect(() =>
      memory.createMemory({
        scopeId: allowedProject.id,
        key: 'allowed',
        title: 'Allowed',
        body: 'correct project',
        actor,
      }),
    ).not.toThrow()
  })

  it('rejects a caller-fabricated engine and keeps nullable deleted-source provenance readable', async () => {
    seedWorkspace('ws', '/repos/project')
    seedSession('session', 'ws')
    const memory = await import('../server/services/memory-service.js')
    const scope = memory.resolveMemoryScope({ level: 'project', projectPath: '/repos/project' })
    const actor = { kind: 'internal-agent' as const, workspaceId: 'ws', sessionId: 'session', engine: 'codex' as const }
    expect(() =>
      memory.createMemory({
        scopeId: scope.id,
        key: 'bad-engine',
        title: 'Bad engine',
        body: 'forged',
        actor: { ...actor, engine: 'claude-code' },
      }),
    ).toThrow(/engine/i)
    const entry = memory.createMemory({ scopeId: scope.id, key: 'durable', title: 'Durable', body: 'kept', actor })
    getDb().prepare('DELETE FROM agent_sessions WHERE id = ?').run('session')
    expect(memory.readMemory({ scopeId: scope.id, entryId: entry.id })).toMatchObject({
      id: entry.id,
      actor: { kind: 'internal-agent', sourceDeleted: true, workspaceId: 'ws', sessionId: null },
    })
    expect(
      memory.listMemoryOperations({ scopeId: scope.id }).items.find((operation) => operation.kind === 'created'),
    ).toMatchObject({
      kind: 'created',
      actor: { kind: 'internal-agent', sourceDeleted: true, workspaceId: 'ws', sessionId: null },
    })
    getDb().prepare('DELETE FROM workspaces WHERE id = ?').run('ws')
    expect(memory.readMemory({ scopeId: scope.id, entryId: entry.id })).toMatchObject({
      actor: { kind: 'internal-agent', sourceDeleted: true, workspaceId: null, sessionId: null },
    })
    expect(
      memory.listMemoryOperations({ scopeId: scope.id }).items.find((operation) => operation.kind === 'created'),
    ).toMatchObject({
      kind: 'created',
      actor: { kind: 'internal-agent', sourceDeleted: true, workspaceId: null, sessionId: null },
    })
  })

  it('fails closed when the bound session engine is NULL or invalid in the database', async () => {
    seedWorkspace('ws-null', '/repos/null')
    seedWorkspace('ws-invalid', '/repos/invalid')
    seedSession('session-null', 'ws-null', null)
    seedSession('session-invalid', 'ws-invalid', 'unknown-engine')
    const memory = await import('../server/services/memory-service.js')
    for (const [workspaceId, sessionId] of [
      ['ws-null', 'session-null'],
      ['ws-invalid', 'session-invalid'],
    ]) {
      const scope = memory.resolveMemoryScope({ level: 'workspace', workspaceId })
      expect(() =>
        memory.createMemory({
          scopeId: scope.id,
          key: 'untrusted-engine',
          title: 'Unknown engine',
          body: 'must not attribute from input',
          actor: { kind: 'internal-agent', workspaceId, sessionId, engine: 'codex' },
        }),
      ).toThrow(/engine/i)
    }
  })

  it('enforces current memory mode on every agent remember call and proposes hybrid project updates', async () => {
    seedWorkspace('ws', '/repo')
    seedSession('session', 'ws')
    const memory = await import('../server/services/memory-service.js')
    const settings = await import('../server/services/settings-service.js')
    settings._setSettingsPath(`${process.env.KOBO_HOME}/settings.json`)
    const actor = { kind: 'internal-agent' as const, workspaceId: 'ws', sessionId: 'session', engine: 'codex' as const }
    const project = memory.resolveMemoryScope({ level: 'project', projectPath: '/repo' })
    const workspace = memory.resolveMemoryScope({ level: 'workspace', workspaceId: 'ws' })

    settings.updateGlobalSettings({ memoryMode: 'manual' })
    expect(
      memory.remember({
        scopeId: workspace.id,
        key: 'manual',
        title: 'Manual',
        body: 'denied',
        actor,
        expectedGeneration: 0,
      }),
    ).toMatchObject({ status: 'denied' })
    settings.updateGlobalSettings({ memoryMode: 'hybrid' })
    const original = memory.createMemory({
      scopeId: project.id,
      key: 'rule',
      title: 'Original',
      body: 'active body',
      actor: { kind: 'human' },
    })
    const pending = memory.remember({
      scopeId: project.id,
      key: 'rule',
      title: 'Suggested',
      body: 'proposal sentinel',
      actor,
      targetEntryId: original.id,
      expectedRevision: original.revision,
      expectedGeneration: project.generation,
    })
    expect(pending.status).toBe('proposed')
    expect(memory.readMemory({ scopeId: project.id, entryId: original.id }).body).toBe('active body')
    expect(memory.listMemoryProposals({ scopeId: project.id })[0].body).toBe('proposal sentinel')

    settings.updateGlobalSettings({ memoryMode: 'automatic' })
    expect(memory.listMemoryProposals({ scopeId: project.id })).toHaveLength(1)
    expect(
      memory.remember({
        scopeId: workspace.id,
        key: 'auto',
        title: 'Auto',
        body: 'applied',
        actor,
        expectedGeneration: workspace.generation,
      }),
    ).toMatchObject({ status: 'applied' })
    expect(() =>
      memory.remember({
        scopeId: workspace.id,
        key: 'stale',
        title: 'Stale',
        body: 'rejected',
        actor,
        expectedGeneration: -1,
      }),
    ).toThrow(/generation/i)
  })

  it('shares only approved Hybrid project knowledge with another workspace in that project', async () => {
    seedWorkspace('hybrid-a', '/shared/project')
    seedWorkspace('hybrid-b', '/shared/project')
    seedSession('hybrid-session', 'hybrid-a', 'claude-code')
    const memory = await import('../server/services/memory-service.js')
    const settings = await import('../server/services/settings-service.js')
    settings.updateGlobalSettings({ memoryMode: 'hybrid' })
    const workspaceScope = memory.resolveMemoryScope({ level: 'workspace', workspaceId: 'hybrid-a' })
    const projectScope = memory.resolveMemoryScope({ level: 'project', projectPath: '/shared/project' })
    const actor = {
      kind: 'internal-agent' as const,
      workspaceId: 'hybrid-a',
      sessionId: 'hybrid-session',
      engine: 'claude-code' as const,
    }

    const local = memory.remember({
      scopeId: workspaceScope.id,
      key: 'local.fact',
      title: 'Workspace fact',
      body: 'Local to A',
      actor,
      expectedGeneration: workspaceScope.generation,
    })
    const shared = memory.remember({
      scopeId: projectScope.id,
      key: 'shared.fact',
      title: 'Project fact',
      body: 'Awaiting human approval',
      actor,
      expectedGeneration: projectScope.generation,
    })

    expect(local).toMatchObject({ status: 'applied', entry: { scopeId: workspaceScope.id } })
    expect(shared).toMatchObject({ status: 'proposed' })
    expect(memory.listMemories({ workspaceId: 'hybrid-b' }).items.map((entry) => entry.key)).not.toContain('local.fact')
    expect(memory.listMemories({ workspaceId: 'hybrid-b' }).items.map((entry) => entry.key)).not.toContain(
      'shared.fact',
    )

    if (shared.status !== 'proposed') throw new Error('Expected project memory to require approval')
    const approved = memory.approveMemoryProposal(shared.proposal.id, { kind: 'human' })
    expect(approved.scopeId).toBe(projectScope.id)
    expect(memory.listMemories({ workspaceId: 'hybrid-b' }).items.map((entry) => entry.key)).toContain('shared.fact')
    expect(memory.listMemories({ workspaceId: 'hybrid-b' }).items.map((entry) => entry.key)).not.toContain('local.fact')
  })

  it('does not revive rejected proposals after a mode change and rejects late writes after a scope clear', async () => {
    seedWorkspace('ws', '/repo')
    seedSession('session', 'ws')
    const memory = await import('../server/services/memory-service.js')
    const settings = await import('../server/services/settings-service.js')
    settings.updateGlobalSettings({ memoryMode: 'hybrid' })
    const scope = memory.resolveMemoryScope({ level: 'project', projectPath: '/repo' })
    const actor = { kind: 'internal-agent' as const, workspaceId: 'ws', sessionId: 'session', engine: 'codex' as const }
    const rejected = memory.remember({
      scopeId: scope.id,
      key: 'rejected.fact',
      title: 'Rejected',
      body: 'Never revive',
      actor,
      expectedGeneration: scope.generation,
    })
    if (rejected.status !== 'proposed') throw new Error('Expected a pending proposal')
    memory.rejectMemoryProposal(rejected.proposal.id, { kind: 'human' })
    const pending = memory.remember({
      scopeId: scope.id,
      key: 'pending.fact',
      title: 'Pending',
      body: 'Must not auto-approve',
      actor,
      expectedGeneration: scope.generation,
    })
    if (pending.status !== 'proposed') throw new Error('Expected a pending proposal')
    settings.updateGlobalSettings({ memoryMode: 'automatic' })
    expect(memory.listMemoryProposals({ scopeId: scope.id }).map((proposal) => proposal.id)).toEqual([
      pending.proposal.id,
    ])
    expect(memory.listMemories({ scopeId: scope.id }).items.map((entry) => entry.key)).not.toContain('pending.fact')

    const preview = memory.previewMemoryClear(scope.id)
    memory.clearMemoryScope({ scopeId: scope.id, expectedRevision: preview.revision, actor: { kind: 'human' } })
    expect(() =>
      memory.remember({
        scopeId: scope.id,
        key: 'late.fact',
        title: 'Late',
        body: 'Stale generation must fail',
        actor,
        expectedGeneration: scope.generation,
      }),
    ).toThrow(/generation/i)
    expect(memory.listMemories({ scopeId: scope.id }).items).toHaveLength(0)
  })

  it('deletes workspace memory while preserving project and global memory', async () => {
    seedWorkspace('delete-me', '/delete/project')
    const memory = await import('../server/services/memory-service.js')
    const { deleteWorkspace } = await import('../server/services/workspace-service.js')
    const global = memory.resolveMemoryScope({ level: 'global' })
    const project = memory.resolveMemoryScope({ level: 'project', projectPath: '/delete/project' })
    const workspace = memory.resolveMemoryScope({ level: 'workspace', workspaceId: 'delete-me' })
    memory.createMemory({ scopeId: global.id, key: 'global', title: 'Global', body: 'Keep', actor: { kind: 'human' } })
    memory.createMemory({
      scopeId: project.id,
      key: 'project',
      title: 'Project',
      body: 'Keep',
      actor: { kind: 'human' },
    })
    memory.createMemory({
      scopeId: workspace.id,
      key: 'workspace',
      title: 'Workspace',
      body: 'Remove',
      actor: { kind: 'human' },
    })

    deleteWorkspace('delete-me')

    expect(memory.listMemories({ scopeId: global.id }).items.map((entry) => entry.key)).toEqual(['global'])
    expect(memory.listMemories({ scopeId: project.id }).items.map((entry) => entry.key)).toEqual(['project'])
    expect(getDb().prepare('SELECT id FROM memory_scopes WHERE id = ?').get(workspace.id)).toBeUndefined()
    expect(JSON.stringify(getDb().prepare('SELECT * FROM memory_entries').all())).not.toContain('Remove')
  })

  it('approves proposals with CAS, makes decisions single-use, and erases rejected proposal text', async () => {
    seedWorkspace('ws', '/repo')
    seedSession('session', 'ws')
    const memory = await import('../server/services/memory-service.js')
    const actor = { kind: 'internal-agent' as const, workspaceId: 'ws', sessionId: 'session', engine: 'codex' as const }
    const scope = memory.resolveMemoryScope({ level: 'project', projectPath: '/repo' })
    const source = memory.createMemory({
      scopeId: scope.id,
      key: 'rule',
      title: 'Before',
      body: 'before',
      actor: { kind: 'human' },
    })
    const suggestion = memory.remember({
      scopeId: scope.id,
      key: 'rule',
      title: 'After',
      body: 'approval sentinel',
      actor,
      targetEntryId: source.id,
      expectedRevision: source.revision,
      expectedGeneration: scope.generation,
    })
    if (suggestion.status !== 'proposed') throw new Error('Expected a pending proposal')
    expect(memory.approveMemoryProposal(suggestion.proposal.id, { kind: 'human' })).toMatchObject({
      body: 'approval sentinel',
      revision: 2,
    })
    expect(() => memory.approveMemoryProposal(suggestion.proposal.id, { kind: 'human' })).toThrow(/proposal/i)
    const rejected = memory.remember({
      scopeId: scope.id,
      key: 'new-rule',
      title: 'Rejected',
      body: 'erase sentinel',
      actor,
      expectedGeneration: scope.generation,
    })
    if (rejected.status !== 'proposed') throw new Error('Expected a pending proposal')
    memory.rejectMemoryProposal(rejected.proposal.id, { kind: 'human' })
    expect(() => memory.rejectMemoryProposal(rejected.proposal.id, { kind: 'human' })).toThrow(/proposal/i)
    const persisted = getDb().prepare('SELECT title, body FROM memory_proposals').all()
    expect(JSON.stringify(persisted)).not.toContain('erase sentinel')
    const durableRows = [
      'memory_scopes',
      'memory_entries',
      'memory_proposals',
      'memory_operations',
      'memory_contexts',
      'memory_budget_contexts',
    ].map((table) => getDb().prepare(`SELECT * FROM ${table}`).all())
    expect(JSON.stringify(durableRows)).not.toContain('erase sentinel')
    expect(memory.listMemoryOperations({ scopeId: scope.id }).items.map((item) => item.kind)).toContain('rejected')
  })

  it('keeps proposal decisions, promotion, deletion and clear restricted to a human', async () => {
    seedWorkspace('ws', '/repo')
    seedSession('session', 'ws')
    const memory = await import('../server/services/memory-service.js')
    const settings = await import('../server/services/settings-service.js')
    settings.updateGlobalSettings({ memoryMode: 'hybrid' })
    const agent = { kind: 'internal-agent' as const, workspaceId: 'ws', sessionId: 'session', engine: 'codex' as const }
    const scope = memory.resolveMemoryScope({ level: 'project', projectPath: '/repo' })
    const entry = memory.createMemory({
      scopeId: scope.id,
      key: 'kept',
      title: 'Kept',
      body: 'active',
      actor: { kind: 'human' },
    })
    const proposal = memory.remember({
      scopeId: scope.id,
      key: 'new',
      title: 'New',
      body: 'pending',
      actor: { ...agent },
      expectedGeneration: scope.generation,
    })
    if (proposal.status !== 'proposed') throw new Error('Expected a pending proposal')

    expect(() => memory.approveMemoryProposal(proposal.proposal.id, agent)).toThrow(/human/i)
    expect(() => memory.rejectMemoryProposal(proposal.proposal.id, agent)).toThrow(/human/i)
    expect(() =>
      memory.deleteMemory({ scopeId: scope.id, entryId: entry.id, expectedRevision: entry.revision, actor: agent }),
    ).toThrow(/human/i)
    expect(() =>
      memory.promoteMemory({
        sourceScopeId: scope.id,
        entryId: entry.id,
        targetScopeId: memory.resolveMemoryScope({ level: 'global' }).id,
        actor: agent,
      }),
    ).toThrow(/human/i)
    expect(() => memory.previewMemoryClear(scope.id, agent)).toThrow(/human/i)
    expect(memory.listMemoryProposals({ scopeId: scope.id })).toHaveLength(1)
    expect(memory.readMemory({ scopeId: scope.id, entryId: entry.id }).body).toBe('active')
  })

  it('keeps stale and colliding proposals reviewable, and deleting an entry removes its pending updates', async () => {
    seedWorkspace('ws', '/repo')
    seedSession('session', 'ws')
    const memory = await import('../server/services/memory-service.js')
    const actor = { kind: 'internal-agent' as const, workspaceId: 'ws', sessionId: 'session', engine: 'codex' as const }
    const scope = memory.resolveMemoryScope({ level: 'project', projectPath: '/repo' })
    const source = memory.createMemory({
      scopeId: scope.id,
      key: 'rule',
      title: 'Before',
      body: 'before',
      actor: { kind: 'human' },
    })
    const stale = memory.remember({
      scopeId: scope.id,
      key: 'rule',
      title: 'Stale',
      body: 'stale sentinel',
      actor,
      targetEntryId: source.id,
      expectedRevision: 1,
      expectedGeneration: 0,
    })
    if (stale.status !== 'proposed') throw new Error('Expected a pending proposal')
    memory.updateMemory({
      scopeId: scope.id,
      entryId: source.id,
      expectedRevision: 1,
      key: 'rule',
      title: 'Now',
      body: 'now',
      actor: { kind: 'human' },
    })
    expect(() => memory.approveMemoryProposal(stale.proposal.id, { kind: 'human' })).toThrow(
      /conflict|revision|changed/i,
    )
    expect(memory.listMemoryProposals({ scopeId: scope.id })).toHaveLength(1)
    memory.deleteMemory({ scopeId: scope.id, entryId: source.id, expectedRevision: 2, actor: { kind: 'human' } })
    expect(memory.listMemoryProposals({ scopeId: scope.id })).toHaveLength(0)
    expect(JSON.stringify(getDb().prepare('SELECT * FROM memory_proposals').all())).not.toContain('stale sentinel')
    const durableRows = [
      'memory_scopes',
      'memory_entries',
      'memory_proposals',
      'memory_operations',
      'memory_contexts',
      'memory_budget_contexts',
    ].map((table) => getDb().prepare(`SELECT * FROM ${table}`).all())
    expect(JSON.stringify(durableRows)).not.toContain('stale sentinel')
  })

  it('keeps an update proposal pending when another entry takes its proposed key', async () => {
    seedWorkspace('ws', '/repo')
    seedSession('session', 'ws')
    const memory = await import('../server/services/memory-service.js')
    const actor = { kind: 'internal-agent' as const, workspaceId: 'ws', sessionId: 'session', engine: 'codex' as const }
    const scope = memory.resolveMemoryScope({ level: 'project', projectPath: '/repo' })
    const target = memory.createMemory({
      scopeId: scope.id,
      key: 'old-key',
      title: 'Old',
      body: 'old',
      actor: { kind: 'human' },
    })
    const proposal = memory.remember({
      scopeId: scope.id,
      key: 'claimed-later',
      title: 'Suggested',
      body: 'pending body',
      actor,
      targetEntryId: target.id,
      expectedRevision: target.revision,
      expectedGeneration: scope.generation,
    })
    if (proposal.status !== 'proposed') throw new Error('Expected an update proposal')
    memory.createMemory({
      scopeId: scope.id,
      key: 'claimed-later',
      title: 'Other',
      body: 'other active content',
      actor: { kind: 'human' },
    })

    expect(() => memory.approveMemoryProposal(proposal.proposal.id, { kind: 'human' })).toThrow(
      memory.MemoryConflictError,
    )
    expect(memory.readMemory({ scopeId: scope.id, entryId: target.id })).toMatchObject({ key: 'old-key', body: 'old' })
    expect(memory.listMemoryProposals({ scopeId: scope.id })).toHaveLength(1)
  })

  it('journals list and search reads with provenance and no note content', async () => {
    seedWorkspace('ws', '/repo')
    seedSession('session', 'ws')
    const memory = await import('../server/services/memory-service.js')
    const internal = {
      kind: 'internal-agent' as const,
      workspaceId: 'ws',
      sessionId: 'session',
      engine: 'codex' as const,
    }
    const external = { kind: 'external-mcp' as const, clientName: 'audit bot', transport: 'http' as const }
    const scope = memory.resolveMemoryScope({ level: 'workspace', workspaceId: 'ws' })
    memory.createMemory({
      scopeId: scope.id,
      key: 'journal-rule',
      title: 'Private title',
      body: 'Private body',
      actor: { kind: 'human' },
    })
    broadcastAll.mockClear()

    memory.listMemories({ scopeId: scope.id, actor: internal })
    memory.searchMemories({ scopeId: scope.id, query: 'Private', actor: external })
    expect(broadcastAll.mock.calls.map(([event, payload]) => [event, payload])).toEqual([
      ['memory:changed', expect.objectContaining({ scopeId: scope.id, journalOnly: true })],
      ['memory:changed', expect.objectContaining({ scopeId: scope.id, journalOnly: true })],
    ])
    const reads = memory
      .listMemoryOperations({ scopeId: scope.id })
      .items.filter((operation) => operation.kind === 'read')
    expect(reads).toHaveLength(2)
    expect(reads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ actor: internal, entryId: expect.any(String) }),
        expect.objectContaining({ actor: external, entryId: expect.any(String) }),
      ]),
    )
    for (const read of reads) {
      expect(read).not.toHaveProperty('title')
      expect(read).not.toHaveProperty('body')
    }
    const stored = getDb().prepare("SELECT * FROM memory_operations WHERE operation = 'read'").all()
    expect(JSON.stringify(stored)).not.toContain('Private title')
    expect(JSON.stringify(stored)).not.toContain('Private body')
  })

  it('promotes by copying source provenance and clears only the exact previewed scope', async () => {
    seedWorkspace('ws-a', '/repo')
    seedWorkspace('ws-b', '/repo')
    seedSession('session', 'ws-a')
    const memory = await import('../server/services/memory-service.js')
    const sourceScope = memory.resolveMemoryScope({ level: 'workspace', workspaceId: 'ws-a' })
    const projectScope = memory.resolveMemoryScope({ level: 'project', projectPath: '/repo' })
    const globalScope = memory.resolveMemoryScope({ level: 'global' })
    const source = memory.createMemory({
      scopeId: sourceScope.id,
      key: 'promote',
      title: 'Promote',
      body: 'copy',
      actor: { kind: 'internal-agent', workspaceId: 'ws-a', sessionId: 'session', engine: 'codex' },
    })
    const promoted = memory.promoteMemory({
      entryId: source.id,
      sourceScopeId: sourceScope.id,
      targetScopeId: projectScope.id,
      actor: { kind: 'human' },
    })
    expect(promoted).toMatchObject({ body: 'copy', actor: source.actor, scopeId: projectScope.id })
    expect(() =>
      memory.promoteMemory({
        entryId: source.id,
        sourceScopeId: sourceScope.id,
        targetScopeId: projectScope.id,
        actor: { kind: 'human' },
      }),
    ).toThrow(/conflict|already has/i)

    const entries = [
      [globalScope, 'g'],
      [projectScope, 'p'],
      [sourceScope, 'a'],
      [memory.resolveMemoryScope({ level: 'workspace', workspaceId: 'ws-b' }), 'b'],
    ] as const
    for (const [scope, key] of entries)
      memory.createMemory({ scopeId: scope.id, key, title: key, body: key, actor: { kind: 'human' } })
    const preview = memory.previewMemoryClear(sourceScope.id)
    memory.clearMemoryScope({ scopeId: sourceScope.id, expectedRevision: preview.revision, actor: { kind: 'human' } })
    expect(memory.listMemories({ scopeId: globalScope.id }).items).toHaveLength(1)
    expect(
      memory
        .listMemories({ scopeId: projectScope.id })
        .items.map((item) => item.key)
        .sort(),
    ).toEqual(['p', 'promote'])
    expect(memory.listMemories({ scopeId: sourceScope.id }).items).toHaveLength(0)
    expect(
      memory
        .listMemories({ workspaceId: 'ws-b' })
        .items.map((item) => item.key)
        .sort(),
    ).toEqual(['b', 'g', 'p', 'promote'])
    expect(() =>
      memory.clearMemoryScope({
        scopeId: sourceScope.id,
        expectedRevision: preview.revision,
        actor: { kind: 'human' },
      }),
    ).toThrow(/changed|revision/i)
  })

  it('clears each level independently while preserving every other scope', async () => {
    seedWorkspace('ws-a', '/repo')
    seedWorkspace('ws-b', '/repo')
    const memory = await import('../server/services/memory-service.js')
    const global = memory.resolveMemoryScope({ level: 'global' })
    const project = memory.resolveMemoryScope({ level: 'project', projectPath: '/repo' })
    const workspaceA = memory.resolveMemoryScope({ level: 'workspace', workspaceId: 'ws-a' })
    const workspaceB = memory.resolveMemoryScope({ level: 'workspace', workspaceId: 'ws-b' })
    const scopes = [global, project, workspaceA, workspaceB]
    const saveEverywhere = (suffix: string) => {
      for (const [index, scope] of scopes.entries()) {
        memory.createMemory({
          scopeId: scope.id,
          key: `entry-${suffix}-${index}`,
          title: `Title ${index}`,
          body: `Body ${index}`,
          actor: { kind: 'human' },
        })
      }
    }
    const clearAndCheck = (targetIndex: number, suffix: string) => {
      const target = scopes[targetIndex]
      const preview = memory.previewMemoryClear(target.id)
      memory.clearMemoryScope({ scopeId: target.id, expectedRevision: preview.revision, actor: { kind: 'human' } })
      for (const [index, scope] of scopes.entries()) {
        expect(memory.listMemories({ scopeId: scope.id }).items).toHaveLength(index === targetIndex ? 0 : 1)
      }
      if (targetIndex !== scopes.length - 1) {
        memory.createMemory({
          scopeId: target.id,
          key: `restore-${suffix}`,
          title: 'Restored',
          body: 'Restored',
          actor: { kind: 'human' },
        })
      }
    }

    saveEverywhere('first')
    clearAndCheck(0, 'global')
    clearAndCheck(1, 'project')
    clearAndCheck(2, 'workspace')
  })
})
