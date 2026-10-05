import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from 'vue-i18n'
import { createMemoryHistory, createRouter } from 'vue-router'
import MemoryPanel from '../components/MemoryPanel.vue'
import en from '../i18n/en'
import { useMemoryStore } from '../stores/memory'

const router = createRouter({
  history: createMemoryHistory(),
  routes: [
    { path: '/', component: { template: '<div />' } },
    { path: '/settings', name: 'settings', component: { template: '<div />' } },
  ],
})
const global = {
  plugins: [createI18n({ legacy: false, locale: 'en', messages: { en } }), router],
  stubs: { QDialog: { props: ['modelValue'], template: '<div v-if="modelValue"><slot /></div>' } },
}
const scope = { id: 'workspace-scope', level: 'workspace' as const, workspaceId: 'ws-1', generation: 0, revision: 1 }
const entry = {
  id: 'entry-1',
  scopeId: scope.id,
  key: 'goal',
  title: 'Goal',
  body: 'Current text',
  revision: 2,
  actor: { kind: 'human' as const },
  createdAt: 'now',
  updatedAt: 'now',
}
const context = {
  id: 'ctx-1',
  workspaceId: 'ws-1',
  sessionId: 'session-current',
  dispatchId: 'dispatch-1',
  engine: 'codex' as const,
  state: 'initialized' as const,
  entryRevisions: [{ id: 'entry-1', revision: 2 }],
  omittedCount: 3,
  estimatedTokens: 42,
  createdAt: '2026-10-05T00:00:00.000Z',
  updatedAt: '2026-10-05T00:00:01.000Z',
  payloadBytes: 180,
  budgetContextId: 'budget-1',
  budgetEpoch: 0,
  cumulativeEstimatedTokens: 123,
  remainingEstimatedTokens: 5877,
  limitTokens: 6000,
  entryStates: [{ id: 'entry-1', revision: 2, state: 'current' as const, title: 'Goal', body: 'Current text' }],
}

function view(workspaceId: string, sessionId: string, overrides: Record<string, unknown> = {}) {
  return {
    scopes: [{ ...scope, id: `scope-${workspaceId}`, workspaceId }],
    entries: [{ ...entry, scopeId: `scope-${workspaceId}`, title: `Goal ${workspaceId}` }],
    proposals: [
      {
        id: `proposal-${workspaceId}`,
        scopeId: `scope-${workspaceId}`,
        key: 'shared',
        title: `Proposal ${workspaceId}`,
        body: 'Pending',
        actor: { kind: 'human' },
        createdAt: 'now',
      },
    ],
    contexts: [
      {
        ...context,
        workspaceId,
        sessionId,
        entryStates: [{ ...context.entryStates[0], title: `Goal ${workspaceId}` }],
      },
    ],
    ...overrides,
  }
}

describe('MemoryPanel', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('moves all memory actions to a dialog and back without losing the editor draft', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) =>
        Promise.resolve(
          Response.json(String(input).includes('/operations?') ? { items: [] } : view('ws-1', 'session-current')),
        ),
      ),
    )
    const wrapper = mount(MemoryPanel, { props: { workspaceId: 'ws-1' }, global, attachTo: document.body })
    try {
      await flushPromises()
      await wrapper.get('button[aria-label="Edit Goal ws-1"]').trigger('click')
      await wrapper.get('textarea').setValue('Unsaved draft')
      await wrapper.get('[data-testid="memory-expand"]').trigger('click')
      await flushPromises()
      const dialog = document.querySelector('[data-testid="memory-dialog"]')!
      expect(dialog.querySelector('[data-testid="memory-panel"]')).not.toBeNull()
      expect(dialog.querySelectorAll('.memory-section')).toHaveLength(4)
      expect(dialog.querySelectorAll('.memory-section__description')).toHaveLength(4)
      expect(dialog.querySelectorAll('.memory-section__number')).toHaveLength(4)
      expect((dialog.querySelector('textarea') as HTMLTextAreaElement).value).toBe('Unsaved draft')
      expect(dialog.querySelector('[data-testid="memory-clear-workspace"]')).not.toBeNull()
      expect(document.querySelectorAll('[data-testid="memory-panel"]')).toHaveLength(1)
      ;(dialog.querySelector('[data-testid="memory-collapse"]') as HTMLButtonElement).click()
      await flushPromises()
      expect(wrapper.get('textarea').element.value).toBe('Unsaved draft')
      expect(wrapper.find('[data-testid="memory-expand"]').exists()).toBe(true)
      expect(wrapper.find('.memory-section__description').exists()).toBe(false)
    } finally {
      wrapper.unmount()
    }
  })

  it('keeps the original scope when editing a global memory from the workspace drawer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) =>
        Promise.resolve(
          Response.json(
            String(input).includes('/operations?')
              ? { items: [] }
              : view('ws-1', 'session-current', {
                  entries: [{ ...entry, scopeId: 'global', title: 'Global fact' }],
                }),
          ),
        ),
      ),
    )
    const store = useMemoryStore()
    const update = vi.spyOn(store, 'updateEntry').mockResolvedValue(entry)
    const wrapper = mount(MemoryPanel, { props: { workspaceId: 'ws-1', sessionId: 'session-current' }, global })
    await flushPromises()
    await wrapper.get('button[aria-label="Edit Global fact"]').trigger('click')
    await wrapper.get('input[name="title"]').setValue('Updated fact')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ scopeId: 'global' }), {
      key: entry.key,
      title: 'Updated fact',
      body: entry.body,
    })
  })

  it.each([false, true])(
    'discards a delayed clear preview after workspace changes (return to original=%s)',
    async (returnToOriginal) => {
      vi.stubGlobal(
        'fetch',
        vi.fn((input: RequestInfo | URL) =>
          Promise.resolve(
            Response.json(
              String(input).includes('/operations?')
                ? { items: [] }
                : view(String(input).includes('/ws-2/') ? 'ws-2' : 'ws-1', 'session-current'),
            ),
          ),
        ),
      )
      let finish!: (value: { revision: number; entries: number; proposals: number }) => void
      vi.spyOn(useMemoryStore(), 'previewClear').mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve
          }),
      )
      const wrapper = mount(MemoryPanel, { props: { workspaceId: 'ws-1' }, global })
      await flushPromises()
      await wrapper.get('[data-testid="memory-clear-workspace"]').trigger('click')
      await wrapper.setProps({ workspaceId: 'ws-2' })
      if (returnToOriginal) await wrapper.setProps({ workspaceId: 'ws-1' })
      await flushPromises()
      finish({ revision: 1, entries: 99, proposals: 0 })
      await flushPromises()
      expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
    },
  )

  it('loads the selected conversation context, budget, omissions and matching current text', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input)
        return Promise.resolve(
          Response.json(url.includes('/operations?') ? { items: [] } : view('ws-1', 'session-current')),
        )
      }),
    )
    const wrapper = mount(MemoryPanel, { props: { workspaceId: 'ws-1', sessionId: 'session-current' }, global })
    await flushPromises()
    expect(wrapper.text()).toContain('Initialized')
    expect(wrapper.text()).toContain('123')
    expect(wrapper.text()).toContain('5877')
    expect(wrapper.text()).toContain('3')
    expect(wrapper.text()).toContain('Current text')
    expect(wrapper.text()).toContain('Codex')
  })

  it('discards stale workspace/session responses when selection changes', async () => {
    let finishFirst!: (response: Response) => void
    const fetch = vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/operations?')) return Promise.resolve(Response.json({ items: [] }))
      if (url.includes('/ws-1/')) return new Promise<Response>((resolve) => (finishFirst = resolve))
      return Promise.resolve(Response.json(view('ws-2', 'session-2')))
    })
    vi.stubGlobal('fetch', fetch)
    const wrapper = mount(MemoryPanel, { props: { workspaceId: 'ws-1', sessionId: 'session-1' }, global })
    await wrapper.setProps({ workspaceId: 'ws-2', sessionId: 'session-2' })
    await flushPromises()
    finishFirst(Response.json(view('ws-1', 'session-1')))
    await flushPromises()
    expect(wrapper.text()).toContain('Goal ws-2')
    expect(wrapper.text()).not.toContain('Goal ws-1')
    expect(useMemoryStore().workspaceView('ws-2', 'session-2')?.contexts[0]?.sessionId).toBe('session-2')
  })

  it('keeps archived and purged workspace memory manageable with explicit Settings link', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input)
        return Promise.resolve(
          Response.json(url.includes('/operations?') ? { items: [] } : view('ws-1', 'session-current')),
        )
      }),
    )
    const wrapper = mount(MemoryPanel, {
      props: { workspaceId: 'ws-1', sessionId: 'session-current', archived: true, purged: true },
      global,
    })
    await flushPromises()
    expect(wrapper.get('[data-testid="memory-clear-workspace"]').attributes('disabled')).toBeUndefined()
    expect(wrapper.get('[data-testid="memory-settings-link"]').attributes('href')).toContain('settings')
    await wrapper.get('[data-testid="memory-settings-link"]').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.name).toBe('settings')
    expect(router.currentRoute.value.query.tab).toBe('memory')
    expect(wrapper.text()).toMatch(/archived/i)
    expect(wrapper.text()).toMatch(/purged/i)
  })

  it('preserves an edited draft across 409, reloads the current entry and submits the rebased revision', async () => {
    let viewRequests = 0
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes('/operations?')) return Promise.resolve(Response.json({ items: [] }))
        viewRequests += 1
        const latest = view('ws-1', 'session-current')
        if (viewRequests > 1) {
          latest.entries[0] = { ...latest.entries[0]!, revision: 3, body: 'Latest from elsewhere' }
        }
        return Promise.resolve(Response.json(latest))
      }),
    )
    const store = useMemoryStore()
    const update = vi
      .spyOn(store, 'updateEntry')
      .mockRejectedValueOnce(Object.assign(new Error('conflict'), { status: 409 }))
      .mockResolvedValue({ ...entry, revision: 3, body: 'My draft' })
    const wrapper = mount(MemoryPanel, { props: { workspaceId: 'ws-1', sessionId: 'session-current' }, global })
    await flushPromises()
    await wrapper.get('button[aria-label="Edit Goal ws-1"]').trigger('click')
    await wrapper.get('textarea[name="body"]').setValue('My draft')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(wrapper.text()).toContain('changed elsewhere')
    expect((wrapper.get('textarea[name="body"]').element as HTMLTextAreaElement).value).toBe('My draft')
    await wrapper
      .findAll('button')
      .find((button) => button.text().includes('Keep draft and rebase'))!
      .trigger('click')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(update).toHaveBeenLastCalledWith(
      expect.objectContaining({ revision: 3 }),
      expect.objectContaining({ body: 'My draft' }),
    )
  })
})
