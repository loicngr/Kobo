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

  it('offers an icon-only shortcut from collapsed sub-agent activity to its drawer card', () => {
    expect(source).toContain('icon="open_in_new"')
    expect(source).toContain("t('chat.openSubagentActivity')")
    expect(source).toContain('@click.stop="openSubagentActivity(row.items[0]!)"')
  })
})
