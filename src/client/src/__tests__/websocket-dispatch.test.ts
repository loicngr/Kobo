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
})
