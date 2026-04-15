import fs from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Module-level spy so it is accessible in all describe blocks
const readFileSyncSpy = vi.spyOn(fs, 'readFileSync')

vi.mock('../server/utils/mcp-client.js', () => {
  // `readClaudeMcpEntry` goes through `fs.readFileSync` (spied above) so tests
  // can continue to stub the config via `readFileSyncSpy.mockReturnValue(...)`.
  const readClaudeMcpEntry = (match: (key: string) => boolean) => {
    try {
      const raw = fs.readFileSync('/fake', 'utf-8')
      const config = JSON.parse(raw as string) as {
        mcpServers?: Record<
          string,
          { command?: string; args?: string[]; env?: Record<string, string>; disabled?: boolean }
        >
      }
      const servers = config.mcpServers ?? {}
      const key = Object.keys(servers).find((k) => match(k) && servers[k].disabled !== true)
      if (!key) return null
      return { key, entry: servers[key] }
    } catch {
      return null
    }
  }

  return {
    readClaudeMcpEntry,
    spawnMcpProcess: vi.fn(() => ({
      stdin: { end: vi.fn(), write: vi.fn() },
      kill: vi.fn(),
      on: vi.fn(),
      once: vi.fn(),
      stdout: { on: vi.fn(), once: vi.fn(), removeListener: vi.fn() },
      stderr: { on: vi.fn() },
      pid: 12345,
    })),
    initializeMcp: vi.fn().mockResolvedValue(undefined),
    callMcpTool: vi.fn().mockResolvedValue({
      content: [
        {
          type: 'text',
          text: '# Issue ACME-API-2 in org\n\n**Description**: Slow DB Query\n**Location**: app:services:finished\n',
        },
      ],
    }),
    unwrapMcpResult: vi.fn((r: unknown) => {
      const obj = r as { content?: Array<{ text?: string }> }
      return obj?.content?.[0]?.text ?? ''
    }),
  }
})

import {
  extractSentryIssue,
  parseSentryResponse,
  parseSentryUrl,
  readSentryMcpConfig,
} from '../server/services/sentry-service.js'
import { initializeMcp, spawnMcpProcess } from '../server/utils/mcp-client.js'

// ─── parseSentryUrl ───────────────────────────────────────────────────────────

describe('parseSentryUrl(url)', () => {
  it('extracts the numeric issue ID from a canonical Sentry URL', () => {
    expect(parseSentryUrl('https://my-org.sentry.io/issues/112081699')).toBe('112081699')
  })

  it('handles trailing slash', () => {
    expect(parseSentryUrl('https://my-org.sentry.io/issues/112081699/')).toBe('112081699')
  })

  it('handles query string', () => {
    expect(parseSentryUrl('https://my-org.sentry.io/issues/112081699?project=42')).toBe('112081699')
  })

  it('handles fragment', () => {
    expect(parseSentryUrl('https://my-org.sentry.io/issues/112081699#events')).toBe('112081699')
  })

  it('handles self-hosted Sentry host', () => {
    expect(parseSentryUrl('https://sentry.example.com/organizations/my-org/issues/42/')).toBe('42')
  })

  it('throws when no numeric issue ID is present', () => {
    expect(() => parseSentryUrl('https://sentry.io/')).toThrow(/Could not extract issue ID from Sentry URL/)
    expect(() => parseSentryUrl('https://sentry.io/issues/')).toThrow(/Could not extract issue ID from Sentry URL/)
    expect(() => parseSentryUrl('https://sentry.io/issues/ACME-API-2')).toThrow(
      /Could not extract issue ID from Sentry URL/,
    )
  })
})

// ─── readSentryMcpConfig ──────────────────────────────────────────────────────

describe('readSentryMcpConfig()', () => {
  afterEach(() => {
    readFileSyncSpy.mockReset()
  })

  it('returns the sentry entry from ~/.claude.json', () => {
    readFileSyncSpy.mockReturnValue(
      JSON.stringify({
        mcpServers: {
          sentry: {
            command: 'npx',
            args: ['-y', '@sentry/mcp-server@latest'],
            env: { SENTRY_ACCESS_TOKEN: 'tok', SENTRY_HOST: 'sentry.example.com' },
          },
        },
      }),
    )
    const cfg = readSentryMcpConfig()
    expect(cfg.command).toBe('npx')
    expect(cfg.args).toEqual(['-y', '@sentry/mcp-server@latest'])
    expect(cfg.env.SENTRY_ACCESS_TOKEN).toBe('tok')
    expect(cfg.env.SENTRY_HOST).toBe('sentry.example.com')
    expect(cfg.env.PATH).toBeDefined()
  })

  it('matches the first key whose name contains "sentry" (case-insensitive)', () => {
    readFileSyncSpy.mockReturnValue(
      JSON.stringify({
        mcpServers: {
          notion: { command: 'npx', args: [], env: {} },
          'My-Sentry-Server': { command: 'sentry-cli', args: ['mcp'], env: { TOKEN: 'x' } },
        },
      }),
    )
    const cfg = readSentryMcpConfig()
    expect(cfg.command).toBe('sentry-cli')
    expect(cfg.env.TOKEN).toBe('x')
  })

  it('throws when no sentry entry exists', () => {
    readFileSyncSpy.mockReturnValue(JSON.stringify({ mcpServers: { notion: { command: 'npx', args: [], env: {} } } }))
    expect(() => readSentryMcpConfig()).toThrow(/Sentry MCP server not configured/)
  })

  it('throws when ~/.claude.json is unreadable', () => {
    readFileSyncSpy.mockImplementation(() => {
      throw new Error('ENOENT')
    })
    expect(() => readSentryMcpConfig()).toThrow(/Sentry MCP server not configured/)
  })

  it('throws when mcpServers is missing', () => {
    readFileSyncSpy.mockReturnValue(JSON.stringify({}))
    expect(() => readSentryMcpConfig()).toThrow(/Sentry MCP server not configured/)
  })

  it('skips disabled sentry entries and picks the next enabled one', () => {
    readFileSyncSpy.mockReturnValue(
      JSON.stringify({
        mcpServers: {
          'sentry-old': {
            command: 'npx',
            args: ['-y', 'old'],
            env: { SENTRY_HOST: 'old.example.com' },
            disabled: true,
          },
          sentry: {
            command: 'npx',
            args: ['-y', 'new'],
            env: { SENTRY_HOST: 'new.example.com' },
            disabled: false,
          },
        },
      }),
    )
    const cfg = readSentryMcpConfig()
    expect(cfg.args).toEqual(['-y', 'new'])
    expect(cfg.env.SENTRY_HOST).toBe('new.example.com')
  })

  it('throws when the only sentry entry is disabled', () => {
    readFileSyncSpy.mockReturnValue(
      JSON.stringify({
        mcpServers: {
          sentry: { command: 'npx', args: [], env: {}, disabled: true },
        },
      }),
    )
    expect(() => readSentryMcpConfig()).toThrow(/Sentry MCP server not configured/)
  })
})

// ─── parseSentryResponse ──────────────────────────────────────────────────────

describe('parseSentryResponse(markdown, numericId)', () => {
  const sample = `# Issue ACME-API-2 in **acme-corp**

**Description**: Slow DB Query
**Location**: app:services:finished
**Platform**: php
**First Seen**: 2026-04-14T23:56:04.427Z
**Last Seen**: 2026-04-15T07:21:13.000Z
**Occurrences**: 89
**URL**: https://acme-corp.sentry.io/issues/ACME-API-2

**Offending Spans:**
db.sql.execute - SELECT *
db.sql.execute - UPDATE services

### Tags

**environment**: preprod
**release**: acme-api@4.41.3-preprod
**runtime**: php 8.1.29

### Extra Data

Additional data attached to this event.

**Full command**: "'app:services:finished'"

### Additional Context

os: Linux
`

  it('extracts the canonical Short-ID from the first heading', () => {
    const c = parseSentryResponse(sample, '112081699')
    expect(c.issueId).toBe('ACME-API-2')
  })

  it('passes numericId through unchanged', () => {
    const c = parseSentryResponse(sample, '112081699')
    expect(c.issueNumericId).toBe('112081699')
  })

  it('extracts title, culprit, platform, seen timestamps, occurrences', () => {
    const c = parseSentryResponse(sample, '112081699')
    expect(c.title).toBe('Slow DB Query')
    expect(c.culprit).toBe('app:services:finished')
    expect(c.platform).toBe('php')
    expect(c.firstSeen).toBe('2026-04-14T23:56:04.427Z')
    expect(c.lastSeen).toBe('2026-04-15T07:21:13.000Z')
    expect(c.occurrences).toBe(89)
  })

  it('extracts tags from the Tags section', () => {
    const c = parseSentryResponse(sample, '1')
    expect(c.tags.environment).toBe('preprod')
    expect(c.tags.release).toBe('acme-api@4.41.3-preprod')
    expect(c.tags.runtime).toBe('php 8.1.29')
  })

  it('extracts offending spans', () => {
    const c = parseSentryResponse(sample, '1')
    expect(c.offendingSpans).toHaveLength(2)
    expect(c.offendingSpans[0]).toContain('SELECT *')
    expect(c.offendingSpans[1]).toContain('UPDATE services')
  })

  it('captures extra context sections', () => {
    const c = parseSentryResponse(sample, '1')
    expect(c.extraContext).toContain('Full command')
    expect(c.extraContext).toContain('os: Linux')
  })

  it('defaults missing fields gracefully', () => {
    const c = parseSentryResponse('# Empty\n', '42')
    expect(c.issueId).toBe('')
    expect(c.issueNumericId).toBe('42')
    expect(c.title).toBe('')
    expect(c.culprit).toBe('')
    expect(c.occurrences).toBe(0)
    expect(c.tags).toEqual({})
    expect(c.offendingSpans).toEqual([])
    expect(c.extraContext).toBe('')
  })

  it('does not swallow trailing top-level "# Using this information" into a ### section', () => {
    // The Sentry MCP appends a trailing H1 section that mentions the short
    // issue code (like "ACME-API-2") and other Sentry-internal hints we
    // do NOT want bleeding into our extracted context.
    const md = `# Issue ACME-API-2 in org

### Additional Context

os: Linux

# Using this information

- You can reference the IssueID in commit messages (e.g. \`Fixes ACME-API-2\`)
- search_issue_events(issueId='ACME-API-2', ...)
`
    const c = parseSentryResponse(md, '999')
    expect(c.extraContext).toContain('os: Linux')
    expect(c.extraContext).not.toContain('ACME-API-2')
    expect(c.extraContext).not.toContain('Using this information')
    expect(c.extraContext).not.toContain('search_issue_events')
  })
})

// ─── extractSentryIssue ───────────────────────────────────────────────────────

describe('extractSentryIssue(url)', () => {
  beforeEach(() => {
    const fakeConfig = {
      mcpServers: {
        sentry: { command: 'npx', args: ['-y', 'x'], env: { TOKEN: 'x' } },
      },
    }
    readFileSyncSpy.mockReturnValue(JSON.stringify(fakeConfig))
  })

  afterEach(() => {
    readFileSyncSpy.mockReset()
  })

  it('extracts and parses the issue via the Sentry MCP server', async () => {
    const content = await extractSentryIssue('https://my-org.sentry.io/issues/112081699')
    expect(content.issueId).toBe('ACME-API-2')
    expect(content.issueNumericId).toBe('112081699')
    expect(content.title).toBe('Slow DB Query')
    expect(content.culprit).toBe('app:services:finished')
  })

  it('throws on invalid URL', async () => {
    await expect(extractSentryIssue('https://sentry.io/')).rejects.toThrow(/Could not extract issue ID/)
  })

  it('always kills the MCP process, even when initializeMcp rejects', async () => {
    const killSpy = vi.fn()
    const endSpy = vi.fn()
    vi.mocked(spawnMcpProcess).mockReturnValueOnce({
      stdin: { end: endSpy, write: vi.fn() },
      kill: killSpy,
      on: vi.fn(),
      once: vi.fn(),
      stdout: { on: vi.fn(), once: vi.fn(), removeListener: vi.fn() },
      stderr: { on: vi.fn() },
      pid: 99999,
    } as unknown as import('node:child_process').ChildProcess)

    vi.mocked(initializeMcp).mockRejectedValueOnce(new Error('boom'))

    await expect(extractSentryIssue('https://my-org.sentry.io/issues/1')).rejects.toThrow(/boom/)

    expect(endSpy).toHaveBeenCalled()
    expect(killSpy).toHaveBeenCalled()
  })
})
