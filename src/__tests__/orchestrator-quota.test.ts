import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../server/services/websocket-service.js', () => ({
  emit: vi.fn(),
  emitEphemeral: vi.fn(),
}))

vi.mock('../server/services/agent/event-router.js', () => ({
  routeEvent: vi.fn(),
}))

vi.mock('../server/services/workspace-service.js', () => ({
  updateWorkspaceStatus: vi.fn(),
  getWorkspace: vi.fn(() => null),
  markWorkspaceUnread: vi.fn(),
}))

describe('computeQuotaBackoffMs', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-23T10:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('uses resetsAt when a saturated bucket has one', async () => {
    const orch = await import('../server/services/agent/orchestrator.js')
    orch._test_setRateLimitInfo('w1', {
      buckets: [{ id: 'five_hour', usedPct: 100, resetsAt: '2026-04-23T10:10:00Z' }],
    })
    const result = orch.computeQuotaBackoffMs('w1', 0)
    expect(result.delayMs).toBe(10 * 60 * 1000 + 30 * 1000)
    expect(result.resetsAt).toBe('2026-04-23T10:10:00Z')
    expect(result.source).toBe('rate_limit_info')
  })

  it('falls back to exponential when no info is stored for the workspace', async () => {
    const orch = await import('../server/services/agent/orchestrator.js')
    orch.forgetRateLimitInfo('w1')
    const result = orch.computeQuotaBackoffMs('w1', 0)
    expect(result.delayMs).toBe(15 * 60 * 1000)
    expect(result.resetsAt).toBeUndefined()
    expect(result.source).toBe('exponential_fallback')
  })

  it('falls back to exponential when resetsAt is in the past', async () => {
    const orch = await import('../server/services/agent/orchestrator.js')
    orch._test_setRateLimitInfo('w1', {
      buckets: [{ id: 'x', usedPct: 100, resetsAt: '2026-04-23T09:55:00Z' }],
    })
    const result = orch.computeQuotaBackoffMs('w1', 0)
    expect(result.source).toBe('exponential_fallback')
    expect(result.delayMs).toBe(15 * 60 * 1000)
  })

  it('falls back to exponential when resetsAt is > 24h in the future', async () => {
    const orch = await import('../server/services/agent/orchestrator.js')
    orch._test_setRateLimitInfo('w1', {
      buckets: [{ id: 'x', usedPct: 100, resetsAt: '2026-04-25T10:00:00Z' }],
    })
    const result = orch.computeQuotaBackoffMs('w1', 2)
    expect(result.source).toBe('exponential_fallback')
    expect(result.delayMs).toBe(60 * 60 * 1000)
  })

  it('fallback ladder steps: 15 → 30 → 60 → 180 → 300 minutes', async () => {
    const orch = await import('../server/services/agent/orchestrator.js')
    orch.forgetRateLimitInfo('w1')
    expect(orch.computeQuotaBackoffMs('w1', 0).delayMs).toBe(15 * 60 * 1000)
    expect(orch.computeQuotaBackoffMs('w1', 1).delayMs).toBe(30 * 60 * 1000)
    expect(orch.computeQuotaBackoffMs('w1', 2).delayMs).toBe(60 * 60 * 1000)
    expect(orch.computeQuotaBackoffMs('w1', 3).delayMs).toBe(180 * 60 * 1000)
    expect(orch.computeQuotaBackoffMs('w1', 4).delayMs).toBe(300 * 60 * 1000)
  })

  it('fallback ladder clamps to 300 minutes past the last rung', async () => {
    const orch = await import('../server/services/agent/orchestrator.js')
    orch.forgetRateLimitInfo('w1')
    expect(orch.computeQuotaBackoffMs('w1', 10).delayMs).toBe(300 * 60 * 1000)
    expect(orch.computeQuotaBackoffMs('w1', 999).delayMs).toBe(300 * 60 * 1000)
  })

  it('picks the furthest-future reset among multiple saturated buckets', async () => {
    const orch = await import('../server/services/agent/orchestrator.js')
    orch._test_setRateLimitInfo('w1', {
      buckets: [
        { id: 'five_hour', usedPct: 100, resetsAt: '2026-04-23T11:00:00Z' },
        { id: 'weekly', usedPct: 100, resetsAt: '2026-04-23T15:00:00Z' },
      ],
    })
    const result = orch.computeQuotaBackoffMs('w1', 0)
    expect(result.resetsAt).toBe('2026-04-23T15:00:00Z')
    expect(result.delayMs).toBe(5 * 60 * 60 * 1000 + 30 * 1000)
  })

  it('ignores unsaturated buckets (usedPct < 95)', async () => {
    const orch = await import('../server/services/agent/orchestrator.js')
    orch._test_setRateLimitInfo('w1', {
      buckets: [
        { id: 'weekly', usedPct: 100, resetsAt: '2026-04-23T15:00:00Z' },
        { id: 'hourly', usedPct: 40, resetsAt: '2026-04-23T11:00:00Z' },
      ],
    })
    const result = orch.computeQuotaBackoffMs('w1', 0)
    expect(result.resetsAt).toBe('2026-04-23T15:00:00Z')
    expect(result.source).toBe('rate_limit_info')
  })

  it('is deleted after forgetRateLimitInfo', async () => {
    const orch = await import('../server/services/agent/orchestrator.js')
    orch._test_setRateLimitInfo('w1', {
      buckets: [{ id: 'x', usedPct: 100, resetsAt: '2026-04-23T10:10:00Z' }],
    })
    orch.forgetRateLimitInfo('w1')
    const result = orch.computeQuotaBackoffMs('w1', 0)
    expect(result.source).toBe('exponential_fallback')
  })
})

describe('handleEvent rate_limit caching', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-23T10:00:00Z'))
  })
  afterEach(() => vi.useRealTimers())

  it('caches rate_limit.info so subsequent computeQuotaBackoffMs can read it', async () => {
    const orch = await import('../server/services/agent/orchestrator.js')
    orch.forgetRateLimitInfo('w1')

    orch.__test__.handleEvent('w1', 'session-1', {
      kind: 'rate_limit',
      info: {
        buckets: [{ id: 'five_hour', usedPct: 100, resetsAt: '2026-04-23T10:30:00Z' }],
      },
    })

    const result = orch.computeQuotaBackoffMs('w1', 0)
    expect(result.source).toBe('rate_limit_info')
    expect(result.resetsAt).toBe('2026-04-23T10:30:00Z')
  })
})

describe('handleQuota ephemeral event payload', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-23T10:00:00Z'))
    vi.clearAllMocks()
  })
  afterEach(() => vi.useRealTimers())

  it('emits agent:quota-backoff with resetsAt and source when rate_limit info is fresh', async () => {
    const orch = await import('../server/services/agent/orchestrator.js')
    const ws = await import('../server/services/websocket-service.js')

    orch._test_setRateLimitInfo('w1', {
      buckets: [{ id: 'five_hour', usedPct: 100, resetsAt: '2026-04-23T10:30:00Z' }],
    })

    orch.__test__.handleQuota('w1')

    expect(ws.emitEphemeral).toHaveBeenCalledWith(
      'w1',
      'agent:quota-backoff',
      expect.objectContaining({
        retryCount: 1,
        backoffMinutes: 31, // 30min + 30s safety → 30.5min rounds up to 31
        resetsAt: '2026-04-23T10:30:00Z',
        source: 'rate_limit_info',
      }),
    )
  })

  it('emits agent:quota-backoff with source=exponential_fallback when no info', async () => {
    const orch = await import('../server/services/agent/orchestrator.js')
    const ws = await import('../server/services/websocket-service.js')

    orch.forgetRateLimitInfo('w2')
    orch.__test__.handleQuota('w2')

    expect(ws.emitEphemeral).toHaveBeenCalledWith(
      'w2',
      'agent:quota-backoff',
      expect.objectContaining({
        retryCount: 1,
        backoffMinutes: 15,
        resetsAt: undefined,
        source: 'exponential_fallback',
      }),
    )
  })
})
