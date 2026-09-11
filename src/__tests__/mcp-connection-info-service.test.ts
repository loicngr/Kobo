import { describe, expect, it } from 'vitest'
import { buildMcpConnectionInfo } from '../server/services/mcp-connection-info-service.js'

const input = {
  port: 4300,
  networkEnabled: false,
  behindProxy: false,
  proxyHostname: null,
  lanHostnames: ['192.168.1.2', '2001:db8::1'],
  command: '/usr/bin/node',
  compiledPath: '/opt/kobo/dist/mcp-server/kobo-tasks-server.js',
  sourcePath: null,
  loaderPath: null,
  databasePath: '/srv/kobo dev/kobo.db',
}

describe('MCP connection metadata', () => {
  it('uses the actual backend port and database, and hides disabled LAN endpoints', () => {
    const result = buildMcpConnectionInfo(input)
    expect(result.localUrl).toBe('http://127.0.0.1:4300/api/mcp')
    expect(result.lanUrls).toEqual([])
    expect(result.stdio?.env).toEqual({
      KOBO_DB_PATH: input.databasePath,
      KOBO_BACKEND_URL: 'http://127.0.0.1:4300',
      KOBO_WORKSPACE_ID: '',
    })
    expect(result.localRequiresToken).toBe(false)
  })
  it('formats IPv6 addresses and requires a local token behind a proxy', () => {
    const result = buildMcpConnectionInfo({ ...input, networkEnabled: true, behindProxy: true })
    expect(result.lanUrls).toEqual(['http://192.168.1.2:4300/api/mcp', 'http://[2001:db8::1]:4300/api/mcp'])
    expect(result.localRequiresToken).toBe(true)
  })
  it('does not advertise LAN hosts rejected by a named reverse proxy', () => {
    const result = buildMcpConnectionInfo({
      ...input,
      networkEnabled: true,
      behindProxy: true,
      proxyHostname: 'kobo.example.com',
    })
    expect(result.lanUrls).toEqual([])
    expect(result.localUrl).toBe('http://127.0.0.1:4300/api/mcp')
    expect(result.proxyHostname).toBe('kobo.example.com')
  })
  it('keeps only the allowed LAN host when the proxy declares an IPv6 address', () => {
    const result = buildMcpConnectionInfo({
      ...input,
      networkEnabled: true,
      behindProxy: true,
      proxyHostname: '2001:db8::1',
    })
    expect(result.lanUrls).toEqual(['http://[2001:db8::1]:4300/api/mcp'])
  })
  it('uses an absolute source loader when the compiled entrypoint is absent', () => {
    const result = buildMcpConnectionInfo({
      ...input,
      compiledPath: null,
      sourcePath: '/dev/kobo/server.ts',
      loaderPath: '/dev/kobo/node_modules/tsx/dist/loader.mjs',
    })
    expect(result.stdio?.args).toEqual([
      '--import',
      'file:///dev/kobo/node_modules/tsx/dist/loader.mjs',
      '/dev/kobo/server.ts',
    ])
  })
  it('does not advertise an unavailable stdio launch command', () => {
    expect(buildMcpConnectionInfo({ ...input, compiledPath: null }).stdio).toBeNull()
    expect(buildMcpConnectionInfo({ ...input, compiledPath: null, sourcePath: '/src/server.ts' }).stdio).toBeNull()
  })
})
