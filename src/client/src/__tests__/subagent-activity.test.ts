import { describe, expect, it } from 'vitest'
import { belongsToSubagent, findSubagentForActivity, subagentActivityEvents } from '../services/subagent-activity'
import type { AgentEvent } from '../types/agent-event'

describe('subagent activity', () => {
  it('groups a background Bash action under its real parent agent, not under a fake shell agent', () => {
    const cards = [
      { toolUseId: 'bash', taskType: 'local_bash', description: 'Run tests' },
      { toolUseId: 'agent', taskType: 'local_agent', description: 'Implement feature' },
    ]
    expect(findSubagentForActivity({ kind: 'subagent', toolCallId: 'agent' }, cards, 'bash')?.description).toBe(
      'Implement feature',
    )
  })

  it('prefers an actual nested agent over its parent regardless of card insertion order', () => {
    const cards = [
      { toolUseId: 'parent', taskType: 'local_agent', description: 'Parent' },
      { toolUseId: 'nested', taskType: 'local_agent', description: 'Nested agent' },
    ]
    expect(findSubagentForActivity({ kind: 'subagent', toolCallId: 'parent' }, cards, 'nested')?.description).toBe(
      'Nested agent',
    )
  })

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

  it('finds the named sub-agent for Claude aliases and Codex child threads', () => {
    const subagents = [
      { toolUseId: 'task-1', taskId: 'sdk-1', description: 'Inspect API rate limit', status: 'running' },
      { toolUseId: 'task-2', threadIds: ['thread-2'], description: 'Write regression test', status: 'done' },
    ]

    expect(findSubagentForActivity({ kind: 'subagent', toolCallId: 'sdk-1' }, subagents)?.description).toBe(
      'Inspect API rate limit',
    )
    expect(findSubagentForActivity({ kind: 'subagent', threadId: 'thread-2' }, subagents)?.description).toBe(
      'Write regression test',
    )
  })
})
