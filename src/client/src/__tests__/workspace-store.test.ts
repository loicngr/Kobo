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
    agentPermissionMode: 'bypass',
    devServerStatus: 'idle',
    hasUnread: false,
    archivedAt: null,
    favoritedAt: null,
    tags: [],
    autoLoop: false,
    autoLoopReady: false,
    noProgressStreak: 0,
    worktreePath: '/tmp/wt',
    worktreeOwned: true,
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

    it('keeps workspace-level items (sessionId=null) only on the first session', () => {
      const store = useWorkspaceStore()
      store.selectedWorkspaceId = 'ws-1'
      store.selectedSessionId = 'sess-1'
      // sessions arrive sorted started_at DESC — last element is the oldest.
      store.sessions = [
        {
          id: 'sess-2',
          workspaceId: 'ws-1',
          pid: null,
          engineSessionId: null,
          status: 'running',
          startedAt: '2026-01-01T00:00:10Z',
          endedAt: null,
          name: null,
        },
        {
          id: 'sess-1',
          workspaceId: 'ws-1',
          pid: null,
          engineSessionId: null,
          status: 'completed',
          startedAt: '2026-01-01T00:00:00Z',
          endedAt: '2026-01-01T00:00:05Z',
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
      // sess-1 is the first session → keep 'a' and the workspace-level 'c'
      expect(store.activityFeed.map((i) => i.id).sort()).toEqual(['a', 'c'])
    })

    it('hides workspace-level items (sessionId=null) on subsequent sessions', () => {
      const store = useWorkspaceStore()
      store.selectedWorkspaceId = 'ws-1'
      store.selectedSessionId = 'sess-2'
      store.sessions = [
        {
          id: 'sess-2',
          workspaceId: 'ws-1',
          pid: null,
          engineSessionId: null,
          status: 'running',
          startedAt: '2026-01-01T00:00:10Z',
          endedAt: null,
          name: null,
        },
        {
          id: 'sess-1',
          workspaceId: 'ws-1',
          pid: null,
          engineSessionId: null,
          status: 'completed',
          startedAt: '2026-01-01T00:00:00Z',
          endedAt: '2026-01-01T00:00:05Z',
          name: null,
        },
      ]
      store.addActivityItem('ws-1', {
        id: 'b',
        type: 'text',
        content: 'y',
        timestamp: '2026-01-01T00:00:11Z',
        sessionId: 'sess-2',
      })
      store.addActivityItem('ws-1', {
        id: 'setup',
        type: 'text',
        content: '[kobo] Running setup script...',
        timestamp: '2026-01-01T00:00:00Z',
      })
      // sess-2 is NOT the first session → setup logs (sessionId=null) are hidden
      expect(store.activityFeed.map((i) => i.id)).toEqual(['b'])
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
      agentPermissionMode: 'bypass',
      devServerStatus: 'stopped',
      hasUnread: false,
      archivedAt: null,
      favoritedAt: null,
      tags: [],
      autoLoop: false,
      autoLoopReady: false,
      noProgressStreak: 0,
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

  describe('pending deferred tool-use (AskUserQuestion)', () => {
    it('round-trips set/get for a pending deferred entry', () => {
      const store = useWorkspaceStore()
      const payload = {
        toolCallId: 'tc-1',
        toolName: 'AskUserQuestion',
        input: { questions: [{ question: 'Q?', options: [{ label: 'A' }] }] },
        agentSessionId: 'agent-sess-A',
      }
      store.setPendingDeferred('w1', payload)
      expect(store.getPendingDeferred('w1')).toEqual(payload)
      expect(store.pendingDeferred.w1).toEqual(payload)
    })

    it('clearPendingDeferred (unconditional) removes the entry', () => {
      const store = useWorkspaceStore()
      store.setPendingDeferred('w1', {
        toolCallId: 'tc-1',
        toolName: 'AskUserQuestion',
        input: {},
        agentSessionId: 'agent-sess-A',
      })
      store.clearPendingDeferred('w1')
      expect(store.getPendingDeferred('w1')).toBeUndefined()
      expect(store.pendingDeferred.w1).toBeUndefined()
    })

    it('clearPendingDeferred(workspaceId, sessionId) only clears when the session matches', () => {
      const store = useWorkspaceStore()
      store.setPendingDeferred('w1', {
        toolCallId: 'tc-1',
        toolName: 'AskUserQuestion',
        input: {},
        agentSessionId: 'agent-sess-A',
      })
      // A different session ending must NOT clear the entry.
      store.clearPendingDeferred('w1', 'agent-sess-B')
      expect(store.getPendingDeferred('w1')?.toolCallId).toBe('tc-1')
      // The owning session ending DOES clear it.
      store.clearPendingDeferred('w1', 'agent-sess-A')
      expect(store.getPendingDeferred('w1')).toBeUndefined()
    })

    it('queue: enqueue 2 items, peek returns first, dequeue returns first then second', () => {
      const store = useWorkspaceStore()
      store.enqueuePending('w1', {
        kind: 'question',
        agentSessionId: 'sA',
        toolCallId: 'q1',
        toolName: 'AskUserQuestion',
        input: {},
      })
      store.enqueuePending('w1', {
        kind: 'permission',
        agentSessionId: 'sA',
        toolCallId: 'p1',
        toolName: 'Bash',
        toolInput: {},
      })
      expect(store.peekPending('w1')?.toolCallId).toBe('q1')
      expect(store.dequeuePending('w1')?.toolCallId).toBe('q1')
      expect(store.peekPending('w1')?.toolCallId).toBe('p1')
      expect(store.dequeuePending('w1')?.toolCallId).toBe('p1')
      expect(store.peekPending('w1')).toBeUndefined()
    })

    it('clearPendingForSession drops items of one session, leaves the other', () => {
      const store = useWorkspaceStore()
      store.enqueuePending('w1', {
        kind: 'question',
        agentSessionId: 'sA',
        toolCallId: 'q1',
        toolName: 'AskUserQuestion',
        input: {},
      })
      store.enqueuePending('w1', {
        kind: 'permission',
        agentSessionId: 'sB',
        toolCallId: 'p1',
        toolName: 'Bash',
        toolInput: {},
      })
      store.clearPendingForSession('w1', 'sA')
      expect(store.peekPending('w1')?.agentSessionId).toBe('sB')
    })

    it('submitDeferredPermission posts to the right endpoint', async () => {
      const store = useWorkspaceStore()
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) } as Response)
      vi.stubGlobal('fetch', fetchMock)
      try {
        await store.submitDeferredPermission('w1', 'tc-1', 'allow', 'why not')
        expect(fetchMock).toHaveBeenCalledWith(
          '/api/workspaces/w1/deferred-permission/decision',
          expect.objectContaining({
            method: 'POST',
            body: JSON.stringify({ toolCallId: 'tc-1', decision: 'allow', reason: 'why not' }),
          }),
        )
      } finally {
        vi.unstubAllGlobals()
      }
    })

    it('isolates pending entries per-workspace', () => {
      const store = useWorkspaceStore()
      store.setPendingDeferred('w1', {
        toolCallId: 'a',
        toolName: 'AskUserQuestion',
        input: {},
        agentSessionId: 'agent-sess-A',
      })
      store.setPendingDeferred('w2', {
        toolCallId: 'b',
        toolName: 'AskUserQuestion',
        input: {},
        agentSessionId: 'agent-sess-B',
      })
      store.clearPendingDeferred('w1')
      expect(store.getPendingDeferred('w1')).toBeUndefined()
      expect(store.getPendingDeferred('w2')?.toolCallId).toBe('b')
    })
  })
})
