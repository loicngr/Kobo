import { describe, expect, it } from 'vitest'
import {
  estimateMemoryTokens,
  MEMORY_OUTPUT_HARD_BYTES,
  prepareMemoryToolEnvelope,
  sliceMemoryBodyFragment,
} from '../server/utils/memory-token-budget.js'

describe('memory output token estimator', () => {
  it('uses UTF-8 bytes plus framing headroom rather than UTF-16 length', () => {
    const ascii = 'x'.repeat(100)
    const unicode = '漢字🙂é'.repeat(25)
    expect(estimateMemoryTokens(unicode)).toBeGreaterThan(estimateMemoryTokens(ascii))
    expect(estimateMemoryTokens(unicode)).toBe(Buffer.byteLength(unicode, 'utf8') + 96)
  })

  it('accounts for escaped JSON and duplicated structured content in the final MCP envelope', () => {
    const result = prepareMemoryToolEnvelope({ text: '\\"'.repeat(8_000), value: '🙂'.repeat(300) })
    expect(result.payloadBytes).toBeLessThanOrEqual(MEMORY_OUTPUT_HARD_BYTES)
    expect(result.estimatedTokens).toBeLessThanOrEqual(1_000)
    expect(result.data.truncated).toBe(true)
    expect(result.serializedEnvelope).toContain('structuredContent')
    expect(Buffer.byteLength(result.serializedEnvelope, 'utf8')).toBe(result.payloadBytes)
  })

  it('budgets internal REST plus text-only MCP framing separately from external structured duplication', () => {
    const data = { result: 'compact payload 🙂' }
    const internal = prepareMemoryToolEnvelope(data, { transport: 'internal' })
    const external = prepareMemoryToolEnvelope(data, { transport: 'external' })
    expect(internal.serializedEnvelope).toContain('"rest"')
    expect(internal.serializedEnvelope).toContain('"content"')
    expect(external.serializedEnvelope).toContain('"structuredContent"')
    expect(internal.estimatedTokens).toBeLessThan(external.estimatedTokens)
  })

  it('does not allow a very large requested result to escape the hard cap', () => {
    const result = prepareMemoryToolEnvelope(
      { items: Array.from({ length: 10_000 }, (_, index) => ({ id: `${index}`, body: '🧠'.repeat(2_000) })) },
      { targetTokens: 1_000 },
    )
    expect(result.payloadBytes).toBeLessThanOrEqual(MEMORY_OUTPUT_HARD_BYTES)
    expect(result.data.items).toEqual([])
    expect(result.data.truncated).toBe(true)
  })

  it('paginates emoji by code point and invalidates a cursor after a revision change', () => {
    const body = '🙂漢字'.repeat(30)
    const first = sliceMemoryBodyFragment({ body, revision: 3 })
    expect([...first.text!]).toHaveLength(40)
    expect(first.nextCursor).toBe('3.40')
    const next = sliceMemoryBodyFragment({ body, revision: 3, cursor: first.nextCursor })
    expect(next.offset).toBe(40)
    expect(next.truncated).toBe(true)
    expect(() => sliceMemoryBodyFragment({ body, revision: 4, cursor: first.nextCursor })).toThrow(/changed/)
  })
})
