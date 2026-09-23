import { describe, expect, it } from 'vitest'
import { formatStartupBanner, readStartupNotes } from '../server/utils/startup-display.js'

describe('startup display', () => {
  const base = { version: '1.2.3', port: 9997, networkEnabled: false, color: false }

  it.each(['http://localhost:8080', 'https://kobo.local:8443/'])(
    'uses the configured development client origin %s for application links',
    (devClientOrigin) => {
      const result = formatStartupBanner({
        ...base,
        devClientOrigin,
        changelog: '## 1.2.3\n- Latest update',
      })
      const origin = devClientOrigin.replace(/\/$/, '')
      expect(result).toContain(`→ ${origin}\n`)
      expect(result).toContain(`Full changelog: ${origin}/#/changelog`)
      expect(result).not.toContain('http://localhost:9997')
    },
  )

  it('shows only the running release, with at most five plain-text highlights', () => {
    const changelog = [
      '## Unreleased',
      '- Not shipped',
      '## 1.2.3',
      '### Fixed',
      '- **One** with `code` and [a link](https://example.com)',
      '- Two',
      '- Three',
      '- Four',
      '- Five',
      '- Six',
      '## 1.2.2',
      '- Older release',
    ].join('\n')
    const result = formatStartupBanner({ ...base, changelog })
    expect(result).toContain('Kōbō  v1.2.3')
    expect(result).toContain('http://localhost:9997')
    expect(result).toContain('One with code and a link')
    expect(result).toContain('Five')
    expect(result).toContain('http://localhost:9997/#/changelog')
    expect(result).not.toMatch(/Six|Older release|Not shipped|\*\*/)
    expect(result).not.toContain('\x1b')
  })

  it('does not mislabel another release when the running version has no notes', () => {
    const result = formatStartupBanner({ ...base, changelog: '## 9.0.0\n- Future feature' })
    expect(result).toContain('Server ready')
    expect(result).not.toMatch(/What’s new|Future feature/)
  })

  it('keeps network URLs and authentication information when network access is on', () => {
    const result = formatStartupBanner({
      ...base,
      networkEnabled: true,
      lanUrls: ['http://192.168.1.2:9997'],
      token: 'test-token',
    })
    expect(result).toContain('http://localhost:9997')
    expect(result).toContain('http://192.168.1.2:9997')
    expect(result).toContain('test-token')
    expect(result).toContain('Network access enabled')
    expect(result).not.toContain('Local access only')
  })

  it('does not display a configured token when network access is off', () => {
    expect(formatStartupBanner({ ...base, token: 'hidden' })).not.toContain('hidden')
  })

  it('bounds long highlights and ignores nested bullets', () => {
    const result = formatStartupBanner({ ...base, changelog: `## 1.2.3\n- ${'word '.repeat(100)}\n  - detail` })
    expect(result).toContain('…')
    expect(result).not.toContain('detail')
    expect(result.split('\n').find((line) => line.includes('•'))!.length).toBeLessThanOrEqual(100)
  })

  it('tolerates a missing changelog', () => {
    expect(readStartupNotes('/nonexistent/kobo/CHANGELOG.md')).toBe('')
    expect(formatStartupBanner(base)).toContain('Server ready')
  })
})
