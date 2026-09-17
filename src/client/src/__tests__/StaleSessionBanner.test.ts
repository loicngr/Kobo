import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, expect, it } from 'vitest'
import { createI18n } from 'vue-i18n'
import StaleSessionBanner from '../components/StaleSessionBanner.vue'
import en from '../i18n/en'
import { type AgentSession, useWorkspaceStore } from '../stores/workspace'

function session(id: string, startedAt: string, endedAt: string | null, status = 'completed'): AgentSession {
  return { id, workspaceId: 'ws-1', startedAt, endedAt, status, pid: null, engineSessionId: id, name: null }
}
function mountBanner() {
  return mount(StaleSessionBanner, {
    props: { workspaceId: 'ws-1' },
    global: {
      plugins: [createI18n({ legacy: false, locale: 'en', messages: { en } })],
      stubs: {
        'q-banner': { template: '<div class="banner"><slot /><slot name="action" /></div>' },
        'q-icon': true,
        'q-btn': { template: '<button />' },
      },
    },
  })
}
beforeEach(() => {
  setActivePinia(createPinia())
  const store = useWorkspaceStore()
  store.selectedWorkspaceId = 'ws-1'
  store.selectedSessionId = 'original'
  store.sessions = [
    session('review', '2026-09-17T10:00:00Z', '2026-09-17T10:05:00Z'),
    session('original', '2026-09-17T09:00:00Z', '2026-09-17T10:06:00Z'),
  ]
})

it('recognizes the returned original session after completion and reload without live events', () => {
  const view = mountBanner()
  expect(view.find('.banner').exists()).toBe(false)
  view.unmount()
})

it('recognizes the original session while the review summary is running', () => {
  const store = useWorkspaceStore()
  store.sessions[1]!.status = 'running'
  store.sessions[1]!.endedAt = null
  const view = mountBanner()
  expect(view.find('.banner').exists()).toBe(false)
  view.unmount()
})

it('jumps from the temporary review to the returned original conversation', async () => {
  const store = useWorkspaceStore()
  store.selectedSessionId = 'review'
  const view = mountBanner()
  expect(view.find('.banner').exists()).toBe(true)
  await view.find('button').trigger('click')
  expect(store.selectedSessionId).toBe('original')
  view.unmount()
})

it('keeps warning when the user views an older session without a return', () => {
  useWorkspaceStore().sessions[1]!.endedAt = '2026-09-17T09:05:00Z'
  const view = mountBanner()
  expect(view.find('.banner').exists()).toBe(true)
  view.unmount()
})
