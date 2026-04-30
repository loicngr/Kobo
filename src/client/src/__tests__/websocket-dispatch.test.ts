import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('websocket dispatch — AgentEvent side-effects to workspace store', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('routes usage events to workspaceStore.addUsageStats', async () => {
    const { useWorkspaceStore } = await import('../stores/workspace.js')
    const ws = useWorkspaceStore()
    const spy = vi.spyOn(ws, 'addUsageStats')
    const { dispatchAgentEvent } = await import('../stores/websocket.js')
    dispatchAgentEvent('w1', { kind: 'usage', inputTokens: 1, outputTokens: 2, costUsd: 0.01 })
    expect(spy).toHaveBeenCalledWith('w1', expect.objectContaining({ inputTokens: 1, outputTokens: 2 }))
  })

  it('routes rate_limit events to workspaceStore.setRateLimitUsage', async () => {
    const { useWorkspaceStore } = await import('../stores/workspace.js')
    const ws = useWorkspaceStore()
    const spy = vi.spyOn(ws, 'setRateLimitUsage')
    const { dispatchAgentEvent } = await import('../stores/websocket.js')
    dispatchAgentEvent('w1', { kind: 'rate_limit', info: { buckets: [{ id: 'five_hour', usedPct: 42 }] } })
    expect(spy).toHaveBeenCalled()
  })

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
        reasoningEffort: 'normal',
        permissionMode: 'auto-accept',
        devServerStatus: 'stopped',
        hasUnread: false,
        archivedAt: null,
        favoritedAt: null,
        tags: [],
        autoLoop: true,
        autoLoopReady: true,
        noProgressStreak: 0,
        permissionProfile: 'bypass',
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
})
