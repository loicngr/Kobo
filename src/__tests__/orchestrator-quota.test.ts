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

vi.mock('../server/services/usage/poller.js', () => ({
  refreshNow: vi.fn(),
}))

vi.mock('../server/services/quota-backoff-service.js', () => ({
  arm: vi.fn(),
  cancel: vi.fn(),
  restoreOnBoot: vi.fn(),
  getPending: vi.fn(),
  listPending: vi.fn(() => []),
  setOnFireCallback: vi.fn(),
}))

vi.mock('../server/services/auto-loop-service.js', () => ({
  onQuotaBackoffExpired: vi.fn(),
}))

describe('computeQuotaBackoffMs', () => {
  beforeEach(async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-23T10:00:00Z'))
    const { refreshNow } = await import('../server/services/usage/poller.js')
    vi.mocked(refreshNow).mockResolvedValue(null)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('uses resetsAt when a saturated bucket has one', async () => {
    const orch = await import('../server/services/agent/orchestrator.js')
    orch._test_setRateLimitInfo('w1', {
      buckets: [{ id: 'five_hour', usedPct: 100, resetsAt: '2026-04-23T10:10:00Z' }],
    })
    const result = await orch.computeQuotaBackoffMs('w1', 0)
    expect(result.delayMs).toBe(10 * 60 * 1000 + 30 * 1000)
    expect(result.resetsAt).toBe('2026-04-23T10:10:00Z')
    expect(result.source).toBe('rate_limit_info')
  })

  it('falls back to exponential when no info is stored for the workspace', async () => {
    const orch = await import('../server/services/agent/orchestrator.js')
    orch.forgetRateLimitInfo('w1')
    const result = await orch.computeQuotaBackoffMs('w1', 0)
    expect(result.delayMs).toBe(15 * 60 * 1000)
    expect(result.resetsAt).toBeUndefined()
    expect(result.source).toBe('fallback_ladder')
  })

  it('falls back to exponential when resetsAt is in the past', async () => {
    const orch = await import('../server/services/agent/orchestrator.js')
    orch._test_setRateLimitInfo('w1', {
      buckets: [{ id: 'x', usedPct: 100, resetsAt: '2026-04-23T09:55:00Z' }],
    })
    const result = await orch.computeQuotaBackoffMs('w1', 0)
    expect(result.source).toBe('fallback_ladder')
    expect(result.delayMs).toBe(15 * 60 * 1000)
  })

  it('falls back to exponential when resetsAt is > 24h in the future', async () => {
    const orch = await import('../server/services/agent/orchestrator.js')
    orch._test_setRateLimitInfo('w1', {
      buckets: [{ id: 'x', usedPct: 100, resetsAt: '2026-04-25T10:00:00Z' }],
    })
    const result = await orch.computeQuotaBackoffMs('w1', 2)
    expect(result.source).toBe('fallback_ladder')
    expect(result.delayMs).toBe(60 * 60 * 1000)
  })

  it('fallback ladder steps: 15 → 30 → 60 → 180 → 300 minutes', async () => {
    const orch = await import('../server/services/agent/orchestrator.js')
    orch.forgetRateLimitInfo('w1')
    expect((await orch.computeQuotaBackoffMs('w1', 0)).delayMs).toBe(15 * 60 * 1000)
    expect((await orch.computeQuotaBackoffMs('w1', 1)).delayMs).toBe(30 * 60 * 1000)
    expect((await orch.computeQuotaBackoffMs('w1', 2)).delayMs).toBe(60 * 60 * 1000)
    expect((await orch.computeQuotaBackoffMs('w1', 3)).delayMs).toBe(180 * 60 * 1000)
    expect((await orch.computeQuotaBackoffMs('w1', 4)).delayMs).toBe(300 * 60 * 1000)
  })

  it('fallback ladder clamps to 300 minutes past the last rung', async () => {
    const orch = await import('../server/services/agent/orchestrator.js')
    orch.forgetRateLimitInfo('w1')
    expect((await orch.computeQuotaBackoffMs('w1', 10)).delayMs).toBe(300 * 60 * 1000)
    expect((await orch.computeQuotaBackoffMs('w1', 999)).delayMs).toBe(300 * 60 * 1000)
  })

  it('picks the furthest-future reset among multiple saturated buckets', async () => {
    const orch = await import('../server/services/agent/orchestrator.js')
    orch._test_setRateLimitInfo('w1', {
      buckets: [
        { id: 'five_hour', usedPct: 100, resetsAt: '2026-04-23T11:00:00Z' },
        { id: 'weekly', usedPct: 100, resetsAt: '2026-04-23T15:00:00Z' },
      ],
    })
    const result = await orch.computeQuotaBackoffMs('w1', 0)
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
    const result = await orch.computeQuotaBackoffMs('w1', 0)
    expect(result.resetsAt).toBe('2026-04-23T15:00:00Z')
    expect(result.source).toBe('rate_limit_info')
  })

  it('is deleted after forgetRateLimitInfo', async () => {
    const orch = await import('../server/services/agent/orchestrator.js')
    orch._test_setRateLimitInfo('w1', {
      buckets: [{ id: 'x', usedPct: 100, resetsAt: '2026-04-23T10:10:00Z' }],
    })
    orch.forgetRateLimitInfo('w1')
    const result = await orch.computeQuotaBackoffMs('w1', 0)
    expect(result.source).toBe('fallback_ladder')
  })
})

describe('computeQuotaBackoffMs — usage API fallback', () => {
  beforeEach(async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-23T10:00:00Z'))
    vi.clearAllMocks()
    const orch = await import('../server/services/agent/orchestrator.js')
    orch.forgetRateLimitInfo('w1')
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('uses five_hour.resetsAt when bucket is saturated', async () => {
    const fiveHourReset = new Date(Date.now() + 7 * 60_000).toISOString()
    const { refreshNow } = await import('../server/services/usage/poller.js')
    vi.mocked(refreshNow).mockResolvedValue({
      providerId: 'claude-code',
      status: 'ok',
      buckets: [
        { id: 'five_hour', label: '5h', usedPct: 99, resetsAt: fiveHourReset },
        { id: 'seven_day', label: '7d', usedPct: 50, resetsAt: undefined },
      ],
      fetchedAt: new Date().toISOString(),
    })
    const orch = await import('../server/services/agent/orchestrator.js')
    const result = await orch._computeQuotaBackoffMs('w1', 0)
    expect(result.source).toBe('usage_api')
    expect(result.delayMs).toBeGreaterThanOrEqual(7 * 60_000)
    expect(result.resetsAt).toBe(fiveHourReset)
  })

  it('falls back to the ladder when usage API reports a non-saturated bucket', async () => {
    const { refreshNow } = await import('../server/services/usage/poller.js')
    vi.mocked(refreshNow).mockResolvedValue({
      providerId: 'claude-code',
      status: 'ok',
      buckets: [{ id: 'five_hour', label: '5h', usedPct: 50, resetsAt: undefined }],
      fetchedAt: new Date().toISOString(),
    })
    const orch = await import('../server/services/agent/orchestrator.js')
    const result = await orch._computeQuotaBackoffMs('w1', 0)
    expect(result.source).toBe('fallback_ladder')
    expect(result.delayMs).toBe(15 * 60_000)
  })

  it('falls back to the ladder when refreshNow throws', async () => {
    const { refreshNow } = await import('../server/services/usage/poller.js')
    vi.mocked(refreshNow).mockRejectedValue(new Error('network'))
    const orch = await import('../server/services/agent/orchestrator.js')
    const result = await orch._computeQuotaBackoffMs('w1', 0)
    expect(result.source).toBe('fallback_ladder')
    expect(result.delayMs).toBe(15 * 60_000)
  })
})

describe('handleEvent rate_limit caching', () => {
  beforeEach(async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-23T10:00:00Z'))
    const { refreshNow } = await import('../server/services/usage/poller.js')
    vi.mocked(refreshNow).mockResolvedValue(null)
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

    const result = await orch.computeQuotaBackoffMs('w1', 0)
    expect(result.source).toBe('rate_limit_info')
    expect(result.resetsAt).toBe('2026-04-23T10:30:00Z')
  })
})

describe('handleQuota → quotaBackoffService.arm', () => {
  beforeEach(async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-23T10:00:00Z'))
    vi.clearAllMocks()
    const { refreshNow } = await import('../server/services/usage/poller.js')
    vi.mocked(refreshNow).mockResolvedValue(null)
  })
  afterEach(() => vi.useRealTimers())

  it('calls arm() with computed delayMs and meta when rate_limit info is fresh', async () => {
    const orch = await import('../server/services/agent/orchestrator.js')
    const quotaBackoffService = await import('../server/services/quota-backoff-service.js')

    orch._test_setRateLimitInfo('w1', {
      buckets: [{ id: 'five_hour', usedPct: 100, resetsAt: '2026-04-23T10:30:00Z' }],
    })

    await orch._handleQuota('w1')

    expect(vi.mocked(quotaBackoffService.arm)).toHaveBeenCalledOnce()
    const [wsId, delayMs, meta] = vi.mocked(quotaBackoffService.arm).mock.calls[0]
    expect(wsId).toBe('w1')
    // 30 min until reset + 30s safety margin = 30 * 60_000 + 30_000
    expect(delayMs).toBe(30 * 60_000 + 30_000)
    expect(meta.resetsAt).toBe('2026-04-23T10:30:00Z')
    expect(meta.source).toBe('rate_limit_info')
  })

  it('calls arm() with fallback ladder values when no info is available', async () => {
    const orch = await import('../server/services/agent/orchestrator.js')
    const quotaBackoffService = await import('../server/services/quota-backoff-service.js')

    orch.forgetRateLimitInfo('w2')
    await orch._handleQuota('w2')

    expect(vi.mocked(quotaBackoffService.arm)).toHaveBeenCalledOnce()
    const [wsId, delayMs, meta] = vi.mocked(quotaBackoffService.arm).mock.calls[0]
    expect(wsId).toBe('w2')
    expect(delayMs).toBe(15 * 60_000)
    expect(meta.resetsAt).toBeNull()
    expect(meta.source).toBe('fallback_ladder')
  })

  it('calls arm() with usage_api source when usage API reports saturation', async () => {
    const fiveHourReset = new Date(Date.now() + 60_000).toISOString()
    const { refreshNow } = await import('../server/services/usage/poller.js')
    vi.mocked(refreshNow).mockResolvedValue({
      providerId: 'claude-code',
      status: 'ok',
      buckets: [{ id: 'five_hour', label: '5h', usedPct: 99, resetsAt: fiveHourReset }],
      fetchedAt: new Date().toISOString(),
    })
    const orch = await import('../server/services/agent/orchestrator.js')
    const quotaBackoffService = await import('../server/services/quota-backoff-service.js')

    orch.forgetRateLimitInfo('w3')
    await orch._handleQuota('w3')

    expect(vi.mocked(quotaBackoffService.arm)).toHaveBeenCalledOnce()
    const [wsId, delayMs, meta] = vi.mocked(quotaBackoffService.arm).mock.calls[0]
    expect(wsId).toBe('w3')
    expect(delayMs).toBeGreaterThan(0)
    expect(meta.source).toBe('usage_api')
    expect(meta.resetsAt).toBe(fiveHourReset)
  })
})

describe('restoreRetryCountsFromDb', () => {
  beforeEach(() => vi.clearAllMocks())

  it('rebuilds retry counts from quotaBackoffService.listPending()', async () => {
    const quotaBackoffService = await import('../server/services/quota-backoff-service.js')
    vi.mocked(quotaBackoffService.listPending).mockReturnValue([
      {
        workspaceId: 'w1',
        targetAt: new Date().toISOString(),
        resetsAt: null,
        source: 'fallback_ladder',
        retryCount: 3,
        createdAt: new Date().toISOString(),
      },
      {
        workspaceId: 'w2',
        targetAt: new Date().toISOString(),
        resetsAt: null,
        source: 'rate_limit_info',
        retryCount: 1,
        createdAt: new Date().toISOString(),
      },
    ])

    const orch = await import('../server/services/agent/orchestrator.js')
    orch.restoreRetryCountsFromDb()

    const counts = orch._getRetryCounts()
    expect(counts.get('w1')).toBe(3)
    expect(counts.get('w2')).toBe(1)
  })
})
