import { flushPromises, shallowMount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from 'vue-i18n'
import DiffViewer from '../components/DiffViewer.vue'
import en from '../i18n/en'
import { useWorkspaceStore, type Workspace } from '../stores/workspace'

vi.mock('monaco-editor/editor/editor.worker.js?worker', () => ({ default: class {} }))
vi.mock('quasar', () => ({ useQuasar: () => ({ screen: { lt: { sm: false, md: false } }, notify: vi.fn() }) }))
vi.mock('src/utils/api', async (original) => ({
  ...(await original<object>()),
  apiFetch: vi.fn(async () => ({ files: [], sourceBranch: 'main', workingBranch: 'feature/a' })),
}))

let wrapper: VueWrapper
let store: ReturnType<typeof useWorkspaceStore>

async function mountViewer() {
  wrapper = shallowMount(DiffViewer, {
    props: { workspaceId: 'ws-a' },
    global: {
      plugins: [createI18n({ legacy: false, locale: 'en', messages: { en } })],
      stubs: {
        QBtnToggle: { name: 'QBtnToggle', props: ['modelValue', 'options'], template: '<div />' },
        QTooltip: { template: '<span><slot /></span>' },
      },
    },
  })
  await flushPromises()
}
function editToggle() {
  return wrapper
    .findAllComponents({ name: 'QBtnToggle' })
    .find((c) => c.props('options').some((o: { value: string }) => o.value === 'inspect'))!
}

beforeEach(() => {
  setActivePinia(createPinia())
  store = useWorkspaceStore()
  store.workspaces = [{ id: 'ws-a', status: 'idle' } as Workspace]
})
afterEach(() => wrapper?.unmount())

describe('Diff viewer controls', () => {
  it('opens in inline view by default', async () => {
    await mountViewer()
    const layout = wrapper
      .findAllComponents({ name: 'QBtnToggle' })
      .find((c) => c.props('options').some((o: { value: string }) => o.value === 'inline'))!
    expect(layout.props('modelValue')).toBe('inline')
  })

  it.each(['executing', 'brainstorming', 'compacting', 'extracting'])(
    'disables edit and explains why while %s, then restores it',
    async (status) => {
      await mountViewer()
      expect(editToggle().props('options')[0].disable).toBe(false)
      store.workspaces[0]!.status = status
      await flushPromises()
      expect(editToggle().props('options')[0].disable).toBe(true)
      expect(editToggle().props('options')[1].disable).toBeUndefined()
      expect(wrapper.text()).toContain(en['diffViewer.agentRunning'])
      store.workspaces[0]!.status = 'idle'
      await flushPromises()
      expect(editToggle().props('options')[0].disable).toBe(false)
    },
  )

  it('also blocks editing when a live controller is present in an idle workspace', async () => {
    store.agentLiveness['ws-a'] = { status: 'running', agentSessionId: 'session-a', startedAt: '', lastEventAt: '' }
    await mountViewer()
    expect(editToggle().props('options')[0].disable).toBe(true)
    expect(wrapper.text()).toContain(en['diffViewer.agentRunning'])
  })
})
