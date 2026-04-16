import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { listClaudeMcpEntries, readClaudeMcpEntry, spawnMcpProcess, unwrapMcpResult } from '../server/utils/mcp-client.js'

describe('spawnMcpProcess(command, args, env)', () => {
  // NOTE: spawnMcpProcess passes env verbatim to child_process.spawn, so callers
  // are responsible for including PATH. Tests merge process.env to mirror real
  // usage (both notion-service and sentry-service merge process.env).
  const baseEnv = () => ({ ...process.env }) as Record<string, string>

  it('spawns a process with the given command, args, and env', () => {
    const proc = spawnMcpProcess('node', ['-e', 'setTimeout(()=>{}, 100)'], {
      ...baseEnv(),
      FOO: 'bar',
    })
    expect(proc.pid).toBeDefined()
    expect(proc.stdin).toBeDefined()
    expect(proc.stdout).toBeDefined()
    proc.kill()
  })

  it('consumes stderr silently by default', () => {
    const proc = spawnMcpProcess('node', ['-e', 'console.error("boom"); setTimeout(()=>{}, 50)'], baseEnv())
    proc.kill()
    expect(proc.pid).toBeDefined()
  })
})

describe('unwrapMcpResult', () => {
  it('parses JSON-string text content', () => {
    const mcp = { content: [{ type: 'text', text: '{"foo":"bar"}' }] }
    expect(unwrapMcpResult(mcp)).toEqual({ foo: 'bar' })
  })

  it('returns raw text if not valid JSON (e.g. markdown)', () => {
    const mcp = { content: [{ type: 'text', text: '# Markdown heading\n\nBody.' }] }
    expect(unwrapMcpResult(mcp)).toBe('# Markdown heading\n\nBody.')
  })

  it('returns the original value when shape does not match', () => {
    expect(unwrapMcpResult(null)).toBeNull()
    expect(unwrapMcpResult({ other: true })).toEqual({ other: true })
  })
})

describe('readClaudeMcpEntry', () => {
  let homeDir = ''
  const oldHome = process.env.HOME

  function writeClaudeConfig(content: object) {
    const claudePath = path.join(homeDir, '.claude.json')
    fs.writeFileSync(claudePath, JSON.stringify(content), 'utf-8')
  }

  function removeClaudeConfig() {
    const claudePath = path.join(homeDir, '.claude.json')
    if (fs.existsSync(claudePath)) fs.rmSync(claudePath)
  }

  it('returns first enabled matching entry', () => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kobo-mcp-home-'))
    process.env.HOME = homeDir
    writeClaudeConfig({
      mcpServers: {
        sentry: { disabled: true, command: 'x' },
        'sentry-prod': { command: 'npx', args: ['-y', '@sentry/mcp-server'], env: { TOKEN: 'abc' } },
      },
    })
    const match = readClaudeMcpEntry((k) => k.includes('sentry'))
    expect(match).not.toBeNull()
    expect(match?.key).toBe('sentry-prod')
    expect(match?.entry.env?.TOKEN).toBe('abc')
    removeClaudeConfig()
    fs.rmSync(homeDir, { recursive: true, force: true })
  })

  afterEach(() => {
    if (homeDir) fs.rmSync(homeDir, { recursive: true, force: true })
    homeDir = ''
    process.env.HOME = oldHome
  })
})

describe('listClaudeMcpEntries', () => {
  let homeDir = ''
  const oldHome = process.env.HOME

  function writeClaudeConfig(content: object) {
    const claudePath = path.join(homeDir, '.claude.json')
    fs.writeFileSync(claudePath, JSON.stringify(content), 'utf-8')
  }

  afterEach(() => {
    if (homeDir) fs.rmSync(homeDir, { recursive: true, force: true })
    homeDir = ''
    process.env.HOME = oldHome
  })

  it('returns only active entries and excludes disabled', () => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kobo-mcp-home-'))
    process.env.HOME = homeDir
    writeClaudeConfig({
      mcpServers: {
        notion: { command: 'npx', args: ['-y', '@notionhq/notion-mcp-server'], env: { NOTION_TOKEN: 'secret' } },
        'sentry-disabled': { command: 'npx', disabled: true, env: { SENTRY_ACCESS_TOKEN: 'secret' } },
        sentry: { command: 'npx', args: ['-y', '@sentry/mcp-server'] },
      },
    })
    const entries = listClaudeMcpEntries()
    expect(entries.map((e) => e.key)).toEqual(['notion', 'sentry'])
  })

  it('returns empty array when file is unreadable', () => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kobo-mcp-home-'))
    process.env.HOME = homeDir
    expect(listClaudeMcpEntries()).toEqual([])
  })
})
