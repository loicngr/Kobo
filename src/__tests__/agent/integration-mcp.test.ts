import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildIntegrationMcpServers, integrationMcpPrompt } from '../../server/services/agent/integration-mcp.js'
import { saveIntegrationConfig } from '../../server/services/integration-config-service.js'

let home: string
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'kobo-agent-mcp-'))
  vi.stubEnv('KOBO_HOME', home)
  vi.stubEnv('HOME', home)
  for (const key of [
    'NOTION_API_TOKEN',
    'NOTION_TOKEN',
    'NOTION_MCP_COMMAND',
    'NOTION_MCP_ARGS',
    'OPENAPI_MCP_HEADERS',
  ])
    vi.stubEnv(key, undefined)
})
afterEach(() => {
  vi.unstubAllEnvs()
  fs.rmSync(home, { recursive: true, force: true })
})
const enabled = { notionEnabled: true, sentryEnabled: true, notionMcpKey: '', sentryMcpKey: '' }
function legacy() {
  fs.writeFileSync(
    path.join(home, '.claude.json'),
    JSON.stringify({
      mcpServers: {
        'notion-team': { command: 'node', args: ['legacy-notion.js'], env: { NOTION_TOKEN: 'legacy-notion' } },
        'sentry-team': { command: 'node', args: ['legacy-sentry.js'], env: { SENTRY_ACCESS_TOKEN: 'legacy-sentry' } },
      },
    }),
  )
}
describe('agent integration MCP configuration', () => {
  it('provides both direct configurations without a Claude account and excludes unrelated environment', () => {
    vi.stubEnv('UNRELATED_SECRET', 'must-not-be-serialized')
    saveIntegrationConfig('notion', { command: 'node', args: ['notion.js'], env: { NOTION_TOKEN: 'direct-notion' } })
    saveIntegrationConfig('sentry', {
      command: 'node',
      args: ['sentry.js'],
      env: { SENTRY_ACCESS_TOKEN: 'direct-sentry' },
    })
    const servers = buildIntegrationMcpServers(enabled, 'claude-code')
    expect(servers.map((s) => s.name)).toEqual([
      expect.stringMatching(/^kobo-notion-/),
      expect.stringMatching(/^kobo-sentry-/),
    ])
    expect(servers[0].env.NOTION_TOKEN).toBe('direct-notion')
    expect(JSON.parse(servers[0].env.OPENAPI_MCP_HEADERS).Authorization).toBe('Bearer direct-notion')
    expect(servers[1].env).toEqual({ SENTRY_ACCESS_TOKEN: 'direct-sentry' })
    expect(JSON.stringify(servers)).not.toContain('must-not-be-serialized')
  })
  it.each(['claude-code', 'codex'] as const)(
    'prefers direct configuration and rereads on each %s launch',
    (engineId) => {
      legacy()
      saveIntegrationConfig('notion', { command: 'node', args: ['direct.js'], env: { NOTION_TOKEN: 'first' } })
      const settings = { ...enabled, sentryEnabled: false, notionMcpKey: 'notion-team' }
      const first = buildIntegrationMcpServers(settings, engineId)
      expect(first[0].args).toEqual(['direct.js'])
      saveIntegrationConfig('notion', { command: 'node', args: ['replacement.js'], env: { NOTION_TOKEN: 'second' } })
      const second = buildIntegrationMcpServers(settings, engineId)
      expect(second[0].args).toEqual(['replacement.js'])
      expect(second[0].env.NOTION_TOKEN).toBe('second')
      if (engineId === 'claude-code') expect(second[0].name).toBe(first[0].name)
      saveIntegrationConfig('notion', null)
      expect(buildIntegrationMcpServers(settings, engineId)[0].args).toEqual(['legacy-notion.js'])
    },
  )
  it.each(['claude-code', 'codex'] as const)('uses exact selected legacy entries for %s', (engineId) => {
    legacy()
    const servers = buildIntegrationMcpServers(
      { ...enabled, notionMcpKey: 'notion-team', sentryMcpKey: 'sentry-team' },
      engineId,
    )
    expect(servers.map((s) => s.args)).toEqual([['legacy-notion.js'], ['legacy-sentry.js']])
  })
  it('omits disabled or unconfigured integrations without breaking ordinary sessions', () => {
    expect(buildIntegrationMcpServers(enabled, 'claude-code')).toEqual([])
    saveIntegrationConfig('notion', { command: 'node', args: [], env: { NOTION_TOKEN: 'unused' } })
    expect(buildIntegrationMcpServers({ ...enabled, notionEnabled: false }, 'claude-code')).toEqual([])
  })
  it('supports environment-only Notion authentication with the same server overrides as imports', () => {
    vi.stubEnv('NOTION_API_TOKEN', 'environment-token')
    vi.stubEnv('NOTION_MCP_COMMAND', 'custom-notion')
    expect(buildIntegrationMcpServers(enabled, 'claude-code')[0]).toMatchObject({
      command: 'custom-notion',
      env: { NOTION_TOKEN: 'environment-token' },
    })
  })
  it('keeps Claude integration tool names and instructions stable across launches', () => {
    saveIntegrationConfig('notion', { command: 'node', args: ['notion.js'], env: { NOTION_TOKEN: 'synthetic' } })
    saveIntegrationConfig('sentry', { command: 'node', args: ['sentry.js'], env: {} })

    const first = buildIntegrationMcpServers(enabled, 'claude-code')
    const second = buildIntegrationMcpServers(enabled, 'claude-code')

    expect(first).toHaveLength(2)
    expect(second.map((server) => server.name)).toEqual(first.map((server) => server.name))
    expect(integrationMcpPrompt(second)).toBe(integrationMcpPrompt(first))
  })
  it('uses fresh names on each Codex launch and never puts credentials into agent instructions', () => {
    saveIntegrationConfig('notion', {
      command: 'node',
      args: ['--secret', 'synthetic-private-arg'],
      env: { NOTION_TOKEN: 'synthetic-private-token' },
    })
    saveIntegrationConfig('sentry', { command: 'node', args: ['sentry.js'], env: {} })
    const first = buildIntegrationMcpServers(enabled, 'codex')
    const second = buildIntegrationMcpServers(enabled, 'codex')
    expect(second[0].name).not.toBe(first[0].name)
    expect(second[1].name).not.toBe(first[1].name)
    expect(integrationMcpPrompt(second)).toContain(second[0].name)
    expect(integrationMcpPrompt(second)).not.toContain('synthetic-private')
    expect(integrationMcpPrompt([])).toBe('')
  })
  it('keeps optional resolution errors isolated and reports no credential-bearing errors', () => {
    vi.stubEnv('NOTION_API_TOKEN', 'synthetic-token')
    saveIntegrationConfig('sentry', { command: 'node', args: [], env: {} })
    const unavailable = vi.fn()
    const servers = buildIntegrationMcpServers(
      { ...enabled, notionMcpKey: 'missing-entry' },
      'claude-code',
      unavailable,
    )
    expect(servers).toHaveLength(1)
    expect(servers[0].name).toMatch(/^kobo-sentry-/)
    expect(unavailable).toHaveBeenCalledExactlyOnceWith('notion')
  })
  it('forwards provider-specific ambient Sentry credentials without unrelated backend environment', () => {
    vi.stubEnv('SENTRY_ACCESS_TOKEN', 'ambient-token')
    vi.stubEnv('SENTRY_HOST', 'sentry.example.test')
    vi.stubEnv('UNRELATED_SECRET', 'private')
    saveIntegrationConfig('sentry', { command: 'node', args: [], env: {} })
    const [server] = buildIntegrationMcpServers({ ...enabled, notionEnabled: false }, 'claude-code')
    expect(server.env).toMatchObject({ SENTRY_ACCESS_TOKEN: 'ambient-token', SENTRY_HOST: 'sentry.example.test' })
    expect(server.env).not.toHaveProperty('UNRELATED_SECRET')
  })
})
