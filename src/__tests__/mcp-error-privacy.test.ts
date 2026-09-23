import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'

vi.mock('node:child_process', () => ({ spawn: vi.fn() }))

import { spawn } from 'node:child_process'
import { callMcpTool, initializeMcp, spawnMcpProcess, unwrapMcpResult } from '../server/utils/mcp-client.js'

function processDouble() {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  })
}
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})
it('never includes server error text in a tool exception', async () => {
  const child = processDouble()
  child.stdin.on('data', (chunk) => {
    const request = JSON.parse(chunk.toString())
    queueMicrotask(() =>
      child.stdout.write(JSON.stringify({ id: request.id, error: { code: -32000, message: 'SECRET_CANARY' } }) + '\n'),
    )
  })
  await expect(callMcpTool(child as unknown as ChildProcess, 'get_ticket', {})).rejects.not.toThrow('SECRET_CANARY')
})
it('does not log executable errors or stderr content, even in debug mode', () => {
  const child = processDouble()
  vi.mocked(spawn).mockReturnValue(child as unknown as ChildProcess)
  vi.stubEnv('DEBUG_MCP_STDERR', '1')
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  spawnMcpProcess('SECRET_CANARY', [], {})
  child.emit('error', new Error('SECRET_CANARY'))
  child.stderr.write('SECRET_CANARY')
  expect(JSON.stringify(log.mock.calls)).not.toContain('SECRET_CANARY')
})
it('does not unwrap an MCP tool error as ordinary ticket content', () => {
  expect(() => unwrapMcpResult({ isError: true, content: [{ type: 'text', text: 'SECRET_CANARY' }] })).toThrow(
    'MCP tool reported a failure',
  )
})

it('rejects an MCP tool failure before connection tests can report success', async () => {
  const child = processDouble()
  child.stdin.on('data', (chunk) => {
    const request = JSON.parse(chunk.toString())
    queueMicrotask(() =>
      child.stdout.write(
        JSON.stringify({
          id: request.id,
          result: { isError: true, content: [{ type: 'text', text: 'SECRET_CANARY' }] },
        }) + '\n',
      ),
    )
  })
  await expect(callMcpTool(child as unknown as ChildProcess, 'get_self', {})).rejects.toThrow(
    'MCP tool reported a failure',
  )
})

it('rejects a refused initialization without sending initialized or exposing its error', async () => {
  const child = processDouble()
  const requests: string[] = []
  child.stdin.on('data', (chunk) => {
    const request = JSON.parse(chunk.toString())
    requests.push(request.method)
    queueMicrotask(() =>
      child.stdout.write(`${JSON.stringify({ id: request.id, error: { code: -32000, message: 'SECRET_CANARY' } })}\n`),
    )
  })
  await expect(initializeMcp(child as unknown as ChildProcess)).rejects.toThrow('MCP initialization failed')
  expect(requests).toEqual(['initialize'])
})
