import { describe, expect, it } from 'vitest'
import type { MemoryActor, MemoryMode, MemoryScope } from '../shared/memory.js'
import { deriveMemoryActor, isMemoryMode, isMemoryScope, memoryWriteDecision } from '../shared/memory.js'

describe('memory policy', () => {
  const modes: MemoryMode[] = ['manual', 'automatic', 'hybrid']
  const levels: MemoryScope['level'][] = ['global', 'project', 'workspace']

  it('decides writes for every mode and scope level', () => {
    const expected = {
      manual: ['deny', 'deny', 'deny'],
      automatic: ['apply', 'apply', 'apply'],
      hybrid: ['propose', 'propose', 'apply'],
    }

    for (const mode of modes) {
      for (const [index, level] of levels.entries()) {
        expect(memoryWriteDecision(mode, level, false)).toBe(expected[mode][index])
      }
    }
  })

  it('denies writes for every mode and scope in a read-only launch', () => {
    for (const mode of modes) {
      for (const level of levels) expect(memoryWriteDecision(mode, level, true)).toBe('deny')
    }
  })

  it('recognizes only supported modes, including untrusted runtime values', () => {
    expect(modes.every(isMemoryMode)).toBe(true)
    for (const value of ['', 'AUTO', 'read-only', null, 1, {}]) expect(isMemoryMode(value)).toBe(false)
    expect(memoryWriteDecision('invalid' as MemoryMode, 'workspace', false)).toBe('deny')
  })

  it('accepts exactly the three valid scope shapes', () => {
    expect(isMemoryScope({ level: 'global' })).toBe(true)
    expect(isMemoryScope({ level: 'project', projectPath: '/repo' })).toBe(true)
    expect(isMemoryScope({ level: 'workspace', workspaceId: 'ws-1' })).toBe(true)
  })

  it('rejects malformed or ambiguous scope shapes', () => {
    for (const value of [
      null,
      [],
      {},
      { level: 'other' },
      { level: 'global', projectPath: '/repo' },
      { level: 'project' },
      { level: 'project', projectPath: '' },
      { level: 'project', projectPath: '/repo', workspaceId: 'ws-1' },
      { level: 'workspace', workspaceId: 2 },
      { level: 'workspace', workspaceId: 'ws-1', extra: true },
    ]) {
      expect(isMemoryScope(value)).toBe(false)
    }
  })

  it('models actor provenance as immutable and never invents external session identity', () => {
    const external: MemoryActor = {
      kind: 'external-mcp',
      clientName: 'CLI',
      transport: 'stdio',
    }
    expect(external).toEqual({ kind: 'external-mcp', clientName: 'CLI', transport: 'stdio' })
    expect('sessionId' in external).toBe(false)

    // @ts-expect-error Actor provenance is backend-owned and immutable.
    external.clientName = 'forged'
  })

  it('derives immutable attribution from trusted source and ignores caller actor metadata', () => {
    const actor = deriveMemoryActor(
      { kind: 'external-mcp', clientName: '  Agent\n  CLI  ', transport: 'stdio' },
      { kind: 'internal-agent', workspaceId: 'forged-ws', sessionId: 'forged-session', engine: 'codex' },
    )

    expect(actor).toEqual({ kind: 'external-mcp', clientName: 'Agent CLI', transport: 'stdio' })
    expect('sessionId' in actor).toBe(false)
    expect(Object.isFrozen(actor)).toBe(true)
  })

  it('bounds external client labels, removes control characters and validates transport', () => {
    const actor = deriveMemoryActor({
      kind: 'external-mcp',
      clientName: `  ${'x'.repeat(200)}\u0000  `,
      transport: 'http',
    })
    expect(actor).toMatchObject({ kind: 'external-mcp', clientName: 'x'.repeat(120), transport: 'http' })
    expect(() => deriveMemoryActor({ kind: 'external-mcp', clientName: 'tool', transport: 'socket' } as never)).toThrow(
      'Invalid external memory transport',
    )
  })
})
