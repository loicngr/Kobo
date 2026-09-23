import { flushPromises, shallowMount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { createI18n } from 'vue-i18n'
import ActivityDigest from '../components/ActivityDigest.vue'
import en from '../i18n/en'
import { useActivityStore } from '../stores/activity'
import { useSettingsStore } from '../stores/settings'
import { apiFetch } from '../utils/api'

vi.mock('../utils/api', () => ({ apiFetch: vi.fn() }))
vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn() }) }))
let wrapper: VueWrapper | undefined
beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  vi.mocked(apiFetch).mockReset().mockResolvedValue({ cursor: 4 })
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  vi.useRealTimers()
  vi.restoreAllMocks()
})
function mountDigest() {
  wrapper = shallowMount(ActivityDigest, {
    global: { plugins: [createI18n({ legacy: false, locale: 'en', messages: { en } })] },
  })
  return wrapper
}

it('hides the digest and performs no tracking when disabled, including visibility and online events', async () => {
  const settings = useSettingsStore()
  settings.loaded = true
  settings.global.activityDigestEnabled = false
  const view = mountDigest()
  document.dispatchEvent(new Event('visibilitychange'))
  window.dispatchEvent(new Event('online'))
  await vi.advanceTimersByTimeAsync(30_000)
  expect(view.find('.activity-entry').exists()).toBe(false)
  expect(apiFetch).not.toHaveBeenCalled()
  expect(localStorage.getItem('kobo:activityVisit')).toBeNull()
})

it('waits for saved settings before starting the visit tracker', async () => {
  const settings = useSettingsStore()
  const view = mountDigest()
  await flushPromises()
  expect(apiFetch).not.toHaveBeenCalled()
  expect(view.find('.activity-entry').exists()).toBe(false)
  settings.loaded = true
  await flushPromises()
  expect(view.find('.activity-entry').exists()).toBe(true)
  expect(apiFetch).toHaveBeenCalledWith('/api/activity?head=1')
})

it('stops the timer and ignores late requests on disable, then recovers unread events on re-enable', async () => {
  const settings = useSettingsStore()
  settings.loaded = true
  settings.global.activityDigestEnabled = true
  const view = mountDigest()
  await flushPromises()
  let finish!: (value: unknown) => void
  vi.mocked(apiFetch).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  await vi.advanceTimersByTimeAsync(15_000)
  settings.global.activityDigestEnabled = false
  await nextTick()
  finish({ cursor: 9 })
  await flushPromises()
  expect(useActivityStore().cursor).toBe(4)
  expect(view.find('.activity-entry').exists()).toBe(false)
  expect(vi.getTimerCount()).toBe(0)
  vi.mocked(apiFetch).mockResolvedValueOnce({
    items: [
      {
        id: 9,
        workspaceId: 'w',
        workspaceName: 'Mission',
        kind: 'error',
        sessionId: null,
        createdAt: new Date().toISOString(),
      },
    ],
    nextCursor: 9,
    cursor: 9,
    hasMore: false,
  })
  settings.global.activityDigestEnabled = true
  await flushPromises()
  expect(view.find('.activity-entry').exists()).toBe(true)
  expect(apiFetch).toHaveBeenLastCalledWith('/api/activity?after=4')
  expect(useActivityStore().items).toHaveLength(1)
  expect(vi.getTimerCount()).toBe(1)
  view.unmount()
  wrapper = undefined
  expect(vi.getTimerCount()).toBe(0)
})
