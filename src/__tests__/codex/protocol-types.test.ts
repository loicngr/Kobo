import { describe, expect, it } from 'vitest'
import type {
  AgentMessageItem,
  ThreadItem,
  ThreadStartParams,
  ToolRequestUserInputResponse,
} from '../../server/services/agent/engines/codex/protocol/types.js'

describe('protocol types compile', () => {
  it('exports a ThreadItem union that includes agent_message', () => {
    const msg: AgentMessageItem = { id: 'i', type: 'agentMessage', text: 'hi' }
    const item: ThreadItem = msg
    expect(item.type).toBe('agentMessage')
  })

  it('exports ToolRequestUserInputResponse with answers map', () => {
    const r: ToolRequestUserInputResponse = {
      answers: { q1: { answers: ['yes'] } },
    }
    expect(r.answers.q1.answers).toEqual(['yes'])
  })

  it('ThreadStartParams requires experimentalRawEvents and persistExtendedHistory', () => {
    const p: ThreadStartParams = {
      cwd: '/tmp',
      experimentalRawEvents: false,
      persistExtendedHistory: false,
    }
    expect(p.cwd).toBe('/tmp')
  })
})
