import { describe, expect, it } from 'vitest'
import { belongsToSubagent, subagentActivityEvents } from '../services/subagent-activity'
import type { AgentEvent } from '../types/agent-event'

describe('subagent activity', () => {
  const card = { toolUseId: 'task-1', taskId: 'sdk-1', threadIds: ['thread-1'], sessionId: 'session-1' }

  it('matches Claude aliases and Codex child threads without matching parent events', () => {
    expect(
      belongsToSubagent(
        {
          kind: 'message:text',
          messageId: 'a',
          text: 'child',
          streaming: false,
          origin: { kind: 'subagent', toolCallId: 'sdk-1' },
        },
        card,
      ),
    ).toBe(true)
    expect(
      belongsToSubagent(
        {
          kind: 'tool:result',
          toolCallId: 'task-1',
          output: 'nested result',
          isError: false,
          origin: { kind: 'subagent', toolCallId: 'parent-task' },
        },
        card,
      ),
    ).toBe(true)
    expect(
      belongsToSubagent(
        {
          kind: 'tool:call',
          messageId: '',
          toolCallId: 'b',
          name: 'Bash',
          input: {},
          origin: { kind: 'subagent', threadId: 'thread-1' },
        },
        card,
      ),
    ).toBe(true)
    expect(
      belongsToSubagent({ kind: 'message:text', messageId: 'parent', text: 'parent', streaming: false }, card),
    ).toBe(false)
  })

  it('keeps activity scoped to the card session', () => {
    const events: AgentEvent[] = [
      {
        kind: 'message:text',
        messageId: 'a',
        text: 'right',
        streaming: false,
        origin: { kind: 'subagent', toolCallId: 'task-1' },
      },
      {
        kind: 'message:text',
        messageId: 'b',
        text: 'wrong session',
        streaming: false,
        origin: { kind: 'subagent', toolCallId: 'task-1' },
      },
    ]
    expect(
      subagentActivityEvents(events, ['session-1', 'session-2'], card).map(
        (event) => event.kind === 'message:text' && event.text,
      ),
    ).toEqual(['right'])
  })
})
