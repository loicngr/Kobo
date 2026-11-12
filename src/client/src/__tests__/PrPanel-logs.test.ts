import { mount } from '@vue/test-utils'
import { expect, it } from 'vitest'
import { createI18n } from 'vue-i18n'
import CiJobLogsDialog from '../components/CiJobLogsDialog.vue'
import PrPanel from '../components/PrPanel.vue'
import en from '../i18n/en'
import type { PrSnapshot } from '../stores/workspace'

const snapshot: PrSnapshot = {
  number: 42,
  title: 'A PR',
  url: 'https://github.com/o/r/pull/42',
  state: 'OPEN',
  base: 'main',
  reviewDecision: null,
  author: { login: 'author' },
  assignees: [],
  reviewers: [],
  labels: [],
  ci: {
    rollup: 'FAILURE',
    checks: [
      {
        name: 'Tests',
        status: 'COMPLETED',
        conclusion: 'FAILURE',
        detailsUrl: 'https://github.com/o/r/actions/runs/1/job/2',
      },
    ],
  },
  updatedAt: '2026-11-10T00:00:00Z',
  unresolvedReviewThreadsCount: 0,
  readyToMerge: false,
}
it('keeps the log reader open on snapshot refresh and closes it for another PR or workspace', async () => {
  const wrapper = mount(PrPanel, {
    shallow: true,
    props: { snapshot, workspaceId: 'a' },
    global: {
      plugins: [createI18n({ legacy: false, locale: 'en', messages: { en } })],
      stubs: { QBtn: { template: '<button><slot /></button>' } },
    },
  })
  await wrapper.find('[icon="article"]').trigger('click')
  expect(wrapper.findComponent(CiJobLogsDialog).exists()).toBe(true)
  await wrapper.setProps({ snapshot: { ...snapshot, updatedAt: '2026-11-10T00:01:00Z' } })
  expect(wrapper.findComponent(CiJobLogsDialog).exists()).toBe(true)
  await wrapper.setProps({ snapshot: { ...snapshot, url: 'https://github.com/o/r/pull/43', number: 43 } })
  expect(wrapper.findComponent(CiJobLogsDialog).exists()).toBe(false)
  await wrapper.find('[icon="article"]').trigger('click')
  await wrapper.setProps({ workspaceId: 'b' })
  expect(wrapper.findComponent(CiJobLogsDialog).exists()).toBe(false)
  wrapper.unmount()
})

it('never links a check whose details URL is not http(s)', () => {
  const unsafe = {
    ...snapshot,
    ci: { ...snapshot.ci, checks: [{ ...snapshot.ci.checks[0], detailsUrl: 'javascript:alert(1)' }] },
  }
  const wrapper = mount(PrPanel, {
    shallow: true,
    props: { snapshot: unsafe, workspaceId: 'a' },
    global: { plugins: [createI18n({ legacy: false, locale: 'en', messages: { en } })] },
  })
  expect(wrapper.html()).not.toContain('javascript:')
  wrapper.unmount()
})
