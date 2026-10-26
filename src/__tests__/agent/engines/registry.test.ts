import { describe, expect, it } from 'vitest'
import { listEngines, resolveEngine } from '../../../server/services/agent/engines/registry.js'

describe('engine registry', () => {
  it('lists at least the claude-code engine', () => {
    const engines = listEngines()
    expect(engines.some((e) => e.id === 'claude-code')).toBe(true)
  })

  it("returns the claude-code engine from resolveEngine('claude-code')", () => {
    const engine = resolveEngine('claude-code')
    expect(engine.id).toBe('claude-code')
    expect(engine.displayName.length).toBeGreaterThan(0)
    expect(engine.capabilities.supportsMcp).toBe(true)
  })

  it('throws a descriptive error for an unknown engine id', () => {
    expect(() => resolveEngine('unknown-engine')).toThrow(/Unknown agent engine 'unknown-engine'/)
  })

  it('listEngines returns capabilities so the UI can render options', () => {
    const engines = listEngines()
    const claude = engines.find((e) => e.id === 'claude-code')!
    expect(Array.isArray(claude.capabilities.models)).toBe(true)
    expect(claude.capabilities.models.length).toBeGreaterThan(0)
  })
})

it('registers native Mistral execution without read-only or live steering', () => {
  expect(listEngines().map((engine) => engine.id)).toEqual(['claude-code', 'codex', 'mistral-vibe'])
  expect(resolveEngine('mistral-vibe')).toMatchObject({
    displayName: 'Mistral Vibe',
    capabilities: {
      permissionModes: ['interactive', 'strict', 'bypass'],
      supportsReadOnly: false,
      supportsLiveSteering: false,
      supportsMcp: true,
      supportsResume: true,
    },
  })
})
