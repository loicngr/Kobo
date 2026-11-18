import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from 'vue-i18n'
import WorkspaceCard from '../components/WorkspaceCard.vue'
import en from '../i18n/en'
import type { Workspace } from '../stores/workspace'
import { useWorkspaceStore } from '../stores/workspace'

afterEach(() => vi.useRealTimers())

const i18n = createI18n({ legacy: false, locale: 'en', messages: { en } })
const menuShow = vi.fn()
const stubs = {
  'q-btn': { template: '<button><slot /></button>' },
  WorkspaceContextMenu: {
    props: ['workspace'],
    emits: ['copy-id', 'notifications'],
    methods: { show: (evt: unknown) => menuShow(evt) },
    template:
      '<div><button class="copy-id-stub" @click="$emit(\'copy-id\', workspace)" /><button class="notifications-stub" @click="$emit(\'notifications\', workspace)" /></div>',
  },
  WorkspaceDrawerIndicators: { template: '<div class="indicators-stub" />' },
  WorkspaceAttentionLabels: {
    name: 'WorkspaceAttentionLabels',
    props: ['workspace', 'ciRecapOnly'],
    template: '<div class="labels-stub" />',
  },
  AutoLoopChip: { template: '<div class="autoloop-stub" />' },
  'q-icon': true,
  'q-chip': { template: '<span class="q-chip"><slot /></span>' },
  'q-tooltip': { template: '<span><slot /></span>' },
}

// Full fixture, mirroring the one in ActivityFeed.test.ts.
const makeWorkspace = (over: Partial<Workspace> = {}): Workspace => ({
  id: 'ws-1',
  name: 'Test',
  sprintId: null,
  slackChannelId: null,
  projectPath: '/tmp/project',
  sourceBranch: 'main',
  workingBranch: 'feature/test',
  status: 'idle',
  notionUrl: null,
  sentryUrl: null,
  notionPageId: null,
  model: 'claude-opus-4-5',
  engine: 'claude-code',
  reasoningEffort: 'normal',
  agentPermissionMode: 'bypass',
  devServerStatus: 'stopped',
  hasUnread: false,
  archivedAt: null,
  favoritedAt: null,
  prWatchDisabledAt: null,
  tags: [],
  description: null,
  agentDescription: null,
  initialPrompt: null,
  prChangesDismissedAt: null,
  prCiFailureDismissedAt: null,
  worktreePurgedAt: null,
  worktreePurgeRestoreData: null,
  autoLoop: false,
  autoLoopReady: false,
  noProgressStreak: 0,
  worktreePath: '/tmp/project/.worktrees/feature/test',
  worktreeOwned: true,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  ...over,
})

function mountCard(props: Record<string, unknown> = {}, touch = false) {
  const workspace =
    (props.workspace as Workspace | undefined) ??
    makeWorkspace(props.variant === 'archived' ? { archivedAt: '2026-01-02T00:00:00Z' } : {})
  return mount(WorkspaceCard, {
    props: {
      variant: 'idle',
      selected: false,
      showProjectChip: false,
      borderColor: 'var(--kobo-border-strong)',
      ...props,
      workspace,
    },
    global: { plugins: [i18n], stubs, provide: { _q_: { platform: { has: { touch } } } } },
  })
}

describe('WorkspaceCard.vue', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    menuShow.mockClear()
  })

  describe('touch "more" button', () => {
    const btn = '[data-testid="workspace-card-menu-button"]'

    it('is rendered only when the platform has a touch screen', () => {
      expect(mountCard({}, true).find(btn).exists()).toBe(true)
      expect(mountCard({}, false).find(btn).exists()).toBe(false)
    })

    it('is hidden in bulk selection mode and present on archived cards', () => {
      expect(mountCard({ selectionMode: true }, true).find(btn).exists()).toBe(false)
      expect(mountCard({ variant: 'archived' }, true).find(btn).exists()).toBe(true)
    })

    it('has an accessible name', () => {
      expect(mountCard({}, true).get(btn).attributes('aria-label')).toBe('Workspace actions')
    })

    it('opens the context menu on tap without selecting nor toggling', async () => {
      const card = mountCard({}, true)
      await card.get(btn).trigger('click')
      expect(menuShow).toHaveBeenCalledTimes(1)
      expect(card.emitted('select')).toBeUndefined()
      expect(card.emitted('toggleSelection')).toBeUndefined()
    })

    it('does not start the hold-to-select timer', async () => {
      vi.useFakeTimers()
      const card = mountCard({}, true)
      await card.get(btn).trigger('pointerdown', { pointerType: 'touch', button: 0, isPrimary: true })
      vi.advanceTimersByTime(1500)
      expect(card.emitted('toggleSelection')).toBeUndefined()
    })

    it('opens on Enter and Space without triggering the card selection', async () => {
      const card = mountCard({}, true)
      await card.get(btn).trigger('keydown', { key: 'Enter' })
      await card.get(btn).trigger('keydown', { key: ' ' })
      expect(menuShow).toHaveBeenCalled()
      expect(card.emitted('select')).toBeUndefined()
    })
  })

  it.each(['idle', 'archived'])('re-emits the context-menu notifications event (%s)', async (variant) => {
    const card = mountCard({ variant })
    await card.get('.notifications-stub').trigger('click')
    expect(card.emitted('notifications')?.[0]).toEqual([card.props('workspace')])
  })

  it('exposes the card as a keyboard-reachable listbox option', () => {
    const card = mountCard({ selected: true })
    const root = card.get('[data-testid="workspace-card"]')
    expect(root.attributes('role')).toBe('option')
    expect(root.attributes('tabindex')).toBe('0')
    expect(root.attributes('aria-selected')).toBe('true')
    expect(root.attributes('aria-label')).toContain('Test')
  })

  it('selects on Enter and on Space, exactly like a click', async () => {
    const card = mountCard()
    const root = card.get('[data-testid="workspace-card"]')
    await root.trigger('keydown', { key: 'Enter' })
    await root.trigger('keydown', { key: ' ' })
    await root.trigger('click')
    expect(card.emitted('select')).toHaveLength(3)
  })

  it('toggles bulk selection with Ctrl/Cmd without navigating, including keyboard', async () => {
    const card = mountCard({ multiSelected: true, selectionMode: true })
    const root = card.get('[data-testid="workspace-card"]')
    await root.trigger('click', { ctrlKey: true })
    await root.trigger('click', { metaKey: true })
    await root.trigger('keydown', { key: ' ', ctrlKey: true })
    expect(card.emitted('select')).toBeUndefined()
    expect(card.emitted('toggleSelection')).toEqual([['ws-1'], ['ws-1'], ['ws-1']])
    expect(root.attributes('aria-selected')).toBe('true')
  })

  it.each(['mouse', 'touch'])(
    'selects after one second with %s and consumes the release click',
    async (pointerType) => {
      vi.useFakeTimers()
      const card = mountCard()
      const root = card.get('[data-testid="workspace-card"]')
      await root.trigger('pointerdown', {
        pointerType,
        button: 0,
        isPrimary: true,
        pointerId: 1,
        clientX: 10,
        clientY: 10,
      })
      await vi.advanceTimersByTimeAsync(999)
      expect(card.emitted('toggleSelection')).toBeUndefined()
      await vi.advanceTimersByTimeAsync(1)
      expect(card.emitted('toggleSelection')).toEqual([['ws-1']])
      await root.trigger('pointerup')
      await root.trigger('click')
      expect(card.emitted('select')).toBeUndefined()
      expect(card.emitted('toggleSelection')).toHaveLength(1)
      card.unmount()
    },
  )

  it.each(['pointerup', 'pointercancel', 'pointerleave', 'pointermove', 'scroll', 'blur'])(
    'cancels the hold on %s',
    async (event) => {
      vi.useFakeTimers()
      const card = mountCard()
      const root = card.get('[data-testid="workspace-card"]')
      await root.trigger('pointerdown', { button: 0, isPrimary: true, pointerId: 1, clientX: 0, clientY: 0 })
      await vi.advanceTimersByTimeAsync(500)
      if (event === 'scroll') document.dispatchEvent(new Event('scroll'))
      else if (event === 'blur') window.dispatchEvent(new Event('blur'))
      else await root.trigger(event, { pointerId: 1, clientX: 20, clientY: 0 })
      await vi.advanceTimersByTimeAsync(2000)
      expect(card.emitted('toggleSelection')).toBeUndefined()
      card.unmount()
    },
  )

  it('keeps short clicks and right-clicks out of long-press selection', async () => {
    vi.useFakeTimers()
    const card = mountCard()
    const root = card.get('[data-testid="workspace-card"]')
    await root.trigger('pointerdown', { button: 2, isPrimary: true })
    await vi.advanceTimersByTimeAsync(2100)
    expect(card.emitted('toggleSelection')).toBeUndefined()
    await root.trigger('pointerdown', { button: 0, isPrimary: true })
    await vi.advanceTimersByTimeAsync(100)
    await root.trigger('pointerup')
    await root.trigger('click')
    expect(card.emitted('select')).toEqual([['ws-1']])
    card.unmount()
  })

  it('toggles on a simple tap in selection mode without confusing the active workspace', async () => {
    const card = mountCard({ selectionMode: true, selected: true, multiSelected: false })
    const root = card.get('[data-testid="workspace-card"]')
    expect(root.attributes('aria-selected')).toBe('false')
    await root.trigger('click')
    expect(card.emitted('toggleSelection')).toEqual([['ws-1']])
    expect(card.emitted('select')).toBeUndefined()
    card.unmount()
  })

  it('suppresses touch context menus while retaining mouse right-click menus', async () => {
    vi.useFakeTimers()
    const card = mountCard()
    const root = card.get('[data-testid="workspace-card"]')
    const menuTouch = vi.fn()
    const menuContext = vi.fn()
    root.element.addEventListener('touchstart', menuTouch)
    root.element.addEventListener('contextmenu', menuContext)
    await root.trigger('pointerdown', { pointerType: 'touch', button: 0, isPrimary: true })
    await root.trigger('touchstart')
    await root.trigger('contextmenu')
    expect(menuTouch).not.toHaveBeenCalled()
    expect(menuContext).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2000)
    expect(card.emitted('toggleSelection')).toEqual([['ws-1']])
    await root.trigger('pointerdown', { pointerType: 'mouse', button: 2, isPrimary: true })
    await root.trigger('contextmenu')
    expect(menuContext).toHaveBeenCalledOnce()
    card.unmount()
  })

  it('cancels a pending hold on unmount', async () => {
    vi.useFakeTimers()
    const card = mountCard()
    await card.get('[data-testid="workspace-card"]').trigger('pointerdown', { button: 0, isPrimary: true })
    card.unmount()
    await vi.advanceTimersByTimeAsync(2100)
    expect(card.emitted('toggleSelection')).toBeUndefined()
  })

  it('relays the copy workspace ID action from its context menu', async () => {
    const card = mountCard()
    await card.get('.copy-id-stub').trigger('click')
    expect(card.emitted('copyId')).toEqual([[makeWorkspace()]])
  })

  it('shows the full attention labels on the attention variant only', () => {
    const attention = mountCard({ variant: 'attention' })
    expect(attention.findComponent({ name: 'WorkspaceAttentionLabels' }).props('ciRecapOnly')).toBe(false)
    const idle = mountCard({ variant: 'idle' })
    expect(idle.findComponent({ name: 'WorkspaceAttentionLabels' }).props('ciRecapOnly')).toBe(true)
  })

  it('restores the two indicator components the archived block had lost', () => {
    // The archived copy in WorkspaceList.vue had dropped both. Re-adding them
    // is a deliberate, visible behaviour change, not an accident.
    const archived = mountCard({ variant: 'archived' })
    expect(archived.find('.indicators-stub').exists()).toBe(true)
    expect(archived.find('.labels-stub').exists()).toBe(true)
  })

  describe('status line of the idle variant', () => {
    const meta = (status: Workspace['status'], variant: 'idle' | 'running' = 'idle') =>
      mountCard({ variant, workspace: makeWorkspace({ status }) })
        .get('.wl-item-meta')
        .text()

    it.each([
      ['error', 'error'],
      ['quota', 'quota reached'],
      ['awaiting-user', 'awaiting your answer'],
    ] as const)('shows the %s status in plain muted text', (status, label) => {
      const card = mountCard({ variant: 'idle', workspace: makeWorkspace({ status }) })
      const line = card.get('.wl-item-meta')
      expect(line.text()).toMatch(new RegExp(`^${label} · `))
      expect(line.classes()).toContain('text-kobo-3')
      expect(line.find('q-icon-stub, .q-icon').exists()).toBe(false)
      expect(line.html()).not.toMatch(/text-(red|amber|negative|warning)/)
    })

    it.each(['idle', 'completed', 'created'] as const)('adds nothing for %s', (status) => {
      expect(meta(status)).not.toContain('·')
    })
  })

  describe('muteDrawer', () => {
    const muted = { muteBrowser: false, muteSound: false, muteToast: false, muteDrawer: true, keepQuestions: false }
    const nameStyle = (card: ReturnType<typeof mountCard>) => card.get('.wl-item-name').attributes('style') ?? ''

    it('shows the unread emphasis for an unmuted workspace', () => {
      expect(nameStyle(mountCard({ workspace: makeWorkspace({ hasUnread: true }) }))).toContain('font-weight: 700')
    })

    it('drops the unread bold and opacity but keeps the stored flag', () => {
      const workspace = makeWorkspace({ hasUnread: true, notificationPrefs: muted })
      const style = nameStyle(mountCard({ workspace }))
      expect(style).toContain('font-weight: 400')
      expect(style).toContain('opacity: 0.75')
      expect(workspace.hasUnread).toBe(true)
    })

    it.each(['attention', 'running', 'idle'] as const)(
      'renders no labels block at all in the %s variant',
      (variant) => {
        const workspace = makeWorkspace({ status: 'error', notificationPrefs: muted })
        const card = mountCard({ workspace, variant })
        expect(card.findComponent({ name: 'WorkspaceAttentionLabels' }).exists()).toBe(false)
      },
    )

    describe('with a running CI and a failed check (real labels component)', () => {
      const snapshot = {
        number: 1,
        title: 't',
        url: 'u',
        state: 'OPEN',
        base: 'main',
        reviewDecision: null,
        author: { login: 'a' },
        assignees: [],
        reviewers: [],
        labels: [],
        ci: {
          rollup: 'FAILURE',
          checks: [
            { name: 'build', status: 'IN_PROGRESS', conclusion: null },
            { name: 'lint', status: 'COMPLETED', conclusion: 'FAILURE' },
          ],
        },
        updatedAt: '',
        unresolvedReviewThreadsCount: 0,
        readyToMerge: false,
      }
      const realStubs = { ...stubs, WorkspaceAttentionLabels: false, 'q-spinner': true, 'q-btn': true }
      const mountWith = (prefs?: typeof muted) => {
        const store = useWorkspaceStore()
        store.prSnapshots = { 'ws-1': snapshot as never }
        return mount(WorkspaceCard, {
          props: {
            variant: 'attention',
            selected: false,
            showProjectChip: false,
            borderColor: 'var(--kobo-border-strong)',
            workspace: makeWorkspace({ status: 'idle', ...(prefs ? { notificationPrefs: prefs } : {}) }),
          },
          global: { plugins: [i18n], stubs: realStubs, provide: { _q_: { platform: { has: { touch: false } } } } },
        })
      }

      it('is unchanged when unmuted: label and recap are rendered', () => {
        const text = mountWith().text()
        expect(text).toContain('CI failed')
        expect(text).toContain('1')
        expect(mountWith().find('.ci-recap').exists()).toBe(true)
      })

      it('renders neither recap nor label when muted', () => {
        const card = mountWith(muted)
        expect(card.find('.ci-recap').exists()).toBe(false)
        expect(card.text()).not.toContain('CI failed')
      })
    })

    it('keeps the attention labels for an unmuted attention card', () => {
      const labels = mountCard({ variant: 'attention' }).findComponent({ name: 'WorkspaceAttentionLabels' })
      expect(labels.props('ciRecapOnly')).toBe(false)
    })
  })

  it('renders the project chip only when asked to', () => {
    expect(mountCard({ showProjectChip: false }).find('.q-chip').exists()).toBe(false)
    expect(mountCard({ showProjectChip: true }).find('.q-chip').exists()).toBe(true)
  })
})
