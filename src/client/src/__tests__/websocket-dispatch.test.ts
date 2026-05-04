import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

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
        tags: [],
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
})
