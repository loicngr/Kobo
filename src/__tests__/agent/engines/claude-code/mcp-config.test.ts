import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanupMcpConfig, writeMcpConfig } from '../../../../server/services/agent/engines/claude-code/mcp-config.js'

describe('writeMcpConfig', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kobo-mcp-test-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('writes a .mcp.json with Claude native format', () => {
    const path = writeMcpConfig(dir, [
      { name: 'kobo-tasks', command: 'node', args: ['/abs/path/server.js'], env: { KOBO_WORKSPACE_ID: 'ws-1' } },
    ])
    expect(path).toBe(join(dir, '.mcp.json'))
    const content = JSON.parse(readFileSync(path, 'utf-8'))
    expect(content).toEqual({
      mcpServers: {
        'kobo-tasks': {
          command: 'node',
          args: ['/abs/path/server.js'],
          env: { KOBO_WORKSPACE_ID: 'ws-1' },
        },
      },
    })
  })

  it('supports multiple servers', () => {
    const path = writeMcpConfig(dir, [
      { name: 'a', command: 'node', args: ['/a'], env: {} },
      { name: 'b', command: 'python', args: ['/b'], env: { FOO: 'bar' } },
    ])
    const content = JSON.parse(readFileSync(path, 'utf-8'))
    expect(Object.keys(content.mcpServers)).toEqual(['a', 'b'])
  })
})

describe('cleanupMcpConfig', () => {
  it('removes the .mcp.json file if it exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kobo-mcp-test-'))
    try {
      const path = writeMcpConfig(dir, [{ name: 'k', command: 'n', args: [], env: {} }])
      cleanupMcpConfig(dir)
      expect(() => readFileSync(path, 'utf-8')).toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('silently no-ops when the file does not exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kobo-mcp-test-'))
    try {
      expect(() => cleanupMcpConfig(dir)).not.toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
