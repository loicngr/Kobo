import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from 'vue-i18n'
import SubagentActivity from '../components/SubagentActivity.vue'
import en from '../i18n/en'
import { useAgentStreamStore } from '../stores/agent-stream'
import type { Subagent } from '../stores/workspace'
import { apiFetchResponse } from '../utils/api'

vi.mock('../utils/api', () => ({
  apiFetchResponse: vi.fn(),
  apiResponseError: vi.fn(),
}))

const i18n = createI18n({ legacy: false, locale: 'en', messages: { en } })
const card: Subagent = {
  toolUseId: 'task-1',
  sessionId: 'session-1',
  status: 'done',
  threadIds: ['thread-1'],
  description: '',
  startedAt: '',
  updatedAt: '',
}

function response(events: unknown[], hasMore: boolean): Response {
  return { ok: true, json: async () => ({ events, hasMore }) } as Response
}

function mountActivity() {
  return mount(SubagentActivity, {
    props: { workspaceId: 'workspace-1', subagent: card },
    global: {
      plugins: [i18n],
      stubs: {
        'q-spinner': true,
        'q-btn': {
          props: ['label', 'loading'],
          template: '<button :disabled="loading" @click="$emit(\'click\')">{{ label }}</button>',
        },
        TextMessageItem: { props: ['item'], template: '<article>{{ item.text }}</article>' },
        ToolCallItem: { props: ['item'], template: '<article>{{ item.name }}</article>' },
      },
    },
  })
}

describe('SubagentActivity.vue', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('loads only the child history, merges live activity and fetches an older page', async () => {
    vi.mocked(apiFetchResponse)
      .mockResolvedValueOnce(
        response(
          [
            {
              id: 'new',
              type: 'agent:event',
              sessionId: 'session-1',
              createdAt: '2026-10-02T10:02:00.000Z',
              payload: {
                kind: 'message:text',
                messageId: 'new',
                text: 'saved child update',
                streaming: false,
                origin: { kind: 'subagent', toolCallId: 'task-1' },
              },
            },
          ],
          true,
        ),
      )
      .mockResolvedValueOnce(
        response(
          [
            {
              id: 'old',
              type: 'agent:event',
              sessionId: 'session-1',
              createdAt: '2026-10-02T10:01:00.000Z',
              payload: {
                kind: 'tool:call',
                messageId: '',
                toolCallId: 'tool-old',
                name: 'Bash',
                input: {},
                origin: { kind: 'subagent', threadId: 'thread-1' },
              },
            },
          ],
          false,
        ),
      )
    const stream = useAgentStreamStore()
    stream.append(
      'workspace-1',
      {
        kind: 'message:text',
        messageId: 'live',
        text: 'live child update',
        streaming: false,
        origin: { kind: 'subagent', toolCallId: 'task-1' },
      },
      '2026-10-02T10:03:00.000Z',
      'live',
      'session-1',
    )

    const wrapper = mountActivity()
    await flushPromises()

    expect(apiFetchResponse).toHaveBeenCalledWith(
      '/api/workspaces/workspace-1/events?limit=100&session=session-1&subagentToolCallId=task-1&subagentThreadIds=thread-1',
    )
    expect(wrapper.text()).toContain('saved child update')
    expect(wrapper.text()).toContain('live child update')

    await wrapper.get('button').trigger('click')
    await flushPromises()

    expect(apiFetchResponse).toHaveBeenLastCalledWith(
      '/api/workspaces/workspace-1/events?limit=100&session=session-1&subagentToolCallId=task-1&subagentThreadIds=thread-1&before=new',
    )
    expect(wrapper.text()).toContain('Bash')
  })
})
