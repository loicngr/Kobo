import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import { createI18n } from 'vue-i18n'
import AgentBusyBanner from '../components/AgentBusyBanner.vue'
import en from '../i18n/en'
import fr from '../i18n/fr'
import { useWorkspaceStore, type Workspace } from '../stores/workspace'

function mountBanner(locale = 'en') {
  return mount(AgentBusyBanner, {
    global: {
      plugins: [createI18n({ legacy: false, locale, messages: { en, fr } })],
      provide: { openDrawerTab: () => undefined },
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
    expect(wrapper.text()).toContain('Agent is busy - 1 sub-agent running')
  })

  it('uses sous-agent in the French busy indicator', () => {
    const store = useWorkspaceStore()
    store.upsertSubagent('ws-1', { toolUseId: 'real', status: 'running' })

    const text = mountBanner('fr').text()
    expect(text).toContain("L'agent est occupé - 1 sous-agent en cours")
    expect(text).toContain('Voir les sous-agents')
  })
})
