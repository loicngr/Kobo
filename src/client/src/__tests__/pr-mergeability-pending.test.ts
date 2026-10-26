import { shallowMount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { createI18n } from 'vue-i18n'
import PrPanel from '../components/PrPanel.vue'
import WorkspaceAttentionLabels from '../components/WorkspaceAttentionLabels.vue'
import de from '../i18n/de'
import en from '../i18n/en'
import es from '../i18n/es'
import fr from '../i18n/fr'
import itLocale from '../i18n/it'
import { type PrSnapshot, useWorkspaceStore, type Workspace } from '../stores/workspace'

vi.mock('quasar', () => ({ useQuasar: () => ({ notify: vi.fn() }) }))

it('shows a translated spinner in the card and PR panel until mergeability is known', async () => {
  setActivePinia(createPinia())
  const snapshot: PrSnapshot = {
    number: 1,
    title: 'Changes',
    url: 'https://example.com/pr/1',
    state: 'OPEN',
    base: 'main',
    reviewDecision: null,
    author: { login: 'dev' },
    assignees: [],
    reviewers: [],
    labels: [],
    ci: { rollup: null, checks: [] },
    updatedAt: '',
    unresolvedReviewThreadsCount: 0,
    readyToMerge: false,
    mergeable: 'UNKNOWN',
  }
  const store = useWorkspaceStore()
  store.prSnapshots.w1 = snapshot
  const global = {
    plugins: [createI18n({ legacy: false, locale: 'fr', messages: { fr } })],
    stubs: { QChip: true, QIcon: true, QTooltip: true, QSpinner: true, QBtn: true },
  }
  const panel = shallowMount(PrPanel, { props: { snapshot }, global })
  const card = shallowMount(WorkspaceAttentionLabels, {
    props: { workspace: { id: 'w1', status: 'idle', updatedAt: '' } as Workspace },
    global,
  })
  try {
    for (const wrapper of [panel, card]) {
      expect(wrapper.text()).toContain(fr['git.pr.mergeabilityPending'])
      expect(wrapper.find('q-spinner-stub').exists()).toBe(true)
      expect(wrapper.text()).not.toContain(fr['workspaceList.attentionReadyToMerge'])
    }
    const ready = { ...snapshot, mergeable: 'MERGEABLE' as const, readyToMerge: true }
    store.prSnapshots.w1 = ready
    await panel.setProps({ snapshot: ready })
    await nextTick()
    for (const wrapper of [panel, card]) expect(wrapper.find('q-spinner-stub').exists()).toBe(false)
    expect(card.text()).toContain(fr['workspaceList.attentionReadyToMerge'])
  } finally {
    panel.unmount()
    card.unmount()
  }
})

it('provides the pending state in all supported languages', () => {
  for (const locale of [en, fr, de, es, itLocale]) {
    expect(locale['git.pr.mergeabilityPending']).toBeTruthy()
  }
})
