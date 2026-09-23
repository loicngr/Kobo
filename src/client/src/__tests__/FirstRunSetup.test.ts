import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { createI18n } from 'vue-i18n'
import { createMemoryHistory, createRouter, isNavigationFailure, NavigationFailureType } from 'vue-router'
import FirstRunSetup from '../components/FirstRunSetup.vue'
import en from '../i18n/en'
import { useSettingsStore } from '../stores/settings'

const { api, push } = vi.hoisted(() => ({ api: vi.fn(), push: vi.fn() }))
vi.mock('../utils/api', () => ({ apiFetch: api }))
vi.mock('vue-router', async (original) => ({
  ...(await original<typeof import('vue-router')>()),
  useRouter: () => ({ push }),
}))
const Button = defineComponent({
  props: ['label', 'disable', 'loading'],
  emits: ['click'],
  setup:
    (p, { emit }) =>
    () =>
      h('button', { disabled: p.disable || p.loading, onClick: () => emit('click') }, p.label),
})
const Input = defineComponent({
  props: ['modelValue'],
  emits: ['update:modelValue'],
  setup:
    (p, { emit }) =>
    () =>
      h('input', {
        value: p.modelValue,
        onInput: (e: Event) => emit('update:modelValue', (e.target as HTMLInputElement).value),
      }),
})
function setup(loaded = true, complete = false) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const settings = useSettingsStore()
  settings.loaded = loaded
  settings.global.onboardingComplete = complete
  const wrapper = mount(FirstRunSetup, {
    global: {
      plugins: [pinia, createI18n({ legacy: false, locale: 'en', messages: { en } })],
      stubs: { QBtn: Button, QInput: Input, QSelect: true, FolderPickerDialog: true },
    },
  })
  return { wrapper, settings }
}
describe('first run setup', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })
  it('does not show fresh defaults before settings have loaded', () => {
    const { wrapper } = setup(false)
    expect(wrapper.find('[data-test="first-run"]').exists()).toBe(false)
    expect(api).not.toHaveBeenCalled()
  })
  it('does not interrupt an existing installation', () => {
    expect(setup(true, true).wrapper.find('[data-test="first-run"]').exists()).toBe(false)
  })
  it('requires a check and invalidates it when the project changes', async () => {
    api.mockResolvedValue({
      engine: 'claude-code',
      checkedAt: '',
      checks: [{ code: 'authentication', status: 'unknown' }],
    })
    const { wrapper } = setup()
    await wrapper.get('input').setValue('/demo/project')
    expect(wrapper.get('[data-test="start"]').attributes('disabled')).toBeDefined()
    await wrapper.get('[data-test="check"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-test="start"]').attributes('disabled')).toBeUndefined()
    await wrapper.get('input').setValue('/another/project')
    expect(wrapper.get('[data-test="start"]').attributes('disabled')).toBeDefined()
  })
  it('never displays raw diagnostic errors', async () => {
    api.mockRejectedValue(new Error('SECRET_CANARY'))
    const { wrapper } = setup()
    await wrapper.get('[data-test="check"]').trigger('click')
    await flushPromises()
    expect(wrapper.text()).not.toContain('SECRET_CANARY')
    expect(wrapper.find('[role="alert"]').exists()).toBe(true)
  })
  it('keeps setup visible when navigation fails and does not mark it complete', async () => {
    const { wrapper, settings } = setup()
    vi.spyOn(settings, 'upsertProject').mockResolvedValue(undefined)
    const complete = vi.spyOn(settings, 'updateGlobal').mockResolvedValue(undefined)
    api.mockResolvedValue({ checks: [] })
    push.mockResolvedValue(new Error('cancelled'))
    await wrapper.get('input').setValue('/demo/project')
    await wrapper.get('[data-test="check"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-test="start"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[role="alert"]').exists()).toBe(true)
    expect(complete).not.toHaveBeenCalled()
  })
  it('routes to the captured project before persisting completion without starting an agent', async () => {
    const { wrapper, settings } = setup()
    let release!: () => void
    vi.spyOn(settings, 'upsertProject').mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
    )
    const complete = vi.spyOn(settings, 'updateGlobal').mockResolvedValue(undefined)
    api.mockResolvedValue({ checks: [] })
    await wrapper.get('input').setValue('/demo/project')
    await wrapper.get('[data-test="check"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-test="start"]').trigger('click')
    expect(push).not.toHaveBeenCalled()
    expect(complete).not.toHaveBeenCalled()
    release()
    await flushPromises()
    expect(push).toHaveBeenCalledWith({
      name: 'create',
      query: { engine: 'claude-code', project: '/demo/project', setupRequest: expect.any(String) },
    })
    expect(complete).toHaveBeenCalledWith({ onboardingComplete: true })
    expect(api.mock.calls.every(([url]) => String(url).startsWith('/api/environment'))).toBe(true)
  })
  it('can reopen the setup after it has been skipped', async () => {
    const { wrapper } = setup(true, true)
    window.dispatchEvent(new Event('kobo:setup'))
    await flushPromises()
    expect(wrapper.find('[data-test="first-run"]').exists()).toBe(true)
    wrapper.unmount()
  })
  it('dispatches a new creation handoff when setup is reopened with the same engine and project', async () => {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/create', name: 'create', component: { template: '<div />' } }],
    })
    await router.push({ name: 'create', query: { engine: 'claude-code', project: '/demo/project' } })
    const failures: unknown[] = []
    push.mockImplementation(async (target) => {
      const failure = await router.push(target)
      failures.push(failure)
      return failure
    })
    api.mockResolvedValue({ checks: [] })
    const { wrapper, settings } = setup()
    vi.spyOn(settings, 'upsertProject').mockResolvedValue(undefined)
    vi.spyOn(settings, 'updateGlobal').mockResolvedValue(undefined)
    await wrapper.get('input').setValue('/demo/project')
    await wrapper.get('[data-test="check"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-test="start"]').trigger('click')
    await flushPromises()
    window.dispatchEvent(new Event('kobo:setup'))
    await flushPromises()
    await wrapper.get('[data-test="start"]').trigger('click')
    await flushPromises()
    expect(failures).toHaveLength(2)
    expect(failures.some((failure) => isNavigationFailure(failure, NavigationFailureType.duplicated))).toBe(false)
    expect(router.currentRoute.value.query.project).toBe('/demo/project')
    wrapper.unmount()
  })
})
