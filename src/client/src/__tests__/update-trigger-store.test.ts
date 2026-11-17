import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UpdateTriggerState } from '../../../shared/update-trigger'
import { useUpdateStore } from '../stores/update'
import { useUpdateTriggerStore } from '../stores/update-trigger'

const apiFetch = vi.hoisted(() => vi.fn())
const apiFetchResponse = vi.hoisted(() => vi.fn(async () => ({ ok: false }) as { ok: boolean; json?: () => unknown }))
vi.mock('src/utils/api', () => ({ apiFetch, apiFetchResponse }))

const KEY = 'kobo:update-request'
const base: UpdateTriggerState = {
  available: true,
  pending: false,
  inProgress: false,
  status: null,
  runningAgents: 0,
  busy: false,
  allowSkipBackup: true,
  allowStopAgents: true,
}
const at = '2026-11-17T10:00:00.000Z'
const restarting = { ...base, inProgress: true, status: { id: 'req-1', phase: 'restarting', updatedAt: at } } as const
const stored = () => JSON.parse(sessionStorage.getItem(KEY) ?? 'null')

function fresh() {
  setActivePinia(createPinia())
  const update = useUpdateStore()
  update.currentVersion = '1.0.0'
  update.latestVersion = '1.1.0'
  return { update, trigger: useUpdateTriggerStore() }
}

/** Serve GET responses in order; POST answers { id }. */
function serve(...states: Array<UpdateTriggerState | Error>) {
  apiFetch.mockImplementation(async (_path: string, options?: { method?: string }) => {
    if (options?.method === 'POST') return { id: 'req-1' }
    const next = states.length > 1 ? states.shift() : states[0]
    if (next instanceof Error) throw next
    return next
  })
}

async function started(...states: Array<UpdateTriggerState | Error>) {
  const ctx = fresh()
  serve(base, ...states)
  await ctx.trigger.refresh()
  await ctx.trigger.start({ skipBackup: false, stopAgents: false })
  return ctx
}

describe('update trigger store', () => {
  beforeEach(() => {
    sessionStorage.clear()
    apiFetch.mockReset()
    apiFetchResponse.mockReset()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('is idle without a request', async () => {
    const { trigger } = fresh()
    serve(base)
    await trigger.refresh()
    expect(trigger.step).toBe('idle')
    expect(trigger.state?.available).toBe(true)
  })

  it('maps the pending flag and each in-progress phase to a step', async () => {
    const { trigger } = await started({ ...base, pending: true })
    expect(trigger.step).toBe('waiting')
    for (const [phase, step] of [
      ['accepted', 'waiting'],
      ['building', 'building'],
      ['stopping-agents', 'stopping-agents'],
      ['restarting', 'restarting'],
    ] as const) {
      serve({ ...base, inProgress: true, status: { id: 'req-1', phase, updatedAt: at } })
      await trigger.refresh()
      expect(trigger.step).toBe(step)
    }
  })

  it('is reconnecting while requests fail during our update, and recovers afterwards', async () => {
    const { trigger } = await started(restarting)
    expect(trigger.step).toBe('restarting')
    serve(new Error('Failed to fetch'))
    await trigger.refresh()
    expect(trigger.step).toBe('reconnecting')
    expect(trigger.requestId).toBe('req-1')
    expect(stored().id).toBe('req-1')
    serve({ ...base, status: { id: 'req-1', phase: 'complete', updatedAt: at } })
    await trigger.refresh()
    expect(trigger.step).toBe('result')
  })

  it('stays idle when a refresh fails without any request of ours', async () => {
    const { trigger } = fresh()
    serve(new Error('Failed to fetch'))
    await trigger.refresh()
    expect(trigger.step).toBe('idle')
  })

  it('keeps the phase step of a non-terminal own status whatever the version', async () => {
    const { trigger, update } = await started(restarting)
    update.currentVersion = '1.1.0'
    expect(trigger.step).toBe('restarting')
  })

  it('never shows done from an unknown version at the click', async () => {
    const { trigger, update } = fresh()
    update.currentVersion = null
    serve(base)
    await trigger.refresh()
    await trigger.start({ skipBackup: false, stopAgents: false })
    expect(stored().version).toBeNull()
    update.currentVersion = '1.1.0'
    expect(trigger.step).not.toBe('done')
  })

  it('is not-started when a request that was never seen in progress is unknown to the server', async () => {
    const { trigger } = await started(base)
    expect(trigger.step).toBe('not-started')
    serve({ ...base, status: { id: 'other', phase: 'complete', updatedAt: at } })
    await trigger.refresh()
    expect(trigger.step).toBe('not-started')
  })

  it('exposes a terminal status with our id as the result', async () => {
    const { trigger } = await started({
      ...base,
      status: { id: 'req-1', phase: 'refused', reason: 'busy', updatedAt: at },
    })
    expect(trigger.step).toBe('result')
    expect(trigger.message).toEqual({ key: 'updateTrigger.reason.busy' })
  })

  it('shows complete without a version while the running version is not known to have changed', async () => {
    const { trigger, update } = await started({ ...base, status: { id: 'req-1', phase: 'complete', updatedAt: at } })
    expect(trigger.step).toBe('result')
    expect(trigger.message).toEqual({ key: 'updateTrigger.result.completeNoVersion' })
    update.currentVersion = '1.1.0'
    expect(trigger.step).toBe('done')
    expect(trigger.message).toEqual({ key: 'updateTrigger.result.complete', params: { version: '1.1.0' } })
  })

  it('does not assign a complete status before the version snapshot was refreshed', async () => {
    const { trigger, update } = await started({ ...base, pending: true })
    let release: () => void = () => {}
    vi.spyOn(update, 'refreshSnapshot').mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = () => {
            update.currentVersion = '1.1.0'
            resolve()
          }
        }),
    )
    serve({ ...base, status: { id: 'req-1', phase: 'complete', updatedAt: at } })
    const pending = trigger.refresh()
    await Promise.resolve()
    await Promise.resolve()
    expect(trigger.step).toBe('waiting')
    release()
    await pending
    expect(trigger.step).toBe('done')
  })

  it('discards a slow response that resolves after a newer one', async () => {
    const { trigger } = fresh()
    let releaseSlow: (value: UpdateTriggerState) => void = () => {}
    apiFetch.mockImplementationOnce(() => new Promise((resolve) => (releaseSlow = resolve)))
    const slow = trigger.refresh()
    apiFetch.mockImplementationOnce(async () => ({ ...base, runningAgents: 3 }))
    await trigger.refresh()
    releaseSlow({ ...base, runningAgents: 1 })
    await slow
    expect(trigger.state?.runningAgents).toBe(3)
  })

  it('is waiting, never not-started, while the refresh after the click is still open', async () => {
    const { trigger } = fresh()
    serve(base)
    await trigger.refresh()
    let release: (value: UpdateTriggerState) => void = () => {}
    apiFetch.mockImplementation(async (_path: string, options?: { method?: string }) => {
      if (options?.method === 'POST') return { id: 'req-1' }
      return new Promise((resolve) => (release = resolve))
    })
    const starting = trigger.start({ skipBackup: false, stopAgents: false })
    // One macrotask: start has reached the held status request (after the version snapshot).
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(apiFetch).toHaveBeenCalledTimes(3)
    expect(trigger.step).toBe('waiting')
    release({ ...base, pending: true })
    await starting
    expect(trigger.step).toBe('waiting')
  })

  it('stores id, version and sightings as one JSON value, and a new instance reads it back', async () => {
    const { trigger } = await started(restarting)
    expect(apiFetch).toHaveBeenCalledWith('/api/maintenance/update-trigger', {
      method: 'POST',
      body: { skipBackup: false, stopAgents: false },
    })
    expect(stored()).toMatchObject({ id: 'req-1', version: '1.0.0' })
    expect(typeof stored().seenAt).toBe('number')
    expect(trigger.requestId).toBe('req-1')
    setActivePinia(createPinia())
    const update = useUpdateStore()
    update.currentVersion = '1.1.0'
    const reloaded = useUpdateTriggerStore()
    expect(reloaded.requestId).toBe('req-1')
    reloaded.state = base
    expect(reloaded.step).toBe('reconnecting')
  })

  it('does not keep a request when the server refuses it', async () => {
    const { trigger } = fresh()
    apiFetch.mockRejectedValue(Object.assign(new Error('Kōbō is busy'), { code: 'busy' }))
    await expect(trigger.start({ skipBackup: false, stopAgents: false })).rejects.toThrow('busy')
    expect(trigger.requestId).toBeNull()
    expect(sessionStorage.getItem(KEY)).toBeNull()
  })

  it('forgets the request on dismiss', async () => {
    const { trigger } = await started(base)
    trigger.dismiss()
    expect(trigger.requestId).toBeNull()
    expect(trigger.step).toBe('idle')
    expect(sessionStorage.getItem(KEY)).toBeNull()
  })

  it('works when sessionStorage throws', async () => {
    const boom = () => {
      throw new Error('denied')
    }
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(boom)
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(boom)
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(boom)
    const { trigger } = await started({ ...base, pending: true })
    expect(trigger.step).toBe('waiting')
    trigger.dismiss()
    expect(trigger.requestId).toBeNull()
  })

  it('is lost, not an endless loader, when our non-terminal status is no longer in progress', async () => {
    const { trigger } = await started({ ...base, status: { id: 'req-1', phase: 'building', updatedAt: at } })
    expect(trigger.step).toBe('lost')
    expect(trigger.finished).toBe(true)
    expect(trigger.message).toEqual({ key: 'updateTrigger.result.lost' })
  })

  it('keeps reconnecting, then shows the adopted aborted result after a restart that rolled back', async () => {
    const { trigger } = await started(restarting)
    serve(new Error('Failed to fetch'))
    await trigger.refresh()
    expect(trigger.step).toBe('reconnecting')
    serve(base)
    await trigger.refresh()
    expect(trigger.step).toBe('reconnecting')
    expect(trigger.finished).toBe(false)
    serve({ ...base, status: { id: 'req-1', phase: 'aborted', updatedAt: at } })
    await trigger.refresh()
    expect(trigger.step).toBe('result')
  })

  it('turns an unknown request into lost five minutes after the last sighting', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(at))
    const { trigger } = await started(restarting)
    serve(base)
    vi.setSystemTime(new Date(Date.parse(at) + 4 * 60_000))
    await trigger.refresh()
    expect(trigger.step).toBe('reconnecting')
    vi.setSystemTime(new Date(Date.parse(at) + 5 * 60_000 + 1000))
    await trigger.refresh()
    expect(trigger.step).toBe('lost')
  })

  it('does not attribute another update to us', async () => {
    const { trigger } = fresh()
    serve({ ...base, inProgress: true, status: { id: 'someone-else', phase: 'building', updatedAt: at } })
    await trigger.refresh()
    expect(trigger.step).toBe('other')
    expect(trigger.finished).toBe(false)
    await trigger.start({ skipBackup: false, stopAgents: false })
    serve({ ...base, inProgress: true, status: { id: 'someone-else', phase: 'building', updatedAt: at } })
    await trigger.refresh()
    expect(trigger.step).toBe('other')
    expect(stored().seenAt).toBeNull()
  })

  describe('a changed version does not hide a failed update', () => {
    it.each([
      ['recovery-required', 'updateTrigger.result.recoveryRequired'],
      ['aborted', 'updateTrigger.result.aborted'],
    ] as const)('shows %s even though the new version runs', async (phase, key) => {
      const { trigger, update } = await started({ ...base, status: { id: 'req-1', phase, updatedAt: at } })
      update.currentVersion = '1.1.0'
      expect(trigger.step).toBe('result')
      expect(trigger.message).toEqual({ key })
    })

    it('is done for complete, or without status once the grace after the click is over', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date(at))
      const { trigger, update } = await started({ ...base, status: { id: 'req-1', phase: 'complete', updatedAt: at } })
      update.currentVersion = '1.1.0'
      expect(trigger.step).toBe('done')
      serve(base)
      vi.setSystemTime(new Date(Date.parse(at) + 6 * 60_000))
      await trigger.refresh()
      expect(trigger.step).toBe('done')
    })
  })

  describe('success without a final report', () => {
    const minutes = (n: number) => new Date(Date.parse(at) + n * 60_000)

    it('waits for the report for 5 minutes, then announces done, and a later report still replaces it', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date(at))
      const { trigger, update } = await started(restarting)
      update.currentVersion = '1.1.0'
      serve(base)
      vi.setSystemTime(minutes(1))
      await trigger.refresh()
      expect(trigger.step).toBe('reconnecting')
      expect(trigger.finished).toBe(false)
      vi.setSystemTime(minutes(6))
      await trigger.refresh()
      expect(trigger.step).toBe('done')
      serve({ ...base, status: { id: 'req-1', phase: 'recovery-required', updatedAt: at } })
      await trigger.refresh()
      expect(trigger.step).toBe('result')
      expect(trigger.message).toEqual({ key: 'updateTrigger.result.recoveryRequired' })
    })

    describe('after a run of failed refreshes longer than the grace', () => {
      async function afterLongDrop() {
        vi.useFakeTimers()
        vi.setSystemTime(new Date(at))
        const ctx = await started(restarting)
        serve(new Error('Failed to fetch'))
        for (const t of [1, 7]) {
          vi.setSystemTime(minutes(t))
          await ctx.trigger.refresh()
        }
        ctx.update.currentVersion = '1.1.0'
        serve(base)
        await ctx.trigger.refresh()
        return ctx
      }

      it('gives the final report the whole grace again before announcing done', async () => {
        const { trigger } = await afterLongDrop()
        expect(trigger.step).toBe('reconnecting')
        expect(stored().seenAt).toBe(minutes(7).getTime())
        vi.setSystemTime(new Date(minutes(12).getTime() + 1000))
        await trigger.refresh()
        expect(trigger.step).toBe('done')
      })

      it('shows a recovery-required report adopted during that grace', async () => {
        const { trigger } = await afterLongDrop()
        vi.setSystemTime(minutes(9))
        serve({ ...base, status: { id: 'req-1', phase: 'recovery-required', updatedAt: at } })
        await trigger.refresh()
        expect(trigger.step).toBe('result')
        expect(trigger.message).toEqual({ key: 'updateTrigger.result.recoveryRequired' })
      })
    })

    it('captures the running version from a fresh snapshot, so a stale tab never announces an update that did not run', async () => {
      const { trigger, update } = fresh()
      apiFetchResponse.mockImplementation(async () => ({ ok: true, json: () => ({ currentVersion: '1.1.0' }) }))
      serve(base)
      await trigger.start({ skipBackup: false, stopAgents: false })
      expect(update.currentVersion).toBe('1.1.0')
      expect(stored().version).toBe('1.1.0')
      expect(trigger.step).toBe('not-started')
    })

    it('waits 5 minutes after the click before announcing done for a request never seen in progress', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date(at))
      const { trigger, update } = await started(base)
      expect(stored().clickedAt).toBe(Date.parse(at))
      update.currentVersion = '1.1.0'
      vi.setSystemTime(minutes(4))
      await trigger.refresh()
      expect(trigger.step).toBe('reconnecting')
      expect(trigger.finished).toBe(false)
      vi.setSystemTime(new Date(minutes(5).getTime() + 1000))
      await trigger.refresh()
      expect(trigger.step).toBe('done')
    })

    it('shows not-started at once for a request never seen in progress when the version did not change', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date(at))
      const { trigger } = await started(base)
      expect(trigger.step).toBe('not-started')
    })
  })

  describe('a pending request after our click window belongs to someone else', () => {
    const seconds = (n: number) => new Date(Date.parse(at) + n * 1000)

    it.each([
      ['not-started', base],
      ['lost', { ...base, status: { id: 'req-1', phase: 'building', updatedAt: at } }],
    ] as const)('keeps %s and its Close button when another tab clicks', async (step, unknown) => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date(at))
      const { trigger } = await started(unknown)
      expect(trigger.step).toBe(step)
      vi.setSystemTime(seconds(191))
      serve({ ...unknown, pending: true })
      await trigger.refresh()
      expect(trigger.step).toBe(step)
      expect(trigger.finished).toBe(true)
    })

    it('still treats a pending request within 190 seconds of the click as ours', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date(at))
      const { trigger } = await started(base)
      vi.setSystemTime(seconds(189))
      serve({ ...base, pending: true })
      await trigger.refresh()
      expect(trigger.step).toBe('waiting')
    })
  })

  it('reads a stored request of the previous shape, without click time, as clicked long ago', () => {
    sessionStorage.setItem(KEY, JSON.stringify({ id: 'req-1', version: '1.0.0', seenAt: null, failingSince: null }))
    const { trigger, update } = fresh()
    update.currentVersion = '1.1.0'
    trigger.state = base
    expect(trigger.step).toBe('done')
    trigger.state = { ...base, pending: true }
    expect(trigger.step).toBe('done')
  })

  describe('lost and not-started are sticky', () => {
    it('does not bring reconnecting back on a failed refresh', async () => {
      const { trigger } = await started({ ...base, status: { id: 'req-1', phase: 'building', updatedAt: at } })
      expect(trigger.step).toBe('lost')
      serve(new Error('500'))
      await trigger.refresh()
      expect(trigger.step).toBe('lost')
      serve({ ...base, status: { id: 'req-1', phase: 'building', updatedAt: at } })
      await trigger.refresh()
      expect(trigger.step).toBe('lost')
    })

    it('does the same for not-started', async () => {
      const { trigger } = await started(base)
      expect(trigger.step).toBe('not-started')
      serve(new Error('500'))
      await trigger.refresh()
      expect(trigger.step).toBe('not-started')
    })
  })

  describe('failing status requests', () => {
    const minutes = (n: number) => new Date(Date.parse(at) + n * 60_000)

    async function failingRun(...times: number[]) {
      vi.useFakeTimers()
      vi.setSystemTime(new Date(at))
      const ctx = await started(restarting)
      serve(new Error('404'))
      for (const t of times) {
        vi.setSystemTime(minutes(t))
        await ctx.trigger.refresh()
      }
      return ctx
    }

    it('keeps reconnecting for 9 minutes of failures and is lost after 11', async () => {
      const { trigger } = await failingRun(0, 9)
      expect(trigger.step).toBe('reconnecting')
      vi.setSystemTime(minutes(11))
      await trigger.refresh()
      expect(trigger.step).toBe('lost')
      expect(trigger.finished).toBe(true)
    })

    it('restarts the run after a success in between', async () => {
      const { trigger } = await failingRun(1, 9)
      serve(restarting)
      vi.setSystemTime(minutes(10))
      await trigger.refresh()
      serve(new Error('404'))
      vi.setSystemTime(minutes(11))
      await trigger.refresh()
      vi.setSystemTime(minutes(19))
      await trigger.refresh()
      expect(trigger.step).toBe('reconnecting')
    })

    it('persists the start of the run with the request', async () => {
      await failingRun(1)
      expect(stored().failingSince).toBe(minutes(1).getTime())
    })

    it('still ends in not-started for a request never seen in progress, after a failed refresh', async () => {
      const { trigger } = await started({ ...base, pending: true })
      serve(new Error('500'))
      await trigger.refresh()
      expect(trigger.step).toBe('reconnecting')
      serve(base)
      await trigger.refresh()
      expect(trigger.step).toBe('not-started')
    })
  })

  describe('version snapshot', () => {
    it('is fetched at the click and only when the version decides the step', async () => {
      const { trigger } = await started(
        { ...base, pending: true },
        { ...base, inProgress: true, status: { id: 'req-1', phase: 'building', updatedAt: at } },
        restarting,
      )
      expect(apiFetchResponse).toHaveBeenCalledTimes(1) // start()
      await trigger.refresh() // building
      await trigger.refresh() // restarting
      serve(new Error('Failed to fetch'))
      await trigger.refresh()
      expect(apiFetchResponse).toHaveBeenCalledTimes(1)
      serve({ ...base, status: { id: 'req-1', phase: 'complete', updatedAt: at } })
      await trigger.refresh()
      expect(apiFetchResponse).toHaveBeenCalledTimes(2)
      expect(trigger.step).toBe('result')
    })

    it('is fetched when the server no longer knows the request', async () => {
      const { trigger } = await started(restarting)
      const before = apiFetchResponse.mock.calls.length
      serve(base)
      await trigger.refresh()
      expect(apiFetchResponse).toHaveBeenCalledTimes(before + 1)
    })
  })

  describe('a status request already in flight at the click', () => {
    const foreign = { ...base, inProgress: true, status: { id: 'someone', phase: 'building', updatedAt: at } } as const

    it.each([
      ['the pre-click state', base],
      ['an update that is not ours', foreign],
    ] as const)('never replaces the optimistic waiting state with %s', async (_label, preClick) => {
      const { trigger } = fresh()
      let releaseOld: (value: UpdateTriggerState) => void = () => {}
      apiFetch.mockImplementationOnce(() => new Promise((resolve) => (releaseOld = resolve)))
      const old = trigger.refresh()
      let releaseSnapshot: (value: { ok: boolean }) => void = () => {}
      apiFetchResponse.mockImplementationOnce(() => new Promise((resolve) => (releaseSnapshot = resolve)))
      let releaseGet: (value: UpdateTriggerState) => void = () => {}
      apiFetch.mockImplementation(async (_path: string, options?: { method?: string }) =>
        options?.method === 'POST' ? { id: 'req-1' } : new Promise((resolve) => (releaseGet = resolve)),
      )
      const starting = trigger.start({ skipBackup: false, stopAgents: false })
      await new Promise((resolve) => setTimeout(resolve, 0))
      releaseOld(preClick)
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(trigger.step).toBe('waiting')
      releaseSnapshot({ ok: false })
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(trigger.step).toBe('waiting')
      releaseGet({ ...base, pending: true })
      await Promise.all([old, starting])
      expect(trigger.step).toBe('waiting')
    })
  })

  describe('polling chains', () => {
    it('leaves exactly one chain after stop then start during a held refresh', async () => {
      vi.useFakeTimers()
      const { trigger } = fresh()
      let release: (value: UpdateTriggerState) => void = () => {}
      apiFetch.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)))
      apiFetch.mockImplementation(async () => base)
      trigger.startPolling()
      trigger.stopPolling()
      trigger.startPolling()
      release(base)
      await vi.advanceTimersByTimeAsync(20_000)
      expect(apiFetch).toHaveBeenCalledTimes(5)
      trigger.stopPolling()
    })
  })

  describe('polling', () => {
    it('polls every 5 seconds until stopped, but not while the page is hidden', async () => {
      vi.useFakeTimers()
      const { trigger } = fresh()
      serve(base)
      trigger.startPolling()
      await vi.advanceTimersByTimeAsync(0)
      expect(apiFetch).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(5000)
      expect(apiFetch).toHaveBeenCalledTimes(2)
      Object.defineProperty(document, 'hidden', { configurable: true, value: true })
      await vi.advanceTimersByTimeAsync(10000)
      expect(apiFetch).toHaveBeenCalledTimes(2)
      Object.defineProperty(document, 'hidden', { configurable: true, value: false })
      document.dispatchEvent(new Event('visibilitychange'))
      await vi.advanceTimersByTimeAsync(0)
      expect(apiFetch).toHaveBeenCalledTimes(3)
      trigger.stopPolling()
      await vi.advanceTimersByTimeAsync(20000)
      expect(apiFetch).toHaveBeenCalledTimes(3)
    })

    it('polls every 30 seconds while the updater is unavailable and nothing of ours is tracked', async () => {
      vi.useFakeTimers()
      const { trigger } = fresh()
      serve({ ...base, available: false })
      trigger.startPolling()
      await vi.advanceTimersByTimeAsync(0)
      expect(apiFetch).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(29_000)
      expect(apiFetch).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1000)
      expect(apiFetch).toHaveBeenCalledTimes(2)
      trigger.stopPolling()
    })

    it('skips a tick while a refresh is still in flight', async () => {
      vi.useFakeTimers()
      const { trigger } = fresh()
      apiFetch.mockImplementation(() => new Promise(() => {}))
      trigger.startPolling()
      await vi.advanceTimersByTimeAsync(20_000)
      expect(apiFetch).toHaveBeenCalledTimes(1)
      trigger.stopPolling()
    })

    it('leaves no timer after startPolling twice and stopPolling once', async () => {
      vi.useFakeTimers()
      const { trigger } = fresh()
      serve(base)
      trigger.startPolling()
      trigger.startPolling()
      trigger.stopPolling()
      await vi.advanceTimersByTimeAsync(0)
      apiFetch.mockClear()
      await vi.advanceTimersByTimeAsync(60_000)
      expect(apiFetch).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    })
  })
})
