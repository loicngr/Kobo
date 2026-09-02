import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAgentStreamStore } from '../stores/agent-stream'
import { useWebSocketStore } from '../stores/websocket'
import {
  isSubagentTerminalEvent,
  type PrSnapshot,
  useWorkspaceStore,
  type Workspace,
  WorkspaceActionError,
} from '../stores/workspace'

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
    prWatchDisabledAt: null,
    tags: [],
    description: null,
    agentDescription: null,
    initialPrompt: null,
    prChangesDismissedAt: null,
    prCiFailureDismissedAt: null,
    worktreePurgedAt: null,
    worktreePurgeRestoreData: null,
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

  describe('createWorkspace', () => {
    it('preserves the server error message when Sentry extraction fails', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          status: 422,
          json: async () => ({ error: 'Failed to extract Sentry issue: MCP authentication failed' }),
        } as Response),
      )
      const store = useWorkspaceStore()

      await expect(
        store.createWorkspace({
          name: 'workspace',
          projectPath: '/tmp/proj',
          sourceBranch: 'main',
          workingBranch: 'feature/task',
        }),
      ).rejects.toThrow('Failed to extract Sentry issue: MCP authentication failed')
    })
  })

  describe('creation progress', () => {
    it('stores the step reported by the server so the create page can name it', () => {
      const store = useWorkspaceStore()
      expect(store.creationProgress).toBeNull()

      store.setCreationProgress({ creationId: 'c1', step: 'setup-script', index: 11, total: 14 })
      expect(store.creationProgress).toEqual({ creationId: 'c1', step: 'setup-script', index: 11, total: 14 })

      store.clearCreationProgress()
      expect(store.creationProgress).toBeNull()
    })

    it('rejects with the server message and the failing step name', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          status: 500,
          headers: { get: () => null },
          json: async () => ({
            error:
              'Failed to start the agent: claude: command not found. The workspace, its worktree and its branch were removed.',
            step: 'start-agent',
            rollback: { done: true, warnings: [] },
          }),
        } as unknown as Response),
      )
      const store = useWorkspaceStore()

      // The server destroys everything it created on this failure, so there is
      // no workspace to push into the list — only an error to show, naming the
      // step that broke.
      const err = await store
        .createWorkspace({
          name: 'w9',
          projectPath: '/tmp/proj',
          sourceBranch: 'main',
          workingBranch: 'feature/x',
          creationId: 'c2',
        })
        .catch((e: unknown) => e)

      expect((err as Error).message).toContain('claude: command not found')
      expect((err as { code?: string }).code).toBe('start-agent')
      expect(store.workspaces).toEqual([])
    })
  })

  describe('selectWorkspace', () => {
    it('clears sessions synchronously before the replacement fetch resolves', () => {
      const store = useWorkspaceStore()
      store.sessions = [
        {
          id: 'old-session',
          workspaceId: 'ws-1',
          pid: null,
          engineSessionId: null,
          status: 'running',
          startedAt: '2026-08-05T10:00:00Z',
          endedAt: null,
          name: null,
        },
      ]
      vi.stubGlobal(
        'fetch',
        vi.fn(() => new Promise<Response>(() => {})),
      )

      try {
        store.selectWorkspace('ws-2')

        expect(store.selectedWorkspaceId).toBe('ws-2')
        expect(store.sessions).toEqual([])
      } finally {
        vi.unstubAllGlobals()
      }
    })
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
      prWatchDisabledAt: null,
      tags: [],
      description: null,
      agentDescription: null,
      initialPrompt: null,
      prChangesDismissedAt: null,
      prCiFailureDismissedAt: null,
      worktreePurgedAt: null,
      worktreePurgeRestoreData: null,
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

  describe('deleteAllArchived', () => {
    beforeEach(() => {
      vi.stubGlobal('fetch', vi.fn())
    })

    const archivedA = makeWorkspace({ id: 'a1', archivedAt: '2026-05-01T00:00:00Z' })
    const archivedB = makeWorkspace({ id: 'a2', archivedAt: '2026-05-02T00:00:00Z' })

    it('clears archived workspaces and returns the deleted count + targeted ids', async () => {
      const store = useWorkspaceStore()
      store.archivedWorkspaces = [{ ...archivedA }, { ...archivedB }]

      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, deleted: 2, warnings: [] }),
      } as Response)

      const result = await store.deleteAllArchived({ deleteLocalBranch: true })

      expect(fetch).toHaveBeenCalledWith('/api/workspaces/archived', expect.objectContaining({ method: 'DELETE' }))
      expect(result.deleted).toBe(2)
      expect(result.ids).toEqual(['a1', 'a2'])
      expect(store.archivedWorkspaces).toEqual([])
    })

    it('clears every per-workspace cache including the normalized agent stream', async () => {
      const store = useWorkspaceStore()
      const stream = useAgentStreamStore()
      store.archivedWorkspaces = [{ ...archivedA }]
      store.gitStatsCache.a1 = { commitCount: 1 } as never
      store.pendingWakeups.a1 = { targetAt: '2026-05-01T00:00:00Z' }
      stream.append('a1', { kind: 'message:text', messageId: 'm1', text: 'retained', streaming: false })
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, deleted: 1, warnings: [] }),
      } as Response)

      await store.deleteAllArchived()

      expect(stream.eventsFor('a1')).toEqual([])
      expect(store.gitStatsCache.a1).toBeUndefined()
      expect(store.pendingWakeups.a1).toBeUndefined()
    })

    it('surfaces best-effort warnings returned by the backend', async () => {
      const store = useWorkspaceStore()
      store.archivedWorkspaces = [{ ...archivedA }]

      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, deleted: 1, warnings: ['worktree stuck'] }),
      } as Response)

      const result = await store.deleteAllArchived()
      expect(result.warnings).toEqual(['worktree stuck'])
    })

    it('throws and keeps the archived list intact on API error', async () => {
      const store = useWorkspaceStore()
      store.archivedWorkspaces = [{ ...archivedA }]

      vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 500 } as Response)

      await expect(store.deleteAllArchived()).rejects.toThrow()
      expect(store.archivedWorkspaces.length).toBe(1)
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

  describe('interruptAgent', () => {
    it('serializes the active-session safety options as JSON', async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true } as Response)
      vi.stubGlobal('fetch', fetchMock)
      const store = useWorkspaceStore()

      await store.interruptAgent('ws-1', {
        expectedSessionId: 'session-running',
        disableAutoLoop: true,
      })

      expect(fetchMock).toHaveBeenCalledWith('/api/workspaces/ws-1/interrupt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedSessionId: 'session-running', disableAutoLoop: true }),
      })
    })

    it.each(['no_agent_running', 'session_not_active', 'interrupt_failed'])(
      'preserves the %s server code in a WorkspaceActionError',
      async (code) => {
        vi.stubGlobal(
          'fetch',
          vi.fn().mockResolvedValue({
            ok: false,
            status: code === 'interrupt_failed' ? 500 : 409,
            json: async () => ({ error: `interruption failed: ${code}`, code }),
          } as Response),
        )
        const store = useWorkspaceStore()

        const rejection = store.interruptAgent('ws-1')

        await expect(rejection).rejects.toMatchObject({
          name: 'WorkspaceActionError',
          message: `interruption failed: ${code}`,
          code,
        })
        await expect(rejection).rejects.toBeInstanceOf(WorkspaceActionError)
      },
    )

    it.each([
      { status: 409, body: null, expectedMessage: 'HTTP 409', label: 'null body' },
      { status: 409, body: [], expectedMessage: 'HTTP 409', label: 'array body' },
      { status: 409, body: 'invalid response', expectedMessage: 'HTTP 409', label: 'primitive body' },
      {
        status: 409,
        body: { error: 'unknown code', code: 'unknown_code' },
        expectedMessage: 'unknown code',
        label: 'unknown code',
      },
      {
        status: 409,
        body: { error: 'invalid code type', code: 42 },
        expectedMessage: 'invalid code type',
        label: 'non-string code',
      },
      {
        status: 500,
        body: { error: 'incoherent no-agent code', code: 'no_agent_running' },
        expectedMessage: 'incoherent no-agent code',
        label: 'no_agent_running under HTTP 500',
      },
      {
        status: 409,
        body: { error: 'incoherent engine code', code: 'interrupt_failed' },
        expectedMessage: 'incoherent engine code',
        label: 'interrupt_failed under HTTP 409',
      },
    ])('rejects $label as an untagged WorkspaceActionError', async ({ status, body, expectedMessage }) => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          status,
          json: async () => body,
        } as Response),
      )
      const store = useWorkspaceStore()

      const rejection = store.interruptAgent('ws-1')

      await expect(rejection).rejects.toBeInstanceOf(WorkspaceActionError)
      await expect(rejection).rejects.toMatchObject({
        name: 'WorkspaceActionError',
        message: expectedMessage,
        code: undefined,
      })
    })

    it('uses the HTTP fallback for a non-string error message while preserving a coherent code', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          status: 500,
          json: async () => ({ error: 42, code: 'interrupt_failed' }),
        } as Response),
      )
      const store = useWorkspaceStore()

      await expect(store.interruptAgent('ws-1')).rejects.toMatchObject({
        name: 'WorkspaceActionError',
        message: 'HTTP 500',
        code: 'interrupt_failed',
      })
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

    it('enqueuePending dedups on toolCallId — a second insert is a no-op', () => {
      const store = useWorkspaceStore()
      store.enqueuePending('w1', {
        kind: 'question',
        agentSessionId: 'sA',
        toolCallId: 'q1',
        toolName: 'AskUserQuestion',
        input: { questions: [] },
      })
      // Same toolCallId, different shape (e.g. live event arriving while a
      // replay is still in flight) — must NOT add a duplicate to the queue.
      store.enqueuePending('w1', {
        kind: 'question',
        agentSessionId: 'sA',
        toolCallId: 'q1',
        toolName: 'AskUserQuestion',
        input: { questions: [{ question: 'Q?' }] },
      })
      expect(store.pendingQueue.w1?.length).toBe(1)
    })

    it('clears an expired question when its agent session already ended', async () => {
      const store = useWorkspaceStore()
      store.enqueuePending('w1', {
        kind: 'question',
        agentSessionId: 'sA',
        toolCallId: 'q1',
        toolName: 'AskUserQuestion',
        input: {},
      })
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          json: async () => ({ error: "No agent running for workspace 'w1'" }),
        } as Response)
        .mockResolvedValueOnce({ ok: true, json: async () => [] } as Response)
      vi.stubGlobal('fetch', fetchMock)
      try {
        await expect(store.submitDeferredAnswer('w1', { q: 'answer' }, 'q1')).resolves.toBeUndefined()
        expect(store.peekPending('w1')).toBeUndefined()
      } finally {
        vi.unstubAllGlobals()
      }
    })

    it('sends an inline free-form response with a deferred answer', async () => {
      const store = useWorkspaceStore()
      const fetchMock = vi.fn().mockResolvedValue({ ok: true } as Response)
      vi.stubGlobal('fetch', fetchMock)
      try {
        await store.submitDeferredAnswer('w1', { detail: 'Autre' }, 'q1', false, 'Tester sur un appareil physique.')
        expect(fetchMock).toHaveBeenCalledWith(
          '/api/workspaces/w1/deferred-tool-use/answer',
          expect.objectContaining({
            body: JSON.stringify({
              answers: { detail: 'Autre' },
              toolCallId: 'q1',
              awaitingFreeForm: false,
              response: 'Tester sur un appareil physique.',
            }),
          }),
        )
      } finally {
        vi.unstubAllGlobals()
      }
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
            body: JSON.stringify({ toolCallId: 'tc-1', decision: 'allow', reason: 'why not', scope: 'once' }),
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

  describe('updateWorkspaceDescription action', () => {
    beforeEach(() => {
      vi.unstubAllGlobals()
    })

    it('PATCHes /api/workspaces/:id with description and applies the response', async () => {
      const store = useWorkspaceStore()
      store.workspaces = [makeWorkspace({ id: 'w1', description: null })]
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ...store.workspaces[0], description: 'Hello' }),
      } as Response)
      vi.stubGlobal('fetch', fetchMock)
      try {
        await store.updateWorkspaceDescription('w1', 'Hello')
        expect(fetchMock).toHaveBeenCalledWith(
          '/api/workspaces/w1',
          expect.objectContaining({
            method: 'PATCH',
            body: JSON.stringify({ description: 'Hello' }),
          }),
        )
        expect(store.workspaces[0].description).toBe('Hello')
      } finally {
        vi.unstubAllGlobals()
      }
    })

    it('reverts the optimistic update when the request fails', async () => {
      const store = useWorkspaceStore()
      store.workspaces = [makeWorkspace({ id: 'w1', description: 'before' })]
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({ error: 'too long' }),
      } as Response)
      vi.stubGlobal('fetch', fetchMock)
      try {
        await expect(store.updateWorkspaceDescription('w1', 'Hello')).rejects.toThrow()
        expect(store.workspaces[0].description).toBe('before')
      } finally {
        vi.unstubAllGlobals()
      }
    })

    it('applies the response by workspace id when the list is reordered in flight', async () => {
      const store = useWorkspaceStore()
      const first = makeWorkspace({ id: 'w1', description: null })
      const second = makeWorkspace({ id: 'w2', description: 'second' })
      store.workspaces = [first, second]
      let resolve!: (response: Response) => void
      vi.stubGlobal(
        'fetch',
        vi.fn(() => new Promise<Response>((r) => (resolve = r))),
      )

      try {
        const update = store.updateWorkspaceDescription('w1', 'updated')
        store.workspaces = [second, { ...first, description: 'updated' }]
        resolve({ ok: true, json: async () => ({ ...first, description: 'server value' }) } as Response)
        await update

        expect(store.workspaces.find((workspace) => workspace.id === 'w1')?.description).toBe('server value')
        expect(store.workspaces.find((workspace) => workspace.id === 'w2')?.description).toBe('second')
      } finally {
        vi.unstubAllGlobals()
      }
    })
  })

  describe('fetchSessions ordering', () => {
    it('ignores an older response for the same workspace when requests overlap', async () => {
      const store = useWorkspaceStore()
      store.selectedWorkspaceId = 'w1'
      let resolveFirst!: (response: Response) => void
      let resolveSecond!: (response: Response) => void
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockImplementationOnce(() => new Promise<Response>((resolve) => (resolveFirst = resolve)))
          .mockImplementationOnce(() => new Promise<Response>((resolve) => (resolveSecond = resolve))),
      )
      const session = (id: string) => ({
        id,
        workspaceId: 'w1',
        pid: null,
        engineSessionId: null,
        status: 'completed',
        startedAt: '2026-01-01T00:00:00Z',
        endedAt: '2026-01-01T00:00:01Z',
        name: null,
      })

      const first = store.fetchSessions('w1')
      const second = store.fetchSessions('w1')
      resolveSecond({ ok: true, json: async () => [session('new')] } as Response)
      await second
      resolveFirst({ ok: true, json: async () => [session('old')] } as Response)
      await first

      expect(store.sessions.map((item) => item.id)).toEqual(['new'])
      vi.unstubAllGlobals()
    })
  })

  describe('fetchWorkspaceDetails ordering', () => {
    it('ignores an older overlapping response for the selected workspace', async () => {
      const store = useWorkspaceStore()
      store.selectedWorkspaceId = 'w1'
      store.workspaces = [makeWorkspace({ id: 'w1', name: 'initial' })]
      let resolveFirst!: (response: Response) => void
      let resolveSecond!: (response: Response) => void
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockImplementationOnce(() => new Promise<Response>((resolve) => (resolveFirst = resolve)))
          .mockImplementationOnce(() => new Promise<Response>((resolve) => (resolveSecond = resolve))),
      )

      const first = store.fetchWorkspaceDetails('w1')
      const second = store.fetchWorkspaceDetails('w1')
      resolveSecond({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ workspace: makeWorkspace({ id: 'w1', name: 'new' }), tasks: [] }),
      } as unknown as Response)
      await second
      resolveFirst({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ workspace: makeWorkspace({ id: 'w1', name: 'old' }), tasks: [] }),
      } as unknown as Response)
      await first

      expect(store.workspaces[0]?.name).toBe('new')
      vi.unstubAllGlobals()
    })

    it('applies agentLiveness from the GET /:id response for the selected workspace', async () => {
      const store = useWorkspaceStore()
      store.selectedWorkspaceId = 'w1'
      store.workspaces = [makeWorkspace({ id: 'w1' })]
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              ...makeWorkspace({ id: 'w1' }),
              tasks: [],
              agentLiveness: { status: 'running', agentSessionId: 's1', startedAt: 't0', lastEventAt: 't1' },
            }),
        } as unknown as Response),
      )

      await store.fetchWorkspaceDetails('w1')

      expect(store.agentLiveness.w1).toEqual({
        status: 'running',
        agentSessionId: 's1',
        startedAt: 't0',
        lastEventAt: 't1',
      })
      vi.unstubAllGlobals()
    })

    it('clears a stale agentLiveness entry when GET /:id reports no controller', async () => {
      const store = useWorkspaceStore()
      store.selectedWorkspaceId = 'w1'
      store.workspaces = [makeWorkspace({ id: 'w1' })]
      store.agentLiveness = { w1: { status: 'running', agentSessionId: 's1', startedAt: 't0', lastEventAt: 't1' } }
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ ...makeWorkspace({ id: 'w1' }), tasks: [], agentLiveness: null }),
        } as unknown as Response),
      )

      await store.fetchWorkspaceDetails('w1')

      expect(store.agentLiveness.w1).toBeUndefined()
      vi.unstubAllGlobals()
    })

    it('does not let a stale response overwrite a status that changed via WebSocket while the request was in flight, but still applies agentLiveness', async () => {
      const store = useWorkspaceStore()
      store.selectedWorkspaceId = 'w1'
      store.workspaces = [makeWorkspace({ id: 'w1', status: 'executing' })]

      let resolveFetch!: (response: Response) => void
      vi.stubGlobal(
        'fetch',
        vi.fn(() => new Promise<Response>((resolve) => (resolveFetch = resolve))),
      )

      const fetching = store.fetchWorkspaceDetails('w1')

      // Simulate the WebSocket announcing a status change while the read is
      // in flight. Deselect around the call so correctif 3's own
      // liveness-refresh hook on `updateWorkspaceFromEvent` doesn't fire a
      // second, self-healing `fetchWorkspaceDetails` — this test isolates
      // the dedicated `_workspaceEventVersions` guard, not the pre-existing
      // per-request version counter.
      store.selectedWorkspaceId = null
      store.updateWorkspaceFromEvent('w1', { status: 'awaiting-user' })
      store.selectedWorkspaceId = 'w1'

      resolveFetch({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            ...makeWorkspace({ id: 'w1', status: 'executing' }),
            tasks: [],
            agentLiveness: { status: 'running', agentSessionId: 's1', startedAt: 't0', lastEventAt: 't1' },
          }),
      } as unknown as Response)
      await fetching

      // The stale `executing` from the in-flight request must not clobber
      // the fresher `awaiting-user` the WebSocket already applied.
      expect(store.workspaces[0]?.status).toBe('awaiting-user')
      // Liveness is server-authoritative and independent of the status
      // guard — it must still be applied even though the status write was
      // suppressed.
      expect(store.agentLiveness.w1).toEqual({
        status: 'running',
        agentSessionId: 's1',
        startedAt: 't0',
        lastEventAt: 't1',
      })
      vi.unstubAllGlobals()
    })
  })

  describe('applyAgentLiveness (pure state merge)', () => {
    it('stores the liveness object for the workspace', () => {
      const store = useWorkspaceStore()
      const liveness = { status: 'running' as const, agentSessionId: 's1', startedAt: 't0', lastEventAt: 't1' }
      store.applyAgentLiveness('w1', liveness)
      expect(store.agentLiveness.w1).toEqual(liveness)
    })

    it('removes the entry when liveness is null', () => {
      const store = useWorkspaceStore()
      store.agentLiveness = { w1: { status: 'running', agentSessionId: 's1', startedAt: 't0', lastEventAt: 't1' } }
      store.applyAgentLiveness('w1', null)
      expect(store.agentLiveness.w1).toBeUndefined()
    })

    it('leaves an unrelated workspace entry untouched', () => {
      const store = useWorkspaceStore()
      store.agentLiveness = { w2: { status: 'running', agentSessionId: 's2', startedAt: 't0', lastEventAt: 't1' } }
      store.applyAgentLiveness('w1', null)
      expect(store.agentLiveness.w2).toBeDefined()
    })

    it('marks the workspace as loaded whether or not a controller is reported', () => {
      const store = useWorkspaceStore()
      store.applyAgentLiveness('w1', null)
      expect(store.agentLivenessLoaded.w1).toBe(true)

      store.applyAgentLiveness('w2', { status: 'running', agentSessionId: 's2', startedAt: 't0', lastEventAt: 't1' })
      expect(store.agentLivenessLoaded.w2).toBe(true)
    })
  })

  describe('agentLivenessLoaded — confirmed-absence tracking (liveness false-positive fix)', () => {
    it('does not treat an unloaded workspace as a confirmed absent controller', () => {
      const store = useWorkspaceStore()
      // Never fetched: no entry in either map.
      expect(store.agentLivenessLoaded.w1).toBeUndefined()
      expect(store.agentLiveness.w1).toBeUndefined()
    })

    it('clears the loaded marker when a status change arrives via WebSocket, even for a non-selected workspace', () => {
      const store = useWorkspaceStore()
      store.selectedWorkspaceId = null
      store.workspaces = [makeWorkspace({ id: 'w1', status: 'idle' })]
      store.agentLivenessLoaded = { w1: true }
      const fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)

      store.updateWorkspaceFromEvent('w1', { status: 'executing' })

      expect(store.agentLivenessLoaded.w1).toBeUndefined()
      vi.unstubAllGlobals()
    })

    it('does not touch the loaded marker when the patch carries no status field', () => {
      const store = useWorkspaceStore()
      store.workspaces = [makeWorkspace({ id: 'w1' })]
      store.agentLivenessLoaded = { w1: true }

      store.updateWorkspaceFromEvent('w1', { description: 'x' })

      expect(store.agentLivenessLoaded.w1).toBe(true)
    })

    it('re-confirms loaded once the selected workspace status-change fetch resolves', async () => {
      const store = useWorkspaceStore()
      store.selectedWorkspaceId = 'w1'
      store.workspaces = [makeWorkspace({ id: 'w1', status: 'idle' })]
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ ...makeWorkspace({ id: 'w1', status: 'executing' }), tasks: [], agentLiveness: null }),
      } as unknown as Response)
      vi.stubGlobal('fetch', fetchMock)

      store.updateWorkspaceFromEvent('w1', { status: 'executing' })
      // Immediately after the WS event, and before the fetch resolves, the
      // marker must be cleared — this is the window that used to produce a
      // false "agent not running" warning.
      expect(store.agentLivenessLoaded.w1).toBeUndefined()

      await vi.waitFor(() => expect(store.agentLivenessLoaded.w1).toBe(true))
      vi.unstubAllGlobals()
    })

    it('fetchWorkspacesInfo marks every returned workspace as loaded, including ones absent from agentLiveness', async () => {
      const store = useWorkspaceStore()
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            workspaces: [
              makeWorkspace({ id: 'ws-1', status: 'idle' }),
              makeWorkspace({ id: 'ws-2', status: 'executing' }),
            ],
            prSnapshots: {},
            gitStats: {},
            agentLiveness: { 'ws-2': { status: 'running', agentSessionId: 's2', startedAt: 't0', lastEventAt: 't1' } },
          }),
      })
      vi.stubGlobal('fetch', fetchMock)

      await store.fetchWorkspacesInfo()

      expect(store.agentLivenessLoaded['ws-1']).toBe(true)
      expect(store.agentLivenessLoaded['ws-2']).toBe(true)
      expect(store.agentLiveness['ws-1']).toBeUndefined()
      vi.unstubAllGlobals()
    })
  })

  describe('updateWorkspaceFromEvent — agentLiveness refresh on status change', () => {
    it('refreshes agentLiveness via GET /:id when the selected workspace flips status', async () => {
      const store = useWorkspaceStore()
      store.selectedWorkspaceId = 'w1'
      store.workspaces = [makeWorkspace({ id: 'w1', status: 'idle' })]
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            ...makeWorkspace({ id: 'w1', status: 'executing' }),
            tasks: [],
            agentLiveness: { status: 'running', agentSessionId: 's1', startedAt: 't0', lastEventAt: 't1' },
          }),
      } as unknown as Response)
      vi.stubGlobal('fetch', fetchMock)

      store.updateWorkspaceFromEvent('w1', { status: 'executing' })
      await vi.waitFor(() => expect(store.agentLiveness.w1).toBeDefined())

      expect(fetchMock).toHaveBeenCalledWith('/api/workspaces/w1', expect.anything())
      expect(store.agentLiveness.w1).toEqual({
        status: 'running',
        agentSessionId: 's1',
        startedAt: 't0',
        lastEventAt: 't1',
      })
      vi.unstubAllGlobals()
    })

    it('does not fetch when the status change is for a non-selected workspace', () => {
      const store = useWorkspaceStore()
      store.selectedWorkspaceId = 'w1'
      store.workspaces = [makeWorkspace({ id: 'w2', status: 'idle' })]
      const fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)

      store.updateWorkspaceFromEvent('w2', { status: 'executing' })

      expect(fetchMock).not.toHaveBeenCalled()
      vi.unstubAllGlobals()
    })

    it('does not fetch when the patch carries no status field', () => {
      const store = useWorkspaceStore()
      store.selectedWorkspaceId = 'w1'
      store.workspaces = [makeWorkspace({ id: 'w1' })]
      const fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)

      store.updateWorkspaceFromEvent('w1', { description: 'x' })

      expect(fetchMock).not.toHaveBeenCalled()
      vi.unstubAllGlobals()
    })
  })

  describe('workspace:description-updated WS handler', () => {
    it('updates the matching workspace in state', () => {
      const store = useWorkspaceStore()
      store.workspaces = [makeWorkspace({ id: 'w1', description: 'old' })]
      const ws = useWebSocketStore()
      ws._routeMessage({
        type: 'workspace:description-updated',
        workspaceId: 'w1',
        payload: { description: 'NEW' },
      })
      expect(store.workspaces[0].description).toBe('NEW')
    })
  })

  describe('workspace:agent-description-updated WS handler', () => {
    it('updates the matching workspace agentDescription in state', () => {
      const store = useWorkspaceStore()
      store.workspaces = [makeWorkspace({ id: 'w1', description: null, agentDescription: 'old' })]
      const ws = useWebSocketStore()
      ws._routeMessage({
        type: 'workspace:agent-description-updated',
        workspaceId: 'w1',
        payload: { agentDescription: 'NEW LIVE STATUS' },
      })
      expect(store.workspaces[0].agentDescription).toBe('NEW LIVE STATUS')
    })

    it('does not touch the user description', () => {
      const store = useWorkspaceStore()
      store.workspaces = [makeWorkspace({ id: 'w1', description: 'user thing', agentDescription: null })]
      const ws = useWebSocketStore()
      ws._routeMessage({
        type: 'workspace:agent-description-updated',
        workspaceId: 'w1',
        payload: { agentDescription: 'agent thing' },
      })
      expect(store.workspaces[0].description).toBe('user thing')
      expect(store.workspaces[0].agentDescription).toBe('agent thing')
    })
  })

  describe('quota backoff store', () => {
    beforeEach(() => setActivePinia(createPinia()))

    it('setPendingQuotaBackoff stores the payload by workspaceId', () => {
      const store = useWorkspaceStore()
      store.setPendingQuotaBackoff('w1', {
        targetAt: '2026-05-06T13:30:00Z',
        resetsAt: null,
        source: 'fallback_ladder',
        reason: 'quota',
      })
      expect(store.pendingQuotaBackoffs.w1?.targetAt).toBe('2026-05-06T13:30:00Z')
    })

    it('clearPendingQuotaBackoff removes the entry', () => {
      const store = useWorkspaceStore()
      store.setPendingQuotaBackoff('w1', { targetAt: 't', resetsAt: null, source: 'fallback_ladder', reason: 'quota' })
      store.clearPendingQuotaBackoff('w1')
      expect(store.pendingQuotaBackoffs.w1).toBeUndefined()
    })

    it('cancelQuotaBackoff issues DELETE and clears state optimistically', async () => {
      const store = useWorkspaceStore()
      store.setPendingQuotaBackoff('w1', { targetAt: 't', resetsAt: null, source: 'fallback_ladder', reason: 'quota' })
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }))
      await store.cancelQuotaBackoff('w1')
      expect(fetchSpy).toHaveBeenCalledWith(
        '/api/workspaces/w1/quota-backoff',
        expect.objectContaining({ method: 'DELETE' }),
      )
      expect(store.pendingQuotaBackoffs.w1).toBeUndefined()
    })

    it('starts the workspace immediately when resuming a backoff', async () => {
      const store = useWorkspaceStore()
      const start = vi.spyOn(store, 'startWorkspace').mockResolvedValue()

      await store.resumeQuotaBackoffNow('w1')

      expect(start).toHaveBeenCalledWith('w1')
    })
  })

  describe('cron WS handlers', () => {
    it('cron:created adds the cron to the workspace list', () => {
      const store = useWorkspaceStore()
      const ws = useWebSocketStore()
      store.crons.w1 = []
      ws._routeMessage({
        type: 'cron:created',
        workspaceId: 'w1',
        payload: {
          cron: {
            id: 'c1',
            workspaceId: 'w1',
            expression: '@hourly',
            prompt: 'p',
            label: null,
            agentSessionId: null,
            nextFireAt: '2026-05-07T11:00:00Z',
            lastFiredAt: null,
            oneShot: false,
            createdAt: '2026-05-07T10:00:00Z',
          },
        },
      })
      expect(store.crons.w1).toHaveLength(1)
      expect(store.crons.w1?.[0]?.id).toBe('c1')
    })

    it('cron:fired updates nextFireAt + lastFiredAt of the matching cron', () => {
      const store = useWorkspaceStore()
      const ws = useWebSocketStore()
      store.crons.w1 = [
        {
          id: 'c1',
          workspaceId: 'w1',
          expression: '@hourly',
          prompt: 'p',
          label: null,
          agentSessionId: null,
          nextFireAt: '2026-05-07T11:00:00Z',
          lastFiredAt: null,
          oneShot: false,
          createdAt: '2026-05-07T10:00:00Z',
        },
      ]
      ws._routeMessage({
        type: 'cron:fired',
        workspaceId: 'w1',
        payload: { id: 'c1', nextFireAt: '2026-05-07T12:00:00Z', status: 'fired' },
      })
      expect(store.crons.w1?.[0]?.nextFireAt).toBe('2026-05-07T12:00:00Z')
      expect(store.crons.w1?.[0]?.lastFiredAt).not.toBeNull()
    })

    it('cron:cancelled removes the cron', () => {
      const store = useWorkspaceStore()
      const ws = useWebSocketStore()
      store.crons.w1 = [
        {
          id: 'c1',
          workspaceId: 'w1',
          expression: '@hourly',
          prompt: 'p',
          label: null,
          agentSessionId: null,
          nextFireAt: '2026-05-07T11:00:00Z',
          lastFiredAt: null,
          oneShot: false,
          createdAt: '2026-05-07T10:00:00Z',
        },
      ]
      ws._routeMessage({ type: 'cron:cancelled', workspaceId: 'w1', payload: { id: 'c1', reason: 'user' } })
      expect(store.crons.w1).toHaveLength(0)
    })

    it('cron:updated replaces the workspace list', () => {
      const store = useWorkspaceStore()
      const ws = useWebSocketStore()
      store.crons.w1 = []
      ws._routeMessage({
        type: 'cron:updated',
        workspaceId: 'w1',
        payload: {
          crons: [
            {
              id: 'c1',
              workspaceId: 'w1',
              expression: '@hourly',
              prompt: 'p',
              label: null,
              agentSessionId: null,
              nextFireAt: '2026-05-07T11:00:00Z',
              lastFiredAt: null,
              oneShot: false,
              createdAt: '2026-05-07T10:00:00Z',
            },
          ],
        },
      })
      expect(store.crons.w1).toHaveLength(1)
    })
  })

  describe('workspace grouping with PR attention', () => {
    beforeEach(() => {
      setActivePinia(createPinia())
    })

    function failingCiSnapshot(): PrSnapshot {
      return {
        number: 1,
        title: 't',
        url: 'u',
        state: 'OPEN',
        base: 'main',
        reviewDecision: null,
        author: { login: 'a' },
        assignees: [],
        reviewers: [],
        labels: [],
        ci: { rollup: 'FAILURE', checks: [] },
        updatedAt: '',
        unresolvedReviewThreadsCount: 0,
        readyToMerge: false,
      }
    }

    it('moves an executing workspace with failing CI into needsAttention, not running', () => {
      const store = useWorkspaceStore()
      store.workspaces = [makeWorkspace({ id: 'w1', status: 'executing' })]
      store.prSnapshots = { w1: failingCiSnapshot() }
      expect(store.needsAttention.map((w) => w.id)).toEqual(['w1'])
      expect(store.running.map((w) => w.id)).toEqual([])
    })

    it('moves an idle workspace with failing CI out of idle into needsAttention', () => {
      const store = useWorkspaceStore()
      store.workspaces = [makeWorkspace({ id: 'w1', status: 'idle' })]
      store.prSnapshots = { w1: failingCiSnapshot() }
      expect(store.needsAttention.map((w) => w.id)).toEqual(['w1'])
      expect(store.idle.map((w) => w.id)).toEqual([])
    })

    it('moves an idle workspace with blocking changes-requested into needsAttention', () => {
      const store = useWorkspaceStore()
      store.workspaces = [makeWorkspace({ id: 'w1', status: 'idle' })]
      store.prSnapshots = {
        w1: {
          ...failingCiSnapshot(),
          ci: { rollup: 'SUCCESS', checks: [] },
          reviewDecision: 'CHANGES_REQUESTED',
          reviewers: [{ login: 'reviewer', state: 'CHANGES_REQUESTED' }],
          unresolvedReviewThreadsCount: 1,
        },
      }
      expect(store.needsAttention.map((w) => w.id)).toEqual(['w1'])
      expect(store.idle.map((w) => w.id)).toEqual([])
    })

    it('keeps a busy workspace with a ready PR in running, not needsAttention', () => {
      const store = useWorkspaceStore()
      store.workspaces = [makeWorkspace({ id: 'w1', status: 'executing' })]
      store.prSnapshots = { w1: { ...failingCiSnapshot(), ci: { rollup: 'SUCCESS', checks: [] }, readyToMerge: true } }
      expect(store.running.map((w) => w.id)).toEqual(['w1'])
      expect(store.needsAttention.map((w) => w.id)).toEqual([])
    })

    it('moves an idle workspace with a ready PR into needsAttention, not idle', () => {
      const store = useWorkspaceStore()
      store.workspaces = [makeWorkspace({ id: 'w1', status: 'idle' })]
      store.prSnapshots = { w1: { ...failingCiSnapshot(), ci: { rollup: 'SUCCESS', checks: [] }, readyToMerge: true } }
      expect(store.needsAttention.map((w) => w.id)).toEqual(['w1'])
      expect(store.idle.map((w) => w.id)).toEqual([])
    })
  })

  describe('createCron / scheduleManualWakeup', () => {
    beforeEach(() => {
      vi.restoreAllMocks()
    })

    it('createCron POSTs the cron then refreshes the list', async () => {
      const ws = useWorkspaceStore()
      const fetchMock = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify({ cron: { id: 'c1' } }), { status: 201 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ crons: [{ id: 'c1' }] }), { status: 200 }))
      await ws.createCron('w1', { expression: '*/15 * * * *', prompt: 'do x', mode: 'fresh', oneShot: false })
      expect(fetchMock).toHaveBeenNthCalledWith(
        1,
        '/api/workspaces/w1/crons',
        expect.objectContaining({ method: 'POST' }),
      )
      expect(ws.crons.w1).toEqual([{ id: 'c1' }])
      fetchMock.mockRestore()
    })

    it('scheduleManualWakeup POSTs and stores the returned pending wakeup', async () => {
      const ws = useWorkspaceStore()
      const pending = { targetAt: '2026-04-22T10:05:00Z', reason: 'manual' }
      const fetchMock = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, pending }), { status: 200 }))
      await ws.scheduleManualWakeup('w1', { delaySeconds: 900, prompt: 'check', mode: 'fresh' })
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/workspaces/w1/pending-wakeup',
        expect.objectContaining({ method: 'POST' }),
      )
      expect(ws.pendingWakeups.w1).toEqual(pending)
      fetchMock.mockRestore()
    })

    it('createCron throws on a non-OK response', async () => {
      const ws = useWorkspaceStore()
      const fetchMock = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ error: 'expression and prompt are required' }), { status: 400 }),
        )
      await expect(ws.createCron('w1', { expression: '', prompt: '', mode: 'fresh', oneShot: false })).rejects.toThrow(
        'expression and prompt are required',
      )
      fetchMock.mockRestore()
    })
  })

  describe('prSnapshots', () => {
    beforeEach(() => {
      setActivePinia(createPinia())
      vi.restoreAllMocks()
    })

    it('fetchPrSnapshots populates the store with the rich payload', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            'ws-1': {
              number: 42,
              state: 'OPEN',
              reviewDecision: 'CHANGES_REQUESTED',
              title: 't',
              url: 'u',
              base: 'main',
              author: { login: 'a' },
              assignees: [],
              reviewers: [],
              labels: [],
              ci: { rollup: null, checks: [] },
              updatedAt: 'now',
            },
          }),
      })
      vi.stubGlobal('fetch', fetchMock)

      const store = useWorkspaceStore()
      await store.fetchPrSnapshots()

      expect(store.prSnapshots['ws-1']).toMatchObject({ number: 42, reviewDecision: 'CHANGES_REQUESTED' })
      expect(fetchMock).toHaveBeenCalledWith('/api/workspaces/pr-states', expect.anything())
    })

    it('refreshPrSnapshot updates a single workspace entry', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            snapshot: {
              number: 99,
              state: 'OPEN',
              reviewDecision: 'APPROVED',
              title: 't',
              url: 'u',
              base: 'main',
              author: { login: 'a' },
              assignees: [],
              reviewers: [],
              labels: [],
              ci: { rollup: null, checks: [] },
              updatedAt: 'now',
            },
          }),
      })
      vi.stubGlobal('fetch', fetchMock)

      const store = useWorkspaceStore()
      store.prSnapshots = { 'ws-1': { number: 1, state: 'OPEN', reviewDecision: null } as never }
      await store.refreshPrSnapshot('ws-1')

      expect(store.prSnapshots['ws-1']).toMatchObject({ number: 99, reviewDecision: 'APPROVED' })
      expect(fetchMock).toHaveBeenCalledWith('/api/workspaces/pr-snapshot/refresh/ws-1', { method: 'POST' })
    })

    it('fetchWorkspacesInfo populates workspaces, prSnapshots and gitStatsCache', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            workspaces: [makeWorkspace({ id: 'ws-1', status: 'idle' })],
            prSnapshots: { 'ws-1': { number: 7, state: 'OPEN' } },
            gitStats: { 'ws-1': { commitCount: 9 } },
          }),
      })
      vi.stubGlobal('fetch', fetchMock)

      const store = useWorkspaceStore()
      await store.fetchWorkspacesInfo()

      expect(store.workspaces.map((w) => w.id)).toEqual(['ws-1'])
      expect(store.prSnapshots['ws-1']).toMatchObject({ number: 7 })
      expect(store.gitStatsCache['ws-1']).toEqual({ commitCount: 9 })
      expect(fetchMock).toHaveBeenCalledWith('/api/workspaces/info', expect.anything())
    })

    it('fetchWorkspacesInfo never replaces fresher local git-stats with an older poll snapshot', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            workspaces: [makeWorkspace({ id: 'ws-1', status: 'idle' })],
            prSnapshots: {},
            // Stale server snapshot (older computedAt) — e.g. pre-rebase.
            gitStats: { 'ws-1': { commitCount: 1, computedAt: 100 } },
          }),
      })
      vi.stubGlobal('fetch', fetchMock)

      const store = useWorkspaceStore()
      // Simulate a fresh on-demand fetch that just landed after a git op.
      store.gitStatsCache = { 'ws-1': { commitCount: 5, computedAt: 200 } as never }

      await store.fetchWorkspacesInfo()

      // The newer local snapshot must survive — no revert to the stale poll data.
      expect(store.gitStatsCache['ws-1']).toMatchObject({ commitCount: 5, computedAt: 200 })
    })

    it('fetchWorkspacesInfo applies a newer poll snapshot over older local git-stats', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            workspaces: [makeWorkspace({ id: 'ws-1', status: 'idle' })],
            prSnapshots: {},
            gitStats: { 'ws-1': { commitCount: 8, computedAt: 300 } },
          }),
      })
      vi.stubGlobal('fetch', fetchMock)

      const store = useWorkspaceStore()
      store.gitStatsCache = { 'ws-1': { commitCount: 5, computedAt: 200 } as never }

      await store.fetchWorkspacesInfo()

      expect(store.gitStatsCache['ws-1']).toMatchObject({ commitCount: 8, computedAt: 300 })
    })

    it('does not let a stale fetchWorkspacesInfo response overwrite a fresher prSnapshot', async () => {
      const store = useWorkspaceStore()
      store.workspaces = [{ id: 'ws_1', name: 'Test' } as Workspace]

      // Two overlapping polls: the first (older) resolves AFTER the second
      // (newer) — simulate with two manually-controlled promises.
      let resolveFirst!: (v: unknown) => void
      let resolveSecond!: (v: unknown) => void
      const firstResponse = new Promise((r) => {
        resolveFirst = r
      })
      const secondResponse = new Promise((r) => {
        resolveSecond = r
      })
      const fetchMock = vi
        .fn()
        .mockImplementationOnce(() => firstResponse)
        .mockImplementationOnce(() => secondResponse)
      vi.stubGlobal('fetch', fetchMock)

      const firstCall = store.fetchWorkspacesInfo()
      const secondCall = store.fetchWorkspacesInfo()

      // Second (newer) call's network response lands first.
      resolveSecond({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            workspaces: [{ id: 'ws_1', name: 'Test', status: 'executing' }],
            prSnapshots: { ws_1: { number: 2, updatedAt: '2026-08-07T00:01:00.000Z' } },
            gitStats: {},
          }),
      })
      await secondCall

      // First (older, now-stale) call's response lands after.
      resolveFirst({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            workspaces: [{ id: 'ws_1', name: 'Test', status: 'idle' }],
            prSnapshots: { ws_1: { number: 1, updatedAt: '2026-08-07T00:00:00.000Z' } },
            gitStats: {},
          }),
      })
      await firstCall

      // The fresher (second) response must win, not the last-to-resolve
      // (first) one.
      expect(store.workspaces[0]?.status).toBe('executing')
      expect(store.prSnapshots.ws_1?.number).toBe(2)
    })

    it('does not overwrite a WebSocket workspace update received while the poll is in flight', async () => {
      const store = useWorkspaceStore()
      store.workspaces = [makeWorkspace({ id: 'ws-live', status: 'idle' })]
      let resolve!: (response: Response) => void
      vi.stubGlobal(
        'fetch',
        vi.fn(() => new Promise<Response>((r) => (resolve = r))),
      )

      const poll = store.fetchWorkspacesInfo()
      store.updateWorkspaceFromEvent('ws-live', { status: 'executing' })
      resolve({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            workspaces: [makeWorkspace({ id: 'ws-live', status: 'idle' })],
            prSnapshots: {},
            gitStats: {},
          }),
      } as Response)
      await poll

      expect(store.workspaces[0]?.status).toBe('executing')
    })

    it('does not overwrite a refreshed PR snapshot received while the bulk poll is in flight', async () => {
      const store = useWorkspaceStore()
      store.workspaces = [makeWorkspace({ id: 'ws-live', status: 'idle' })]
      let resolvePoll!: (response: Response) => void
      vi.stubGlobal(
        'fetch',
        vi.fn((input: string | URL | Request) => {
          const url = String(input)
          if (url === '/api/workspaces/info') return new Promise<Response>((resolve) => (resolvePoll = resolve))
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              snapshot: { number: 2, state: 'OPEN', updatedAt: '2026-08-07T00:01:00.000Z' },
            }),
          } as Response)
        }),
      )

      const poll = store.fetchWorkspacesInfo()
      await store.refreshPrSnapshot('ws-live')
      resolvePoll({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            workspaces: [makeWorkspace({ id: 'ws-live', status: 'idle' })],
            prSnapshots: { 'ws-live': { number: 1, state: 'OPEN', updatedAt: '2026-08-07T00:00:00.000Z' } },
            gitStats: {},
          }),
      } as Response)
      await poll

      expect(store.prSnapshots['ws-live']?.number).toBe(2)
    })

    it('refreshPrSnapshot clears the entry when the server returns 404', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: () => Promise.resolve({ error: 'No PR for this workspace' }),
      })
      vi.stubGlobal('fetch', fetchMock)

      const store = useWorkspaceStore()
      store.prSnapshots = { 'ws-1': { number: 1, state: 'OPEN' } as never }
      await store.refreshPrSnapshot('ws-1')

      expect(store.prSnapshots['ws-1']).toBeUndefined()
    })
  })

  describe('list load failure', () => {
    it('records the server message instead of showing an empty account', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          status: 503,
          text: async () => JSON.stringify({ error: 'database is locked' }),
        } as unknown as Response),
      )
      const store = useWorkspaceStore()

      await store.fetchWorkspaces()

      expect(store.listLoadError).toBe('database is locked')
      expect(store.workspaces).toEqual([])
      expect(store.loading).toBe(false)
    })

    it('reports a transport failure with something other than an HTTP code', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
      const store = useWorkspaceStore()

      await store.fetchWorkspaces()

      expect(store.listLoadError).toBe('Failed to fetch')
    })

    it('clears the failure once a load succeeds', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ workspaces: [makeWorkspace({ id: 'w1' })] }),
        } as unknown as Response),
      )
      const store = useWorkspaceStore()
      store.listLoadError = 'previous failure'

      await store.fetchWorkspaces()

      expect(store.listLoadError).toBeNull()
      expect(store.workspaces).toHaveLength(1)
    })

    it('retryLoadWorkspaces reloads both the active and archived lists', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ workspaces: [] }),
      } as unknown as Response)
      vi.stubGlobal('fetch', fetchMock)
      const store = useWorkspaceStore()
      store.archivedLoaded = true

      await store.retryLoadWorkspaces()

      const urls = fetchMock.mock.calls.map(([url]) => url as string)
      expect(urls).toContain('/api/workspaces')
      expect(urls).toContain('/api/workspaces/archived')
    })

    it('keeps the server message when starting a workspace fails', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          status: 409,
          text: async () => JSON.stringify({ error: 'An agent is already running for this workspace' }),
        } as unknown as Response),
      )
      const store = useWorkspaceStore()

      await expect(store.startWorkspace('w1')).rejects.toThrow('An agent is already running for this workspace')
    })
  })

  describe('poll load failure', () => {
    /** `/api/workspaces/info` mock: `null` fails the request, an object answers it. */
    function stubInfoFetch(responses: Array<null | Record<string, unknown>>) {
      let call = 0
      const fetchMock = vi.fn(() => {
        const body = responses[Math.min(call++, responses.length - 1)]
        if (body === null || body === undefined) {
          return Promise.resolve({
            ok: false,
            status: 502,
            text: async () => JSON.stringify({ error: 'backend is gone' }),
          } as unknown as Response)
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          text: async () => JSON.stringify(body),
        } as unknown as Response)
      })
      vi.stubGlobal('fetch', fetchMock)
      return fetchMock
    }

    const emptyInfo = { workspaces: [], prSnapshots: {}, gitStats: {} }

    it('stays quiet on a single dropped poll', async () => {
      stubInfoFetch([null])
      const store = useWorkspaceStore()

      await store.fetchWorkspacesInfo()

      // One missed poll (a laptop waking up, a proxy blip) must not flash a
      // "backend is down" banner at a user whose backend is fine.
      expect(store.listLoadError).toBeNull()
    })

    it('raises the banner after two consecutive failed polls', async () => {
      stubInfoFetch([null, null])
      const store = useWorkspaceStore()

      await store.fetchWorkspacesInfo()
      await store.fetchWorkspacesInfo()

      expect(store.listLoadError).toBe('backend is gone')
    })

    it('never empties the workspace list when a poll fails', async () => {
      stubInfoFetch([null, null])
      const store = useWorkspaceStore()
      store.workspaces = [makeWorkspace({ id: 'ws-1' })]

      await store.fetchWorkspacesInfo()
      await store.fetchWorkspacesInfo()

      // A failure records the failure. It never wipes data that is valid on
      // screen — the user keeps their list, plus an honest banner.
      expect(store.workspaces.map((w) => w.id)).toEqual(['ws-1'])
    })

    it('clears the banner as soon as a poll succeeds again', async () => {
      stubInfoFetch([null, null, emptyInfo])
      const store = useWorkspaceStore()

      await store.fetchWorkspacesInfo()
      await store.fetchWorkspacesInfo()
      expect(store.listLoadError).toBe('backend is gone')

      await store.fetchWorkspacesInfo()

      // A banner posted at load time used to survive the backend coming back.
      expect(store.listLoadError).toBeNull()
    })

    it('resets the failure streak on success, so one later failure stays quiet', async () => {
      stubInfoFetch([null, emptyInfo, null])
      const store = useWorkspaceStore()

      await store.fetchWorkspacesInfo()
      await store.fetchWorkspacesInfo()
      await store.fetchWorkspacesInfo()

      expect(store.listLoadError).toBeNull()
    })

    it('lets a successful archived load clear the banner', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          text: async () => JSON.stringify([]),
        } as unknown as Response),
      )
      const store = useWorkspaceStore()
      store.listLoadError = 'previous failure'

      await store.fetchArchivedWorkspaces()

      expect(store.listLoadError).toBeNull()
    })

    it('does not let a successful archived load clear a banner raised by the active list', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn((input: string | URL | Request) => {
          const url = String(input)
          if (url === '/api/workspaces/archived') {
            return Promise.resolve({ ok: true, status: 200, text: async () => '[]' } as unknown as Response)
          }
          return Promise.resolve({
            ok: false,
            status: 500,
            text: async () => JSON.stringify({ error: 'database is locked' }),
          } as unknown as Response)
        }),
      )
      const store = useWorkspaceStore()
      store.archivedLoaded = true

      await store.retryLoadWorkspaces()

      // The archived list has no authority over a failure of the main list.
      expect(store.listLoadError).toBe('database is locked')
    })
  })
})
