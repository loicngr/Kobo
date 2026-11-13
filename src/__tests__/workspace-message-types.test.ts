import { describe, expect, it } from 'vitest'
import { parseMessageSource } from '../shared/workspace-message-types.js'

const slack = { kind: 'slack', userName: 'Alice', userId: 'U1', channelId: 'C1', threadTs: '1.2' }

describe('parseMessageSource', () => {
  it('keeps the slack variant', () => {
    expect(parseMessageSource(slack)).toEqual(slack)
  })

  it('cleans the slack user name and falls back', () => {
    expect(parseMessageSource({ ...slack, userName: ' A\n\tB ' })).toMatchObject({ userName: 'A B' })
    expect(parseMessageSource({ ...slack, userName: 'x'.repeat(300) })).toMatchObject({ userName: 'x'.repeat(100) })
    expect(parseMessageSource({ ...slack, userName: undefined })).toMatchObject({ userName: 'Slack user' })
  })

  it('rejects slack sources with missing ids', () => {
    for (const key of ['userId', 'channelId', 'threadTs']) {
      expect(parseMessageSource({ ...slack, [key]: undefined })).toBeUndefined()
      expect(parseMessageSource({ ...slack, [key]: '' })).toBeUndefined()
    }
  })

  it('keeps the mcp variant', () => {
    expect(parseMessageSource({ kind: 'mcp', clientName: 'c', transport: 'http' })).toEqual({
      kind: 'mcp',
      clientName: 'c',
      transport: 'http',
    })
    expect(parseMessageSource({ kind: 'mcp', clientName: 'c', transport: 'x' })).toBeUndefined()
  })
})
