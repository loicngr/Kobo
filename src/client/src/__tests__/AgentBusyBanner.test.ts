import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import { createI18n } from 'vue-i18n'
import AgentBusyBanner from '../components/AgentBusyBanner.vue'
import en from '../i18n/en'
import { useWorkspaceStore, type Workspace } from '../stores/workspace'

function mountBanner() {
  return mount(AgentBusyBanner, {
    global: {
      plugins: [createI18n({ legacy: false, locale: 'en', messages: { en } })],
      stubs: { 'q-spinner-dots': true, 'q-space': true },
    },
  })
}

describe('AgentBusyBanner.vue', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    const store = useWorkspaceStore()
    store.workspaces = [{ id: 'ws-1', status: 'executing' } as unknown as Workspace]
    store.selectedWorkspaceId = 'ws-1'
  })

  it('does not count an ambient task (Monitor) as a running sub-agent', () => {
    const store = useWorkspaceStore()
    store.upsertSubagent('ws-1', {
      toolUseId: 'mon',
      status: 'running',
      ambient: true,
      description: 'Wait for the new CI/CD Pipeline run',
    })
    const wrapper = mountBanner()
    expect(wrapper.text()).not.toContain('sub-agent')
  })

  it('counts only non-ambient running sub-agents', () => {
    const store = useWorkspaceStore()
    store.upsertSubagent('ws-1', { toolUseId: 'mon', status: 'running', ambient: true })
    store.upsertSubagent('ws-1', { toolUseId: 'real', status: 'running' })
    store.upsertSubagent('ws-1', { toolUseId: 'broken', status: 'failed' })
    const wrapper = mountBanner()
    expect(wrapper.text()).toContain('1 sub-agent running')
  })
})
