import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(join(process.cwd(), 'src/components/TurnCard.vue'), 'utf-8')

describe('TurnCard', () => {
  it('uses distinct accents for user and agent turns', () => {
    expect(source).toContain("accent: 'var(--kobo-turn-user)'")
    expect(source).toContain("accent: 'var(--kobo-turn-agent)'")
    expect(source).toMatch(/\.turn-badge-user\s*\{[\s\S]*?color:\s*var\(--kobo-turn-user\);/)
    expect(source).toMatch(/\.turn-badge-agent\s*\{[\s\S]*?color:\s*var\(--kobo-turn-agent\);/)
  })
})
