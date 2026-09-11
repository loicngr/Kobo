import { expect, it } from 'vitest'
import { createMcpClientContext } from '../server/services/mcp-client-context.js'

it('bounds and normalizes display labels without treating them as identities', () => {
  expect(createMcpClientContext('  My\n client\u0000  ', 'stdio')).toEqual({
    kind: 'mcp',
    clientName: 'My client',
    transport: 'stdio',
  })
  expect(createMcpClientContext().clientName).toBe('External MCP client')
  expect(createMcpClientContext('x'.repeat(200)).clientName).toHaveLength(100)
  expect(() => encodeURIComponent(createMcpClientContext(`${'a'.repeat(99)}🤖`).clientName)).not.toThrow()
  expect(() => encodeURIComponent(createMcpClientContext('\ud800').clientName)).not.toThrow()
})
