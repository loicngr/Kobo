import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import { useWorkspaceStore } from '../stores/workspace'

describe('workspace store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
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
    it('returns all items when no session selected', () => {
      const store = useWorkspaceStore()
      store.selectedWorkspaceId = 'ws-1'
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
      expect(store.activityFeed).toHaveLength(2)
    })

    it('filters by selected session, keeping items without sessionId', () => {
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
      expect(feed.map((i) => i.id).sort()).toEqual(['a', 'c'])
    })
  })
})
