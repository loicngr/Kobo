import { describe, expect, it } from 'vitest'
import { resolveCodexBinary } from '../../server/services/agent/engines/codex/spawn.js'

describe('resolveCodexBinary', () => {
  it('returns a path to the codex binary shipped with @openai/codex', () => {
    const path = resolveCodexBinary()
    expect(path.endsWith('codex.js')).toBe(true)
  })
})
