import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { expect, it } from 'vitest'

it('reports a non-OK managed backend reply as a tool error through real stdio', async () => {
  const backend = createServer((request, response) => {
    let raw = ''
    request.on('data', (chunk) => {
      raw += chunk
    })
    request.on('end', () => {
      const name = (JSON.parse(raw) as { name?: string }).name
      if (name === 'plain') {
        response.writeHead(413, { 'Content-Type': 'text/plain' }).end('Payload Too Large')
        return
      }
      if (name === 'structured') {
        response
          .writeHead(403, { 'Content-Type': 'application/json' })
          .end(JSON.stringify({ isError: true, content: [{ type: 'text', text: 'Revoked' }] }))
        return
      }
      response.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'Bad arguments' }))
    })
  })
  await new Promise<void>((resolve) => backend.listen(0, '127.0.0.1', resolve))
  const client = new Client({ name: 'http-error-test', version: '1' })
  try {
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ['--import', 'tsx', 'src/mcp-server/kobo-tasks-server.ts'],
        env: {
          PATH: process.env.PATH ?? '',
          KOBO_WORKSPACE_ID: 'own',
          KOBO_MCP_SESSION_TOKEN: 'capability',
          KOBO_BACKEND_URL: `http://127.0.0.1:${(backend.address() as AddressInfo).port}`,
        },
        stderr: 'pipe',
      }),
    )
    const text = (result: Awaited<ReturnType<typeof client.callTool>>) => (result.content as { text: string }[])[0].text
    const rejected = await client.callTool({ name: 'json', arguments: {} })
    expect(rejected.isError).toBe(true)
    expect(text(rejected)).toBe('Bad arguments')
    const oversized = await client.callTool({ name: 'plain', arguments: {} })
    expect(oversized.isError).toBe(true)
    expect(text(oversized)).toContain('413')
    const structured = await client.callTool({ name: 'structured', arguments: {} })
    expect(structured.isError).toBe(true)
    expect(text(structured)).toBe('Revoked')
  } finally {
    await client.close()
    await new Promise((resolve) => backend.close(resolve))
  }
}, 30_000)
