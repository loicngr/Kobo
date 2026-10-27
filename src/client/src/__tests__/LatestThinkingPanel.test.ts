import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import { nextTick } from 'vue'
import { createI18n } from 'vue-i18n'
import LatestThinkingPanel from '../components/LatestThinkingPanel.vue'
import en from '../i18n/en'
import { useAgentStreamStore } from '../stores/agent-stream'
import { useParallelReviewStore } from '../stores/parallel-review'
import { useSettingsStore } from '../stores/settings'
import { useWorkspaceStore } from '../stores/workspace'
import type { AgentEvent } from '../types/agent-event'

const source = readFileSync(join(process.cwd(), 'src/components/LatestThinkingPanel.vue'), 'utf-8')

describe('LatestThinkingPanel', () => {
  beforeEach(() => setActivePinia(createPinia()))

  function panel() {
    const workspace = useWorkspaceStore()
    workspace.selectedWorkspaceId = 'w'
    workspace.selectedSessionId = 'current'
    workspace.workspaces = [
      {
        id: 'w',
        name: 'Test',
        projectPath: '/tmp/project',
        sourceBranch: 'main',
        workingBranch: 'feature',
        status: 'executing',
        notionUrl: null,
        sentryUrl: null,
        notionPageId: null,
        model: 'auto',
        engine: 'mistral-vibe',
        reasoningEffort: 'auto',
        agentPermissionMode: 'interactive',
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
        comparisonId: null,
        autoLoop: false,
        autoLoopReady: false,
        noProgressStreak: 0,
        worktreePath: '/tmp/project',
        worktreeOwned: true,
        createdAt: '',
        updatedAt: '',
      },
    ]
    useSettingsStore().global.showThinkingBlocks = true
    return mount(LatestThinkingPanel, {
      props: { workspaceId: 'w' },
      global: {
        plugins: [createI18n({ legacy: false, locale: 'en', messages: { en } })],
        stubs: { QIcon: true, QExpansionItem: { template: '<div><slot name="header" /><slot /></div>' } },
      },
    })
  }

  it('keeps reviewer thinking visible after the main agent ends', async () => {
    const view = panel()
    const workspace = useWorkspaceStore()
    workspace.workspaces[0]!.status = 'completed'
    useParallelReviewStore().setStatus('w', {
      reviewSessionId: 'current',
      originalSessionId: 'main',
      phase: 'reviewing',
      compacting: false,
      returnToSession: false,
      error: null,
    })
    useAgentStreamStore().append(
      'w',
      { kind: 'message:thinking', messageId: 'review-thought', text: 'Checking migrations', streaming: true },
      '',
      'event',
      'current',
    )
    await nextTick()
    expect(view.text()).toContain('Checking migrations')
    useParallelReviewStore().setStatus('w', {
      reviewSessionId: 'current',
      originalSessionId: 'main',
      phase: 'completed',
      compacting: false,
      returnToSession: false,
      error: null,
    })
    workspace.workspaces[0]!.status = 'executing'
    await nextTick()
    expect(view.text()).toBe('')
    view.unmount()
  })

  it('renders the whole streamed thought, deduplicates reconnects and isolates selected sessions', async () => {
    const view = panel()
    const stream = useAgentStreamStore()
    const append = (text: string, id: string, sessionId = 'current') =>
      stream.append('w', { kind: 'message:thinking', messageId: 'm', text, streaming: true }, '', id, sessionId)
    append('Inspect ', 'e1')
    await nextTick()
    expect(view.text()).toBe('Inspect')
    append('the workspace.', 'e2')
    append('the workspace.', 'e2')
    append('Another session', 'e3', 'other')
    await nextTick()
    expect(view.text()).toBe('Inspect the workspace.')
    useWorkspaceStore().selectedSessionId = 'other'
    await nextTick()
    expect(view.text()).toBe('Another session')
    useWorkspaceStore().selectedSessionId = 'current'
    await nextTick()
    expect(view.text()).toBe('Inspect the workspace.')
    view.unmount()
  })

  it.each([
    { kind: 'message:end', messageId: 'm' },
    { kind: 'message:text', messageId: 'm', text: 'Answer', streaming: true },
    { kind: 'tool:call', messageId: 'm', toolCallId: 't', name: 'Read', input: {} },
    { kind: 'usage', inputTokens: 1, outputTokens: 1 },
    { kind: 'session:ended', reason: 'completed', exitCode: 0 },
  ] satisfies AgentEvent[])('hides the current thought after $kind and starts a new block', async (boundary) => {
    const view = panel()
    const stream = useAgentStreamStore()
    stream.append(
      'w',
      { kind: 'message:thinking', messageId: 'm', text: 'First', streaming: true },
      '',
      'e1',
      'current',
    )
    await nextTick()
    expect(view.text()).toBe('First')
    stream.append('w', boundary, '', 'e2', 'current')
    await nextTick()
    expect(view.find('.latest-thinking-panel').exists()).toBe(false)
    stream.append('w', { kind: 'message:thinking', messageId: 'm', text: 'Next', streaming: true }, '', 'e3', 'current')
    await nextTick()
    expect(view.text()).toBe('Next')
    view.unmount()
  })

  it('keeps complete native blocks separate and honors visibility controls', async () => {
    const view = panel()
    const stream = useAgentStreamStore()
    for (const text of ['Completed block', 'Latest complete block']) {
      stream.append('w', { kind: 'message:thinking', messageId: 'm', text }, '', text, 'current')
    }
    await nextTick()
    expect(view.text()).toBe('Latest complete block')
    useSettingsStore().global.showThinkingBlocks = false
    await nextTick()
    expect(view.find('.latest-thinking-panel').exists()).toBe(false)
    useSettingsStore().global.showThinkingBlocks = true
    useWorkspaceStore().workspaces[0]!.status = 'idle'
    await nextTick()
    expect(view.find('.latest-thinking-panel').exists()).toBe(false)
    view.unmount()
  })

  it('preserves long thoughts in the expanded content', async () => {
    const view = panel()
    const first = 'I will inspect the complete workspace history before checking the implementation. '
    const last = 'Then I will verify the result without losing any native reasoning.'
    const stream = useAgentStreamStore()
    for (const text of [first, last]) {
      stream.append('w', { kind: 'message:thinking', messageId: 'm', text, streaming: true }, '', text, 'current')
    }
    await nextTick()
    expect(view.find('.markdown-thinking').text()).toBe(first + last)
    view.unmount()
  })

  it('uses the same dark background as the wakeup banner', () => {
    expect(source).toContain('latest-thinking-panel bg-dark')
  })
})
