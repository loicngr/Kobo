import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { expect, it } from 'vitest'
import { listMcpToolNames } from '../server/utils/mcp-client.js'

function server(reply: (request: { params: { cursor?: string }; method: string }) => object) {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough() })
  child.stdin.on('data', (chunk) => {
    const request = JSON.parse(chunk.toString())
    queueMicrotask(() => child.stdout.write(`${JSON.stringify({ id: request.id, ...reply(request) })}\n`))
  })
  return child as unknown as ChildProcess
}

it('discovers tool names across pages without calling any tools', async () => {
  const methods: string[] = []
  const child = server((request) => {
    methods.push(request.method)
    return {
      result:
        request.params.cursor === 'next'
          ? { tools: [{ name: 'whoami' }] }
          : { tools: [{ name: 'update_issue' }], nextCursor: 'next' },
    }
  })
  await expect(listMcpToolNames(child)).resolves.toEqual(['update_issue', 'whoami'])
  expect(methods).toEqual(['tools/list', 'tools/list'])
})

it('rejects repeated pagination cursors instead of looping', async () => {
  const child = server(() => ({ result: { tools: [], nextCursor: 'same' } }))
  await expect(listMcpToolNames(child)).rejects.toThrow('pagination')
})

it('does not expose private server error details', async () => {
  const child = server(() => ({ error: { code: -32000, message: 'SECRET_CANARY' } }))
  await expect(listMcpToolNames(child)).rejects.not.toThrow('SECRET_CANARY')
})

it.each([null, {}, { tools: [null] }, { tools: [{ name: 42 }] }, { tools: [], nextCursor: 42 }])(
  'rejects malformed catalogues without attempting an identity lookup',
  async (result) => {
    const child = server(() => ({ result }))
    await expect(listMcpToolNames(child)).rejects.toThrow('Invalid MCP tool catalogue')
  },
)
