import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createI18n } from 'vue-i18n'
import type { ProgressBar } from '../../../shared/progress-bars'
import SessionProgressPanel from '../components/SessionProgressPanel.vue'
import en from '../i18n/en'
import fr from '../i18n/fr'
import { useProgressBarsStore } from '../stores/progress-bars'
import { apiFetch } from '../utils/api'

vi.mock('../utils/api', () => ({ apiFetch: vi.fn() }))
const now = '2026-10-12T12:00:00.000Z'
function bar(id: string, overrides: Partial<ProgressBar> = {}): ProgressBar {
  return {
    id,
    workspaceId: 'w1',
    sessionId: 's1',
    label: `Tests ${id}`,
    step: null,
    current: null,
    total: null,
    status: 'running',
    dismissed: false,
    dismissedAt: null,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
    revision: 1,
    sequence: 0,
    ...overrides,
  }
}
const wrappers: ReturnType<typeof mount>[] = []
function panel(locale = 'en') {
  const wrapper = mount(SessionProgressPanel, {
    attachTo: document.body,
    props: { workspaceId: 'w1', sessionId: 's1' },
    global: {
      plugins: [createI18n({ legacy: false, locale, flatJson: true, messages: { en: { ...en }, fr: { ...fr } } })],
    },
  })
  wrappers.push(wrapper)
  return wrapper
}
beforeEach(() => {
  setActivePinia(createPinia())
  vi.useFakeTimers()
  vi.setSystemTime(now)
  vi.mocked(apiFetch).mockReset().mockResolvedValue({ items: [], nextOffset: null, totalCount: 0, serverTime: now })
})
afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount()
  vi.useRealTimers()
  document.body.innerHTML = ''
})
it('renders nothing empty and three rows with expandable overflow', async () => {
  const wrapper = panel()
  await flushPromises()
  expect(wrapper.find('section').exists()).toBe(false)
  for (let index = 0; index < 5; index++) useProgressBarsStore().apply(bar(String(index)))
  await flushPromises()
  expect(wrapper.findAll('[role="progressbar"]')).toHaveLength(3)
  expect(wrapper.get('[data-action="overflow"]').text()).toContain('2')
  await wrapper.get('[data-action="overflow"]').trigger('click')
  expect(wrapper.findAll('[role="progressbar"]')).toHaveLength(5)
  expect(wrapper.get('[data-action="overflow"]').attributes('aria-expanded')).toBe('true')
})
it('reports measured or indeterminate values and renders activity content as text', async () => {
  const wrapper = panel()
  useProgressBarsStore().apply(bar('1', { current: 2, total: 7, label: '<b>tests</b>' }))
  useProgressBarsStore().apply(bar('2'))
  await flushPromises()
  const [measured, unknown] = wrapper.findAll('[role="progressbar"]')
  expect(measured?.attributes('aria-valuenow')).toBe('2')
  expect(measured?.attributes('aria-valuemax')).toBe('7')
  expect(measured?.attributes('aria-label')).toBe('<b>tests</b>')
  expect(wrapper.find('b').exists()).toBe(false)
  expect(unknown?.attributes('aria-valuenow')).toBeUndefined()
  expect(wrapper.get('[data-dismiss="1"]').attributes('aria-label')).toContain('<b>tests</b>')
})
it('shows interruption as reporting interrupted and preserves unknown totals on success', async () => {
  const wrapper = panel('fr')
  const store = useProgressBarsStore()
  store.apply(bar('1', { status: 'interrupted' }))
  store.apply(bar('2', { status: 'succeeded', completedAt: now }))
  await flushPromises()
  expect(wrapper.text()).toContain('Suivi interrompu')
  expect(wrapper.text()).not.toContain('100%')
  await vi.advanceTimersByTimeAsync(5000)
  expect(wrapper.findAll('[role="progressbar"]')).toHaveLength(1)
  wrapper.unmount()
  expect(vi.getTimerCount()).toBe(0)
})
it('moves keyboard focus to another close button and emits composer focus for the last row', async () => {
  const wrapper = panel()
  const store = useProgressBarsStore()
  store.apply(bar('1'))
  store.apply(bar('2'))
  await flushPromises()
  vi.mocked(apiFetch).mockResolvedValueOnce(bar('1', { dismissed: true, revision: 2 }))
  const first = wrapper.get('[data-dismiss="1"]')
  ;(first.element as HTMLElement).focus()
  await first.trigger('click')
  await flushPromises()
  expect(document.activeElement).toBe(wrapper.get('[data-dismiss="2"]').element)
  vi.mocked(apiFetch).mockResolvedValueOnce(bar('2', { dismissed: true, revision: 2 }))
  await wrapper.get('[data-dismiss="2"]').trigger('click')
  await flushPromises()
  expect(wrapper.emitted('focusComposer')).toHaveLength(1)
})
it('shows a translated dismissal failure and can retry without hiding the error region', async () => {
  const wrapper = panel('fr')
  const store = useProgressBarsStore()
  store.apply(bar('1'))
  await flushPromises()
  vi.mocked(apiFetch).mockRejectedValueOnce(new Error('secret server error'))
  await wrapper.get('[data-dismiss="1"]').trigger('click')
  await flushPromises()
  expect(wrapper.get('[role="alert"]').text()).toContain('Impossible de masquer')
  expect(wrapper.text()).not.toContain('secret server error')
})
it('switches selected sessions synchronously and ignores unrelated session bars', async () => {
  const wrapper = panel()
  useProgressBarsStore().apply(bar('1'))
  await flushPromises()
  await wrapper.setProps({ sessionId: null })
  expect(wrapper.find('section').exists()).toBe(false)
  await wrapper.setProps({ sessionId: 's2' })
  useProgressBarsStore().apply(bar('1'))
  await flushPromises()
  expect(wrapper.find('section').exists()).toBe(false)
})

it('does not introduce an error banner when a session with no known activities cannot be fetched', async () => {
  vi.mocked(apiFetch).mockRejectedValueOnce(new Error('Offline'))
  const wrapper = panel()
  await flushPromises()
  expect(wrapper.find('section').exists()).toBe(false)
})

it('announces completion without announcing numeric updates and restores focus after timed expiry', async () => {
  const wrapper = panel()
  const store = useProgressBarsStore()
  store.apply(bar('1', { current: 1, total: 10 }))
  await flushPromises()
  store.apply(bar('1', { current: 2, total: 10, revision: 2 }))
  await flushPromises()
  expect(wrapper.get('[role="status"]').text()).toBe('')
  ;(wrapper.get('[data-dismiss="1"]').element as HTMLElement).focus()
  store.apply(bar('1', { current: 2, total: 10, revision: 3, status: 'succeeded', completedAt: now }))
  await flushPromises()
  expect(wrapper.get('[role="status"]').text()).toContain('Succeeded')
  await vi.advanceTimersByTimeAsync(5000)
  expect(wrapper.emitted('focusComposer')).toHaveLength(1)
})

it('removes the error region when a success expires before its failed dismissal reply', async () => {
  const wrapper = panel('fr')
  await flushPromises()
  const store = useProgressBarsStore()
  store.apply(bar('1', { status: 'succeeded', completedAt: now }))
  await vi.advanceTimersByTimeAsync(4000)
  let reject!: (error: Error) => void
  vi.mocked(apiFetch).mockReturnValueOnce(
    new Promise((_resolve, rej) => {
      reject = rej
    }),
  )
  await wrapper.get('[data-dismiss="1"]').trigger('click')
  await vi.advanceTimersByTimeAsync(2000)
  reject(new Error('Offline'))
  await flushPromises()
  expect(wrapper.find('section').exists()).toBe(false)
})

it.each([3, 0])('restores overflow-button focus when expiry leaves %i activities', async (remaining) => {
  const wrapper = panel()
  await flushPromises()
  const store = useProgressBarsStore()
  for (let index = 1; index <= 4; index++) {
    store.apply(bar(String(index), index > remaining ? { status: 'succeeded', completedAt: now } : {}))
  }
  await flushPromises()
  const overflow = wrapper.get('[data-action="overflow"]').element as HTMLElement
  overflow.focus()
  await vi.advanceTimersByTimeAsync(5000)
  expect(wrapper.find('[data-action="overflow"]').exists()).toBe(false)
  if (remaining) {
    expect(document.activeElement).toBe(wrapper.get(`[data-dismiss="${remaining}"]`).element)
    expect(wrapper.emitted('focusComposer')).toBeUndefined()
  } else {
    expect(wrapper.emitted('focusComposer')).toHaveLength(1)
  }
})

it('does not take focus from outside the panel when overflow disappears', async () => {
  const wrapper = panel()
  await flushPromises()
  const store = useProgressBarsStore()
  for (const id of ['1', '2', '3']) store.apply(bar(id))
  store.apply(bar('4', { status: 'succeeded', completedAt: now }))
  await flushPromises()
  const outside = document.createElement('input')
  document.body.append(outside)
  outside.focus()
  await vi.advanceTimersByTimeAsync(5000)
  expect(wrapper.find('[data-action="overflow"]').exists()).toBe(false)
  expect(document.activeElement).toBe(outside)
  expect(wrapper.emitted('focusComposer')).toBeUndefined()
})
