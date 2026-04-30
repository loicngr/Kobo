import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { isSubagentTerminalEvent, useWorkspaceStore, type Workspace } from '../stores/workspace'

/** Build a fully-typed Workspace fixture, overrides take precedence. */
function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: 'w1',
    name: 'w1',
    projectPath: '/',
    sourceBranch: 'main',
    workingBranch: 'b',
    status: 'idle',
    notionUrl: null,
    sentryUrl: null,
    notionPageId: null,
    model: 'auto',
    engine: 'claude-code',
    reasoningEffort: 'medium',
    permissionMode: 'auto-accept',
    devServerStatus: 'idle',
    hasUnread: false,
    archivedAt: null,
    favoritedAt: null,
    tags: [],
    autoLoop: false,
    autoLoopReady: false,
    noProgressStreak: 0,
    permissionProfile: 'bypass',
    createdAt: '',
    updatedAt: '',
    ...overrides,
  }
}

describe('workspace store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  describe('isSubagentTerminalEvent(subtype, status)', () => {
    it('marks task_notification with a known terminal status as done', () => {
      // Empirically observed in Claude Code payloads:
      expect(isSubagentTerminalEvent('task_notification', 'completed')).toBe(true)
      expect(isSubagentTerminalEvent('task_notification', 'stopped')).toBe(true)
      expect(isSubagentTerminalEvent('task_notification', 'failed')).toBe(true)
      expect(isSubagentTerminalEvent('task_notification', 'cancelled')).toBe(true)
    })

    it('conservatively keeps subagent running on an unknown status', () => {
      // If Claude Code ever emits a non-terminal task_notification
      // (e.g. "progressing"), we must NOT mark the subagent done.
      expect(isSubagentTerminalEvent('task_notification', 'progressing')).toBe(false)
      expect(isSubagentTerminalEvent('task_notification', undefined)).toBe(false)
      expect(isSubagentTerminalEvent('task_notification', '')).toBe(false)
    })

    it('never treats in-flight subtypes as terminal', () => {
      expect(isSubagentTerminalEvent('task_started', 'completed')).toBe(false)
      expect(isSubagentTerminalEvent('task_progress', 'completed')).toBe(false)
    })

    it('never treats unrelated subtypes as terminal', () => {
      expect(isSubagentTerminalEvent('init', 'completed')).toBe(false)
      expect(isSubagentTerminalEvent('hook_started', 'completed')).toBe(false)
      expect(isSubagentTerminalEvent(undefined, 'completed')).toBe(false)
    })
  })

  describe('upsertSubagent', () => {
    it('creates a new subagent on first upsert', () => {
      const store = useWorkspaceStore()
      store.upsertSubagent('ws-1', {
        toolUseId: 'tool-1',
        description: 'Fix bug',
        status: 'running',
      })

      expect(store.subagents['ws-1']?.['tool-1']).toMatchObject({
        toolUseId: 'tool-1',
        description: 'Fix bug',
        status: 'running',
      })
    })

    it('merges updates with existing subagent', () => {
      const store = useWorkspaceStore()
      store.upsertSubagent('ws-1', { toolUseId: 'tool-1', description: 'Fix bug' })
      store.upsertSubagent('ws-1', { toolUseId: 'tool-1', lastToolName: 'Bash', totalTokens: 1000 })

      const subagent = store.subagents['ws-1']?.['tool-1']
      expect(subagent?.description).toBe('Fix bug')
      expect(subagent?.lastToolName).toBe('Bash')
      expect(subagent?.totalTokens).toBe(1000)
    })

    it('never regresses status from done to running', () => {
      const store = useWorkspaceStore()
      store.upsertSubagent('ws-1', { toolUseId: 'tool-1', status: 'running' })
      store.upsertSubagent('ws-1', { toolUseId: 'tool-1', status: 'done' })
      // Late task_progress arrives with status: running — should stay done
      store.upsertSubagent('ws-1', { toolUseId: 'tool-1', status: 'running' })

      expect(store.subagents['ws-1']?.['tool-1']?.status).toBe('done')
    })

    it('preserves startedAt across updates', () => {
      const store = useWorkspaceStore()
      store.upsertSubagent('ws-1', { toolUseId: 'tool-1', description: 'x' })
      const startedAt = store.subagents['ws-1']?.['tool-1']?.startedAt

      // Wait a tick then update
      store.upsertSubagent('ws-1', { toolUseId: 'tool-1', status: 'done' })
      expect(store.subagents['ws-1']?.['tool-1']?.startedAt).toBe(startedAt)
    })

    it('scopes subagents by workspace', () => {
      const store = useWorkspaceStore()
      store.upsertSubagent('ws-1', { toolUseId: 'tool-1', description: 'A' })
      store.upsertSubagent('ws-2', { toolUseId: 'tool-2', description: 'B' })

      expect(Object.keys(store.subagents['ws-1'] ?? {})).toEqual(['tool-1'])
      expect(Object.keys(store.subagents['ws-2'] ?? {})).toEqual(['tool-2'])
    })
  })

  describe('currentSubagents getter', () => {
    it('returns empty array when no workspace selected', () => {
      const store = useWorkspaceStore()
      expect(store.currentSubagents).toEqual([])
    })

    it('returns subagents for selected workspace only', () => {
      const store = useWorkspaceStore()
      store.upsertSubagent('ws-1', { toolUseId: 'tool-1', description: 'A' })
      store.upsertSubagent('ws-2', { toolUseId: 'tool-2', description: 'B' })
      store.selectedWorkspaceId = 'ws-1'

      expect(store.currentSubagents).toHaveLength(1)
      expect(store.currentSubagents[0]?.toolUseId).toBe('tool-1')
    })

    it('sorts by startedAt ascending', async () => {
      const store = useWorkspaceStore()
      store.upsertSubagent('ws-1', { toolUseId: 'first', description: 'First' })
      // Ensure different startedAt by waiting 1ms
      await new Promise((resolve) => setTimeout(resolve, 2))
      store.upsertSubagent('ws-1', { toolUseId: 'second', description: 'Second' })
      store.selectedWorkspaceId = 'ws-1'

      const order = store.currentSubagents.map((s) => s.toolUseId)
      expect(order).toEqual(['first', 'second'])
    })
  })

  describe('addActivityItem', () => {
    it('creates feed for new workspace', () => {
      const store = useWorkspaceStore()
      store.addActivityItem('ws-1', {
        id: 'item-1',
        type: 'text',
        content: 'hello',
        timestamp: '2026-01-01T00:00:00Z',
      })
      expect(store.activityFeeds['ws-1']).toHaveLength(1)
    })

    it('resolves pending user messages when agent replies', () => {
      const store = useWorkspaceStore()
      store.addActivityItem('ws-1', {
        id: 'user-1',
        type: 'text',
        content: 'hi',
        timestamp: '2026-01-01T00:00:00Z',
        meta: { sender: 'user', pending: true },
      })
      store.addActivityItem('ws-1', {
        id: 'agent-1',
        type: 'text',
        content: 'hello',
        timestamp: '2026-01-01T00:00:01Z',
      })

      const userItem = store.activityFeeds['ws-1']?.find((i) => i.id === 'user-1')
      expect(userItem?.meta?.pending).toBe(false)
    })

    it('deduplicates items by id (sync replay)', () => {
      const store = useWorkspaceStore()
      const item = {
        id: 'item-1',
        type: 'text' as const,
        content: 'hello',
        timestamp: '2026-01-01T00:00:00Z',
      }
      store.addActivityItem('ws-1', item)
      store.addActivityItem('ws-1', item)
      expect(store.activityFeeds['ws-1']).toHaveLength(1)
    })
  })

  describe('activityFeed getter (session filtering)', () => {
    it('returns empty array when no session selected but sessions exist', () => {
      const store = useWorkspaceStore()
      store.selectedWorkspaceId = 'ws-1'
      // Simulate sessions having been fetched but no session selected yet
      store.sessions = [
        {
          id: 'sess-1',
          workspaceId: 'ws-1',
          pid: null,
          engineSessionId: null,
          status: 'running',
          startedAt: '2026-01-01T00:00:00Z',
          endedAt: null,
          name: null,
        },
      ]
      store.addActivityItem('ws-1', {
        id: 'a',
        type: 'text',
        content: 'x',
        timestamp: '2026-01-01T00:00:00Z',
        sessionId: 'sess-1',
      })
      expect(store.activityFeed).toHaveLength(0)
    })

    it('returns all items when sessions list is empty (new workspace)', () => {
      const store = useWorkspaceStore()
      store.selectedWorkspaceId = 'ws-1'
      store.sessions = []
      store.addActivityItem('ws-1', {
        id: 'a',
        type: 'text',
        content: 'x',
        timestamp: '2026-01-01T00:00:00Z',
        sessionId: 'sess-1',
      })
      store.addActivityItem('ws-1', {
        id: 'b',
        type: 'text',
        content: 'y',
        timestamp: '2026-01-01T00:00:01Z',
      })
      // Fall-back behavior: with no sessions hydrated, show everything so the
      // user doesn't stare at a blank feed during the fetch window.
      expect(store.activityFeed.map((i) => i.id).sort()).toEqual(['a', 'b'])
    })

    it('filters by selected session and keeps workspace-level items without sessionId', () => {
      const store = useWorkspaceStore()
      store.selectedWorkspaceId = 'ws-1'
      store.selectedSessionId = 'sess-1'
      store.addActivityItem('ws-1', {
        id: 'a',
        type: 'text',
        content: 'x',
        timestamp: '2026-01-01T00:00:00Z',
        sessionId: 'sess-1',
      })
      store.addActivityItem('ws-1', {
        id: 'b',
        type: 'text',
        content: 'y',
        timestamp: '2026-01-01T00:00:01Z',
        sessionId: 'sess-2',
      })
      store.addActivityItem('ws-1', {
        id: 'c',
        type: 'text',
        content: 'z',
        timestamp: '2026-01-01T00:00:02Z',
      })
      const feed = store.activityFeed
      // 'a' belongs to selected session, 'c' has no session (workspace-level)
      expect(feed.map((i) => i.id).sort()).toEqual(['a', 'c'])
    })

    it('accepts legacy engine session ids for the selected session', () => {
      const store = useWorkspaceStore()
      store.selectedWorkspaceId = 'ws-1'
      store.selectedSessionId = 'sess-1'
      store.sessions = [
        {
          id: 'sess-1',
          workspaceId: 'ws-1',
          pid: null,
          engineSessionId: 'engine-legacy-1',
          status: 'completed',
          startedAt: '2026-01-01T00:00:00Z',
          endedAt: '2026-01-01T00:00:01Z',
          name: null,
        },
      ]
      store.addActivityItem('ws-1', {
        id: 'legacy',
        type: 'text',
        content: 'legacy session event',
        timestamp: '2026-01-01T00:00:00Z',
        sessionId: 'engine-legacy-1',
      })
      store.addActivityItem('ws-1', {
        id: 'other',
        type: 'text',
        content: 'other session event',
        timestamp: '2026-01-01T00:00:01Z',
        sessionId: 'sess-2',
      })

      expect(store.activityFeed.map((i) => i.id)).toEqual(['legacy'])
    })
  })

  describe('toggleFavorite', () => {
    const baseWorkspace: Workspace = {
      id: 'ws-1',
      name: 'Test',
      projectPath: '/tmp/test',
      sourceBranch: 'main',
      workingBranch: 'feature/test',
      status: 'idle',
      notionUrl: null,
      sentryUrl: null,
      notionPageId: null,
      model: 'claude-opus-4-5',
      engine: 'claude-code',
      reasoningEffort: 'normal',
      permissionMode: 'default',
      devServerStatus: 'stopped',
      hasUnread: false,
      archivedAt: null,
      favoritedAt: null,
      tags: [],
      autoLoop: false,
      autoLoopReady: false,
      noProgressStreak: 0,
      permissionProfile: 'bypass',
      worktreePath: '/tmp/test/.worktrees/feature/test',
      worktreeOwned: true,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    }

    beforeEach(() => {
      vi.stubGlobal('fetch', vi.fn())
    })

    it('applies optimistic update and persists on success', async () => {
      const store = useWorkspaceStore()
      store.workspaces = [{ ...baseWorkspace }]

      const updatedAt = '2026-04-17T12:00:00.000Z'
      const returnedWorkspace: Workspace = { ...baseWorkspace, favoritedAt: updatedAt }

      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => returnedWorkspace,
      } as Response)

      await store.toggleFavorite('ws-1')

      expect(store.workspaces[0].favoritedAt).toBe(updatedAt)
    })

    it('reverts optimistic update on API error', async () => {
      const store = useWorkspaceStore()
      store.workspaces = [{ ...baseWorkspace }]

      vi.mocked(fetch).mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({ error: 'boom' }),
      } as Response)

      await store.toggleFavorite('ws-1').catch(() => {})

      expect(store.workspaces[0].favoritedAt).toBeNull()
    })
  })

  describe('disableAutoLoop', () => {
    beforeEach(() => {
      vi.stubGlobal('fetch', vi.fn())
    })

    it('throws when the API returns a non-ok status', async () => {
      const store = useWorkspaceStore()
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({ error: 'stop failed' }),
      } as Response)

      await expect(store.disableAutoLoop('ws-1')).rejects.toThrow('stop failed')
    })
  })

  describe('usage snapshot integration', () => {
    beforeEach(() => {
      setActivePinia(createPinia())
    })

    it('applyUsageSnapshot stores the snapshot under the provider key', () => {
      const store = useWorkspaceStore()
      store.applyUsageSnapshot({
        providerId: 'claude-code',
        snapshot: {
          providerId: 'claude-code',
          status: 'ok',
          buckets: [{ id: 'five_hour', label: 'five_hour', usedPct: 12, resetsAt: '2026-04-29T18:00:00Z' }],
          fetchedAt: '2026-04-29T14:30:00Z',
        },
      })
      expect(store.providerUsage['claude-code']?.status).toBe('ok')
    })

    it('currentProviderUsage resolves via selectedWorkspace.engine', () => {
      const store = useWorkspaceStore()
      store.workspaces = [makeWorkspace({ id: 'w1', engine: 'claude-code' })]
      store.selectedWorkspaceId = 'w1'
      store.applyUsageSnapshot({
        providerId: 'claude-code',
        snapshot: {
          providerId: 'claude-code',
          status: 'ok',
          buckets: [],
          fetchedAt: '2026-04-29T14:30:00Z',
        },
      })
      expect(store.currentProviderUsage?.providerId).toBe('claude-code')
    })

    it('currentProviderUsage returns null when workspace.engine has no provider mapping', () => {
      const store = useWorkspaceStore()
      store.workspaces = [makeWorkspace({ id: 'w1', engine: 'unknown-engine' })]
      store.selectedWorkspaceId = 'w1'
      store.applyUsageSnapshot({
        providerId: 'claude-code',
        snapshot: { providerId: 'claude-code', status: 'ok', buckets: [], fetchedAt: 'now' },
      })
      expect(store.currentProviderUsage).toBeNull()
    })
  })
})
