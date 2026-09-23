import { nanoid } from 'nanoid'
import { readClaudeMcpEntry } from '../../utils/mcp-client.js'
import { getIntegrationConfig } from '../integration-config-service.js'
import { buildNotionMcpConfig } from '../notion-service.js'
import { readSentryMcpConfig } from '../sentry-service.js'
import type { GlobalSettings } from '../settings-service.js'
import type { McpServerSpec } from './engines/types.js'

type IntegrationSettings = Pick<GlobalSettings, 'notionEnabled' | 'sentryEnabled' | 'notionMcpKey' | 'sentryMcpKey'>

/** Availability only: no provider process or credential-bearing response. */
export function hasIntegrationMcpConfig(integration: 'notion' | 'sentry', selectedKey?: string): boolean {
  if (getIntegrationConfig(integration)) return true
  if (
    integration === 'notion' &&
    (process.env.NOTION_API_TOKEN || process.env.NOTION_TOKEN || process.env.OPENAPI_MCP_HEADERS)
  )
    return true
  const key = selectedKey?.trim()
  return Boolean(
    readClaudeMcpEntry((name) =>
      key ? name === key : integration === 'notion' ? name === 'notion' : /sentry/i.test(name),
    ),
  )
}

/** Resolve at every launch/resume; never write credentials into a project file. */
export function buildIntegrationMcpServers(
  settings: IntegrationSettings,
  onUnavailable?: (integration: 'notion' | 'sentry') => void,
): McpServerSpec[] {
  const servers: McpServerSpec[] = []
  // Fresh names avoid Codex recursively merging stale native config fields.
  const launch = nanoid(12)
  for (const integration of ['notion', 'sentry'] as const) {
    if (!settings[`${integration}Enabled`]) continue
    try {
      const key = settings[`${integration}McpKey`]
      if (!hasIntegrationMcpConfig(integration, key)) continue
      const config = integration === 'notion' ? buildNotionMcpConfig(key, false) : readSentryMcpConfig(key, false)
      servers.push({ name: `kobo-${integration}-${launch}`, ...config })
    } catch {
      // Optional connections cannot block ordinary missions. Never expose raw
      // config/parse errors, which may contain credential material.
      onUnavailable?.(integration)
    }
  }
  return servers
}

export function integrationMcpPrompt(servers: McpServerSpec[], unavailable: Array<'notion' | 'sentry'> = []): string {
  if (!servers.length && !unavailable.length) return ''
  return [
    '[Kōbō managed integrations]',
    ...unavailable.map(
      (name) =>
        `${name}: Kōbō could not load this connection. Ask the user to check Settings if needed; do not silently substitute personal credentials.`,
    ),
    'For these integrations, use the MCP servers listed below, configured in Kōbō Settings. Prefer them over personal/native servers and namespaces from earlier turns. Discover their available tools; do not assume all servers implement the same tools. If unavailable, report the connection problem instead of silently switching credentials.',
    ...servers.map((server) => `${server.name.startsWith('kobo-notion-') ? 'Notion' : 'Sentry'}: ${server.name}`),
    'These connections do not grant permission to modify remote data. Follow the user request and engine permissions.',
  ].join('\n')
}
