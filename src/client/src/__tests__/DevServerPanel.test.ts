import { flushPromises, shallowMount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, expect, it, vi } from 'vitest'
import { createI18n } from 'vue-i18n'
import DevServerPanel from '../components/DevServerPanel.vue'
import en from '../i18n/en'
import { useDevServerStore } from '../stores/dev-server'
import { type ProjectSettings, useSettingsStore } from '../stores/settings'

afterEach(() => vi.restoreAllMocks())

it('shows queued starts with cancellation and no duplicate start action, then follows readiness', async () => {
  const pinia = createPinia()
  setActivePinia(pinia)
  useSettingsStore().projects = [{ path: '/project', devServer: { startCommand: 'npm run dev' } }] as ProjectSettings[]
  const store = useDevServerStore()
  vi.spyOn(store, 'fetchStatus').mockResolvedValue(undefined)
  const stop = vi.spyOn(store, 'stopDevServer').mockResolvedValue(undefined)
  const status = {
    status: 'queued' as const,
    instanceName: 'w',
    projectName: 'p',
    httpPort: '',
    url: '',
    containers: [],
  }
  store.updateFromWsEvent('w', status)
  const wrapper = shallowMount(DevServerPanel, {
    props: { workspace: { id: 'w', projectPath: '/project' } },
    global: {
      plugins: [pinia, createI18n({ legacy: false, locale: 'en', messages: { en } })],
      stubs: { QBadge: true, QSpace: true, QBtn: true, QTooltip: true, RouterLink: true },
    },
  })
  expect(wrapper.get('q-badge-stub').attributes('label')).toBe('Queued')
  expect(wrapper.find('[aria-label="Start dev server"]').exists()).toBe(false)
  await wrapper.get('[aria-label="Cancel queued start"]').trigger('click')
  await flushPromises()
  expect(stop).toHaveBeenCalledWith('w')
  store.updateFromWsEvent('w', { ...status, status: 'starting' })
  await wrapper.vm.$nextTick()
  expect(wrapper.get('q-badge-stub').attributes('label')).toBe('Starting')
  expect(wrapper.find('[aria-label="Stop dev server"]').exists()).toBe(true)
  store.updateFromWsEvent('w', { ...status, status: 'running' })
  await wrapper.vm.$nextTick()
  expect(wrapper.get('q-badge-stub').attributes('label')).toBe('Running')
  wrapper.unmount()
})
