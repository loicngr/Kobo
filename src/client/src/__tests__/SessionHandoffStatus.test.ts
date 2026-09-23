import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, expect, it, vi } from 'vitest'
import { createI18n } from 'vue-i18n'
import type { SessionHandoff } from '../../../shared/session-handoff'
import SessionHandoffStatus from '../components/SessionHandoffStatus.vue'
import en from '../i18n/en'
import { useDocumentsStore } from '../stores/documents'
import { useSessionHandoffStore } from '../stores/session-handoff'
import { useWorkspaceStore } from '../stores/workspace'

const notify = vi.fn()
vi.mock('quasar', async (original) => ({ ...(await original<object>()), useQuasar: () => ({ notify }) }))
const global = {
  plugins: [createI18n({ legacy: false, locale: 'en', messages: { en } })],
  stubs: {
    QBtn: {
      props: ['label', 'disable', 'loading'],
      template: '<button :disabled="disable || loading">{{ label }}</button>',
    },
    QSpinner: true,
  },
}
beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  useSessionHandoffStore().current['ws-1'] = {
    id: 'handoff-1',
    workspaceId: 'ws-1',
    state: 'failed',
    sourceSessionId: 'source',
    reportPath: '.ai/handoffs/handoff-1.md',
    error: 'Quota exhausted',
  } as SessionHandoff
})

it('offers explicit recovery choices without dispatching automatically', async () => {
  const decide = vi.spyOn(useSessionHandoffStore(), 'decide').mockResolvedValue({} as SessionHandoff)
  const view = mount(SessionHandoffStatus, { props: { workspaceId: 'ws-1' }, global })
  expect(view.text()).toContain('Quota exhausted')
  expect(decide).not.toHaveBeenCalled()
  for (const action of ['retry', 'skip', 'cancel'] as const) {
    await view.get(`[data-test="handoff-${action}"]`).trigger('click')
    await flushPromises()
    expect(decide).toHaveBeenLastCalledWith('ws-1', 'handoff-1', action)
  }
  view.unmount()
})

it('opens the saved document and source conversation through their existing stores', async () => {
  const open = vi.spyOn(useDocumentsStore(), 'openDocumentByPath').mockResolvedValue(true)
  const select = vi.spyOn(useWorkspaceStore(), 'selectSession').mockImplementation(() => {})
  const view = mount(SessionHandoffStatus, { props: { workspaceId: 'ws-1' }, global })
  await view.get('[data-test="handoff-report"]').trigger('click')
  expect(open).toHaveBeenCalledWith('ws-1', '.ai/handoffs/handoff-1.md')
  await view.get('[data-test="handoff-source"]').trigger('click')
  expect(select).toHaveBeenCalledWith('source')
  view.unmount()
})

it('leaves cancel available during generation and preserves failures visibly', async () => {
  const store = useSessionHandoffStore()
  store.current['ws-1']!.state = 'generating'
  vi.spyOn(store, 'decide').mockRejectedValue(new Error('Shutdown not confirmed'))
  const view = mount(SessionHandoffStatus, { props: { workspaceId: 'ws-1' }, global })
  expect(view.find('[data-test="handoff-retry"]').exists()).toBe(false)
  expect(view.text()).toContain('Preparing the handoff')
  await view.get('[data-test="handoff-cancel"]').trigger('click')
  await flushPromises()
  expect(notify).toHaveBeenCalledWith(expect.objectContaining({ message: 'Shutdown not confirmed' }))
  expect(view.get('[data-test="handoff-cancel"]').attributes('disabled')).toBeUndefined()
  view.unmount()
})
