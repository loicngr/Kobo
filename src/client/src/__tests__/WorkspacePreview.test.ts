import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { reactive } from 'vue'
import { createI18n } from 'vue-i18n'
import { createMemoryHistory, createRouter } from 'vue-router'
import WorkspacePreview from '../components/WorkspacePreview.vue'
import en from '../i18n/en'
import { useDevServerStore } from '../stores/dev-server'
import { useLayoutStore } from '../stores/layout'
import { apiFetch } from '../utils/api'
import { isWorkspacePreviewNavigation } from '../utils/preview'
import { _clearUnsavedScopesForTest, hasUnsavedWork, registerUnsavedScope } from '../utils/unsaved-guard'

const screen = reactive({ lt: { md: false } })
vi.mock('quasar', () => ({ useQuasar: () => ({ screen }) }))
vi.mock('../utils/api', () => ({ apiFetch: vi.fn() }))
const i18n = createI18n({ legacy: false, locale: 'en', messages: { en } })
beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  vi.mocked(apiFetch).mockClear()
  screen.lt.md = false
  const dev = useDevServerStore()
  vi.spyOn(dev, 'fetchStatus').mockResolvedValue(undefined)
  vi.spyOn(dev, 'stopDevServer').mockResolvedValue(undefined)
  dev.statuses.w = {
    status: 'running',
    instanceName: 'w',
    projectName: '',
    httpPort: '5173',
    url: 'http://localhost:5173',
    containers: [],
  }
  vi.mocked(apiFetch).mockResolvedValue({
    url: 'https://w.preview.example.com/.kobo-preview/open?ticket=test',
    publicUrl: 'https://w.preview.example.com/',
    remote: true,
  })
})
afterEach(() => {
  vi.restoreAllMocks()
  _clearUnsavedScopesForTest()
})
async function setup(path = '/workspace/w') {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/workspace/:id/:view(preview)?', name: 'workspace', component: WorkspacePreview }],
  })
  await router.push(path)
  await router.isReady()
  const wrapper = mount(WorkspacePreview, {
    props: { workspaceId: 'w' },
    slots: { default: '<textarea data-testid="draft">Keep my draft</textarea>' },
    global: {
      plugins: [i18n, router],
      stubs: { QBtn: true, QSpace: true, QSpinner: true, QResizeObserver: true },
    },
  })
  return { wrapper, router }
}
describe('workspace preview layouts', () => {
  it('preserves draft and iframe across views, closes without stopping and restores drawers', async () => {
    const layout = useLayoutStore()
    const initialWidth = layout.rightDrawerWidth
    const { wrapper, router } = await setup()
    expect(apiFetch).not.toHaveBeenCalled()
    wrapper.vm.setMode('split')
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/workspace/w/preview')
    expect(wrapper.find('[role="separator"]').exists()).toBe(true)
    const frame = wrapper.get('iframe').element
    const draft = wrapper.get('[data-testid="draft"]').element
    wrapper.vm.setMode('preview')
    await flushPromises()
    expect(wrapper.get('iframe').element).toBe(frame)
    expect(wrapper.get('[data-testid="draft"]').element).toBe(draft)
    expect(wrapper.get('.preview-chat').attributes('style')).toContain('display: none')
    layout.setRight(false)
    layout.rightDrawerWidth = 600
    await wrapper.get('[aria-label="Close preview and restore layout"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('iframe').exists()).toBe(false)
    expect(layout.rightDrawerOpen).toBe(true)
    expect(layout.rightDrawerWidth).toBe(initialWidth)
    expect(useDevServerStore().stopDevServer).not.toHaveBeenCalled()
    expect(router.currentRoute.value.path).toBe('/workspace/w')
    wrapper.unmount()
  })
  it('opens a deep link and persists keyboard resizing independently of the drawer', async () => {
    const { wrapper } = await setup('/workspace/w/preview?preview=split')
    await flushPromises()
    await wrapper.get('[role="separator"]').trigger('keydown', { key: 'ArrowRight' })
    expect(localStorage.getItem('kobo:preview:width:drawer')).toBe('47')
    useLayoutStore().setRight(false)
    await flushPromises()
    expect(wrapper.get('[role="separator"]').attributes('aria-valuenow')).toBe('45')
    await wrapper.get('[role="separator"]').trigger('dblclick')
    expect(localStorage.getItem('kobo:preview:width:plain')).toBe('45')
    wrapper.unmount()
  })
  it('keeps both panels usable when resized to an extreme', async () => {
    const { wrapper } = await setup('/workspace/w/preview?preview=split')
    await flushPromises()
    wrapper.findComponent({ name: 'QResizeObserver' }).vm.$emit('resize', { width: 640 })
    await flushPromises()
    for (let i = 0; i < 30; i++) await wrapper.get('[role="separator"]').trigger('keydown', { key: 'ArrowRight' })
    expect(wrapper.get('[role="separator"]').attributes('aria-valuenow')).toBe('55')
    expect(Number.parseFloat((wrapper.get('.preview-chat').element as HTMLElement).style.flexBasis)).toBeCloseTo(55)
    wrapper.unmount()
  })
  it('switches to one panel when drawers leave insufficient space', async () => {
    const { wrapper } = await setup('/workspace/w/preview?preview=split')
    await flushPromises()
    wrapper.findComponent({ name: 'QResizeObserver' }).vm.$emit('resize', { width: 580 })
    await flushPromises()
    expect(wrapper.find('[role="separator"]').exists()).toBe(false)
    expect(wrapper.get('.preview-chat').attributes('style')).toContain('display: none')
    wrapper.findComponent({ name: 'QResizeObserver' }).vm.$emit('resize', { width: 1000 })
    await flushPromises()
    await wrapper.vm.setMode('split')
    await flushPromises()
    expect(wrapper.vm.mode).toBe('split')
    expect(wrapper.find('[role="separator"]').exists()).toBe(true)
    wrapper.unmount()
  })
  it('returns to chat on stop and ignores late responses without reopening on restart', async () => {
    let resolve!: (data: { url: string; publicUrl: string; remote: boolean }) => void
    vi.mocked(apiFetch).mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r
        }),
    )
    const { wrapper } = await setup('/workspace/w/preview')
    await flushPromises()
    const dev = useDevServerStore()
    dev.statuses.w!.status = 'stopped'
    await flushPromises()
    resolve({ url: 'https://w.preview.example.com/old', publicUrl: 'https://w.preview.example.com/old', remote: true })
    await flushPromises()
    expect(wrapper.find('iframe').exists()).toBe(false)
    expect(wrapper.vm.mode).toBe('chat')
    expect(wrapper.get('.preview-chat').attributes('style')).not.toContain('display: none')
    dev.statuses.w!.status = 'running'
    await flushPromises()
    expect(wrapper.find('iframe').exists()).toBe(false)
    expect(wrapper.vm.mode).toBe('chat')
    wrapper.unmount()
  })
  it('does not change the layout if another navigation guard refuses it', async () => {
    const { wrapper, router } = await setup()
    router.beforeEach(() => false)
    wrapper.vm.setMode('preview')
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/workspace/w')
    expect(wrapper.vm.mode).toBe('chat')
    expect(apiFetch).not.toHaveBeenCalled()
    wrapper.unmount()
  })
  it('keeps the draft without a leave prompt for layout-only navigation', async () => {
    const { wrapper, router } = await setup()
    registerUnsavedScope('chat:message', () => true)
    const prompt = vi.fn(() => false)
    router.beforeEach((to, from) => {
      if (isWorkspacePreviewNavigation(to, from) || !hasUnsavedWork()) return true
      return prompt()
    })
    const draft = wrapper.get('[data-testid="draft"]').element
    wrapper.vm.setMode('split')
    await flushPromises()
    expect(wrapper.find('iframe').exists()).toBe(true)
    await wrapper.get('[aria-label="Close preview and restore layout"]').trigger('click')
    await flushPromises()
    expect(wrapper.vm.mode).toBe('chat')
    expect(wrapper.get('[data-testid="draft"]').element).toBe(draft)
    expect(prompt).not.toHaveBeenCalled()
    await router.push('/workspace/other')
    expect(prompt).toHaveBeenCalledOnce()
    expect(router.currentRoute.value.path).toBe('/workspace/w')
    wrapper.unmount()
  })
  it('opens the Tools preview deep link in any workspace router, including embedded panes', async () => {
    const { wrapper, router } = await setup()
    await router.push('/workspace/w/preview?preview=split')
    await flushPromises()
    expect(wrapper.find('iframe').exists()).toBe(true)
    expect(wrapper.vm.mode).toBe('split')
    wrapper.unmount()
  })
  it('unloads a hidden preview on stop even when the route is already Chat', async () => {
    const { wrapper } = await setup('/workspace/w/preview')
    await flushPromises()
    wrapper.vm.setMode('chat')
    await flushPromises()
    useDevServerStore().statuses.w!.status = 'stopped'
    await flushPromises()
    expect(wrapper.find('iframe').exists()).toBe(false)
    expect(wrapper.vm.mode).toBe('chat')
    wrapper.unmount()
  })
  it('uses one panel at a time on mobile and unloads a stopped server', async () => {
    screen.lt.md = true
    const { wrapper, router } = await setup('/workspace/w/preview?preview=split')
    await flushPromises()
    expect(wrapper.find('[role="separator"]').exists()).toBe(false)
    expect(wrapper.get('.preview-chat').attributes('style')).toContain('display: none')
    useDevServerStore().statuses.w!.status = 'stopped'
    await flushPromises()
    expect(wrapper.find('iframe').exists()).toBe(false)
    expect(wrapper.vm.mode).toBe('chat')
    expect(router.currentRoute.value.path).toBe('/workspace/w')
    expect(wrapper.get('.preview-chat').attributes('style')).not.toContain('display: none')
    wrapper.unmount()
  })
})
