import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { reactive } from 'vue'
import { createI18n } from 'vue-i18n'
import type { ProviderAccounts } from '../../../shared/provider-accounts'
import QuotaFooter from '../components/QuotaFooter.vue'
import en from '../i18n/en'
import { apiFetch } from '../utils/api'

const { workspaceMock } = vi.hoisted(() => ({ workspaceMock: vi.fn() }))
vi.mock('../stores/workspace', () => ({ useWorkspaceStore: workspaceMock }))
vi.mock('../utils/api', () => ({ apiFetch: vi.fn() }))
const accounts: ProviderAccounts = {
  available: true,
  accounts: [
    { id: '1', email: 'one@example.com', label: 'Personal', active: true, disabled: false },
    { id: '2', email: 'two@example.com', label: 'Work', active: false, disabled: false },
    { id: '3', email: 'off@example.com', label: 'Disabled', active: false, disabled: true },
  ],
}
const quota = {
  status: 'ok',
  fetchedAt: '2026-10-14T10:00:00Z',
  buckets: [{ id: 'five_hour', label: '5-hour', usedPct: 42, resetsAt: null }],
}
function makeStore() {
  return reactive({
    selectedWorkspace: { id: 'w1', engine: 'claude-code' },
    selectedSessionId: 's1',
    sessions: [
      { id: 's1', workspaceId: 'w1', engine: 'claude-code' },
      { id: 's2', workspaceId: 'w1', engine: 'codex' },
    ],
    providerUsage: { 'claude-code': quota },
    currentProviderUsage: quota,
    requestUsageRefresh: vi.fn().mockResolvedValue(undefined),
  })
}
let store: ReturnType<typeof makeStore>
const wrappers: ReturnType<typeof mount>[] = []
function panel() {
  const wrapper = mount(QuotaFooter, {
    global: {
      plugins: [
        createI18n({
          legacy: false,
          locale: 'en',
          flatJson: true,
          messages: {
            en: Object.fromEntries(
              Object.entries(en).filter(
                ([key]) => key.startsWith('quotaFooter.') || key.startsWith('stats.usageBucket'),
              ),
            ),
          },
        }),
      ],
      stubs: {
        QMenu: { props: ['modelValue'], template: '<div v-if="modelValue" data-menu><slot /></div>' },
        QBtn: {
          props: ['label', 'disable', 'loading'],
          template: '<button :disabled="disable || loading">{{ label }}<slot /></button>',
        },
        QSelect: {
          props: ['modelValue', 'options', 'disable', 'label'],
          emits: ['update:modelValue'],
          template:
            '<select :value="modelValue" :disabled="disable" :aria-label="label" @change="$emit(\'update:modelValue\', $event.target.value)"><option value=""></option><option v-for="option in options" :key="option.id" :value="option.id" :disabled="option.disabled">{{ option.label }}</option></select>',
        },
        QLinearProgress: { props: ['value'], template: '<div role="progressbar" :aria-valuenow="value" />' },
        QIcon: true,
        QSeparator: true,
        QSpinner: true,
      },
    },
  })
  wrappers.push(wrapper)
  return wrapper
}
async function open(wrapper: ReturnType<typeof panel>) {
  await wrapper.get('[data-action="usage-menu"]').trigger('click')
  await flushPromises()
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}
beforeEach(() => {
  vi.clearAllMocks()
  store = makeStore()
  workspaceMock.mockReturnValue(store)
  vi.mocked(apiFetch).mockReset().mockResolvedValue(accounts)
})
afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount()
})
describe('QuotaFooter', () => {
  it('keeps compact quota progress bars large enough to read in the footer', () => {
    const source = readFileSync(join(process.cwd(), 'src/components/QuotaFooter.vue'), 'utf-8')
    expect(source).toMatch(/\.quota-bar\s*\{[\s\S]*?width:\s*48px;[\s\S]*?height:\s*7px;/)
  })
  it('keeps Claude quotas and hides every account control when ccswap is absent', async () => {
    vi.mocked(apiFetch).mockResolvedValue({ available: false, accounts: [] })
    const wrapper = panel()
    await flushPromises()
    await open(wrapper)
    expect(wrapper.text()).toContain('42%')
    expect(wrapper.text()).toContain('Claude Code usage')
    expect(wrapper.find('select').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('ccswap')
  })
  it('hides the entire Codex footer when ccswap is absent without showing Claude quotas', async () => {
    store.selectedSessionId = 's2'
    vi.mocked(apiFetch).mockResolvedValue({ available: false, accounts: [] })
    const wrapper = panel()
    await flushPromises()
    expect(apiFetch).toHaveBeenCalledWith('/api/usage/codex/accounts', expect.objectContaining({ timeoutMs: 45_000 }))
    expect(wrapper.find('[data-action="usage-menu"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('42%')
  })
  it('selects the viewed session engine and switches only after an explicit action', async () => {
    store.selectedSessionId = 's2'
    const wrapper = panel()
    await flushPromises()
    await open(wrapper)
    expect(wrapper.text()).toContain('Codex accounts')
    expect(wrapper.text()).toContain('one@example.com')
    expect(wrapper.text()).toContain('all Codex workspaces')
    expect(wrapper.text()).not.toContain('42%')
    expect(wrapper.get('[data-action="switch-account"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('option[value="3"]').attributes('disabled')).toBeDefined()
    await wrapper.get('select').setValue('2')
    expect(vi.mocked(apiFetch).mock.calls.every(([, options]) => options?.method !== 'POST')).toBe(true)
    vi.mocked(apiFetch).mockResolvedValueOnce({
      ...accounts,
      accounts: accounts.accounts.map((a) => ({ ...a, active: a.id === '2' })),
    })
    await wrapper.get('[data-action="switch-account"]').trigger('click')
    await flushPromises()
    expect(apiFetch).toHaveBeenLastCalledWith(
      '/api/usage/codex/accounts/switch',
      expect.objectContaining({ method: 'POST', body: { accountId: '2' }, timeoutMs: 120_000 }),
    )
    expect(wrapper.get('[data-current-account]').text()).toContain('two@example.com')
    expect(store.requestUsageRefresh).not.toHaveBeenCalled()
  })
  it('falls back to the workspace engine and refreshes accounts only when opened', async () => {
    store.selectedSessionId = 'missing'
    store.selectedWorkspace.engine = 'codex'
    const wrapper = panel()
    await flushPromises()
    expect(apiFetch).toHaveBeenCalledTimes(1)
    await open(wrapper)
    expect(apiFetch).toHaveBeenCalledTimes(2)
    await wrapper.get('[data-action="usage-menu"]').trigger('click')
    await open(wrapper)
    expect(apiFetch).toHaveBeenCalledTimes(3)
  })
  it('reloads accounts after a switch failure, clears selection and never renders raw errors', async () => {
    const wrapper = panel()
    await flushPromises()
    await open(wrapper)
    await wrapper.get('select').setValue('2')
    vi.mocked(apiFetch).mockRejectedValueOnce(new Error('secret cli output'))
    await wrapper.get('[data-action="switch-account"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('Could not confirm the account switch')
    expect(wrapper.text()).not.toContain('secret cli output')
    expect(wrapper.get('[data-action="switch-account"]').attributes('disabled')).toBeDefined()
    expect(vi.mocked(apiFetch).mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1)
    expect(apiFetch).toHaveBeenLastCalledWith('/api/usage/claude-code/accounts', expect.anything())
  })
  it('ignores a stale discovery response after navigating to another provider', async () => {
    const pending = deferred<ProviderAccounts>()
    vi.mocked(apiFetch).mockReturnValueOnce(pending.promise).mockResolvedValue({ available: false, accounts: [] })
    const wrapper = panel()
    store.selectedSessionId = 's2'
    await flushPromises()
    pending.resolve(accounts)
    await flushPromises()
    expect(wrapper.find('[data-action="usage-menu"]').exists()).toBe(false)
  })
  it('ignores a stale failed switch after navigation even to the same provider', async () => {
    const wrapper = panel()
    await flushPromises()
    await open(wrapper)
    await wrapper.get('select').setValue('2')
    const pending = deferred<ProviderAccounts>()
    vi.mocked(apiFetch).mockReturnValueOnce(pending.promise)
    await wrapper.get('[data-action="switch-account"]').trigger('click')
    store.selectedWorkspace = { id: 'w2', engine: 'claude-code' }
    await flushPromises()
    await open(wrapper)
    const callCount = vi.mocked(apiFetch).mock.calls.length
    pending.reject(new Error('old error'))
    await flushPromises()
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    expect(apiFetch).toHaveBeenCalledTimes(callCount)
  })
  it('does not reload after an in-flight switch fails following unmount', async () => {
    const wrapper = panel()
    await flushPromises()
    await open(wrapper)
    await wrapper.get('select').setValue('2')
    const pending = deferred<ProviderAccounts>()
    vi.mocked(apiFetch).mockReturnValueOnce(pending.promise)
    await wrapper.get('[data-action="switch-account"]').trigger('click')
    const callCount = vi.mocked(apiFetch).mock.calls.length
    wrapper.unmount()
    pending.reject(new Error('late error'))
    await flushPromises()
    expect(apiFetch).toHaveBeenCalledTimes(callCount)
  })
  it('reuses pending discovery when opening the menu', async () => {
    const pending = deferred<ProviderAccounts>()
    vi.mocked(apiFetch).mockReturnValueOnce(pending.promise)
    const wrapper = panel()
    await open(wrapper)
    expect(apiFetch).toHaveBeenCalledTimes(1)
    pending.resolve(accounts)
    await flushPromises()
    expect(wrapper.get('[data-current-account]').text()).toContain('one@example.com')
  })
  it('clears cached Claude quotas before switching even without a websocket update', async () => {
    const wrapper = panel()
    await flushPromises()
    await open(wrapper)
    await wrapper.get('select').setValue('2')
    await wrapper.get('[data-action="switch-account"]').trigger('click')
    await flushPromises()
    expect(wrapper.text()).not.toContain('42%')
    expect(store.providerUsage['claude-code']).toBeUndefined()
  })
  it('ignores sessions belonging to the previous workspace during navigation', async () => {
    store.selectedSessionId = 's2'
    store.selectedWorkspace = { id: 'w2', engine: 'claude-code' }
    const wrapper = panel()
    await flushPromises()
    expect(apiFetch).toHaveBeenCalledWith('/api/usage/claude-code/accounts', expect.anything())
    await open(wrapper)
    expect(wrapper.text()).toContain('Claude Code usage')
  })
  it('shows an empty account state and does not assume the active login', async () => {
    vi.mocked(apiFetch).mockResolvedValue({ available: true, accounts: [] })
    const wrapper = panel()
    await flushPromises()
    await open(wrapper)
    expect(wrapper.text()).toContain('No saved Claude Code accounts')
    expect(wrapper.get('[data-current-account]').text()).toContain('not recognized')
    expect(wrapper.get('[data-action="switch-account"]').attributes('disabled')).toBeDefined()
  })
  it('shows a safe load error without retrying automatically', async () => {
    vi.mocked(apiFetch).mockRejectedValue(new Error('secret output'))
    const wrapper = panel()
    await flushPromises()
    await open(wrapper)
    expect(wrapper.get('[role="alert"]').text()).toContain('Could not load accounts')
    expect(wrapper.text()).not.toContain('secret output')
    expect(wrapper.find('select').exists()).toBe(false)
    expect(apiFetch).toHaveBeenCalledTimes(2)
  })
  it('rejects disabled and currently active selections and blocks duplicate clicks while switching', async () => {
    const wrapper = panel()
    await flushPromises()
    await open(wrapper)
    for (const id of ['1', '3']) {
      await wrapper.get('select').setValue(id)
      expect(wrapper.get('[data-action="switch-account"]').attributes('disabled')).toBeDefined()
    }
    await wrapper.get('select').setValue('2')
    const pending = deferred<ProviderAccounts>()
    vi.mocked(apiFetch).mockReturnValueOnce(pending.promise)
    await wrapper.get('[data-action="switch-account"]').trigger('click')
    expect(wrapper.get('select').attributes('disabled')).toBeDefined()
    await wrapper.get('[data-action="switch-account"]').trigger('click')
    expect(vi.mocked(apiFetch).mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1)
    pending.resolve(accounts)
    await flushPromises()
  })
  it('explains unsupported authentication environments without exposing backend output', async () => {
    vi.mocked(apiFetch).mockRejectedValue(
      Object.assign(new Error('secret path'), { code: 'accounts_unsupported_environment' }),
    )
    const wrapper = panel()
    await flushPromises()
    await open(wrapper)
    expect(wrapper.get('[role="alert"]').text()).toContain('This authentication configuration does not support')
    expect(wrapper.text()).not.toContain('secret path')
  })
})
