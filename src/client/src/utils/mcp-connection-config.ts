import { normalizeClientName } from '../../../shared/workspace-message-types'

export interface McpConnectionInfo {
  localUrl: string
  lanUrls: string[]
  networkEnabled: boolean
  behindProxy: boolean
  proxyHostname: string | null
  localRequiresToken: boolean
  stdio: { command: string; args: string[]; env: Record<string, string> } | null
}

export interface McpEndpoint {
  url: string
  kind: 'local' | 'remote' | 'proxy'
  requiresToken: boolean
}

/** Browser origin is the page the user actually opened; never a forwarded header. */
export function getMcpEndpoints(info: McpConnectionInfo, browserOrigin: string): McpEndpoint[] {
  const endpoints: McpEndpoint[] = [{ url: info.localUrl, kind: 'local', requiresToken: info.localRequiresToken }]
  if (!info.networkEnabled) return endpoints
  endpoints.push(...info.lanUrls.map((url) => ({ url, kind: 'remote' as const, requiresToken: true })))
  if (info.behindProxy) {
    try {
      const origin = new URL(browserOrigin)
      if (
        ['http:', 'https:'].includes(origin.protocol) &&
        (!info.proxyHostname || origin.hostname.replace(/^\[|\]$/g, '') === info.proxyHostname)
      ) {
        const url = `${origin.origin}/api/mcp`
        if (!endpoints.some((endpoint) => endpoint.url === url))
          endpoints.push({ url, kind: 'proxy', requiresToken: true })
      }
    } catch {
      /* No browser origin, e.g. during SSR. */
    }
  }
  return endpoints
}

/** Credentials enter the formatter only through the explicit copy-with-token action. */
export function formatMcpConfig(
  info: McpConnectionInfo,
  endpoint: McpEndpoint | 'stdio',
  clientName: string,
  token?: string,
): string {
  const name = clientName.trim() ? normalizeClientName(clientName) : ''
  const credential = token || '<KOBO_NETWORK_TOKEN>'
  if (endpoint === 'stdio') {
    if (!info.stdio) throw new Error('MCP stdio entrypoint unavailable')
    return JSON.stringify(
      {
        mcpServers: {
          kobo: {
            ...info.stdio,
            env: {
              ...info.stdio.env,
              ...(name ? { KOBO_MCP_CLIENT_NAME: name } : {}),
              ...(info.localRequiresToken ? { KOBO_NETWORK_TOKEN: credential } : {}),
            },
          },
        },
      },
      null,
      2,
    )
  }
  const headers = {
    ...(name ? { 'X-Kobo-Client-Name': encodeURIComponent(name), 'X-Kobo-Client-Name-Encoding': 'uri' } : {}),
    ...(endpoint.requiresToken ? { 'X-Kobo-Token': credential } : {}),
  }
  return JSON.stringify(
    { mcpServers: { kobo: { url: endpoint.url, ...(Object.keys(headers).length ? { headers } : {}) } } },
    null,
    2,
  )
}
