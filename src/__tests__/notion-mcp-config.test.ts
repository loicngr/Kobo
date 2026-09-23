import { describe, expect, it, vi } from 'vitest'

vi.mock('../server/utils/mcp-client.js', () => ({
  readClaudeMcpEntry: vi.fn((match: (key: string) => boolean) => {
    const servers = {
      notion: {
        command: 'npx',
        args: ['-y', '@notionhq/notion-mcp-server'],
        env: { NOTION_TOKEN: 'default-token' },
      },
      'notion-prod': {
        command: 'npx',
        args: ['-y', '@notionhq/notion-mcp-server@latest'],
        env: { NOTION_TOKEN: 'prod-token' },
      },
      sentry: {
        command: 'npx',
        args: ['-y', '@sentry/mcp-server'],
        env: { SENTRY_ACCESS_TOKEN: 'abc' },
      },
    } as const
    const key = Object.keys(servers).find((k) => match(k))
    if (!key) return null
    return { key, entry: servers[key as keyof typeof servers] }
  }),
  spawnMcpProcess: vi.fn(),
  initializeMcp: vi.fn(),
  callMcpTool: vi.fn(),
  unwrapMcpResult: vi.fn(),
}))

import { buildNotionMcpConfig } from '../server/services/notion-service.js'

describe('buildNotionMcpConfig', () => {
  it('uses explicit selected MCP key token when provided', () => {
    const cfg = buildNotionMcpConfig('notion-prod')
    const headers = JSON.parse(cfg.env.OPENAPI_MCP_HEADERS)
    expect(headers.Authorization).toBe('Bearer prod-token')
  })

  it('falls back to default notion entry token', () => {
    const cfg = buildNotionMcpConfig()
    const headers = JSON.parse(cfg.env.OPENAPI_MCP_HEADERS)
    expect(headers.Authorization).toBe('Bearer default-token')
  })
})
