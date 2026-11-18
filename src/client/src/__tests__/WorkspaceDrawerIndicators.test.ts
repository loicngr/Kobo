import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from 'vue-i18n'
import WorkspaceDrawerIndicators from '../components/WorkspaceDrawerIndicators.vue'
import en from '../i18n/en'
import type { Workspace } from '../stores/workspace'

const i18n = createI18n({ legacy: false, locale: 'en', messages: { en } })
const none = { muteBrowser: false, muteSound: false, muteToast: false, muteDrawer: false, keepQuestions: false }

function mountIndicators(notificationPrefs?: Partial<typeof none>) {
  const workspace = {
    id: 'ws-1',
    prWatchDisabledAt: null,
    ...(notificationPrefs ? { notificationPrefs: { ...none, ...notificationPrefs } } : {}),
  } as unknown as Workspace
  return mount(WorkspaceDrawerIndicators, {
    props: { workspace },
    global: {
      plugins: [i18n],
      stubs: {
        'q-icon': { props: ['name'], template: '<i class="q-icon-stub" :data-name="name"><slot /></i>' },
        'q-tooltip': { template: '<span class="q-tooltip-stub"><slot /></span>' },
      },
    },
  })
}

const bell = (w: ReturnType<typeof mountIndicators>) => w.find('[data-testid="notification-muted-indicator"]')

describe('WorkspaceDrawerIndicators bell-off', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('is hidden without prefs and without any mute', () => {
    expect(bell(mountIndicators()).exists()).toBe(false)
    expect(bell(mountIndicators({})).exists()).toBe(false)
  })

  it('is hidden for keepQuestions alone', () => {
    expect(bell(mountIndicators({ keepQuestions: true })).exists()).toBe(false)
  })

  it.each([
    ['muteBrowser', 'Browser notifications'],
    ['muteSound', 'Sounds'],
    ['muteToast', 'Toasts'],
    ['muteDrawer', 'Drawer signals'],
  ] as const)('is shown for %s and lists the muted channel', (key, label) => {
    const w = mountIndicators({ [key]: true })
    expect(bell(w).exists()).toBe(true)
    expect(bell(w).attributes('data-name')).toBe('notifications_off')
    expect(bell(w).attributes('aria-label')).toBeTruthy()
    expect(w.find('.q-tooltip-stub').text()).toContain(label)
  })

  it('lists several muted channels', () => {
    const text = mountIndicators({ muteSound: true, muteDrawer: true }).find('.q-tooltip-stub').text()
    expect(text).toContain('Sounds')
    expect(text).toContain('Drawer signals')
    expect(text).not.toContain('Toasts')
  })
})

describe('accessible labels with the real QIcon', () => {
  beforeEach(() => setActivePinia(createPinia()))
  const mountReal = async (workspace: Record<string, unknown>) => {
    const { Quasar, QIcon } = await vi.importActual<typeof import('quasar')>('quasar/dist/quasar.client.js')
    return mount(WorkspaceDrawerIndicators, {
      props: { workspace: { id: 'ws-1', prWatchDisabledAt: null, ...workspace } as unknown as Workspace },
      global: {
        plugins: [i18n, Quasar],
        components: { QIcon },
        stubs: { 'q-tooltip': { template: '<span class="q-tooltip-stub"><slot /></span>' } },
      },
    })
  }

  it('exposes the bell with the muted channels and without aria-hidden', async () => {
    const w = await mountReal({ notificationPrefs: { ...none, muteSound: true, muteDrawer: true } })
    const el = w.get('[data-testid="notification-muted-indicator"]')
    expect(el.attributes('aria-hidden')).not.toBe('true')
    expect(el.attributes('role')).toBe('img')
    expect(el.attributes('aria-label')).toContain('Sounds')
    expect(el.attributes('aria-label')).toContain('Drawer signals')
  })

  it('exposes the PR-watch-disabled icon the same way', async () => {
    const w = await mountReal({ prWatchDisabledAt: '2026-01-01T00:00:00Z' })
    const el = w.get('[data-testid="pr-watch-disabled-indicator"]')
    expect(el.attributes('aria-hidden')).not.toBe('true')
    expect(el.attributes('role')).toBe('img')
    expect(el.attributes('aria-label')).toBe('PR checks ignored for this workspace')
  })
})
