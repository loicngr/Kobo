import { flushPromises, shallowMount } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import NetworkLoginDialog from '../components/NetworkLoginDialog.vue'
import { authenticateBrowser } from '../utils/auth-token'
import { closeNetworkLogin, networkLoginOpen, openNetworkLogin } from '../utils/network-login-bus'

vi.mock('../utils/auth-token', () => ({ authenticateBrowser: vi.fn() }))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
afterEach(() => {
  closeNetworkLogin()
  vi.restoreAllMocks()
})

it('requires explicit opt-in, keeps errors visible, and clears credentials after successful login', async () => {
  const reload = vi.spyOn(window.location, 'reload').mockImplementation(() => {})
  vi.mocked(authenticateBrowser)
    .mockResolvedValueOnce(new Response('{}', { status: 401 }))
    .mockResolvedValueOnce(new Response('{}'))
  openNetworkLogin()
  const wrapper = shallowMount(NetworkLoginDialog, {
    global: {
      renderStubDefaultSlot: true,
      stubs: {
        QDialog: { props: ['modelValue'], template: '<div><slot /></div>' },
        QCard: { template: '<div><slot /></div>' },
        QCardSection: { template: '<div><slot /></div>' },
        QCardActions: { template: '<div><slot /></div>' },
        QInput: { name: 'QInput', props: ['modelValue', 'error'], emits: ['update:modelValue'], template: '<input />' },
        QCheckbox: {
          name: 'QCheckbox',
          props: ['modelValue'],
          emits: ['update:modelValue'],
          template: '<input type="checkbox" />',
        },
        QBtn: { name: 'QBtn', emits: ['click'], template: '<button />' },
      },
    },
  })
  try {
    const checkbox = wrapper.findComponent({ name: 'QCheckbox' })
    const input = wrapper.findComponent({ name: 'QInput' })
    const button = wrapper.findComponent({ name: 'QBtn' })
    expect(checkbox.props('modelValue')).toBe(false)
    input.vm.$emit('update:modelValue', 'synthetic')
    button.vm.$emit('click')
    await flushPromises()
    expect(authenticateBrowser).toHaveBeenLastCalledWith('synthetic', false)
    expect(input.props('error')).toBe(true)
    expect(networkLoginOpen.value).toBe(true)
    checkbox.vm.$emit('update:modelValue', true)
    button.vm.$emit('click')
    await flushPromises()
    expect(authenticateBrowser).toHaveBeenLastCalledWith('synthetic', true)
    expect(input.props('modelValue')).toBe('')
    expect(networkLoginOpen.value).toBe(false)
    expect(reload).toHaveBeenCalledOnce()
  } finally {
    wrapper.unmount()
  }
})
