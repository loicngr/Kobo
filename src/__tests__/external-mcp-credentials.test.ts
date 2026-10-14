import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  authenticateExternalMcpToken,
  createExternalMcpCredential,
  listExternalMcpCredentials,
  revokeExternalMcpCredential,
} from '../server/services/external-mcp-credentials-service.js'

let home: string
let previous: string | undefined
beforeEach(() => {
  previous = process.env.KOBO_HOME
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'kobo-mcp-keys-'))
  process.env.KOBO_HOME = home
})
afterEach(() => {
  if (previous === undefined) delete process.env.KOBO_HOME
  else process.env.KOBO_HOME = previous
  fs.rmSync(home, { recursive: true, force: true })
})
describe('dedicated external MCP credentials', () => {
  it('defaults to read-only, persists hashes only, and independently revokes', () => {
    const issued = createExternalMcpCredential({ name: 'reader', workspaceIds: ['one'] })
    expect(authenticateExternalMcpToken(issued.token)?.workspaceIds).toEqual(['one'])
    expect(issued.credential.tools).toContain('get_workspace')
    expect(issued.credential.tools).not.toContain('send_workspace_message')
    expect(JSON.stringify(listExternalMcpCredentials())).not.toContain(issued.token)
    const file = path.join(home, 'mcp-credentials.json')
    expect(fs.readFileSync(file, 'utf8')).not.toContain(issued.token)
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    const other = createExternalMcpCredential({ name: 'other', allWorkspaces: true })
    revokeExternalMcpCredential(issued.credential.id)
    expect(authenticateExternalMcpToken(issued.token)).toBeNull()
    expect(authenticateExternalMcpToken(other.token)).not.toBeNull()
  })
  it('requires explicit workspace scope and rejects malformed grants/expiry', () => {
    expect(() => createExternalMcpCredential({ name: 'none' })).toThrow()
    expect(() => createExternalMcpCredential({ name: 'bad', allWorkspaces: true, tools: ['made_up'] })).toThrow()
    expect(() => createExternalMcpCredential({ name: 'bad', allWorkspaces: true, expiresAt: '2000-01-01' })).toThrow()
    expect(authenticateExternalMcpToken('administrator-secret')).toBeNull()
  })
})
