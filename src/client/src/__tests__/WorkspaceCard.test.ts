import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from 'vue-i18n'
import WorkspaceCard from '../components/WorkspaceCard.vue'
import en from '../i18n/en'
import type { Workspace } from '../stores/workspace'

afterEach(() => vi.useRealTimers())

const i18n = createI18n({ legacy: false, locale: 'en', messages: { en } })
const stubs = {
  WorkspaceContextMenu: {
    props: ['workspace'],
    emits: ['copy-id'],
    template: '<button class="copy-id-stub" @click="$emit(\'copy-id\', workspace)" />',
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

function mountCard(props: Record<string, unknown> = {}) {
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
    global: { plugins: [i18n], stubs },
  })
}

describe('WorkspaceCard.vue', () => {
  beforeEach(() => setActivePinia(createPinia()))

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

  it('renders the project chip only when asked to', () => {
    expect(mountCard({ showProjectChip: false }).find('.q-chip').exists()).toBe(false)
    expect(mountCard({ showProjectChip: true }).find('.q-chip').exists()).toBe(true)
  })
})
