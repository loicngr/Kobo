import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(join(process.cwd(), 'src/components/QuotaFooter.vue'), 'utf-8')

describe('QuotaFooter', () => {
  it('keeps compact quota progress bars large enough to read in the footer', () => {
    expect(source).toMatch(/\.quota-bar\s*\{[\s\S]*?width:\s*48px;[\s\S]*?height:\s*7px;/)
  })
})
