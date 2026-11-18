import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
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

describe('CI durations', () => {
  const T0 = '2026-11-18T10:00:00Z'
  const iso = (seconds: number) => new Date(Date.parse(T0) + seconds * 1000).toISOString()
  const check = (
    name: string,
    status: string,
    conclusion: string | null,
    startedAt?: string | null,
    completedAt?: string | null,
  ) => ({
    name,
    status,
    conclusion,
    detailsUrl: null,
    ...(startedAt === undefined ? {} : { startedAt, completedAt }),
  })
  const timedSnapshot = (): PrSnapshot => ({
    ...snapshot,
    ci: {
      rollup: 'FAILURE',
      checks: [
        check('Failed', 'COMPLETED', 'FAILURE', iso(0), iso(25)),
        check('Running', 'IN_PROGRESS', null, iso(20), null),
        check('Waiting', 'QUEUED', null, null, null),
        check('Passed', 'COMPLETED', 'SUCCESS', iso(10), iso(25)),
      ],
    },
  })
  const render = (props: { snapshot: PrSnapshot }) =>
    mount(PrPanel, {
      shallow: true,
      props: { ...props, workspaceId: 'a' },
      global: {
        plugins: [createI18n({ legacy: false, locale: 'en', messages: { en } })],
        stubs: { CiDuration: false },
      },
    })
  const rows = (wrapper: ReturnType<typeof render>) =>
    wrapper.findAll('.pr-panel__ci-item').map((row) => row.text().replace(/\s+/g, ' ').trim())

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(iso(30)))
    Object.defineProperty(document, 'hidden', { configurable: true, value: false })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows each check duration and a wall-clock total that ticks while a check runs', async () => {
    const wrapper = render({ snapshot: timedSnapshot() })
    ;(wrapper.vm as unknown as { showPassed: boolean }).showPassed = true
    await nextTick()
    expect(rows(wrapper)).toEqual([
      expect.stringMatching(/Failed\s*· 25 s/),
      expect.stringMatching(/Running\s*· 10 s/),
      expect.not.stringContaining(' · '),
      expect.stringMatching(/Passed\s*· 15 s/),
    ])
    // earliest start (0) to now (30), as the running check is still unfinished.
    expect(wrapper.find('.pr-panel__ci-total').text()).toBe('Total: 30 s')
    await vi.advanceTimersByTimeAsync(3000)
    expect(rows(wrapper)[1]).toMatch(/Running\s*· 13 s/)
    expect(wrapper.find('.pr-panel__ci-total').text()).toBe('Total: 33 s')
    wrapper.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('has no clock once every check is finished and the total is wall-clock, not a sum', () => {
    const done = timedSnapshot()
    done.ci.checks = done.ci.checks.filter((c) => c.name !== 'Running' && c.name !== 'Waiting')
    const wrapper = render({ snapshot: done })
    expect(vi.getTimerCount()).toBe(0)
    expect(wrapper.find('.pr-panel__ci-total').text()).toBe('Total: 25 s')
    wrapper.unmount()
  })

  it('a clock tick does not re-render the panel, only the running durations', async () => {
    const wrapper = render({ snapshot: timedSnapshot() })
    const instance = wrapper.vm.$ as unknown as { render: (...args: unknown[]) => unknown }
    const original = instance.render
    let renders = 0
    instance.render = (...args: unknown[]) => {
      renders++
      return original(...args)
    }
    await vi.advanceTimersByTimeAsync(3000)
    expect(renders).toBe(0)
    expect(rows(wrapper)[1]).toMatch(/Running\s*· 13 s/)
    expect(wrapper.find('.pr-panel__ci-total').text()).toBe('Total: 33 s')
    wrapper.unmount()
  })

  it('renders a status-less check (commit status) without throwing, with no duration and no timer', () => {
    const odd = {
      ...snapshot,
      ci: { rollup: 'PENDING', checks: [{ name: 'ctx', conclusion: null, detailsUrl: null, startedAt: iso(0) }] },
    }
    const wrapper = render({ snapshot: odd as unknown as PrSnapshot })
    expect(rows(wrapper)[0]).not.toContain(' · ')
    expect(wrapper.find('.pr-panel__ci-total').exists()).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    wrapper.unmount()
  })

  it.each(['CLOSED', 'MERGED'] as const)('has no clock and no running time when the PR is %s', async (state) => {
    const stale = timedSnapshot()
    stale.state = state
    const wrapper = render({ snapshot: stale })
    expect(vi.getTimerCount()).toBe(0)
    expect(rows(wrapper)[1]).not.toContain(' · ')
    // total only from finished checks: Failed 0..25 (Passed hidden but counted 10..25)
    expect(wrapper.find('.pr-panel__ci-total').text()).toBe('Total: 25 s')
    await vi.advanceTimersByTimeAsync(3000)
    expect(wrapper.find('.pr-panel__ci-total').text()).toBe('Total: 25 s')
    wrapper.unmount()
  })

  it('renders exactly as today for a snapshot without dates', () => {
    const wrapper = render({ snapshot })
    expect(wrapper.find('.pr-panel__ci-total').exists()).toBe(false)
    expect(rows(wrapper)[0]).toMatch(/^Tests/)
    expect(rows(wrapper)[0]).not.toContain(' · ')
    expect(vi.getTimerCount()).toBe(0)
    wrapper.unmount()
  })
})
