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

  it('groups every action from one sub-agent in one collapsed block', () => {
    expect(source).toContain("const subagentRows = new Map<string, Extract<DisplayRow, { type: 'subagent' }>>()")
    expect(source).toContain('const existingRow = subagentRows.get(subagentKey)')
    expect(source).not.toContain('const previous = rows.at(-1)')
  })

  it('shows an icon and the matching sub-agent description in collapsed activity', () => {
    expect(source).toContain('findSubagentForActivity')
    expect(source).toContain('row.subagentName')
    expect(source).toContain('name="hub"')
    expect(source).toContain("return name || t('chat.subagentActivity')")
  })
})
