import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import changelogRouter, { parseChangelog } from '../server/routes/changelog.js'

describe('parseChangelog', () => {
  it('splits the markdown into ordered version sections', () => {
    const md = [
      '# Changelog',
      '',
      '## 1.7.14',
      '',
      '- Added the Environment card',
      '',
      '## 1.7.13',
      '',
      '- Fixed the default port',
    ].join('\n')

    const entries = parseChangelog(md)
    expect(entries.map((e) => e.version)).toEqual(['1.7.14', '1.7.13'])
    expect(entries[0].notes).toContain('Environment card')
    expect(entries[1].notes).toContain('default port')
  })

  it('strips a leading "v" from version headings', () => {
    const entries = parseChangelog('## v2.0.0\n\n- Release')
    expect(entries[0].version).toBe('2.0.0')
  })

  it('ignores headings that are not version numbers', () => {
    const md = '## Unreleased\n\n- WIP\n\n## 1.0.0\n\n- First'
    const entries = parseChangelog(md)
    expect(entries.map((e) => e.version)).toEqual(['1.0.0'])
  })

  it('returns an empty list for markdown with no version headings', () => {
    expect(parseChangelog('# Changelog\n\nNothing here yet.')).toEqual([])
  })
})

describe('GET /api/changelog', () => {
  it('returns the current version and parsed changelog entries', async () => {
    const app = new Hono()
    app.route('/api/changelog', changelogRouter)

    const res = await app.request('/api/changelog')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      currentVersion: string
      versions: { version: string; notes: string }[]
    }
    expect(typeof body.currentVersion).toBe('string')
    expect(Array.isArray(body.versions)).toBe(true)
  })
})
