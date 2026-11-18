import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from 'vue-i18n'
import type { WorkspaceNotificationPrefs } from '../../../shared/workspace-notifications'
import WorkspaceContextMenu from '../components/WorkspaceContextMenu.vue'
import WorkspaceNotificationsDialog from '../components/WorkspaceNotificationsDialog.vue'
import en from '../i18n/en'
import { useWorkspaceStore, type Workspace } from '../stores/workspace'

vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('quasar', async (importOriginal) => ({
  ...(await importOriginal<typeof import('quasar')>()),
  useQuasar: () => ({ screen: { lt: { sm: false, md: false } }, notify: vi.fn(), dialog: vi.fn() }),
}))

const i18n = createI18n({ legacy: false, locale: 'en', messages: { en } })
const none: WorkspaceNotificationPrefs = {
  muteBrowser: false,
  muteSound: false,
  muteToast: false,
  muteDrawer: false,
  keepQuestions: false,
}
const slot = { template: '<div><slot /></div>' }
const stubs = {
  QDialog: { props: ['modelValue'], template: '<div v-if="modelValue"><slot /></div>' },
  QCard: slot,
  QCardSection: slot,
  QCardActions: slot,
  QCheckbox: {
    props: ['modelValue', 'label', 'disable'],
    emits: ['update:modelValue'],
    template:
      '<label><input type="checkbox" :checked="modelValue" :disabled="disable || undefined" @change="$emit(\'update:modelValue\', $event.target.checked)" />{{ label }}</label>',
  },
  QBtn: {
    props: ['label', 'disable'],
    template: '<button type="button" :disabled="disable || undefined">{{ label }}</button>',
  },
}

function setup(prefs: Partial<WorkspaceNotificationPrefs> = {}) {
  setActivePinia(createPinia())
  const store = useWorkspaceStore()
  store.workspaces = [
    { id: 'ws-1', name: 'My workspace', notificationPrefs: { ...none, ...prefs } } as unknown as Workspace,
  ]
  const save = vi.spyOn(store, 'setNotificationPrefs').mockResolvedValue(undefined)
  const wrapper = mount(WorkspaceNotificationsDialog, {
    props: { modelValue: true, workspaceId: 'ws-1' },
    global: { plugins: [i18n], stubs },
  })
  return { store, save, wrapper }
}

const box = (wrapper: ReturnType<typeof setup>['wrapper'], label: string) =>
  wrapper
    .findAll('label')
    .find((l) => l.text().startsWith(label))!
    .find('input')
const button = (wrapper: ReturnType<typeof setup>['wrapper'], label: string) =>
  wrapper.findAll('button').find((b) => b.text() === label)!

afterEach(() => vi.restoreAllMocks())

describe('WorkspaceNotificationsDialog', () => {
  it('shows the workspace name in the title', () => {
    const { wrapper } = setup()
    expect(wrapper.text()).toContain('My workspace')
  })

  it.each([
    ['Browser notifications', 'muteBrowser'],
    ['Sounds', 'muteSound'],
    ['Toasts', 'muteToast'],
    ['Drawer signals', 'muteDrawer'],
  ] as const)('ticking %s saves a new object with only %s changed', async (label, key) => {
    const { wrapper, save } = setup()
    await box(wrapper, label).setValue(true)
    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith('ws-1', { ...none, [key]: true })
  })

  it('keeps the questions exception disabled until sound or toast is muted', async () => {
    const { wrapper, store } = setup({ keepQuestions: true })
    const keep = () => box(wrapper, 'Keep')
    expect(keep().attributes('disabled')).toBeDefined()
    store.workspaces[0]!.notificationPrefs = { ...none, keepQuestions: true, muteSound: true }
    await wrapper.vm.$nextTick()
    expect(keep().attributes('disabled')).toBeUndefined()
    expect(keep().element.checked).toBe(true)
  })

  it('saves keepQuestions through its own box', async () => {
    const { wrapper, save } = setup({ muteToast: true })
    await box(wrapper, 'Keep').setValue(true)
    expect(save).toHaveBeenCalledWith('ws-1', { ...none, muteToast: true, keepQuestions: true })
  })

  it('shows the drawer caption only while the drawer is muted', async () => {
    const { wrapper, store } = setup()
    expect(wrapper.text()).not.toContain('Dashboard')
    store.workspaces[0]!.notificationPrefs = { ...none, muteDrawer: true }
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('Dashboard')
  })

  it('Mute all and Restore all keep keepQuestions', async () => {
    const { wrapper, save } = setup({ keepQuestions: true })
    await button(wrapper, 'Mute all').trigger('click')
    expect(save).toHaveBeenLastCalledWith('ws-1', {
      muteBrowser: true,
      muteSound: true,
      muteToast: true,
      muteDrawer: true,
      keepQuestions: true,
    })
    await button(wrapper, 'Restore all').trigger('click')
    expect(save).toHaveBeenLastCalledWith('ws-1', { ...none, keepQuestions: true })
  })

  it('shows an alert on a rejected save and nothing else, then clears it on the next success', async () => {
    const { wrapper, save } = setup()
    save.mockRejectedValueOnce(new Error('boom'))
    await box(wrapper, 'Sounds').setValue(true)
    await flushPromises()
    const alert = wrapper.find('[role="alert"]')
    expect(alert.exists()).toBe(true)
    expect(alert.text()).toBe(en['workspaceNotifications.error'])
    expect(alert.text()).not.toContain('boom')
    await box(wrapper, 'Toasts').setValue(true)
    await flushPromises()
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
  })

  it('closes itself when the workspace disappears', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json([])))
    const { wrapper, store } = setup()
    store.workspaces = []
    await flushPromises()
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual([false])
    vi.unstubAllGlobals()
  })

  it('the Close button closes', async () => {
    const { wrapper } = setup()
    await button(wrapper, 'Close').trigger('click')
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual([false])
  })
})

describe('WorkspaceContextMenu notifications entry', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it.each([false, true])('emits notifications (archived=%s)', async (archived) => {
    const workspace = { id: 'ws-1', name: 'W', tags: [], status: 'idle' } as unknown as Workspace
    const wrapper = mount(WorkspaceContextMenu, {
      props: { workspace, archived },
      global: {
        plugins: [i18n],
        stubs: {
          QMenu: slot,
          QList: slot,
          QItem: { template: '<div class="q-item" @click="$emit(\'click\')"><slot /></div>' },
          QItemSection: slot,
          QIcon: true,
          QSeparator: true,
        },
        directives: { closePopup: {} },
      },
    })
    const item = wrapper.findAll('.q-item').find((i) => i.text().includes('Notifications'))
    expect(item).toBeDefined()
    await item!.trigger('click')
    expect(wrapper.emitted('notifications')?.[0]).toEqual([workspace])
  })
})

describe('WorkspaceNotificationsDialog with the real store', () => {
  type Held = { url: string; body: Record<string, boolean> | null; resolve: (r: Response) => void }
  let puts: Held[]
  let archivedReply: () => Promise<Response>
  const ok = (p: Partial<WorkspaceNotificationPrefs>) => Response.json({ notificationPrefs: { ...none, ...p } })
  const fail = () => Response.json({ error: 'boom' }, { status: 500 })
  const ws = (id: string, prefs?: Partial<WorkspaceNotificationPrefs>) =>
    ({
      id,
      name: `Name ${id}`,
      ...(prefs ? { notificationPrefs: { ...none, ...prefs } } : {}),
    }) as unknown as Workspace

  function realSetup(active: Workspace[], archived: Workspace[] = []) {
    setActivePinia(createPinia())
    puts = []
    archivedReply = () => Promise.resolve(Response.json(archived))
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        if (init?.method === 'PUT')
          return new Promise<Response>((resolve) =>
            puts.push({ url, body: JSON.parse(String(init.body)) as Record<string, boolean>, resolve }),
          )
        if (url === '/api/workspaces/archived') return archivedReply()
        return Promise.resolve(Response.json([]))
      }),
    )
    const store = useWorkspaceStore()
    store.workspaces = active
    store.archivedWorkspaces = archived
    const wrapper = mount(WorkspaceNotificationsDialog, {
      props: { modelValue: true, workspaceId: active[0]?.id ?? archived[0]?.id ?? null },
      global: { plugins: [i18n], stubs },
    })
    return { store, wrapper }
  }
  type W = ReturnType<typeof realSetup>['wrapper']
  const checked = (w: W, label: string) => (box(w, label).element as HTMLInputElement).checked
  const alerts = (w: W) => w.findAll('[role="alert"]').length
  const lastClose = (w: W) => w.emitted('update:modelValue')?.at(-1)

  // The store keeps in-flight saves per id at module level: settle every held request between tests.
  afterEach(async () => {
    for (let i = 0; i < 5; i++) {
      for (const held of puts.splice(0)) held.resolve(Response.json({ notificationPrefs: held.body }))
      await flushPromises()
    }
    vi.unstubAllGlobals()
  })

  it('sends the first change with the second request and keeps both after two quick clicks', async () => {
    const { store, wrapper } = realSetup([ws('a', {})])
    await box(wrapper, 'Sounds').setValue(true)
    await flushPromises()
    await box(wrapper, 'Toasts').setValue(true)
    await flushPromises()
    expect(puts).toHaveLength(1)
    expect(puts[0]?.body).toEqual({ ...none, muteSound: true })
    puts[0]?.resolve(ok({ muteSound: true }))
    await flushPromises()
    expect(puts).toHaveLength(2)
    expect(puts[1]?.body).toEqual({ ...none, muteSound: true, muteToast: true })
    puts[1]?.resolve(ok({ muteSound: true, muteToast: true }))
    await flushPromises()
    expect(store.notificationPrefsOf('a')).toEqual({ ...none, muteSound: true, muteToast: true })
    expect(checked(wrapper, 'Sounds') && checked(wrapper, 'Toasts')).toBe(true)
    expect(alerts(wrapper)).toBe(0)
  })

  it('rolls the box back and shows exactly one alert after a failed save', async () => {
    const { wrapper } = realSetup([ws('a', {})])
    await box(wrapper, 'Sounds').setValue(true)
    await flushPromises()
    expect(checked(wrapper, 'Sounds')).toBe(true)
    puts[0]?.resolve(fail())
    await flushPromises()
    expect(checked(wrapper, 'Sounds')).toBe(false)
    expect(alerts(wrapper)).toBe(1)
  })

  it('shows one alert and rolls both boxes back when two overlapping clicks share the failing run', async () => {
    const { wrapper } = realSetup([ws('a', {})])
    await box(wrapper, 'Sounds').setValue(true)
    await flushPromises()
    await box(wrapper, 'Toasts').setValue(true)
    await flushPromises()
    puts[0]?.resolve(fail())
    await flushPromises()
    puts[1]?.resolve(fail())
    await flushPromises()
    expect(checked(wrapper, 'Sounds') || checked(wrapper, 'Toasts')).toBe(false)
    expect(alerts(wrapper)).toBe(1)
  })

  it('works for a workspace that only lives in the archived list', async () => {
    const { store, wrapper } = realSetup([], [ws('arch', {})])
    await box(wrapper, 'Drawer signals').setValue(true)
    await flushPromises()
    puts[0]?.resolve(ok({ muteDrawer: true }))
    await flushPromises()
    expect(store.archivedWorkspaces[0]?.notificationPrefs?.muteDrawer).toBe(true)
    expect(checked(wrapper, 'Drawer signals')).toBe(true)
  })

  it('shows every box unticked for undefined prefs and sends a full five-key object', async () => {
    const { wrapper } = realSetup([ws('a')])
    for (const label of ['Browser notifications', 'Sounds', 'Toasts', 'Drawer signals', 'Keep'])
      expect(checked(wrapper, label)).toBe(false)
    await box(wrapper, 'Browser notifications').setValue(true)
    await flushPromises()
    expect(puts[0]?.body).toEqual({ ...none, muteBrowser: true })
    expect(Object.keys(puts[0]?.body ?? {}).sort()).toEqual(Object.keys(none).sort())
  })

  it('keeps a stored keepQuestions: shown ticked but disabled, and kept by Restore all and Mute all', async () => {
    const { wrapper } = realSetup([ws('a', { keepQuestions: true })])
    expect(checked(wrapper, 'Keep')).toBe(true)
    expect(box(wrapper, 'Keep').attributes('disabled')).toBeDefined()
    await button(wrapper, 'Restore all').trigger('click')
    await flushPromises()
    expect(puts[0]?.body).toEqual({ ...none, keepQuestions: true })
    puts[0]?.resolve(ok({ keepQuestions: true }))
    await flushPromises()
    await button(wrapper, 'Mute all').trigger('click')
    await flushPromises()
    expect(puts[1]?.body).toEqual({
      muteBrowser: true,
      muteSound: true,
      muteToast: true,
      muteDrawer: true,
      keepQuestions: true,
    })
  })

  it('clears the error when reopened for another workspace', async () => {
    const { wrapper } = realSetup([ws('a', {}), ws('b', {})])
    await box(wrapper, 'Sounds').setValue(true)
    await flushPromises()
    puts[0]?.resolve(fail())
    await flushPromises()
    expect(alerts(wrapper)).toBe(1)
    await wrapper.setProps({ modelValue: false })
    await wrapper.setProps({ modelValue: true, workspaceId: 'b' })
    expect(alerts(wrapper)).toBe(0)
  })

  it('does not show a stale failure of workspace A in the dialog of B', async () => {
    const { wrapper } = realSetup([ws('a', {}), ws('b', {})])
    await box(wrapper, 'Sounds').setValue(true)
    await flushPromises()
    await wrapper.setProps({ modelValue: false })
    await wrapper.setProps({ modelValue: true, workspaceId: 'b' })
    puts[0]?.resolve(fail())
    await flushPromises()
    expect(alerts(wrapper)).toBe(0)
  })

  describe('when the workspace leaves the active list', () => {
    it('stays open, keeps showing its prefs and still saves after being archived (archived list never loaded)', async () => {
      const a = ws('a', { muteSound: true })
      const { store, wrapper } = realSetup([a])
      let release!: (r: Response) => void
      archivedReply = () => new Promise<Response>((resolve) => (release = resolve))
      store.workspaces = []
      await flushPromises()
      expect(wrapper.text()).toContain('Name a')
      expect(checked(wrapper, 'Sounds')).toBe(true)
      expect(box(wrapper, 'Sounds').attributes('disabled')).toBeDefined()
      expect(button(wrapper, 'Mute all').attributes('disabled')).toBeDefined()
      release(Response.json([a]))
      await flushPromises()
      expect(lastClose(wrapper)).toBeUndefined()
      expect(checked(wrapper, 'Sounds')).toBe(true)
      expect(box(wrapper, 'Sounds').attributes('disabled')).toBeUndefined()
      await box(wrapper, 'Toasts').setValue(true)
      await flushPromises()
      expect(puts[0]?.body).toEqual({ ...none, muteSound: true, muteToast: true })
    })

    it('closes once the fetch confirms the workspace is gone', async () => {
      const { store, wrapper } = realSetup([ws('a', {})])
      store.workspaces = []
      await flushPromises()
      expect(lastClose(wrapper)).toEqual([false])
    })

    it('does not close a different workspace opened during the fetch', async () => {
      const { store, wrapper } = realSetup([ws('a', {}), ws('b', {})])
      let release!: (r: Response) => void
      archivedReply = () => new Promise<Response>((resolve) => (release = resolve))
      store.workspaces = [ws('b', {})]
      await flushPromises()
      await wrapper.setProps({ workspaceId: 'b' })
      release(Response.json([]))
      await flushPromises()
      expect(lastClose(wrapper)).toBeUndefined()
    })
  })

  describe('confirming that the workspace is gone', () => {
    let held: ((r: Response) => void)[]
    const hold = () => {
      held = []
      archivedReply = () => new Promise<Response>((resolve) => held.push(resolve))
    }
    const flush = async () => {
      await flushPromises()
      await flushPromises()
    }

    it('retries when the first archived fetch was superseded, and stays open once the workspace shows up', async () => {
      const a = ws('a', { muteSound: true })
      const { store, wrapper } = realSetup([a])
      hold()
      store.workspaces = []
      await flush()
      void store.fetchArchivedWorkspaces() // a newer fetch supersedes the dialog's
      await flush()
      held[0]?.(Response.json([]))
      held[1]?.(Response.json([]))
      await flush()
      expect(held).toHaveLength(3) // dialog fetch, newer fetch, one retry
      expect(lastClose(wrapper)).toBeUndefined()
      held[2]?.(Response.json([a]))
      await flush()
      expect(lastClose(wrapper)).toBeUndefined()
      expect(box(wrapper, 'Sounds').attributes('disabled')).toBeUndefined()
    })

    it('runs a single check chain when closed and reopened on the same id during the fetch', async () => {
      const a = ws('a', { muteSound: true })
      const { store, wrapper } = realSetup([a])
      hold()
      store.workspaces = []
      await flush()
      await wrapper.setProps({ modelValue: false })
      await wrapper.setProps({ modelValue: true })
      await flush()
      expect(held).toHaveLength(1)
      held[0]?.(Response.json([a]))
      await flush()
      expect(held).toHaveLength(1)
      expect(lastClose(wrapper)).toBeUndefined()
      expect(checked(wrapper, 'Sounds')).toBe(true)
    })

    it('closes after one non-superseded fetch when the workspace is really gone', async () => {
      const { store, wrapper } = realSetup([ws('a', {})])
      hold()
      store.workspaces = []
      await flush()
      held[0]?.(Response.json([]))
      await flush()
      expect(held).toHaveLength(1)
      expect(lastClose(wrapper)).toEqual([false])
    })

    it('bounds the retries: a fetch superseded every time ends by closing', async () => {
      const { store, wrapper } = realSetup([ws('a', {})])
      hold()
      store.workspaces = []
      await flush()
      for (let round = 0; round < 3; round++) {
        void store.fetchArchivedWorkspaces()
        await flush()
        held[held.length - 2]?.(Response.json([]))
        await flush()
        if (round < 2) expect(lastClose(wrapper)).toBeUndefined()
      }
      expect(lastClose(wrapper)).toEqual([false])
      expect(held).toHaveLength(6)
    })

    it('keeps the controls disabled while the fetch never settles, and Close still works', async () => {
      const { store, wrapper } = realSetup([ws('a', {})])
      hold()
      store.workspaces = []
      await flush()
      expect(box(wrapper, 'Sounds').attributes('disabled')).toBeDefined()
      expect(button(wrapper, 'Restore all').attributes('disabled')).toBeDefined()
      await button(wrapper, 'Close').trigger('click')
      expect(lastClose(wrapper)).toEqual([false])
    })

    it('enables the controls again when the workspace reappears in the active list during the fetch', async () => {
      const a = ws('a', { muteToast: true })
      const { store, wrapper } = realSetup([a])
      hold()
      store.workspaces = []
      await flush()
      expect(box(wrapper, 'Toasts').attributes('disabled')).toBeDefined()
      store.workspaces = [a]
      await flush()
      expect(box(wrapper, 'Toasts').attributes('disabled')).toBeUndefined()
      held[0]?.(Response.json([]))
      await flush()
      expect(lastClose(wrapper)).toBeUndefined()
      expect(checked(wrapper, 'Toasts')).toBe(true)
    })
  })

  describe('accessibility', () => {
    it('names the dialog and describes the boxes by their captions', async () => {
      const { wrapper } = realSetup([ws('a', { muteDrawer: true })])
      expect(wrapper.attributes('aria-label')).toBe('Notifications: Name a')
      const drawer = wrapper.findAll('label').find((l) => l.text().startsWith('Drawer signals'))!
      const drawerHint = wrapper.get(`#${drawer.attributes('aria-describedby')}`)
      expect(drawerHint.text()).toContain('Dashboard')
      const keep = wrapper.findAll('label').find((l) => l.text().startsWith('Keep'))!
      const ids = (keep.attributes('aria-describedby') ?? '').split(' ')
      expect(ids).toHaveLength(2)
      expect(ids.map((id) => wrapper.get(`#${id}`).text())).toEqual([
        en['workspaceNotifications.keepQuestionsHint'],
        en['workspaceNotifications.keepQuestionsDisabled'],
      ])
      const stored = realSetup([ws('a', { muteSound: true })]).wrapper
      const enabledKeep = stored.findAll('label').find((l) => l.text().startsWith('Keep'))!
      expect((enabledKeep.attributes('aria-describedby') ?? '').split(' ')).toHaveLength(1)
      const calm = stored.findAll('label').find((l) => l.text().startsWith('Drawer signals'))!
      expect(calm.attributes('aria-describedby')).toBeUndefined()
    })
  })
})
