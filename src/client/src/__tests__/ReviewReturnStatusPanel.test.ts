import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createI18n } from 'vue-i18n'
import ReviewReturnStatusPanel from '../components/ReviewReturnStatusPanel.vue'
import en from '../i18n/en'
import { useAutoLoopReviewStore } from '../stores/auto-loop-review'

const status = { reviewSessionId: 'review', originalSessionId: 'original', phase: 'unknown' as const, error: null }
beforeEach(() => {
  setActivePinia(createPinia())
  vi.spyOn(useAutoLoopReviewStore(), 'fetchReturn').mockResolvedValue()
})
afterEach(() => vi.restoreAllMocks())
function panel() {
  return mount(ReviewReturnStatusPanel, {
    props: { workspaceId: 'w' },
    global: {
      plugins: [createI18n({ legacy: false, locale: 'en', messages: { en } })],
      stubs: { QBtn: { props: ['label', 'disable'], template: '<button :disabled="disable">{{ label }}</button>' } },
    },
  })
}
it('does not invent a pending return when its status fetch fails', async () => {
  vi.mocked(useAutoLoopReviewStore().fetchReturn).mockRejectedValueOnce(new Error('offline'))
  const view = panel()
  await flushPromises()
  expect(view.find('section').exists()).toBe(false)
  view.unmount()
})
it('requires explicit retry of an uncertain handoff and explains possible duplicate delivery', async () => {
  const store = useAutoLoopReviewStore()
  store.setReturn('w', status)
  const retry = vi.spyOn(store, 'resolveReturn').mockResolvedValue()
  const view = panel()
  await flushPromises()
  expect(view.text()).toContain('may already have received')
  expect(retry).not.toHaveBeenCalled()
  await view.get('[data-test="review-return-retry"]').trigger('click')
  expect(retry).toHaveBeenCalledWith('w', 'retry')
  view.unmount()
})
it('clears the old workspace state on navigation and keeps stale errors out of the new view', async () => {
  const store = useAutoLoopReviewStore()
  store.setReturn('w', status)
  let reject!: (error: Error) => void
  vi.spyOn(store, 'resolveReturn').mockImplementation(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail
      }),
  )
  const view = panel()
  await view.get('[data-test="review-return-retry"]').trigger('click')
  await view.setProps({ workspaceId: 'other' })
  reject(new Error('Late error'))
  await flushPromises()
  expect(view.find('section').exists()).toBe(false)
  expect(store.fetchReturn).toHaveBeenCalledWith('other')
  view.unmount()
})
