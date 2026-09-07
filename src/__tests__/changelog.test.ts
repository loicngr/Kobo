import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import changelogRouter, { _clearLatestVersionCache, parseChangelog } from '../server/routes/changelog.js'

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

  it('treats a combined "X.Y.Z/W" heading as its own version section', () => {
    const md = [
      '## 1.8.0',
      '',
      '- New stuff',
      '',
      '## 1.7.34/35',
      '',
      '- chore(npm): update claude sdk',
      '',
      '## 1.7.33',
      '',
      '- Older',
    ].join('\n')

    const entries = parseChangelog(md)
    expect(entries.map((e) => e.version)).toEqual(['1.8.0', '1.7.34/35', '1.7.33'])
    // The combined heading must NOT leak into the previous (1.8.0) entry's notes.
    expect(entries[0].notes).not.toContain('1.7.34/35')
    expect(entries[1].notes).toContain('update claude sdk')
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
  beforeEach(() => {
    _clearLatestVersionCache()
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no network in tests')))
  })
  afterEach(() => vi.unstubAllGlobals())

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

describe('GET /api/changelog — latest version lookup', () => {
  const app = new Hono().route('/api/changelog', changelogRouter)

  beforeEach(() => {
    _clearLatestVersionCache()
    // Never let a test reach registry.npmjs.org: offline it would block for
    // the 5 s timeout, online it would depend on what npm answers today.
    vi.stubGlobal('fetch', vi.fn())
  })
  afterEach(() => vi.unstubAllGlobals())

  it('reports the registry version and caches it for later requests', async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({ version: '99.0.0' }) } as Response)

    const first = (await (await app.request('/api/changelog')).json()) as { latestVersion: string | null }
    const second = (await (await app.request('/api/changelog')).json()) as { latestVersion: string | null }

    expect(first.latestVersion).toBe('99.0.0')
    expect(second.latestVersion).toBe('99.0.0')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('answers null when the registry is unreachable, and does not retry on the next load', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('offline'))

    const first = (await (await app.request('/api/changelog')).json()) as { latestVersion: string | null }
    const second = (await (await app.request('/api/changelog')).json()) as { latestVersion: string | null }

    expect(first.latestVersion).toBeNull()
    expect(second.latestVersion).toBeNull()
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('shares one in-flight lookup between concurrent requests', async () => {
    let resolveFetch: (r: Response) => void = () => {}
    vi.mocked(fetch).mockReturnValue(
      new Promise<Response>((resolve) => {
        resolveFetch = resolve
      }),
    )

    const a = app.request('/api/changelog')
    const b = app.request('/api/changelog')
    resolveFetch({ ok: true, json: async () => ({ version: '1.2.3' }) } as Response)
    await Promise.all([a, b])

    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
