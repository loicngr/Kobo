import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from 'vue-i18n'
import {
  UPDATE_TRIGGER_PHASES,
  UPDATE_TRIGGER_REASONS,
  type UpdateTriggerPhase,
  type UpdateTriggerState,
} from '../../../shared/update-trigger'
import UpdateTriggerDialog from '../components/UpdateTriggerDialog.vue'
import en from '../i18n/en'
import ChangelogPage from '../pages/ChangelogPage.vue'
import { useUpdateStore } from '../stores/update'
import { useUpdateTriggerStore } from '../stores/update-trigger'

const apiFetch = vi.hoisted(() => vi.fn())
const apiFetchResponse = vi.hoisted(() => vi.fn())
vi.mock('src/utils/api', () => ({
  apiFetch,
  apiFetchResponse,
  apiResponseError: async () => new Error('http'),
}))
vi.mock('src/composables/use-tours', () => ({ useTours: () => ({ scheduleAutoRun: vi.fn() }) }))
vi.mock('vue-router', () => ({ useRouter: () => ({ back: vi.fn() }) }))

const i18n = createI18n({ legacy: false, locale: 'en', messages: { en } })
const base: UpdateTriggerState = {
  available: true,
  pending: false,
  inProgress: false,
  status: null,
  runningAgents: 0,
  busy: false,
  allowSkipBackup: true,
  allowStopAgents: true,
}
const at = '2026-11-17T10:00:00.000Z'
const slot = { template: '<div><slot /></div>' }
const stubs = {
  QDialog: { props: ['modelValue'], template: '<div v-if="modelValue"><slot /></div>' },
  QCard: slot,
  QCardSection: slot,
  QCardActions: slot,
  QLinearProgress: {
    props: ['indeterminate'],
    template: '<div role="progressbar" :data-indeterminate="indeterminate" />',
  },
  QTooltip: true,
  QIcon: true,
  QSpace: true,
  QPage: slot,
  QCheckbox: {
    props: ['modelValue', 'label'],
    emits: ['update:modelValue'],
    template:
      '<label><input type="checkbox" :checked="modelValue" @change="$emit(\'update:modelValue\', $event.target.checked)" />{{ label }}</label>',
  },
  QBtn: {
    props: ['label', 'disable', 'loading'],
    template: '<button :disabled="disable || undefined" type="button">{{ label }}<slot /></button>',
  },
  DrawerToggleButton: true,
  TourReplayButton: true,
}

function setup(state: UpdateTriggerState | null, requestId: string | null = null) {
  setActivePinia(createPinia())
  if (requestId)
    sessionStorage.setItem(
      'kobo:update-request',
      JSON.stringify({ id: requestId, version: null, seenAt: null, clickedAt: Date.now() }),
    )
  const update = useUpdateStore()
  update.currentVersion = '1.0.0'
  update.latestVersion = '1.1.0'
  const trigger = useUpdateTriggerStore()
  trigger.state = state
  return { update, trigger }
}

function mountDialog(modelValue = true) {
  return mount(UpdateTriggerDialog, { props: { modelValue }, global: { plugins: [i18n], stubs } })
}

const confirm = (w: ReturnType<typeof mountDialog>) => w.find('[data-test="update-confirm"]')

describe('UpdateTriggerDialog', () => {
  beforeEach(() => {
    sessionStorage.clear()
    apiFetch.mockReset()
    apiFetchResponse.mockReset()
  })

  it('blocks confirmation with running agents until the second checkbox is ticked', async () => {
    setup({ ...base, runningAgents: 2, busy: true })
    const w = mountDialog()
    expect(w.text()).toContain(en['updateTrigger.agentsRunning'].replace('{count}', '2'))
    expect(confirm(w).attributes('disabled')).toBeDefined()
    expect(w.text()).toContain(en['updateTrigger.stopAgentsWarning'])
    await w.find('[data-test="update-stop-agents"] input').setValue(true)
    expect(confirm(w).attributes('disabled')).toBeUndefined()
  })

  it('asks to confirm the stop when a workspace is still marked running without any agent', async () => {
    const { trigger } = setup({ ...base, busy: true })
    const start = vi.spyOn(trigger, 'start').mockResolvedValue()
    const w = mountDialog()
    expect(w.text()).toContain(en['updateTrigger.workspaceMarkedRunning'])
    expect(w.text()).not.toContain(en['updateTrigger.agentsRunning'].replace('{count}', '0'))
    expect(confirm(w).attributes('disabled')).toBeDefined()
    await w.find('[data-test="update-stop-agents"] input').setValue(true)
    expect(confirm(w).attributes('disabled')).toBeUndefined()
    await confirm(w).trigger('click')
    expect(start).toHaveBeenCalledWith({ skipBackup: false, stopAgents: true })
  })

  describe('host options', () => {
    it('always backs up, saying so, when the server does not allow skipping the backup', async () => {
      const { trigger } = setup({ ...base, allowSkipBackup: false })
      const start = vi.spyOn(trigger, 'start').mockResolvedValue()
      const w = mountDialog()
      expect(w.find('[data-test="update-backup"]').exists()).toBe(false)
      expect(w.text()).toContain(en['updateTrigger.backupAlways'])
      await confirm(w).trigger('click')
      expect(start).toHaveBeenCalledWith({ skipBackup: false, stopAgents: false })
    })

    it('offers the backup choice only when the server allows skipping it', () => {
      setup(base)
      const w = mountDialog()
      expect(w.find('[data-test="update-backup"]').exists()).toBe(true)
      expect(w.text()).not.toContain(en['updateTrigger.backupAlways'])
    })

    it('blocks a busy update, without the stop box, when the server does not allow stopping agents', () => {
      setup({ ...base, runningAgents: 1, busy: true, allowStopAgents: false })
      const w = mountDialog()
      expect(w.find('[data-test="update-stop-agents"]').exists()).toBe(false)
      expect(w.text()).toContain(en['updateTrigger.stopNotAllowed'])
      expect(w.text()).toContain(en['updateTrigger.agentsRunning'].replace('{count}', '1'))
      expect(confirm(w).attributes('disabled')).toBeDefined()
    })

    it('lets an idle update through when the server does not allow stopping agents', () => {
      setup({ ...base, allowStopAgents: false })
      const w = mountDialog()
      expect(w.text()).not.toContain(en['updateTrigger.stopNotAllowed'])
      expect(confirm(w).attributes('disabled')).toBeUndefined()
    })
  })

  it('does not ask about agents when none run', () => {
    setup(base)
    const w = mountDialog()
    expect(w.find('[data-test="update-stop-agents"]').exists()).toBe(false)
    expect(confirm(w).attributes('disabled')).toBeUndefined()
  })

  it('warns when the backup is unticked', async () => {
    setup(base)
    const w = mountDialog()
    expect(w.text()).not.toContain(en['updateTrigger.backupWarning'])
    await w.find('[data-test="update-backup"] input').setValue(false)
    expect(w.text()).toContain(en['updateTrigger.backupWarning'])
  })

  it('confirms with both booleans and switches to the loader', async () => {
    const { trigger } = setup({ ...base, runningAgents: 1, busy: true })
    const start = vi.spyOn(trigger, 'start')
    apiFetch.mockImplementation(async (_path: string, options?: { method?: string }) =>
      options?.method === 'POST' ? { id: 'req-1' } : { ...base, pending: true, runningAgents: 1, busy: true },
    )
    const w = mountDialog()
    await w.find('[data-test="update-backup"] input').setValue(false)
    await w.find('[data-test="update-stop-agents"] input').setValue(true)
    await confirm(w).trigger('click')
    await flushPromises()
    expect(start).toHaveBeenCalledWith({ skipBackup: true, stopAgents: true })
    expect(w.find('[role="progressbar"]').attributes('data-indeterminate')).toBeDefined()
    expect(w.text()).toContain(en['updateTrigger.step.waiting'])
    expect(w.find('[data-test="update-confirm"]').exists()).toBe(false)
  })

  it('shows the waiting step, never the not-started warning, while the real start is still refreshing', async () => {
    setup(base)
    let release: (value: UpdateTriggerState) => void = () => {}
    apiFetch.mockImplementation(async (_path: string, options?: { method?: string }) => {
      if (options?.method === 'POST') return { id: 'req-1' }
      return new Promise((resolve) => (release = resolve))
    })
    const w = mountDialog()
    await confirm(w).trigger('click')
    await flushPromises()
    expect(w.find('[role="status"]').text()).toContain(en['updateTrigger.step.waiting'])
    expect(w.text()).not.toContain(en['updateTrigger.result.notStarted'])
    expect(w.find('[data-test="update-dismiss"]').exists()).toBe(false)
    release({ ...base, pending: true })
    await flushPromises()
    expect(w.find('[role="status"]').text()).toContain(en['updateTrigger.step.waiting'])
  })

  it('resets the form when a foreign update comes and goes while the dialog stays open', async () => {
    const { trigger } = setup({ ...base, runningAgents: 1, busy: true })
    const w = mountDialog()
    await w.find('[data-test="update-stop-agents"] input').setValue(true)
    trigger.state = {
      ...base,
      runningAgents: 1,
      inProgress: true,
      status: { id: 'other', phase: 'building', updatedAt: at },
    }
    await flushPromises()
    expect(trigger.step).toBe('other')
    trigger.state = { ...base, runningAgents: 1, busy: true }
    await flushPromises()
    expect((w.find('[data-test="update-stop-agents"] input').element as HTMLInputElement).checked).toBe(false)
    expect(confirm(w).attributes('disabled')).toBeDefined()
  })

  it('drops a stale start error once a foreign update has ended', async () => {
    const { trigger } = setup(base)
    vi.spyOn(trigger, 'start').mockRejectedValue(Object.assign(new Error('x'), { code: 'busy' }))
    const w = mountDialog()
    await confirm(w).trigger('click')
    await flushPromises()
    expect(w.find('[role="alert"]').exists()).toBe(true)
    trigger.state = { ...base, inProgress: true, status: { id: 'other', phase: 'building', updatedAt: at } }
    await flushPromises()
    trigger.state = base
    await flushPromises()
    expect(w.find('[role="alert"]').exists()).toBe(false)
    expect(confirm(w).exists()).toBe(true)
  })

  it('resets backup, stop-agents consent and error every time the dialog opens', async () => {
    setup({ ...base, runningAgents: 1, busy: true })
    const w = mountDialog()
    await w.find('[data-test="update-backup"] input').setValue(false)
    await w.find('[data-test="update-stop-agents"] input').setValue(true)
    await w.setProps({ modelValue: false })
    await w.setProps({ modelValue: true })
    expect((w.find('[data-test="update-backup"] input').element as HTMLInputElement).checked).toBe(true)
    expect((w.find('[data-test="update-stop-agents"] input').element as HTMLInputElement).checked).toBe(false)
    expect(confirm(w).attributes('disabled')).toBeDefined()
    expect(w.text()).not.toContain(en['updateTrigger.backupWarning'])
  })

  it.each([
    ['busy', 'updateTrigger.reason.busy'],
    ['pending', 'updateTrigger.reason.alreadyRunning'],
    ['in-progress', 'updateTrigger.reason.alreadyRunning'],
    ['unavailable', 'updateTrigger.error.unavailable'],
    ['not-allowed', 'updateTrigger.error.notAllowed'],
  ] as const)('shows the text of the %s refusal and keeps the form', async (code, key) => {
    const { trigger } = setup(base)
    vi.spyOn(trigger, 'start').mockRejectedValue(Object.assign(new Error('x'), { code }))
    const w = mountDialog()
    await confirm(w).trigger('click')
    await flushPromises()
    expect(w.find('[role="alert"]').text()).toBe(en[key])
    expect(confirm(w).exists()).toBe(true)
  })

  it.each(['constructor', 'toString', 'something-new'])(
    'shows the generic refusal text for the unknown code %s',
    async (code) => {
      const { trigger } = setup(base)
      vi.spyOn(trigger, 'start').mockRejectedValue(Object.assign(new Error('x'), { code }))
      const w = mountDialog()
      await confirm(w).trigger('click')
      await flushPromises()
      expect(w.find('[role="alert"]').text()).toBe(en['updateTrigger.reason.unknown'])
    },
  )

  it('says the outcome is unknown after a network failure, unless a refresh then shows an update under way', async () => {
    const { trigger } = setup(base)
    vi.spyOn(trigger, 'start').mockRejectedValue(new Error('Failed to fetch'))
    apiFetch.mockResolvedValue(base)
    const w = mountDialog()
    await confirm(w).trigger('click')
    await flushPromises()
    expect(w.find('[role="alert"]').text()).toBe(en['updateTrigger.error.network'])
    const second = setup(base)
    vi.spyOn(second.trigger, 'start').mockRejectedValue(new Error('timeout'))
    apiFetch.mockResolvedValue({ ...base, pending: true })
    const w2 = mountDialog()
    await confirm(w2).trigger('click')
    await flushPromises()
    expect(w2.find('[role="alert"]').text()).toBe(en['updateTrigger.reason.alreadyRunning'])
  })

  it.each([
    ['complete', 'updateTrigger.result.completeNoVersion'],
    ['up-to-date', 'updateTrigger.result.upToDate'],
    ['aborted', 'updateTrigger.result.aborted'],
    ['recovery-required', 'updateTrigger.result.recoveryRequired'],
  ] as Array<[UpdateTriggerPhase, keyof typeof en]>)('renders the %s result', (phase, key) => {
    setup({ ...base, status: { id: 'req-1', phase, updatedAt: at } }, 'req-1')
    const w = mountDialog()
    expect(w.find('[role="status"]').text()).toContain(en[key])
    expect(w.find('[data-test="update-dismiss"]').exists()).toBe(true)
  })

  it('renders the done text with the new version', () => {
    sessionStorage.setItem(
      'kobo:update-request',
      JSON.stringify({ id: 'req-1', version: '1.0.0', seenAt: Date.now() - 6 * 60_000 }),
    )
    setActivePinia(createPinia())
    useUpdateStore().currentVersion = '1.1.0'
    useUpdateTriggerStore().state = base
    const w = mountDialog()
    expect(w.find('[role="status"]').text()).toContain(
      en['updateTrigger.result.complete'].replace('{version}', '1.1.0'),
    )
  })

  it.each([
    ['busy', 'updateTrigger.reason.busy'],
    ['already-running', 'updateTrigger.reason.alreadyRunning'],
    ['interrupted-update', 'updateTrigger.reason.interruptedUpdate'],
    ['legacy-runtime', 'updateTrigger.reason.legacyRuntime'],
    ['unknown', 'updateTrigger.reason.unknown'],
  ] as const)('renders the refused reason %s', (reason, key) => {
    setup({ ...base, status: { id: 'req-1', phase: 'refused', reason, updatedAt: at } }, 'req-1')
    expect(mountDialog().find('[role="status"]').text()).toContain(en[key])
  })

  it('covers every phase and reason of the shared unions with a message', () => {
    for (const reason of UPDATE_TRIGGER_REASONS) {
      setup({ ...base, status: { id: 'r', phase: 'refused', reason, updatedAt: at } }, 'r')
      expect(mountDialog().find('[role="status"]').text()).not.toBe('')
    }
    for (const phase of UPDATE_TRIGGER_PHASES) {
      setup({ ...base, inProgress: true, status: { id: 'r', phase, updatedAt: at } }, 'r')
      expect(mountDialog().find('[role="status"]').text()).not.toBe('')
    }
  })

  it('renders the not-started text and dismisses it', async () => {
    const { trigger } = setup(base, 'req-1')
    const w = mountDialog()
    expect(w.find('[role="status"]').text()).toContain(en['updateTrigger.result.notStarted'])
    await w.find('[data-test="update-dismiss"]').trigger('click')
    expect(trigger.requestId).toBeNull()
  })

  it('renders the lost text with a close button', () => {
    setup({ ...base, status: { id: 'req-1', phase: 'building', updatedAt: at } }, 'req-1')
    const w = mountDialog()
    expect(w.find('[role="status"]').text()).toContain(en['updateTrigger.result.lost'])
    expect(w.find('[data-test="update-dismiss"]').exists()).toBe(true)
  })

  it('renders reconnecting with the sign-in hint', async () => {
    const { trigger } = setup({ ...base, inProgress: true }, 'req-1')
    apiFetch.mockRejectedValue(new Error('Failed to fetch'))
    await trigger.refresh()
    const w = mountDialog()
    expect(w.text()).toContain(en['updateTrigger.step.reconnecting'])
    expect(w.text()).toContain(en['updateTrigger.signInAgain'])
  })

  it('keeps one live region, rendered even when idle, without repeating the status sentence in the bar label', () => {
    setup({ ...base, pending: true }, 'req-1')
    const w = mountDialog()
    expect(w.findAll('[role="status"]')).toHaveLength(1)
    const label = w.find('[role="progressbar"]').attributes('aria-label') ?? ''
    expect(w.find('[role="status"]').text()).not.toContain(label)
  })
})

describe('ChangelogPage update button', () => {
  beforeEach(() => {
    sessionStorage.clear()
    apiFetch.mockReset()
    apiFetchResponse.mockReset()
    apiFetchResponse.mockResolvedValue({
      ok: true,
      json: async () => ({ currentVersion: '1.0.0', versions: [] }),
    })
  })
  afterEach(() => vi.useRealTimers())

  async function page(
    state: UpdateTriggerState,
    latest: string | null,
    dismissed = false,
    requestId: string | null = null,
  ) {
    if (dismissed && latest) localStorage.setItem('kobo:dismissed-update-version', latest)
    const { update } = setup(null, requestId)
    update.latestVersion = latest
    apiFetch.mockResolvedValue(state)
    const w = mount(ChangelogPage, { global: { plugins: [i18n], stubs } })
    await flushPromises()
    return w
  }

  it('is absent when the updater is unavailable or no newer version is known', async () => {
    expect((await page({ ...base, available: false }, '1.1.0')).find('[data-tour="changelog-update"]').exists()).toBe(
      false,
    )
    expect((await page(base, '1.0.0')).find('[data-tour="changelog-update"]').exists()).toBe(false)
    expect((await page(base, null)).find('[data-tour="changelog-update"]').exists()).toBe(false)
  })

  it('is present, also when the banner version was dismissed', async () => {
    const w = await page(base, '1.1.0', true)
    const anchor = w.find('[data-tour="changelog-update"]')
    expect(anchor.exists()).toBe(true)
    expect(anchor.text()).toContain(en['updateTrigger.available'].replace('{version}', '1.1.0'))
    expect(anchor.text()).toContain(en['updateTrigger.button'])
  })

  it('hides the button while our own update is in progress, even long after the last poll', async () => {
    const w = await page(
      { ...base, inProgress: true, status: { id: 'req-1', phase: 'building', updatedAt: at } },
      '1.1.0',
      false,
      'req-1',
    )
    expect(w.text()).toContain(en['updateTrigger.step.building'])
    expect(w.find('[data-tour="changelog-update"]').exists()).toBe(false)
  })

  it('replaces the button by a neutral line, without close button, for an update that is not ours', async () => {
    const w = await page(
      { ...base, inProgress: true, status: { id: 'other', phase: 'building', updatedAt: at } },
      '1.1.0',
    )
    expect(w.find('[data-tour="changelog-update"]').exists()).toBe(false)
    expect(w.text()).toContain(en['updateTrigger.otherInProgress'])
    expect(w.text()).not.toContain(en['updateTrigger.step.building'])
    expect(w.find('[data-test="update-dismiss"]').exists()).toBe(false)
  })

  it('dismisses a leftover result and opens the form with one click', async () => {
    const w = await page({ ...base, status: { id: 'req-1', phase: 'aborted', updatedAt: at } }, '1.1.0', false, 'req-1')
    expect(w.text()).toContain(en['updateTrigger.result.aborted'])
    await w.find('[data-tour="changelog-update"] button').trigger('click')
    await flushPromises()
    expect(useUpdateTriggerStore().requestId).toBeNull()
    expect(w.find('[data-test="update-confirm"]').exists()).toBe(true)
  })

  describe('a done of ours while a newer version is available', () => {
    const request = (seenAt: number | null) =>
      sessionStorage.setItem('kobo:update-request', JSON.stringify({ id: 'req-1', version: '0.9.0', seenAt }))

    it('keeps a provisional done, announced without the final report, when the form is opened', async () => {
      request(Date.now() - 6 * 60_000)
      const w = await page(base, '1.1.0')
      expect(w.text()).toContain(en['updateTrigger.result.complete'].replace('{version}', '1.0.0'))
      await w.find('[data-tour="changelog-update"] button').trigger('click')
      await flushPromises()
      expect(useUpdateTriggerStore().requestId).toBe('req-1')
      expect(w.find('[data-test="update-confirm"]').exists()).toBe(false)
    })

    it('dismisses a done backed by our complete report and opens the form with one click', async () => {
      request(null)
      const w = await page({ ...base, status: { id: 'req-1', phase: 'complete', updatedAt: at } }, '1.1.0')
      expect(w.text()).toContain(en['updateTrigger.result.complete'].replace('{version}', '1.0.0'))
      await w.find('[data-tour="changelog-update"] button').trigger('click')
      await flushPromises()
      expect(useUpdateTriggerStore().requestId).toBeNull()
      expect(w.find('[data-test="update-confirm"]').exists()).toBe(true)
    })
  })

  it('renders a single live region while the dialog is open', async () => {
    const w = await page({ ...base, pending: true }, '1.1.0', false, 'req-1')
    expect(w.findAll('[role="status"]')).toHaveLength(1)
    await w.find('[data-tour="changelog-update"] button').trigger('click')
    await flushPromises()
    expect(w.findAll('[role="status"]')).toHaveLength(1)
  })

  it('stops polling when the page unmounts', async () => {
    vi.useFakeTimers()
    const w = await page(base, '1.1.0')
    const calls = apiFetch.mock.calls.length
    await vi.advanceTimersByTimeAsync(5000)
    expect(apiFetch.mock.calls.length).toBeGreaterThan(calls)
    w.unmount()
    const after = apiFetch.mock.calls.length
    await vi.advanceTimersByTimeAsync(60_000)
    expect(apiFetch.mock.calls.length).toBe(after)
  })
})
