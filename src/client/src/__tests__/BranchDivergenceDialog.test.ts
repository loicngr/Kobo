import { flushPromises, mount } from '@vue/test-utils'
import { expect, it, vi } from 'vitest'
import { createI18n } from 'vue-i18n'
import BranchDivergenceDialog from '../components/BranchDivergenceDialog.vue'
import en from '../i18n/en'

const fetchBranchDivergence = vi.hoisted(() => vi.fn())
vi.mock('../stores/workspace', () => ({ useWorkspaceStore: () => ({ fetchBranchDivergence }) }))
it('opens ahead and behind commits in new tabs without modifying the chat', async () => {
  const sha = 'a'.repeat(40)
  const commit = { sha, shortSha: 'aaaaaaa', subject: 'Change', author: 'Author', date: '2026-11-10', isPushed: true }
  fetchBranchDivergence.mockResolvedValue({ ahead: [commit], behind: [commit] })
  const wrapper = mount(BranchDivergenceDialog, {
    props: {
      modelValue: false,
      workspaceId: 'ws',
      initialTab: 'ahead',
      aheadCount: 1,
      behindCount: 1,
      sourceBranch: 'main',
      workingBranch: 'feature',
    },
    global: {
      plugins: [createI18n({ legacy: false, locale: 'en', messages: { en } })],
      stubs: Object.fromEntries(
        ['QDialog', 'QCard', 'QCardSection', 'QTabs', 'QTabPanels', 'QTabPanel', 'QCardActions'].map((name) => [
          name,
          { template: '<div><slot /></div>' },
        ]),
      ),
    },
  })
  await wrapper.setProps({ modelValue: true })
  await flushPromises()
  const links = wrapper.findAll('a.commit-item')
  expect(links).toHaveLength(2)
  for (const link of links) {
    expect(link.attributes('href')).toBe(`/api/workspaces/ws/commits/${sha}/open`)
    expect(link.attributes('target')).toBe('_blank')
    expect(link.attributes('rel')).toContain('noopener')
  }
  expect(wrapper.emitted('append-sha')).toBeUndefined()
  wrapper.unmount()
})
