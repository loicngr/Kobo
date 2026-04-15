import { describe, expect, it } from 'vitest'
import { spawnMcpProcess, unwrapMcpResult } from '../server/utils/mcp-client.js'

describe('spawnMcpProcess(command, args, env)', () => {
  // NOTE: spawnMcpProcess passes env verbatim to child_process.spawn, so callers
  // are responsible for including PATH. Tests merge process.env to mirror real
  // usage (both notion-service and sentry-service merge process.env).
  const baseEnv = () => ({ ...process.env }) as Record<string, string>

  it('spawns a process with the given command, args, and env', () => {
    const proc = spawnMcpProcess('node', ['-e', 'setTimeout(()=>{}, 100)'], {
      ...baseEnv(),
      FOO: 'bar',
    })
    expect(proc.pid).toBeDefined()
    expect(proc.stdin).toBeDefined()
    expect(proc.stdout).toBeDefined()
    proc.kill()
  })

  it('consumes stderr silently by default', () => {
    const proc = spawnMcpProcess('node', ['-e', 'console.error("boom"); setTimeout(()=>{}, 50)'], baseEnv())
    proc.kill()
    expect(proc.pid).toBeDefined()
  })
})

describe('unwrapMcpResult', () => {
  it('parses JSON-string text content', () => {
    const mcp = { content: [{ type: 'text', text: '{"foo":"bar"}' }] }
    expect(unwrapMcpResult(mcp)).toEqual({ foo: 'bar' })
  })

  it('returns raw text if not valid JSON (e.g. markdown)', () => {
    const mcp = { content: [{ type: 'text', text: '# Markdown heading\n\nBody.' }] }
    expect(unwrapMcpResult(mcp)).toBe('# Markdown heading\n\nBody.')
  })

  it('returns the original value when shape does not match', () => {
    expect(unwrapMcpResult(null)).toBeNull()
    expect(unwrapMcpResult({ other: true })).toEqual({ other: true })
  })
})
