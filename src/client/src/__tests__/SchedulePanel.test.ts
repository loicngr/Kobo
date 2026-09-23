import { flushPromises, shallowMount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from 'vue-i18n'
import SchedulePanel from '../components/SchedulePanel.vue'
import en from '../i18n/en'
import { useWorkspaceStore } from '../stores/workspace'

const { api } = vi.hoisted(() => ({ api: vi.fn() }))
vi.mock('../utils/api', () => ({ apiFetch: api }))
vi.mock('quasar', () => ({ useQuasar: () => ({ notify: vi.fn() }) }))
describe('schedule admission visibility', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
  })
  afterEach(() => {
    vi.useRealTimers()
  })
  it('shows capacity reason without changing the scheduled deadline and refreshes read-only', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useWorkspaceStore()
    vi.spyOn(store, 'fetchCrons').mockResolvedValue(undefined)
    const deadline = '2026-09-23T10:00:00Z'
    store.pendingWakeups.w = { targetAt: deadline, reason: 'Check build' }
    api.mockResolvedValue({ allowed: false, reason: 'capacity', running: 1, limit: 1 })
    const wrapper = shallowMount(SchedulePanel, {
      props: { workspaceId: 'w' },
      global: { plugins: [pinia, createI18n({ legacy: false, locale: 'en', messages: { en } })] },
    })
    await flushPromises()
    expect(wrapper.get('[data-test="admission-status"]').text()).toContain('Concurrency limit reached: 1/1')
    expect(store.pendingWakeups.w?.targetAt).toBe(deadline)
    api.mockResolvedValue({ allowed: true, reason: null, running: 0, limit: 1 })
    await vi.advanceTimersByTimeAsync(5000)
    await flushPromises()
    expect(wrapper.find('[data-test="admission-status"]').exists()).toBe(false)
    expect(api).toHaveBeenCalledWith('/api/workspaces/w/automatic-admission')
    wrapper.unmount()
    const count = api.mock.calls.length
    await vi.advanceTimersByTimeAsync(10000)
    expect(api).toHaveBeenCalledTimes(count)
  })
})
