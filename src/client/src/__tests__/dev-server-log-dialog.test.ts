import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from 'vue-i18n'
import DevServerLogDialog from '../components/DevServerLogDialog.vue'
import en from '../i18n/en'
import { useDevServerStore } from '../stores/dev-server'

let wrapper: VueWrapper
let store: ReturnType<typeof useDevServerStore>

function mountDialog(open = false) {
  wrapper = mount(DevServerLogDialog, {
    props: { modelValue: open, workspaceId: 'a' },
    global: {
      plugins: [createI18n({ legacy: false, locale: 'en', messages: { en } })],
      stubs: {
        QDialog: { template: '<div><slot /></div>' },
        QCard: { template: '<div><slot /></div>' },
        QCardSection: { template: '<div><slot /></div>' },
        QSpace: true,
        QBtn: { template: '<button><slot /></button>' },
        QTooltip: true,
        QSeparator: true,
      },
    },
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  setActivePinia(createPinia())
  store = useDevServerStore()
  vi.spyOn(store, 'fetchLogs').mockResolvedValue('building image')
})

afterEach(() => {
  wrapper?.unmount()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('dev-server log dialog', () => {
  it('shows the first response and keeps polling after opening', async () => {
    mountDialog()
    const logContainer = wrapper.get('.log-content').element
    Object.defineProperty(logContainer, 'scrollHeight', { value: 120 })
    await wrapper.setProps({ modelValue: true })
    await flushPromises()
    expect(wrapper.text()).toContain('building image')
    expect(logContainer.scrollTop).toBe(120)
    expect(store.fetchLogs).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(5000)
    expect(store.fetchLogs).toHaveBeenCalledTimes(2)
  })

  it('waits for an old request, discards it and immediately loads the new workspace', async () => {
    let finish!: (logs: string) => void
    vi.mocked(store.fetchLogs)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve
          }),
      )
      .mockResolvedValue('workspace b logs')
    mountDialog(true)
    await wrapper.setProps({ workspaceId: 'b' })
    expect(store.fetchLogs).toHaveBeenCalledOnce()
    finish('old workspace a logs')
    await flushPromises()
    expect(store.fetchLogs).toHaveBeenLastCalledWith('b')
    expect(wrapper.text()).toContain('workspace b logs')
    expect(wrapper.text()).not.toContain('old workspace a logs')
  })

  it('resumes after closing and reopening during a request without overlapping it', async () => {
    let finish!: (logs: string) => void
    vi.mocked(store.fetchLogs)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve
          }),
      )
      .mockResolvedValue('latest build logs')
    mountDialog(true)
    await wrapper.setProps({ modelValue: false })
    await wrapper.setProps({ modelValue: true })
    expect(store.fetchLogs).toHaveBeenCalledOnce()
    finish('stale logs')
    await flushPromises()
    expect(store.fetchLogs).toHaveBeenCalledTimes(2)
    expect(wrapper.text()).toContain('latest build logs')
    await wrapper.setProps({ modelValue: false })
    await vi.advanceTimersByTimeAsync(10000)
    expect(store.fetchLogs).toHaveBeenCalledTimes(2)
  })

  it('pauses when hidden and does not restart after unmount with a request pending', async () => {
    mountDialog(true)
    await flushPromises()
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(10000)
    expect(store.fetchLogs).toHaveBeenCalledOnce()
    let finish!: (logs: string) => void
    vi.mocked(store.fetchLogs).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
    document.dispatchEvent(new Event('visibilitychange'))
    expect(store.fetchLogs).toHaveBeenCalledTimes(2)
    wrapper.unmount()
    finish('last logs')
    await vi.advanceTimersByTimeAsync(10000)
    expect(store.fetchLogs).toHaveBeenCalledTimes(2)
  })
})
