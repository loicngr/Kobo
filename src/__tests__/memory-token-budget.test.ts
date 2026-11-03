import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as settings from '../server/services/settings-service.js'
import { _setSettingsPath } from '../server/services/settings-service.js'
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
    const body = '🙂漢字'.repeat(50)
    const first = sliceMemoryBodyFragment({ body, revision: 3 })
    expect([...first.text!]).toHaveLength(60)
    expect(first.nextCursor).toBe('3.60')
    const next = sliceMemoryBodyFragment({ body, revision: 3, cursor: first.nextCursor })
    expect(next.offset).toBe(60)
    expect(next.truncated).toBe(true)
    expect(() => sliceMemoryBodyFragment({ body, revision: 4, cursor: first.nextCursor })).toThrow(/changed/)
  })
})

let settingsDir: string
beforeEach(() => {
  settingsDir = mkdtempSync(join(tmpdir(), 'kobo-memory-settings-'))
  _setSettingsPath(join(settingsDir, 'settings.json'))
})
afterEach(() => {
  rmSync(settingsDir, { recursive: true, force: true })
})

it('reads limits once for a whole serialization and picks up changes on the next call', () => {
  const spy = vi.spyOn(settings, 'getMemoryLimits')
  try {
    const input = { items: Array.from({ length: 100 }, (_, i) => ({ id: String(i), body: 'x'.repeat(100) })) }
    prepareMemoryToolEnvelope(input)
    expect(spy).toHaveBeenCalledTimes(1)
    settings.updateGlobalSettings({
      memoryLimits: { ...settings.getMemoryLimits(), responseTokens: 2000, responseHardTokens: 2500 },
    })
    spy.mockClear()
    const result = prepareMemoryToolEnvelope(input)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(result.estimatedTokens).toBeGreaterThan(1000)
    expect(result.estimatedTokens).toBeLessThanOrEqual(2000)
  } finally {
    spy.mockRestore()
  }
})
