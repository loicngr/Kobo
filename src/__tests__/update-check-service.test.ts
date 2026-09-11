import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../server/services/websocket-service.js', () => ({ broadcastAll: vi.fn() }))

import changelog from '../server/routes/changelog.js'
import {
  _clearLatestVersionCache,
  refreshUpdateCheck,
  startUpdateChecker,
  stopUpdateChecker,
  UPDATE_CHECK_INTERVAL_MS,
} from '../server/services/update-check-service.js'
import { broadcastAll } from '../server/services/websocket-service.js'

const response = (version: unknown) => ({ ok: true, json: async () => ({ version }) }) as Response

describe('update checker', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-11'))
    _clearLatestVersionCache()
    vi.clearAllMocks()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response('99.0.0')))
  })
  afterEach(() => {
    _clearLatestVersionCache()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('checks immediately and every twenty minutes with idempotent start/stop', async () => {
    startUpdateChecker()
    startUpdateChecker()
    await vi.advanceTimersByTimeAsync(0)
    expect(fetch).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS - 1)
    expect(fetch).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(fetch).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS)
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(broadcastAll).toHaveBeenLastCalledWith(
      'kobo:update-checked',
      expect.objectContaining({ latestVersion: '99.0.0', checkStatus: 'success' }),
    )
    stopUpdateChecker()
    stopUpdateChecker()
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS)
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('performs one overdue check after sleep instead of replaying missed intervals', async () => {
    startUpdateChecker()
    await vi.advanceTimersByTimeAsync(0)
    vi.setSystemTime(Date.now() + 10 * UPDATE_CHECK_INTERVAL_MS)
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('schedules from the shared last attempt when an HTTP lookup wins a delayed tick', async () => {
    startUpdateChecker()
    await vi.advanceTimersByTimeAsync(0)
    vi.setSystemTime(Date.now() + UPDATE_CHECK_INTERVAL_MS + 1000)
    await refreshUpdateCheck()
    expect(fetch).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS)
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('rejects HTTP errors and invalid response bodies without retrying per load', async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: false } as Response)
    expect(await refreshUpdateCheck()).toMatchObject({ latestVersion: null, checkStatus: 'failed' })
    await refreshUpdateCheck()
    expect(fetch).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS)
    vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => null } as Response)
    expect(await refreshUpdateCheck()).toMatchObject({ latestVersion: null, checkStatus: 'failed' })
  })

  it('shares an in-flight registry lookup with the changelog route', async () => {
    let resolve!: (response: Response) => void
    vi.mocked(fetch).mockReturnValue(
      new Promise((done) => {
        resolve = done
      }),
    )
    startUpdateChecker()
    const route = new Hono().route('/api/changelog', changelog).request('/api/changelog')
    await vi.advanceTimersByTimeAsync(0)
    expect(fetch).toHaveBeenCalledTimes(1)
    resolve(response('99.0.0'))
    expect(await (await route).json()).toMatchObject({ latestVersion: '99.0.0' })
  })

  it('caches failures for twenty minutes and preserves the last successful version', async () => {
    const success = await refreshUpdateCheck()
    vi.mocked(fetch).mockRejectedValue(new Error('offline'))
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS)
    const failed = await refreshUpdateCheck()
    expect(failed).toMatchObject({
      latestVersion: '99.0.0',
      checkStatus: 'failed',
      lastSuccessAt: success.lastSuccessAt,
    })
    await refreshUpdateCheck()
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it.each(['bad', '1.2', '1.2.3-beta', '01.2.3', null, {}])('rejects invalid latest releases: %j', async (version) => {
    vi.mocked(fetch).mockResolvedValue(response(version))
    expect(await refreshUpdateCheck()).toMatchObject({ latestVersion: null, checkStatus: 'failed' })
  })

  it('aborts after five seconds, even if a fetch implementation never settles', async () => {
    vi.mocked(fetch).mockReturnValue(new Promise(() => {}))
    const lookup = refreshUpdateCheck()
    await vi.advanceTimersByTimeAsync(5000)
    expect(await lookup).toMatchObject({ checkStatus: 'failed' })
    expect(vi.mocked(fetch).mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
  })

  it('aborts on stop and suppresses late results and broadcasts', async () => {
    let resolve!: (response: Response) => void
    vi.mocked(fetch).mockReturnValue(
      new Promise((done) => {
        resolve = done
      }),
    )
    startUpdateChecker()
    stopUpdateChecker()
    resolve(response('99.0.0'))
    await vi.advanceTimersByTimeAsync(0)
    expect(broadcastAll).not.toHaveBeenCalled()
    expect(vi.mocked(fetch).mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
  })
})
