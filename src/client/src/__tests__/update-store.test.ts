import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useUpdateStore } from '../stores/update'

const snapshot = (latestVersion: string | null, extra = {}) => ({ currentVersion: '1.9.0', latestVersion, ...extra })

describe('update availability', () => {
  beforeEach(() => {
    localStorage.clear()
    setActivePinia(createPinia())
  })

  it('shows a new stable version without a reload and compares numeric components', () => {
    const store = useUpdateStore()
    store.applySnapshot(snapshot('1.9.0'))
    expect(store.availableVersion).toBeNull()
    store.applySnapshot(snapshot('1.10.0'))
    expect(store.availableVersion).toBe('1.10.0')
  })

  it.each(['1.9.0', '1.8.99', 'bad', '99.0', '99.0.0-beta', '099.0.0'])(
    'ignores older or invalid releases: %s',
    (version) => {
      const store = useUpdateStore()
      store.applySnapshot(snapshot(version))
      expect(store.availableVersion).toBeNull()
    },
  )

  it('keeps a dismissal across polls and reloads, but shows the next version', () => {
    let store = useUpdateStore()
    store.applySnapshot(snapshot('1.10.0'))
    store.dismissUpdate()
    store.applySnapshot(snapshot('1.10.0'))
    expect(store.availableVersion).toBeNull()
    setActivePinia(createPinia())
    store = useUpdateStore()
    store.applySnapshot(snapshot('1.10.0'))
    expect(store.availableVersion).toBeNull()
    store.applySnapshot(snapshot('1.11.0'))
    expect(store.availableVersion).toBe('1.11.0')
  })

  it('preserves known availability across failures and clears an obsolete banner after success', () => {
    const store = useUpdateStore()
    store.applySnapshot(snapshot('1.10.0'))
    store.applySnapshot(snapshot(null, { checkStatus: 'failed' }))
    expect(store.availableVersion).toBe('1.10.0')
    store.applySnapshot(snapshot('1.9.0', { checkStatus: 'success' }))
    expect(store.availableVersion).toBeNull()
  })

  it('does not let a stale reconnect response overwrite a newer broadcast', () => {
    const store = useUpdateStore()
    store.applySnapshot(snapshot('1.11.0', { lastAttemptAt: '2026-09-11T10:20:00Z' }))
    store.applySnapshot(snapshot('1.10.0', { lastAttemptAt: '2026-09-11T10:00:00Z' }))
    expect(store.availableVersion).toBe('1.11.0')
  })

  it('fetches the cached snapshot on reconnect and coalesces simultaneous loads', async () => {
    const store = useUpdateStore()
    const fetchMock = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue({ ok: true, json: async () => snapshot('1.10.0') } as Response)
    await Promise.all([store.refreshSnapshot(), store.refreshSnapshot()])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(store.availableVersion).toBe('1.10.0')
    fetchMock.mockRestore()
  })
})
