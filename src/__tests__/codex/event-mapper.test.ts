import { describe, expect, it } from 'vitest'
import {
  createMapperState,
  emitSessionStarted,
  handleAgentMessageDelta,
  handleItemCompleted,
  handleItemStarted,
  handleRateLimitsUpdated,
  handleTurnCompleted,
  QUOTA_PATTERN,
  tryEmitQuota,
} from '../../server/services/agent/engines/codex/event-mapper.js'
import type { AgentEvent } from '../../server/services/agent/engines/types.js'

// Helper to get a fresh deterministic state
function mkState() {
  return createMapperState({ sessionPrefix: 'test' })
}

// ── 1. emitSessionStarted ──────────────────────────────────────────────────────

describe('emitSessionStarted', () => {
  it('emits session:started with scoped engineSessionId', () => {
    const state = mkState()
    const events = emitSessionStarted('thread-abc', state)
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({ kind: 'session:started', engineSessionId: 'thread-abc' })
  })

  it('is idempotent — does not emit twice for the same session', () => {
    const state = mkState()
    const first = emitSessionStarted('thread-abc', state)
    const second = emitSessionStarted('thread-abc', state)
    expect(first).toHaveLength(1)
    expect(second).toHaveLength(0)
    expect(state.sessionStartedEmitted).toBe(true)
  })

  it('stores the sessionId in state', () => {
    const state = mkState()
    emitSessionStarted('thread-xyz', state)
    expect(state.sessionId).toBe('thread-xyz')
  })
})

// ── 2. handleItemStarted — agentMessage ───────────────────────────────────────

describe('handleItemStarted — agentMessage', () => {
  it('starts streaming text with message:text event', () => {
    const state = mkState()
    const item = { id: 'item_0', type: 'agentMessage' as const, text: 'Hello' }
    const events = handleItemStarted(item, state)
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({
      kind: 'message:text',
      messageId: 'test_item_0',
      text: 'Hello',
      streaming: true,
    })
    expect(state.openMessages.has('test_item_0')).toBe(true)
  })

  it('tracks item in openMessages with sawText=true when text is non-empty', () => {
    const state = mkState()
    const item = { id: 'item_0', type: 'agentMessage' as const, text: 'Hi' }
    handleItemStarted(item, state)
    expect(state.openMessages.get('test_item_0')?.sawText).toBe(true)
  })

  it('tracks item in openMessages with sawText=false when text is empty', () => {
    const state = mkState()
    const item = { id: 'item_0', type: 'agentMessage' as const, text: '' }
    handleItemStarted(item, state)
    expect(state.openMessages.get('test_item_0')?.sawText).toBe(false)
  })
})

// ── 3. handleAgentMessageDelta ─────────────────────────────────────────────────

describe('handleAgentMessageDelta', () => {
  it('emits message:text with the delta text and streaming=true', () => {
    const state = mkState()
    const delta = { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item_0', delta: ' world' }
    const events = handleAgentMessageDelta(delta, state)
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({
      kind: 'message:text',
      messageId: 'test_item_0',
      text: ' world',
      streaming: true,
    })
  })

  it('scopes the messageId with the session prefix', () => {
    const state = createMapperState({ sessionPrefix: 'pfx' })
    const delta = { threadId: 'thread-1', turnId: 'turn-1', itemId: 'msg_1', delta: 'abc' }
    const events = handleAgentMessageDelta(delta, state)
    expect((events[0] as Extract<AgentEvent, { kind: 'message:text' }>).messageId).toBe('pfx_msg_1')
  })
})

// ── 4. handleItemCompleted — agentMessage: deltas already streamed vs not ───────

describe('handleItemCompleted — agentMessage', () => {
  it('emits ONLY message:end when deltas already streamed (avoids double-append on client)', () => {
    // Setup: deltas streamed the text, so sawText=true. The client store has
    // already accumulated `text` via `existing.text += ev.text` on each delta.
    // Re-emitting the full text on completed would double the message.
    const state = mkState()
    state.openMessages.set('test_item_0', { sawText: true })
    const item = { id: 'item_0', type: 'agentMessage' as const, text: 'Done.' }
    const events = handleItemCompleted(item, state)
    // No streaming:false message:text — deltas already filled the buffer.
    expect(events.find((e) => e.kind === 'message:text')).toBeUndefined()
    expect(events).toContainEqual({ kind: 'message:end', messageId: 'test_item_0' })
    expect(state.openMessages.has('test_item_0')).toBe(false)
  })

  it('emits message:text (streaming=false) + message:end when no deltas were seen (non-streaming fallback)', () => {
    // No delta path was triggered — the engine should still surface the full
    // text on completion. This is the fallback for non-streaming Codex modes.
    const state = mkState()
    state.openMessages.set('test_item_0', { sawText: false })
    const item = { id: 'item_0', type: 'agentMessage' as const, text: 'Done.' }
    const events = handleItemCompleted(item, state)
    expect(events).toContainEqual({
      kind: 'message:text',
      messageId: 'test_item_0',
      text: 'Done.',
      streaming: false,
    })
    expect(events).toContainEqual({ kind: 'message:end', messageId: 'test_item_0' })
    expect(state.openMessages.has('test_item_0')).toBe(false)
  })
})

// ── 5. handleItemCompleted — agentMessage with [BRAINSTORM_COMPLETE] ───────────

describe('handleItemCompleted — agentMessage brainstorm sentinel', () => {
  it('emits session:brainstorm-complete when text contains the sentinel', () => {
    const state = mkState()
    const item = {
      id: 'item_0',
      type: 'agentMessage' as const,
      text: 'Plan complete [BRAINSTORM_COMPLETE]',
    }
    const events = handleItemCompleted(item, state)
    expect(events).toContainEqual({ kind: 'session:brainstorm-complete' })
  })

  it('does not emit session:brainstorm-complete when sentinel is absent', () => {
    const state = mkState()
    const item = { id: 'item_0', type: 'agentMessage' as const, text: 'Just a message' }
    const events = handleItemCompleted(item, state)
    expect(events.some((e) => e.kind === 'session:brainstorm-complete')).toBe(false)
  })
})

// ── 6. handleItemCompleted — agentMessage quota detection ─────────────────────

describe('handleItemCompleted — agentMessage quota detection', () => {
  it('emits error/quota when message text matches QUOTA_PATTERN', () => {
    const state = mkState()
    const item = { id: 'item_0', type: 'agentMessage' as const, text: 'rate limit exceeded' }
    const events = handleItemCompleted(item, state)
    expect(events).toContainEqual({
      kind: 'error',
      category: 'quota',
      message: 'rate limit exceeded',
    })
    expect(state.quotaErrorEmitted).toBe(true)
    expect(state.sawErrorResult).toBe(true)
  })

  it('QUOTA_PATTERN matches various quota error wordings', () => {
    expect(QUOTA_PATTERN.test('rate limit reached')).toBe(true)
    expect(QUOTA_PATTERN.test('quota exceeded')).toBe(true)
    expect(QUOTA_PATTERN.test('out of extra usage')).toBe(true)
    expect(QUOTA_PATTERN.test('usage limit exceeded')).toBe(true)
    expect(QUOTA_PATTERN.test('insufficient_quota')).toBe(true)
    expect(QUOTA_PATTERN.test('just a regular message')).toBe(false)
  })
})

// ── 7. handleItemCompleted — reasoning ────────────────────────────────────────

describe('handleItemCompleted — reasoning', () => {
  it('emits message:thinking with concatenated summary and content', () => {
    const state = mkState()
    const item = {
      id: 'item_1',
      type: 'reasoning' as const,
      summary: ['Thinking step 1', 'Thinking step 2'],
      content: ['Internal reasoning detail'],
    }
    const events = handleItemCompleted(item, state)
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({
      kind: 'message:thinking',
      messageId: 'test_item_1',
      text: 'Thinking step 1\nThinking step 2\nInternal reasoning detail',
    })
  })

  it('handles empty arrays gracefully', () => {
    const state = mkState()
    const item = { id: 'item_1', type: 'reasoning' as const, summary: [], content: [] }
    const events = handleItemCompleted(item, state)
    expect(events).toHaveLength(1)
    expect((events[0] as Extract<AgentEvent, { kind: 'message:thinking' }>).text).toBe('')
  })
})

// ── 8. handleItemStarted — commandExecution ────────────────────────────────────

describe('handleItemStarted — commandExecution', () => {
  it('emits tool:call with name=Bash and the command', () => {
    const state = mkState()
    const item = {
      id: 'item_2',
      type: 'commandExecution' as const,
      command: 'ls -la',
      aggregatedOutput: null,
      exitCode: null,
      status: 'inProgress' as const,
    }
    const events = handleItemStarted(item, state)
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({
      kind: 'tool:call',
      messageId: '',
      toolCallId: 'test_item_2',
      name: 'Bash',
      input: { command: 'ls -la' },
    })
  })
})

// ── 9. handleItemCompleted — commandExecution failed ──────────────────────────

describe('handleItemCompleted — commandExecution', () => {
  it('emits tool:result with isError=true when status=failed', () => {
    const state = mkState()
    const item = {
      id: 'item_2',
      type: 'commandExecution' as const,
      command: 'bad-cmd',
      status: 'failed' as const,
      aggregatedOutput: 'command not found',
      exitCode: 127,
    }
    const events = handleItemCompleted(item, state)
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({
      kind: 'tool:result',
      toolCallId: 'test_item_2',
      output: { aggregated_output: 'command not found', exit_code: 127 },
      isError: true,
    })
  })

  it('emits tool:result with isError=false when status=completed', () => {
    const state = mkState()
    const item = {
      id: 'item_3',
      type: 'commandExecution' as const,
      command: 'echo hi',
      status: 'completed' as const,
      aggregatedOutput: 'hi',
      exitCode: 0,
    }
    const events = handleItemCompleted(item, state)
    expect(events[0]).toMatchObject({ kind: 'tool:result', isError: false })
  })

  it('uses snake_case keys for output (aggregated_output, exit_code) as the UI expects', () => {
    const state = mkState()
    const item = {
      id: 'item_4',
      type: 'commandExecution' as const,
      command: 'pwd',
      status: 'completed' as const,
      aggregatedOutput: '/home/user',
      exitCode: 0,
    }
    const events = handleItemCompleted(item, state)
    const result = events[0] as Extract<AgentEvent, { kind: 'tool:result' }>
    expect(result.output).toHaveProperty('aggregated_output', '/home/user')
    expect(result.output).toHaveProperty('exit_code', 0)
  })
})

// ── 9.5 handleItemStarted — fileChange (Codex → Edit shape) ───────────────────

describe('handleItemStarted — fileChange', () => {
  it('emits a Claude-style Edit tool:call so file_path is visible in the UI', () => {
    const state = mkState()
    const item = {
      id: 'item_3',
      type: 'fileChange' as const,
      changes: [
        {
          path: '/repo/src/foo.ts',
          kind: { type: 'update' as const, move_path: null },
          diff: '@@ -1,1 +1,1 @@\n-old\n+new',
        },
      ],
      status: 'completed' as const,
    }
    const events = handleItemStarted(item, state)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      kind: 'tool:call',
      toolCallId: 'test_item_3',
      name: 'Edit',
      input: {
        file_path: '/repo/src/foo.ts',
        diff: '@@ -1,1 +1,1 @@\n-old\n+new',
        change_kind: 'update',
      },
    })
    // The renderer's compactPath/getFileChangeInfo path depends on file_path.
    const input = (events[0] as { input: Record<string, unknown> }).input
    expect(input.file_path).toBe('/repo/src/foo.ts')
  })

  it('surfaces move_path for renames (kind=update with move_path)', () => {
    const state = mkState()
    const item = {
      id: 'item_3',
      type: 'fileChange' as const,
      changes: [
        {
          path: '/repo/src/old.ts',
          kind: { type: 'update' as const, move_path: '/repo/src/new.ts' },
          diff: '',
        },
      ],
      status: 'completed' as const,
    }
    const events = handleItemStarted(item, state)
    const input = (events[0] as { input: Record<string, unknown> }).input
    expect(input.move_path).toBe('/repo/src/new.ts')
  })
})

// ── 9.6 handle*Item* — collabAgentToolCall (Codex sub-agents) ────────────────

describe('handleItemStarted — collabAgentToolCall', () => {
  it('emits both a Task tool:call (chat card) and subagent:progress (side panel) on spawnAgent', () => {
    const state = mkState()
    const item = {
      id: 'item_sa',
      type: 'collabAgentToolCall' as const,
      tool: 'spawnAgent' as const,
      status: 'inProgress' as const,
      senderThreadId: 'thr_parent',
      receiverThreadIds: ['thr_child'],
      prompt: 'Summarise the README',
      model: null,
      agentsStates: {},
    }
    const events = handleItemStarted(item, state)
    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({
      kind: 'tool:call',
      toolCallId: 'test_item_sa',
      name: 'Task',
      input: {
        codex_tool: 'spawnAgent',
        description: 'Summarise the README',
        prompt: 'Summarise the README',
        sender_thread_id: 'thr_parent',
        receiver_thread_ids: ['thr_child'],
      },
    })
    expect(events[1]).toEqual({
      kind: 'subagent:progress',
      toolCallId: 'test_item_sa',
      status: 'running',
      description: 'Summarise the README',
      taskType: 'spawnAgent',
    })
  })

  it('falls back to the tool name in description when prompt is null (wait / closeAgent)', () => {
    const state = mkState()
    const item = {
      id: 'item_sa',
      type: 'collabAgentToolCall' as const,
      tool: 'wait' as const,
      status: 'inProgress' as const,
      senderThreadId: 'thr_parent',
      receiverThreadIds: ['thr_child'],
      prompt: null,
      model: null,
      agentsStates: {},
    }
    const events = handleItemStarted(item, state)
    const toolCall = events[0] as { input: Record<string, unknown> }
    expect(toolCall.input.description).toBe('wait')
    expect(toolCall.input.prompt).toBeNull()
    expect(events[1]).toEqual({
      kind: 'subagent:progress',
      toolCallId: 'test_item_sa',
      status: 'running',
      description: 'wait',
      taskType: 'wait',
    })
  })
})

describe('handleItemCompleted — collabAgentToolCall', () => {
  it('emits tool:result + subagent:progress=done when the call completes', () => {
    const state = mkState()
    const item = {
      id: 'item_sa',
      type: 'collabAgentToolCall' as const,
      tool: 'spawnAgent' as const,
      status: 'completed' as const,
      senderThreadId: 'thr_parent',
      receiverThreadIds: ['thr_child'],
      prompt: 'Do thing',
      model: 'gpt-5.4',
      agentsStates: { thr_child: { status: 'completed' as const, message: null } },
    }
    const events = handleItemCompleted(item, state)
    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({
      kind: 'tool:result',
      toolCallId: 'test_item_sa',
      isError: false,
      output: {
        codex_tool: 'spawnAgent',
        status: 'completed',
      },
    })
    expect(events[1]).toEqual({
      kind: 'subagent:progress',
      toolCallId: 'test_item_sa',
      status: 'done',
      description: 'Do thing',
      taskType: 'spawnAgent',
    })
  })

  it('marks tool:result as error when the collab call failed', () => {
    const state = mkState()
    const item = {
      id: 'item_sa',
      type: 'collabAgentToolCall' as const,
      tool: 'spawnAgent' as const,
      status: 'failed' as const,
      senderThreadId: 'thr_parent',
      receiverThreadIds: [],
      prompt: 'Boom',
      model: null,
      agentsStates: {},
    }
    const events = handleItemCompleted(item, state)
    expect(events[0]).toMatchObject({ kind: 'tool:result', isError: true })
  })
})

// ── 9.7 handle*Item* — extra item types (dynamic / image / review / compaction)

describe('handleItemStarted — dynamicToolCall', () => {
  it('namespaces the tool name with mcp-style separator', () => {
    const state = mkState()
    const item = {
      id: 'dyn_1',
      type: 'dynamicToolCall' as const,
      namespace: 'ext',
      tool: 'doStuff',
      arguments: { x: 1 },
      status: 'inProgress' as const,
      contentItems: null,
      success: null,
      durationMs: null,
    }
    const events = handleItemStarted(item, state)
    expect(events).toEqual([
      {
        kind: 'tool:call',
        messageId: '',
        toolCallId: 'test_dyn_1',
        name: 'ext__doStuff',
        input: { x: 1 },
      },
    ])
  })

  it('uses the bare tool name when namespace is null', () => {
    const state = mkState()
    const item = {
      id: 'dyn_2',
      type: 'dynamicToolCall' as const,
      namespace: null,
      tool: 'standalone',
      arguments: {},
      status: 'inProgress' as const,
      contentItems: null,
      success: null,
      durationMs: null,
    }
    const events = handleItemStarted(item, state)
    expect((events[0] as { name: string }).name).toBe('standalone')
  })
})

describe('handleItemCompleted — dynamicToolCall', () => {
  it('marks the result as error when success=false', () => {
    const state = mkState()
    const item = {
      id: 'dyn_3',
      type: 'dynamicToolCall' as const,
      namespace: null,
      tool: 't',
      arguments: {},
      status: 'completed' as const,
      contentItems: [{ type: 'inputText' as const, text: 'oops' }],
      success: false,
      durationMs: 123,
    }
    const events = handleItemCompleted(item, state)
    expect(events[0]).toMatchObject({ kind: 'tool:result', isError: true })
  })
})

describe('handleItemStarted — imageView', () => {
  it('emits a Read-equivalent tool:call with file_path', () => {
    const state = mkState()
    const item = { id: 'img_1', type: 'imageView' as const, path: '/tmp/x.png' }
    const events = handleItemStarted(item, state)
    expect(events).toEqual([
      {
        kind: 'tool:call',
        messageId: '',
        toolCallId: 'test_img_1',
        name: 'Read',
        input: { file_path: '/tmp/x.png' },
      },
    ])
  })
})

describe('handleItemStarted — imageGeneration', () => {
  it('emits ImageGeneration tool:call with revisedPrompt', () => {
    const state = mkState()
    const item = {
      id: 'gen_1',
      type: 'imageGeneration' as const,
      status: 'queued',
      revisedPrompt: 'a red apple',
      result: '',
    }
    const events = handleItemStarted(item, state)
    expect(events[0]).toMatchObject({
      kind: 'tool:call',
      name: 'ImageGeneration',
      input: { revisedPrompt: 'a red apple' },
    })
  })
})

describe('handleItemStarted — review mode', () => {
  it('maps enteredReviewMode to a thinking block prefixed with review:start', () => {
    const state = mkState()
    const item = { id: 'rv_1', type: 'enteredReviewMode' as const, review: 'checking diff' }
    const events = handleItemStarted(item, state)
    expect(events[0]).toMatchObject({ kind: 'message:thinking' })
    expect((events[0] as { text: string }).text).toContain('[review:start]')
    expect((events[0] as { text: string }).text).toContain('checking diff')
  })

  it('maps exitedReviewMode to a thinking block prefixed with review:end', () => {
    const state = mkState()
    const item = { id: 'rv_2', type: 'exitedReviewMode' as const, review: 'done' }
    const events = handleItemStarted(item, state)
    expect((events[0] as { text: string }).text).toContain('[review:end]')
  })
})

describe('handleItemStarted — contextCompaction', () => {
  it('emits session:compacted (no payload)', () => {
    const state = mkState()
    const item = { id: 'cmp_1', type: 'contextCompaction' as const }
    const events = handleItemStarted(item, state)
    expect(events).toEqual([{ kind: 'session:compacted' }])
  })
})

// ── 10. handleItemStarted — webSearch ─────────────────────────────────────────

describe('handleItemStarted — webSearch', () => {
  it('emits tool:call with name=WebSearch and the query', () => {
    const state = mkState()
    const item = { id: 'item_5', type: 'webSearch' as const, query: 'how to use vitest' }
    const events = handleItemStarted(item, state)
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({
      kind: 'tool:call',
      messageId: '',
      toolCallId: 'test_item_5',
      name: 'WebSearch',
      input: { query: 'how to use vitest' },
    })
  })
})

// ── 11. handleItemCompleted — plan ────────────────────────────────────────────

describe('handleItemCompleted — plan', () => {
  function todosOf(events: ReturnType<typeof handleItemCompleted>) {
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ kind: 'tool:call', name: 'TodoWrite' })
    const ev = events[0] as { input: { todos: Array<{ content: string; status: string }> } }
    return ev.input.todos
  }

  it('falls back to a single-item list when the text has no bullets', () => {
    const state = mkState()
    const item = { id: 'item_6', type: 'plan' as const, text: 'Implement feature X' }
    const todos = todosOf(handleItemCompleted(item, state))
    expect(todos).toEqual([{ content: 'Implement feature X', status: 'pending' }])
  })

  it('splits dash-bullet lines into individual todos', () => {
    const state = mkState()
    const item = {
      id: 'item_6',
      type: 'plan' as const,
      text: '- First task\n- Second task\n- Third task',
    }
    const todos = todosOf(handleItemCompleted(item, state))
    expect(todos).toEqual([
      { content: 'First task', status: 'pending' },
      { content: 'Second task', status: 'pending' },
      { content: 'Third task', status: 'pending' },
    ])
  })

  it('accepts *, + and numbered bullets equivalently', () => {
    const state = mkState()
    const item = {
      id: 'item_6',
      type: 'plan' as const,
      text: '* Star item\n+ Plus item\n1. Numbered one\n2. Numbered two',
    }
    const todos = todosOf(handleItemCompleted(item, state))
    expect(todos.map((t) => t.content)).toEqual(['Star item', 'Plus item', 'Numbered one', 'Numbered two'])
  })

  it('ignores markdown headings (#, ##, ###)', () => {
    const state = mkState()
    const item = {
      id: 'item_6',
      type: 'plan' as const,
      text: '# Title\n## Subtitle\n- Real item',
    }
    const todos = todosOf(handleItemCompleted(item, state))
    expect(todos).toEqual([{ content: 'Real item', status: 'pending' }])
  })

  it('flattens nested bullets into the same flat todo list', () => {
    const state = mkState()
    const item = {
      id: 'item_6',
      type: 'plan' as const,
      text: '- Parent task\n  - Child A\n  - Child B\n- Sibling task',
    }
    const todos = todosOf(handleItemCompleted(item, state))
    expect(todos.map((t) => t.content)).toEqual(['Parent task', 'Child A', 'Child B', 'Sibling task'])
  })

  it('preserves a paragraph continuation under a bullet', () => {
    const state = mkState()
    const item = {
      id: 'item_6',
      type: 'plan' as const,
      text: '- First task that wraps\n  to the next line\n- Second task',
    }
    const todos = todosOf(handleItemCompleted(item, state))
    expect(todos[0].content).toBe('First task that wraps to the next line')
    expect(todos[1].content).toBe('Second task')
  })

  it('returns an empty array when the text is blank', () => {
    const state = mkState()
    const item = { id: 'item_6', type: 'plan' as const, text: '   \n\n  ' }
    const events = handleItemCompleted(item, state)
    // Empty plan should still emit a TodoWrite call (so the UI can clear stale
    // todos), but with an empty list.
    expect(events).toHaveLength(1)
    const ev = events[0] as { input: { todos: unknown[] } }
    expect(ev.input.todos).toEqual([])
  })
})

// ── 12. handleItemCompleted — error item ──────────────────────────────────────

describe('handleItemCompleted — error item', () => {
  it('emits error event with category=other for non-quota errors', () => {
    const state = mkState()
    const item = { id: 'item_7', type: 'error' as const, message: 'Something went wrong' }
    const events = handleItemCompleted(item, state)
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({
      kind: 'error',
      category: 'other',
      message: 'Something went wrong',
    })
    expect(state.sawErrorResult).toBe(true)
  })

  it('emits error/quota for quota-matching error items', () => {
    const state = mkState()
    const item = { id: 'item_7', type: 'error' as const, message: 'rate limit exceeded' }
    const events = handleItemCompleted(item, state)
    expect(events[0]).toMatchObject({ kind: 'error', category: 'quota' })
    expect(state.quotaErrorEmitted).toBe(true)
  })
})

// ── 13. handleTurnCompleted — turn failed with error ──────────────────────────

describe('handleTurnCompleted', () => {
  it('emits error event when turn.status=failed with a non-quota message', () => {
    const state = mkState()
    const n = {
      threadId: 'thread-1',
      turn: {
        id: 'turn-1',
        status: 'failed' as const,
        startedAt: null,
        completedAt: null,
        durationMs: null,
        error: { message: 'Internal server error' },
      },
    }
    const events = handleTurnCompleted(n, state)
    expect(events).toContainEqual({
      kind: 'error',
      category: 'other',
      message: 'Internal server error',
    })
    expect(state.sawErrorResult).toBe(true)
  })

  it('uses fallback message when turn.error is null', () => {
    const state = mkState()
    const n = {
      threadId: 'thread-1',
      turn: {
        id: 'turn-1',
        status: 'failed' as const,
        startedAt: null,
        completedAt: null,
        durationMs: null,
        error: null,
      },
    }
    const events = handleTurnCompleted(n, state)
    expect(events[0]).toMatchObject({ kind: 'error', message: 'turn failed' })
  })

  it('emits no events when turn.status=completed', () => {
    const state = mkState()
    const n = {
      threadId: 'thread-1',
      turn: {
        id: 'turn-1',
        status: 'completed' as const,
        startedAt: null,
        completedAt: null,
        durationMs: null,
        error: null,
      },
    }
    const events = handleTurnCompleted(n, state)
    expect(events).toHaveLength(0)
  })

  it('flags state.sawTurnInterrupted=true when status=interrupted (no event emitted)', () => {
    const state = mkState()
    const n = {
      threadId: 'thread-1',
      turn: {
        id: 'turn-1',
        status: 'interrupted' as const,
        startedAt: null,
        completedAt: null,
        durationMs: null,
        error: null,
      },
    }
    const events = handleTurnCompleted(n, state)
    // No AgentEvent — the engine reads the flag and emits session:ended reason='killed'
    expect(events).toHaveLength(0)
    expect(state.sawTurnInterrupted).toBe(true)
    expect(state.sawErrorResult).toBe(false)
  })
})

// ── 14. handleTurnCompleted — quota detection ─────────────────────────────────

describe('handleTurnCompleted — quota', () => {
  it('emits error/quota via tryEmitQuota when turn fails with a quota message', () => {
    const state = mkState()
    const n = {
      threadId: 'thread-1',
      turn: {
        id: 'turn-1',
        status: 'failed' as const,
        startedAt: null,
        completedAt: null,
        durationMs: null,
        error: { message: 'quota exceeded, please upgrade' },
      },
    }
    const events = handleTurnCompleted(n, state)
    expect(events).toContainEqual(expect.objectContaining({ kind: 'error', category: 'quota' }))
    expect(state.quotaErrorEmitted).toBe(true)
    expect(state.sawErrorResult).toBe(true)
  })
})

// ── 14b. handleRateLimitsUpdated — buckets + status ───────────────────────────

describe('handleRateLimitsUpdated', () => {
  it('maps primary+secondary windows to rate_limit buckets with ISO resetsAt', () => {
    const state = mkState()
    // 2026-05-11T12:00:00Z = 1778500800 (approximate, used as unix seconds)
    const out = handleRateLimitsUpdated(
      {
        rateLimits: {
          limitId: 'l1',
          limitName: 'API requests',
          primary: { usedPercent: 25, windowDurationMins: 60, resetsAt: 1778500800 },
          secondary: { usedPercent: 10, windowDurationMins: 1440, resetsAt: 1778587200 },
          rateLimitReachedType: null,
        },
      },
      state,
    )
    expect(out).toEqual([
      {
        kind: 'rate_limit',
        info: {
          buckets: [
            { id: 'primary', label: 'API requests', usedPct: 25, resetsAt: '2026-05-11T12:00:00.000Z' },
            { id: 'secondary', label: 'API requests', usedPct: 10, resetsAt: '2026-05-12T12:00:00.000Z' },
          ],
          status: 'allowed',
        },
      },
    ])
  })

  it('returns [] when no buckets are present', () => {
    const state = mkState()
    const out = handleRateLimitsUpdated(
      { rateLimits: { limitId: null, limitName: null, primary: null, secondary: null, rateLimitReachedType: null } },
      state,
    )
    expect(out).toEqual([])
  })

  it('flags status=allowed_warning when usedPct >= 80', () => {
    const state = mkState()
    const out = handleRateLimitsUpdated(
      {
        rateLimits: {
          limitId: null,
          limitName: null,
          primary: { usedPercent: 82, windowDurationMins: 60, resetsAt: null },
          secondary: null,
          rateLimitReachedType: null,
        },
      },
      state,
    )
    const rl = out.find((e) => e.kind === 'rate_limit') as Extract<AgentEvent, { kind: 'rate_limit' }>
    expect(rl.info.status).toBe('allowed_warning')
  })

  it('emits rate_limit + error/quota and flags state when rateLimitReachedType is set', () => {
    const state = mkState()
    const out = handleRateLimitsUpdated(
      {
        rateLimits: {
          limitId: null,
          limitName: null,
          primary: { usedPercent: 100, windowDurationMins: 60, resetsAt: null },
          secondary: null,
          rateLimitReachedType: 'primary',
        },
      },
      state,
    )
    const rl = out.find((e) => e.kind === 'rate_limit') as Extract<AgentEvent, { kind: 'rate_limit' }>
    expect(rl.info.status).toBe('rejected')
    const err = out.find((e) => e.kind === 'error') as Extract<AgentEvent, { kind: 'error' }>
    expect(err.category).toBe('quota')
    expect(state.sawErrorResult).toBe(true)
    expect(state.quotaErrorEmitted).toBe(true)
  })
})

// ── 15. tryEmitQuota is one-shot ──────────────────────────────────────────────

describe('tryEmitQuota', () => {
  it('emits error/quota exactly once regardless of how many times it is called', () => {
    const state = mkState()
    const collected: AgentEvent[] = []
    const emit = (ev: AgentEvent) => collected.push(ev)

    tryEmitQuota(state, emit, 'quota exceeded')
    tryEmitQuota(state, emit, 'quota exceeded again')
    tryEmitQuota(state, emit, 'rate limit reached')

    expect(collected).toHaveLength(1)
    expect(collected[0]).toEqual({ kind: 'error', category: 'quota', message: 'quota exceeded' })
    expect(state.quotaErrorEmitted).toBe(true)
    expect(state.sawErrorResult).toBe(true)
  })

  it('sets both quotaErrorEmitted and sawErrorResult on first call', () => {
    const state = mkState()
    expect(state.quotaErrorEmitted).toBe(false)
    expect(state.sawErrorResult).toBe(false)
    tryEmitQuota(state, () => {}, 'rate_limit exceeded')
    expect(state.quotaErrorEmitted).toBe(true)
    expect(state.sawErrorResult).toBe(true)
  })

  it('is a no-op when quotaErrorEmitted is already set', () => {
    const state = mkState()
    state.quotaErrorEmitted = true
    state.sawErrorResult = true
    const collected: AgentEvent[] = []
    tryEmitQuota(state, (ev) => collected.push(ev), 'rate limit')
    expect(collected).toHaveLength(0)
  })
})

// ── Additional: createMapperState defaults ────────────────────────────────────

describe('createMapperState', () => {
  it('creates state with sessionStartedEmitted=false', () => {
    const state = mkState()
    expect(state.sessionStartedEmitted).toBe(false)
  })

  it('creates state with an empty openMessages map', () => {
    const state = mkState()
    expect(state.openMessages.size).toBe(0)
  })

  it('uses the provided sessionPrefix', () => {
    const state = createMapperState({ sessionPrefix: 'my_prefix' })
    expect(state.sessionPrefix).toBe('my_prefix')
  })

  it('generates a cdx_-prefixed nanoid when no sessionPrefix is provided', () => {
    const state = createMapperState()
    expect(state.sessionPrefix).toMatch(/^cdx_[A-Za-z0-9_-]{10}$/)
  })
})
