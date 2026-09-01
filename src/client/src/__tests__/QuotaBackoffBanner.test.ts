import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(join(process.cwd(), 'src/components/QuotaBackoffBanner.vue'), 'utf-8')

describe('QuotaBackoffBanner', () => {
  it('renders its recovery actions as dark outlined controls on the warning fill', () => {
    expect(source).toContain('outline dense no-caps size="sm" color="kobo-ink"')
  })
})
