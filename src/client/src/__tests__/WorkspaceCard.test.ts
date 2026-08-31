import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import { createI18n } from 'vue-i18n'
import WorkspaceCard from '../components/WorkspaceCard.vue'
import en from '../i18n/en'
import type { Workspace } from '../stores/workspace'

const i18n = createI18n({ legacy: false, locale: 'en', messages: { en } })
const stubs = {
  WorkspaceContextMenu: { template: '<div class="ctx-stub" />' },
  WorkspaceDrawerIndicators: { template: '<div class="indicators-stub" />' },
  WorkspaceAttentionLabels: {
    name: 'WorkspaceAttentionLabels',
    props: ['workspace', 'ciRecapOnly'],
    template: '<div class="labels-stub" />',
  },
  AutoLoopChip: { template: '<div class="autoloop-stub" />' },
  'q-chip': { template: '<span class="q-chip"><slot /></span>' },
  'q-tooltip': { template: '<span><slot /></span>' },
}

// Full fixture, mirroring the one in ActivityFeed.test.ts.
const makeWorkspace = (over: Partial<Workspace> = {}): Workspace => ({
  id: 'ws-1',
  name: 'Test',
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
