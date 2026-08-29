import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from 'vue-i18n'
import AgentErrorBanner from '../components/AgentErrorBanner.vue'
import en from '../i18n/en'
import { useAgentStreamStore } from '../stores/agent-stream'

const i18n = createI18n({ legacy: false, locale: 'en', messages: { en } })

const globalStubs = {
  'q-banner': { template: '<div class="q-banner-stub"><slot name="avatar" /><slot /><slot name="action" /></div>' },
  'q-icon': { template: '<i />' },
  'q-btn': { template: '<button><slot /></button>' },
  'q-tooltip': { template: '<span><slot /></span>' },
}

function mountBanner(workspaceId: string) {
  return mount(AgentErrorBanner, {
    props: { workspaceId },
    global: { plugins: [i18n], stubs: globalStubs },
  })
}

describe('AgentErrorBanner.vue — characterisation', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
    setActivePinia(createPinia())
  })

  it('surfaces a spawn_failed error with its engine message', () => {
    const stream = useAgentStreamStore()
    stream.append('ws-1', { kind: 'error', category: 'spawn_failed', message: 'codex binary not found' })

    const wrapper = mountBanner('ws-1')

    expect(wrapper.text()).toContain(en['agent.error.spawn_failed'])
    expect(wrapper.text()).toContain('codex binary not found')
  })

  it('stays silent for a quota error, which has its own surface', () => {
    const stream = useAgentStreamStore()
    stream.append('ws-2', { kind: 'error', category: 'quota', message: 'usage limit reached' })

    const wrapper = mountBanner('ws-2')

    expect(wrapper.find('.q-banner-stub').exists()).toBe(false)
  })

  it('stays silent for an informational CLI warning', () => {
    const stream = useAgentStreamStore()
    stream.append('ws-3', { kind: 'error', category: 'other', message: 'Warning: something cosmetic' })

    const wrapper = mountBanner('ws-3')

    expect(wrapper.find('.q-banner-stub').exists()).toBe(false)
  })
})
