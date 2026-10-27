import { flushPromises, shallowMount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createI18n } from 'vue-i18n'
import StartReviewDialog from '../components/StartReviewDialog.vue'
import ToolsPanel from '../components/ToolsPanel.vue'
import en from '../i18n/en'
import { useParallelReviewStore } from '../stores/parallel-review'
import { useWorkspaceStore, type Workspace } from '../stores/workspace'

vi.mock('quasar', async () => ({ ...(await vi.importActual('quasar')), useQuasar: () => ({ notify: vi.fn() }) }))
const workspace = {
  id: 'w',
  status: 'executing',
  engine: 'claude-code',
  model: 'auto',
  projectPath: '/',
  tags: [],
} as unknown as Workspace
beforeEach(() => {
  setActivePinia(createPinia())
  const store = useWorkspaceStore()
  store.workspaces = [workspace]
  store.selectedWorkspaceId = 'w'
  store.selectedSessionId = 'main'
  vi.spyOn(store, 'fetchSessions').mockResolvedValue()
  vi.spyOn(useParallelReviewStore(), 'fetchStatus').mockResolvedValue()
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
function panel() {
  return shallowMount(ToolsPanel, {
    props: { workspace },
    global: {
      plugins: [createI18n({ legacy: false, locale: 'en', messages: { en } })],
      stubs: {
        QBtn: {
          props: ['label', 'disable', 'loading'],
          template: '<button :disabled="disable">{{ label }}<slot /></button>',
        },
        ActionAvailability: { template: '<div><slot /></div>' },
      },
    },
  })
}
it('opens a forced parallel review while the primary works and selects the returned session explicitly', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(Response.json({ ok: true, parallel: true, newSession: true, sessionId: 'review' })),
  )
  const view = panel()
  const button = view.findAll('button').find((button) => button.text().includes(en['tools.review']))!
  expect(button.attributes('disabled')).toBeUndefined()
  await button.trigger('click')
  const dialog = view.findComponent(StartReviewDialog)
  expect(dialog.props()).toMatchObject({ modelValue: true, parallel: true })
  dialog.vm.$emit('submit', { newSession: true, returnToSession: false })
  await flushPromises()
  expect(useWorkspaceStore().fetchSessions).toHaveBeenCalledWith('w', 'review')
  view.unmount()
})
it('does not redirect a view changed while the launch response is pending', async () => {
  let resolve!: (response: Response) => void
  vi.stubGlobal(
    'fetch',
    vi.fn(
      () =>
        new Promise<Response>((done) => {
          resolve = done
        }),
    ),
  )
  const view = panel()
  view.findComponent(StartReviewDialog).vm.$emit('submit', { newSession: true, returnToSession: true })
  useWorkspaceStore().selectedSessionId = 'other'
  resolve(Response.json({ ok: true, parallel: true, sessionId: 'review' }))
  await flushPromises()
  expect(useWorkspaceStore().fetchSessions).not.toHaveBeenCalled()
  expect(useWorkspaceStore().selectedSessionId).toBe('other')
  view.unmount()
})
it('keeps an already completed return on the source when completion preceded the launch receipt', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ ok: true, parallel: true, sessionId: 'review' })))
  const view = panel()
  view.findComponent(StartReviewDialog).vm.$emit('submit', { newSession: true, returnToSession: true })
  useParallelReviewStore().setStatus('w', {
    reviewSessionId: 'review',
    originalSessionId: 'main',
    phase: 'completed',
    returnToSession: true,
    compacting: false,
    error: null,
  })
  await flushPromises()
  expect(useWorkspaceStore().fetchSessions).toHaveBeenCalledWith('w', 'main')
  view.unmount()
})
