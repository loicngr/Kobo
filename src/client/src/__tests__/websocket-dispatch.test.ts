import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Workspace } from '../stores/workspace'

vi.mock('src/utils/notifications', () => ({ notify: vi.fn() }))

import { notify } from 'src/utils/notifications'

function workspaceFixture(status = 'executing'): Workspace {
  return {
    id: 'w1',
    name: 'Replacement workspace',
    projectPath: '/tmp/project',
    sourceBranch: 'main',
    workingBranch: 'feature/replacement',
    status,
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
    worktreePath: '/tmp/project/.worktrees/feature/replacement',
    worktreeOwned: true,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  }
}

describe('websocket dispatch — AgentEvent side-effects to workspace store', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('does not regress local status from quota to error when session:ended follows a quota hit', async () => {
    const { useWorkspaceStore } = await import('../stores/workspace.js')
    const ws = useWorkspaceStore()
    ws.workspaces = [
      {
        id: 'w1',
        name: 'Quota workspace',
        projectPath: '/tmp/project',
        sourceBranch: 'main',
        workingBranch: 'feature/quota',
        status: 'quota',
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
        autoLoop: true,
        autoLoopReady: true,
        noProgressStreak: 0,
        worktreePath: '/tmp/project/.worktrees/feature/quota',
        worktreeOwned: true,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
    ]
    vi.spyOn(ws, 'fetchWorkspaces').mockResolvedValue()
    vi.spyOn(ws, 'finalizeRunningSubagents').mockImplementation(() => {})
    const { _setReplayingForDispatch, dispatchAgentEvent } = await import('../stores/websocket.js')

    _setReplayingForDispatch(true)
    try {
      dispatchAgentEvent('w1', { kind: 'session:ended', reason: 'error', exitCode: 1 })
    } finally {
      _setReplayingForDispatch(false)
    }

    expect(ws.workspaces[0]?.status).toBe('quota')
  })

  it('routes subagent:progress events to workspaceStore.upsertSubagent', async () => {
    const { useWorkspaceStore } = await import('../stores/workspace.js')
    const ws = useWorkspaceStore()
    const spy = vi.spyOn(ws, 'upsertSubagent')
    const { dispatchAgentEvent } = await import('../stores/websocket.js')
    dispatchAgentEvent('w1', { kind: 'subagent:progress', toolCallId: 't1', status: 'done', totalTokens: 100 })
    expect(spy).toHaveBeenCalledWith(
      'w1',
      expect.objectContaining({ toolUseId: 't1', status: 'done', totalTokens: 100 }),
    )
  })

  it('sets the transient compacting flag on session:compacting and clears it on session:compacted', async () => {
    const { useAgentStreamStore } = await import('../stores/agent-stream.js')
    const stream = useAgentStreamStore()
    const { dispatchAgentEvent } = await import('../stores/websocket.js')

    expect(stream.isCompacting('w1')).toBe(false)

    dispatchAgentEvent('w1', { kind: 'session:compacting', active: true })
    expect(stream.isCompacting('w1')).toBe(true)
    // Ephemeral: it must NOT enter the persisted event stream.
    expect(stream.eventsFor('w1')).toHaveLength(0)

    dispatchAgentEvent('w1', { kind: 'session:compacted' })
    expect(stream.isCompacting('w1')).toBe(false)
  })

  it('clears the compacting flag when the session ends mid-compaction', async () => {
    const { useAgentStreamStore } = await import('../stores/agent-stream.js')
    const stream = useAgentStreamStore()
    const { useWorkspaceStore } = await import('../stores/workspace.js')
    const ws = useWorkspaceStore()
    vi.spyOn(ws, 'fetchWorkspaces').mockResolvedValue()
    vi.spyOn(ws, 'finalizeRunningSubagents').mockImplementation(() => {})
    const { dispatchAgentEvent } = await import('../stores/websocket.js')

    dispatchAgentEvent('w1', { kind: 'session:compacting', active: true })
    expect(stream.isCompacting('w1')).toBe(true)

    dispatchAgentEvent('w1', { kind: 'session:ended', reason: 'completed', exitCode: 0 })
    expect(stream.isCompacting('w1')).toBe(false)
  })

  it('ignores workspace-wide effects when a superseded session ends after its replacement starts', async () => {
    const { useAgentStreamStore } = await import('../stores/agent-stream.js')
    const stream = useAgentStreamStore()
    const { useWorkspaceStore } = await import('../stores/workspace.js')
    const ws = useWorkspaceStore()
    ws.workspaces = [workspaceFixture()]
    const fetchWorkspaces = vi.spyOn(ws, 'fetchWorkspaces').mockResolvedValue()
    const finalizeRunningSubagents = vi.spyOn(ws, 'finalizeRunningSubagents')
    const flushQueuedMessage = vi.spyOn(ws, 'flushQueuedMessage')
    vi.mocked(notify).mockClear()
    const { dispatchAgentEvent } = await import('../stores/websocket.js')

    dispatchAgentEvent(
      'w1',
      { kind: 'session:started', engineSessionId: 'engine-A' },
      undefined,
      undefined,
      'session-A',
    )
    dispatchAgentEvent(
      'w1',
      { kind: 'session:started', engineSessionId: 'engine-B' },
      undefined,
      undefined,
      'session-B',
    )
    ws.enqueuePending('w1', {
      kind: 'question',
      toolCallId: 'pending-A',
      toolName: 'AskUserQuestion',
      input: {},
      agentSessionId: 'session-A',
    })
    ws.enqueuePending('w1', {
      kind: 'permission',
      toolCallId: 'pending-B',
      toolName: 'Bash',
      toolInput: {},
      agentSessionId: 'session-B',
    })
    ws.queueMessage('w1', 'queued for A', 'session-A')
    ws.queueMessage('w1', 'queued for B', 'session-B')
    dispatchAgentEvent(
      'w1',
      { kind: 'subagent:progress', toolCallId: 'subagent-B', status: 'running' },
      undefined,
      undefined,
      'session-B',
    )
    dispatchAgentEvent('w1', { kind: 'session:compacting', active: true }, undefined, undefined, 'session-B')

    dispatchAgentEvent(
      'w1',
      { kind: 'session:ended', reason: 'completed', exitCode: 0 },
      undefined,
      undefined,
      'session-A',
    )

    const activeSessions = ws.activeAgentSessionIds
    expect(stream.eventsFor('w1').at(-1)).toEqual({ kind: 'session:ended', reason: 'completed', exitCode: 0 })
    expect(stream.sessionIdsFor('w1').at(-1)).toBe('session-A')
    expect(ws.peekPending('w1')?.agentSessionId).toBe('session-B')
    expect(ws.getQueuedMessage('w1', 'session-A')).toBeUndefined()
    expect(ws.getQueuedMessage('w1', 'session-B')?.content).toBe('queued for B')
    expect(ws.workspaces[0]?.status).toBe('executing')
    expect(activeSessions.w1).toBe('session-B')
    expect(stream.isCompacting('w1')).toBe(true)
    expect(ws.subagents.w1?.['subagent-B']?.status).toBe('running')
    expect(fetchWorkspaces).not.toHaveBeenCalled()
    expect(finalizeRunningSubagents).not.toHaveBeenCalled()
    expect(flushQueuedMessage).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()

    dispatchAgentEvent(
      'w1',
      { kind: 'session:ended', reason: 'completed', exitCode: 0 },
      undefined,
      undefined,
      'session-B',
    )

    expect(ws.peekPending('w1')).toBeUndefined()
    expect(ws.getQueuedMessage('w1', 'session-B')).toBeUndefined()
    expect(ws.workspaces[0]?.status).toBe('completed')
    expect(activeSessions.w1).toBeUndefined()
    expect(stream.isCompacting('w1')).toBe(false)
    expect(ws.subagents.w1?.['subagent-B']?.status).toBe('done')
    expect(fetchWorkspaces).toHaveBeenCalledTimes(1)
    expect(finalizeRunningSubagents).toHaveBeenCalledTimes(1)
    expect(flushQueuedMessage).toHaveBeenCalledWith('w1', 'session-B')
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it('keeps the historical termination path when no active session identity is known', async () => {
    const { useAgentStreamStore } = await import('../stores/agent-stream.js')
    const stream = useAgentStreamStore()
    const { useWorkspaceStore } = await import('../stores/workspace.js')
    const ws = useWorkspaceStore()
    ws.workspaces = [workspaceFixture()]
    ws.queueMessage('w1', 'legacy queued message', 'session-legacy')
    const fetchWorkspaces = vi.spyOn(ws, 'fetchWorkspaces').mockResolvedValue()
    const flushQueuedMessage = vi.spyOn(ws, 'flushQueuedMessage')
    vi.mocked(notify).mockClear()
    const { dispatchAgentEvent } = await import('../stores/websocket.js')

    dispatchAgentEvent('w1', { kind: 'session:compacting', active: true })
    dispatchAgentEvent(
      'w1',
      { kind: 'session:ended', reason: 'completed', exitCode: 0 },
      undefined,
      undefined,
      'session-legacy',
    )

    expect(ws.activeAgentSessionIds.w1).toBeUndefined()
    expect(ws.workspaces[0]?.status).toBe('completed')
    expect(stream.isCompacting('w1')).toBe(false)
    expect(ws.getQueuedMessage('w1', 'session-legacy')).toBeUndefined()
    expect(flushQueuedMessage).toHaveBeenCalledWith('w1', 'session-legacy')
    expect(fetchWorkspaces).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it('honors a durable superseded marker without relying on local ownership context', async () => {
    const { useAgentStreamStore } = await import('../stores/agent-stream.js')
    const stream = useAgentStreamStore()
    const { useWorkspaceStore } = await import('../stores/workspace.js')
    const ws = useWorkspaceStore()
    ws.workspaces = [workspaceFixture()]
    ws.enqueuePending('w1', {
      kind: 'question',
      toolCallId: 'pending-A',
      toolName: 'AskUserQuestion',
      input: {},
      agentSessionId: 'session-A',
    })
    ws.queueMessage('w1', 'queued for A', 'session-A')
    ws.upsertSubagent('w1', { toolUseId: 'subagent-B', status: 'running' })
    const fetchWorkspaces = vi.spyOn(ws, 'fetchWorkspaces').mockResolvedValue()
    const finalizeRunningSubagents = vi.spyOn(ws, 'finalizeRunningSubagents')
    const flushQueuedMessage = vi.spyOn(ws, 'flushQueuedMessage')
    vi.mocked(notify).mockClear()
    const { dispatchAgentEvent } = await import('../stores/websocket.js')
    dispatchAgentEvent('w1', { kind: 'session:compacting', active: true })

    dispatchAgentEvent(
      'w1',
      { kind: 'session:ended', reason: 'completed', exitCode: 0, superseded: true },
      undefined,
      undefined,
      'session-A',
    )

    expect(stream.eventsFor('w1').at(-1)).toEqual({
      kind: 'session:ended',
      reason: 'completed',
      exitCode: 0,
      superseded: true,
    })
    expect(ws.peekPending('w1')).toBeUndefined()
    expect(ws.getQueuedMessage('w1', 'session-A')).toBeUndefined()
    expect(ws.workspaces[0]?.status).toBe('executing')
    expect(stream.isCompacting('w1')).toBe(true)
    expect(ws.subagents.w1?.['subagent-B']?.status).toBe('running')
    expect(fetchWorkspaces).not.toHaveBeenCalled()
    expect(finalizeRunningSubagents).not.toHaveBeenCalled()
    expect(flushQueuedMessage).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
  })

  it('clears the active owner when an anonymous legacy session end applies global effects', async () => {
    const { useWorkspaceStore } = await import('../stores/workspace.js')
    const ws = useWorkspaceStore()
    ws.workspaces = [workspaceFixture()]
    ws.setActiveAgentSession('w1', 'session-B')
    vi.spyOn(ws, 'fetchWorkspaces').mockResolvedValue()
    vi.mocked(notify).mockClear()
    const { dispatchAgentEvent } = await import('../stores/websocket.js')

    dispatchAgentEvent('w1', { kind: 'session:ended', reason: 'completed', exitCode: 0 })

    expect(ws.activeAgentSessionIds.w1).toBeUndefined()
    expect(ws.workspaces[0]?.status).toBe('completed')
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it('sets the compacting flag when a `/compact` command is sent', async () => {
    const { useAgentStreamStore } = await import('../stores/agent-stream.js')
    const stream = useAgentStreamStore()
    const { useWebSocketStore } = await import('../stores/websocket.js')
    const wsStore = useWebSocketStore()

    expect(stream.isCompacting('w1')).toBe(false)
    wsStore.sendChatMessage('w1', '/compact')
    expect(stream.isCompacting('w1')).toBe(true)
  })

  it('does not set the compacting flag for a regular message', async () => {
    const { useAgentStreamStore } = await import('../stores/agent-stream.js')
    const stream = useAgentStreamStore()
    const { useWebSocketStore } = await import('../stores/websocket.js')
    const wsStore = useWebSocketStore()

    wsStore.sendChatMessage('w1', 'compact the code please')
    expect(stream.isCompacting('w1')).toBe(false)
  })

  it('reports that a chat message was not sent while the WebSocket is disconnected', async () => {
    const { useWebSocketStore } = await import('../stores/websocket.js')
    const wsStore = useWebSocketStore()

    expect(wsStore.sendChatMessage('w1', 'do not lose this message')).toBe(false)
  })

  it('accumulates TaskCreate calls into the agent todos panel (Claude Code ≥ v0.3.142)', async () => {
    const { useWorkspaceStore } = await import('../stores/workspace.js')
    const ws = useWorkspaceStore()
    const { dispatchAgentEvent } = await import('../stores/websocket.js')

    // Real TaskCreate input shape captured from the SDK (subject/description/activeForm).
    dispatchAgentEvent('w1', {
      kind: 'tool:call',
      messageId: 'm1',
      toolCallId: 'tc1',
      name: 'TaskCreate',
      input: { subject: 'Arroser les plantes', description: 'desc', activeForm: 'Arrosage' },
    })
    dispatchAgentEvent('w1', {
      kind: 'tool:result',
      toolCallId: 'tc1',
      output: 'Task #1 created successfully: Arroser les plantes',
      isError: false,
    })
    dispatchAgentEvent('w1', {
      kind: 'tool:call',
      messageId: 'm1',
      toolCallId: 'tc2',
      name: 'TaskCreate',
      input: { subject: 'Trier la boîte mail', activeForm: 'Tri' },
    })
    dispatchAgentEvent('w1', {
      kind: 'tool:result',
      toolCallId: 'tc2',
      output: 'Task #2 created successfully: Trier la boîte mail',
      isError: false,
    })

    const todos = ws.agentTodos.w1 ?? []
    expect(todos.map((t) => t.content)).toEqual(['Arroser les plantes', 'Trier la boîte mail'])
    expect(todos.every((t) => t.status === 'pending')).toBe(true)
    expect(todos.map((t) => t.taskNumber)).toEqual([1, 2])
  })

  it('applies TaskUpdate by #N and normalizes running → in_progress', async () => {
    const { useWorkspaceStore } = await import('../stores/workspace.js')
    const ws = useWorkspaceStore()
    const { dispatchAgentEvent } = await import('../stores/websocket.js')

    dispatchAgentEvent('w1', {
      kind: 'tool:call',
      messageId: 'm',
      toolCallId: 'a',
      name: 'TaskCreate',
      input: { subject: 'T1' },
    })
    dispatchAgentEvent('w1', {
      kind: 'tool:result',
      toolCallId: 'a',
      output: 'Task #1 created successfully: T1',
      isError: false,
    })
    // Real TaskUpdate shape: `{ taskId: '<n>', status }` (camelCase, string id).
    dispatchAgentEvent('w1', {
      kind: 'tool:call',
      messageId: 'm',
      toolCallId: 'b',
      name: 'TaskUpdate',
      input: { taskId: '1', status: 'running' },
    })

    const todos = ws.agentTodos.w1 ?? []
    expect(todos[0]?.status).toBe('in_progress')

    dispatchAgentEvent('w1', {
      kind: 'tool:call',
      messageId: 'm',
      toolCallId: 'c',
      name: 'TaskUpdate',
      input: { taskId: '1', status: 'completed' },
    })
    expect((ws.agentTodos.w1 ?? [])[0]?.status).toBe('completed')
  })

  it('TaskUpdate with status "deleted" removes the row (real shape)', async () => {
    const { useWorkspaceStore } = await import('../stores/workspace.js')
    const ws = useWorkspaceStore()
    const { dispatchAgentEvent } = await import('../stores/websocket.js')

    for (const [id, n, subject] of [
      ['a', 1, 'Plantes'],
      ['b', 2, 'Mail'],
      ['c', 3, 'Café'],
    ] as const) {
      dispatchAgentEvent('w1', {
        kind: 'tool:call',
        messageId: 'm',
        toolCallId: id,
        name: 'TaskCreate',
        input: { subject },
      })
      dispatchAgentEvent('w1', {
        kind: 'tool:result',
        toolCallId: id,
        output: `Task #${n} created successfully: ${subject}`,
        isError: false,
      })
    }
    expect((ws.agentTodos.w1 ?? []).length).toBe(3)

    // Real deletion: TaskUpdate { taskId: '2', status: 'deleted' }.
    dispatchAgentEvent('w1', {
      kind: 'tool:call',
      messageId: 'm',
      toolCallId: 'd',
      name: 'TaskUpdate',
      input: { taskId: '2', status: 'deleted' },
    })

    expect((ws.agentTodos.w1 ?? []).map((t) => t.content)).toEqual(['Plantes', 'Café'])
  })

  it('triggers a git refresh 3 s after a `gh pr create` Bash tool:call', async () => {
    vi.useFakeTimers()
    try {
      const { useWorkspaceStore } = await import('../stores/workspace.js')
      const ws = useWorkspaceStore()
      const spy = vi.spyOn(ws, 'triggerGitRefresh')
      const { dispatchAgentEvent } = await import('../stores/websocket.js')

      dispatchAgentEvent('w1', {
        kind: 'tool:call',
        messageId: 'm1',
        toolCallId: 'c1',
        name: 'Bash',
        input: { command: 'gh pr create --title "X" --body "Y"', description: 'open PR' },
      })

      expect(spy).not.toHaveBeenCalled()
      vi.advanceTimersByTime(3000)
      expect(spy).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does NOT trigger a git refresh for `gh pr view` (read-only)', async () => {
    vi.useFakeTimers()
    try {
      const { useWorkspaceStore } = await import('../stores/workspace.js')
      const ws = useWorkspaceStore()
      const spy = vi.spyOn(ws, 'triggerGitRefresh')
      const { dispatchAgentEvent } = await import('../stores/websocket.js')

      dispatchAgentEvent('w1', {
        kind: 'tool:call',
        messageId: 'm1',
        toolCallId: 'c1',
        name: 'Bash',
        input: { command: 'gh pr view feature/foo', description: 'inspect PR' },
      })

      vi.advanceTimersByTime(5000)
      expect(spy).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('routes usage:snapshot to workspaceStore.applyUsageSnapshot', async () => {
    const { useWorkspaceStore } = await import('../stores/workspace.js')
    const store = useWorkspaceStore()
    const spy = vi.spyOn(store, 'applyUsageSnapshot')
    const { useWebSocketStore } = await import('../stores/websocket.js')
    const wsStore = useWebSocketStore()

    ;(wsStore as unknown as { _routeMessage: (msg: Record<string, unknown>) => void })._routeMessage({
      type: 'usage:snapshot',
      payload: {
        providerId: 'claude-code',
        snapshot: {
          providerId: 'claude-code',
          status: 'ok',
          buckets: [],
          fetchedAt: '2026-04-29T14:30:00Z',
        },
      },
    })

    expect(spy).toHaveBeenCalledWith({
      providerId: 'claude-code',
      snapshot: expect.objectContaining({ status: 'ok' }),
    })
  })

  it('routes session:user-input-requested(question) to enqueuePending as a question item', async () => {
    const { useWorkspaceStore } = await import('../stores/workspace.js')
    const ws = useWorkspaceStore()
    const spy = vi.spyOn(ws, 'enqueuePending')
    const { dispatchAgentEvent } = await import('../stores/websocket.js')
    const input = { questions: [{ question: 'Q?', options: [{ label: 'A' }] }] }
    dispatchAgentEvent(
      'w1',
      {
        kind: 'session:user-input-requested',
        requestKind: 'question',
        toolCallId: 'tc-1',
        toolName: 'AskUserQuestion',
        payload: input,
      },
      undefined,
      undefined,
      'agent-sess-A',
    )
    expect(spy).toHaveBeenCalledWith('w1', {
      kind: 'question',
      toolCallId: 'tc-1',
      toolName: 'AskUserQuestion',
      input,
      agentSessionId: 'agent-sess-A',
    })
    const head = ws.peekPending('w1')
    expect(head?.kind).toBe('question')
    expect(head?.toolCallId).toBe('tc-1')
  })

  it('routes session:user-input-requested(permission) to enqueuePending as a permission item', async () => {
    const { useWorkspaceStore } = await import('../stores/workspace.js')
    const ws = useWorkspaceStore()
    const spy = vi.spyOn(ws, 'enqueuePending')
    const { dispatchAgentEvent } = await import('../stores/websocket.js')
    const toolInput = { command: 'rm -rf /' }
    dispatchAgentEvent(
      'w1',
      {
        kind: 'session:user-input-requested',
        requestKind: 'permission',
        toolCallId: 'tc-2',
        toolName: 'Bash',
        payload: toolInput,
      },
      undefined,
      undefined,
      'agent-sess-B',
    )
    expect(spy).toHaveBeenCalledWith('w1', {
      kind: 'permission',
      toolCallId: 'tc-2',
      toolName: 'Bash',
      toolInput,
      agentSessionId: 'agent-sess-B',
    })
    const head = ws.peekPending('w1')
    expect(head?.kind).toBe('permission')
  })

  it('clearPendingForSession on session:ended drops items of that session', async () => {
    const { useWorkspaceStore } = await import('../stores/workspace.js')
    const ws = useWorkspaceStore()
    vi.spyOn(ws, 'fetchWorkspaces').mockResolvedValue()
    vi.spyOn(ws, 'finalizeRunningSubagents').mockImplementation(() => {})
    ws.enqueuePending('w1', {
      kind: 'question',
      toolCallId: 'tc-A',
      toolName: 'AskUserQuestion',
      input: {},
      agentSessionId: 'sess-A',
    })
    ws.enqueuePending('w1', {
      kind: 'permission',
      toolCallId: 'tc-B',
      toolName: 'Bash',
      toolInput: {},
      agentSessionId: 'sess-B',
    })
    const { dispatchAgentEvent } = await import('../stores/websocket.js')
    dispatchAgentEvent(
      'w1',
      { kind: 'session:ended', reason: 'completed', exitCode: 0 },
      undefined,
      undefined,
      'sess-A',
    )
    const head = ws.peekPending('w1')
    expect(head?.toolCallId).toBe('tc-B')
  })

  it('clears pending deferred on session:started for THE SAME session', async () => {
    const { useWorkspaceStore } = await import('../stores/workspace.js')
    const ws = useWorkspaceStore()
    ws.setPendingDeferred('w1', {
      toolCallId: 'tc-1',
      toolName: 'AskUserQuestion',
      input: {},
      agentSessionId: 'agent-sess-A',
    })
    const { dispatchAgentEvent } = await import('../stores/websocket.js')
    dispatchAgentEvent(
      'w1',
      { kind: 'session:started', engineSessionId: 'sess-1' },
      undefined,
      undefined,
      'agent-sess-A',
    )
    expect(ws.getPendingDeferred('w1')).toBeUndefined()
  })

  it('does NOT clear pending deferred when a different session starts', async () => {
    const { useWorkspaceStore } = await import('../stores/workspace.js')
    const ws = useWorkspaceStore()
    ws.setPendingDeferred('w1', {
      toolCallId: 'tc-1',
      toolName: 'AskUserQuestion',
      input: {},
      agentSessionId: 'agent-sess-A',
    })
    const { dispatchAgentEvent } = await import('../stores/websocket.js')
    dispatchAgentEvent(
      'w1',
      { kind: 'session:started', engineSessionId: 'sess-2' },
      undefined,
      undefined,
      'agent-sess-B',
    )
    expect(ws.getPendingDeferred('w1')?.toolCallId).toBe('tc-1')
  })

  it('rebuilds the latest active session identity during event replay', async () => {
    const { useWorkspaceStore } = await import('../stores/workspace.js')
    const ws = useWorkspaceStore()
    const { useWebSocketStore } = await import('../stores/websocket.js')
    const socket = useWebSocketStore()
    const event = (id: string, sessionId: string, payload: Record<string, unknown>): Record<string, unknown> => ({
      id,
      workspaceId: 'w1',
      type: 'agent:event',
      payload,
      createdAt: `2026-01-01T00:00:0${id}.000Z`,
      sessionId,
    })

    socket._routeMessage({
      type: 'sync:response',
      payload: {
        events: [
          event('1', 'session-A', { kind: 'session:started', engineSessionId: 'engine-A' }),
          event('2', 'session-B', { kind: 'session:started', engineSessionId: 'engine-B' }),
          event('3', 'session-A', { kind: 'session:ended', reason: 'completed', exitCode: 0 }),
        ],
      },
    })

    expect(ws.activeAgentSessionIds.w1).toBe('session-B')

    socket._routeMessage({
      type: 'sync:response',
      payload: {
        events: [
          event('1', 'session-A', { kind: 'session:started', engineSessionId: 'engine-A' }),
          event('2', 'session-B', { kind: 'session:started', engineSessionId: 'engine-B' }),
          event('3', 'session-A', { kind: 'session:ended', reason: 'completed', exitCode: 0 }),
          event('4', 'session-B', { kind: 'session:ended', reason: 'completed', exitCode: 0 }),
        ],
      },
    })

    expect(ws.activeAgentSessionIds.w1).toBeUndefined()
  })

  it('removes only ended-session queued messages while replaying persisted events', async () => {
    const { useWorkspaceStore } = await import('../stores/workspace.js')
    const ws = useWorkspaceStore()
    ws.queueMessage('w1', 'queued for A', 'session-A')
    ws.queueMessage('w1', 'queued for B', 'session-B')
    const { useWebSocketStore } = await import('../stores/websocket.js')

    useWebSocketStore()._routeMessage({
      type: 'sync:response',
      payload: {
        events: [
          {
            id: '1',
            workspaceId: 'w1',
            type: 'agent:event',
            payload: { kind: 'session:started', engineSessionId: 'engine-B' },
            createdAt: '2026-01-01T00:00:01.000Z',
            sessionId: 'session-B',
          },
          {
            id: '2',
            workspaceId: 'w1',
            type: 'agent:event',
            payload: { kind: 'session:ended', reason: 'completed', exitCode: 0, superseded: true },
            createdAt: '2026-01-01T00:00:02.000Z',
            sessionId: 'session-A',
          },
        ],
      },
    })

    expect(ws.getQueuedMessage('w1', 'session-A')).toBeUndefined()
    expect(ws.getQueuedMessage('w1', 'session-B')?.content).toBe('queued for B')
    expect(ws.activeAgentSessionIds.w1).toBe('session-B')
  })

  it('clears replay ownership when a persisted legacy session end has no session id', async () => {
    const { useWorkspaceStore } = await import('../stores/workspace.js')
    const ws = useWorkspaceStore()
    ws.setActiveAgentSession('w1', 'session-B')
    const { useWebSocketStore } = await import('../stores/websocket.js')

    useWebSocketStore()._routeMessage({
      type: 'sync:response',
      payload: {
        events: [
          {
            id: '1',
            workspaceId: 'w1',
            type: 'agent:event',
            payload: { kind: 'session:ended', reason: 'completed', exitCode: 0 },
            createdAt: '2026-01-01T00:00:01.000Z',
          },
        ],
      },
    })

    expect(ws.activeAgentSessionIds.w1).toBeUndefined()
  })
})
