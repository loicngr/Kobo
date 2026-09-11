import { describe, expect, it } from 'vitest'
import { formatMcpConfig, getMcpEndpoints, type McpConnectionInfo } from '../utils/mcp-connection-config'

const info: McpConnectionInfo = {
  localUrl: 'http://127.0.0.1:4300/api/mcp',
  lanUrls: ['http://192.168.1.2:4300/api/mcp'],
  networkEnabled: true,
  behindProxy: false,
  proxyHostname: null,
  localRequiresToken: false,
  stdio: {
    command: '/usr/bin/node',
    args: ['/opt/kobo/server.js'],
    env: { KOBO_DB_PATH: '/srv/dev/kobo.db', KOBO_BACKEND_URL: 'http://127.0.0.1:4300', KOBO_WORKSPACE_ID: '' },
  },
}

describe('MCP connection configuration', () => {
  it('keeps backend ports when the UI runs on a separate development port', () => {
    expect(getMcpEndpoints(info, 'http://localhost:9300').map((endpoint) => endpoint.url)).toEqual([
      info.localUrl,
      ...info.lanUrls,
    ])
  })
  it('uses the current HTTPS origin behind a proxy without accepting a mismatched configured hostname', () => {
    const proxy = { ...info, behindProxy: true, proxyHostname: 'kobo.example.com' }
    expect(getMcpEndpoints(proxy, 'https://kobo.example.com:8443').at(-1)?.url).toBe(
      'https://kobo.example.com:8443/api/mcp',
    )
    expect(getMcpEndpoints(proxy, 'https://other.example.com')).toHaveLength(2)
  })
  it('offers no remote URL while network access is disabled', () => {
    expect(
      getMcpEndpoints({ ...info, networkEnabled: false, behindProxy: true }, 'https://kobo.example.com'),
    ).toHaveLength(1)
  })
  it('uses placeholders unless a token is explicitly passed for copying', () => {
    const endpoint = getMcpEndpoints(info, '')[1]!
    const preview = formatMcpConfig(info, endpoint, '工房 🤖')
    expect(preview).toContain('<KOBO_NETWORK_TOKEN>')
    expect(JSON.parse(preview).mcpServers.kobo.headers).toMatchObject({
      'X-Kobo-Client-Name': encodeURIComponent('工房 🤖'),
      'X-Kobo-Client-Name-Encoding': 'uri',
    })
    expect(formatMcpConfig(info, endpoint, '', 'secret')).toContain('secret')
    expect(formatMcpConfig(info, endpoint, '', '')).toContain('<KOBO_NETWORK_TOKEN>')
    expect(formatMcpConfig(info, getMcpEndpoints(info, '')[0]!, '', 'secret')).not.toContain('secret')
  })
  it('preserves absolute stdio paths and only adds credentials when required', () => {
    const preview = JSON.parse(formatMcpConfig({ ...info, localRequiresToken: true }, 'stdio', 'Helper'))
    expect(preview.mcpServers.kobo.env).toMatchObject({
      KOBO_DB_PATH: '/srv/dev/kobo.db',
      KOBO_MCP_CLIENT_NAME: 'Helper',
      KOBO_NETWORK_TOKEN: '<KOBO_NETWORK_TOKEN>',
    })
    expect(() => formatMcpConfig({ ...info, stdio: null }, 'stdio', '')).toThrow('unavailable')
  })
})
