import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { expect, it, vi } from 'vitest'
import { getDb } from '../server/db/index.js'
import { createIdleSession, getActiveSession } from '../server/services/workspace-service.js'
import { createLiveMcpFixture } from './live/external-mcp-fixture.js'

it('uses a temporary scoped external credential for HTTP and global stdio without starting an engine', async () => {
  const fixture = await createLiveMcpFixture('mistral-vibe', 'auto')
  const http = new Client({ name: 'fixture-auth-http', version: '1' })
  const errors: unknown[] = []
  const stdio = new Client({ name: 'fixture-auth-stdio', version: '1' })
  try {
    const stored = readFileSync(join(fixture.home, 'mcp-credentials.json'), 'utf8')
    expect(stored).not.toContain(fixture.token)
    expect(JSON.parse(stored)).toMatchObject([
      {
        workspaceIds: [fixture.workspaceId],
        allWorkspaces: false,
        tools: ['list_workspaces', 'read_workspace_messages', 'send_workspace_message'],
      },
    ])
    const url = await fixture.start()
    const denied = await fetch(`${url}/api/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    expect(denied.status).toBe(401)
    await http.connect(
      new StreamableHTTPClientTransport(new URL(`${url}/api/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${fixture.token}` } },
      }),
    )
    await stdio.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ['--import', 'tsx', 'src/mcp-server/kobo-tasks-server.ts'],
        env: {
          PATH: process.env.PATH ?? '',
          KOBO_HOME: fixture.home,
          KOBO_WORKSPACE_ID: '',
          KOBO_BACKEND_URL: url,
          KOBO_MCP_TOKEN: fixture.token,
        },
        stderr: 'pipe',
      }),
    )
    for (const client of [http, stdio]) {
      const result = await client.callTool({ name: 'list_workspaces', arguments: {} })
      expect(result.isError).not.toBe(true)
      expect(JSON.parse((result.content as { text: string }[])[0]!.text)).toContainEqual(
        expect.objectContaining({ id: fixture.workspaceId }),
      )
    }
  } catch (error) {
    errors.push(error)
  } finally {
    await fixture.cleanup(errors, [stdio, http])
  }
}, 40_000)

it('cleans up the external fixture even when an MCP client close rejects, preserving all errors', async () => {
  const home = process.env.KOBO_HOME
  const fixture = await createLiveMcpFixture('mistral-vibe', 'auto')
  try {
    const url = await fixture.start()
    const primary = new Error('Original assertion')
    const closing = new Error('MCP close failed')
    const failed = { close: vi.fn().mockRejectedValue(closing) }
    const other = { close: vi.fn().mockResolvedValue(undefined) }
    const error = await fixture.cleanup([primary], [failed, other]).catch((error: unknown) => error)
    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors).toEqual([primary, closing])
    expect(other.close).toHaveBeenCalledOnce()
    expect(existsSync(fixture.home)).toBe(false)
    expect(process.env.KOBO_HOME).toBe(home)
    await expect(fetch(`${url}/api/health`)).rejects.toThrow()
  } finally {
    await fixture.cleanup()
  }
})

it('selects the live smoke session before and after resume with the current SQLite schema', async () => {
  const fixture = await createLiveMcpFixture('mistral-vibe', 'auto')
  try {
    const db = getDb(fixture.dbPath)
    const created = createIdleSession(fixture.workspaceId)
    db.prepare("UPDATE agent_sessions SET status = 'completed', engine_session_id = ? WHERE id = ?").run(
      'native-smoke',
      created.id,
    )
    const session = getActiveSession(fixture.workspaceId)!
    expect(session).toMatchObject({ id: created.id, engineSessionId: 'native-smoke' })
    // An unused, newer session must not replace the actual resumed conversation.
    createIdleSession(fixture.workspaceId)
    db.prepare("UPDATE agent_sessions SET status = 'running' WHERE id = ?").run(session.id)
    const latest = getActiveSession(fixture.workspaceId)
    expect(latest?.id).toBe(session.id)
    expect(latest?.engineSessionId).toBe(session.engineSessionId)
  } finally {
    await fixture.cleanup()
  }
})
