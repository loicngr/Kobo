import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(join(process.cwd(), 'src/components/LatestThinkingPanel.vue'), 'utf-8')

describe('LatestThinkingPanel', () => {
  it('uses the same dark background as the wakeup banner', () => {
    expect(source).toContain('latest-thinking-panel bg-dark')
  })
})
