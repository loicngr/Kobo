import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  acquireUpdateMaintenance,
  deferForUpdateMaintenance,
  isUpdateMaintenanceActive,
  releaseUpdateMaintenance,
} from '../server/services/update-maintenance-service.js'

describe('update maintenance admission', () => {
  afterEach(() => {
    releaseUpdateMaintenance('owner')
    vi.useRealTimers()
  })

  it('checks activity and reserves synchronously; rejects a different owner', () => {
    expect(acquireUpdateMaintenance('owner', () => false)).toBe('busy')
    expect(isUpdateMaintenanceActive()).toBe(false)
    expect(acquireUpdateMaintenance('owner', () => true)).toBe('acquired')
    expect(isUpdateMaintenanceActive()).toBe(true)
    expect(acquireUpdateMaintenance('other', () => true)).toBe('conflict')
    expect(releaseUpdateMaintenance('other')).toBe(false)
    expect(isUpdateMaintenanceActive()).toBe(true)
  })

  it('retains scheduled callbacks until explicit release and coalesces repeats', async () => {
    vi.useFakeTimers()
    const fired = vi.fn()
    acquireUpdateMaintenance('owner', () => true)
    expect(deferForUpdateMaintenance('wakeup:one', fired)).toBe(true)
    expect(deferForUpdateMaintenance('wakeup:one', fired)).toBe(true)
    await vi.advanceTimersByTimeAsync(600_000)
    expect(fired).not.toHaveBeenCalled()
    expect(releaseUpdateMaintenance('owner')).toBe(true)
    await vi.runAllTimersAsync()
    expect(fired).toHaveBeenCalledOnce()
    expect(deferForUpdateMaintenance('wakeup:one', fired)).toBe(false)
  })
})
