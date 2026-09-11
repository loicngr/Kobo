import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { expect, it } from 'vitest'
import { createLiveMcpFixture } from './external-mcp-fixture.js'

it('exchanges a real engine reply through MCP and replays the receipt after restart', async () => {
  const engine = process.env.KOBO_LIVE_ENGINE
  const model = process.env.KOBO_LIVE_MODEL
  if ((engine !== 'codex' && engine !== 'claude-code') || !model)
    throw new Error(
      'Set KOBO_LIVE_ENGINE=codex|claude-code and KOBO_LIVE_MODEL to an available model; this explicit test requires real credentials',
    )
  const fixture = await createLiveMcpFixture(engine, model)
  let client = new Client({ name: 'kobo-live-http', version: '1' })
  const stdio = new Client({ name: 'kobo-live-stdio', version: '1' })
  async function call(
    name: string,
    args: Record<string, unknown>,
    connection = client,
  ): Promise<Record<string, unknown>> {
    const result = await connection.callTool({ name, arguments: args })
    if (result.isError) throw new Error(`MCP ${name}: ${JSON.stringify(result.content)}`)
    return JSON.parse((result.content as { text: string }[])[0]!.text) as Record<string, unknown>
  }
  try {
    const url = await fixture.start()
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${url}/api/mcp`), {
        requestInit: { headers: { 'X-Kobo-Client-Name': 'Live HTTP client' } },
      }),
    )
    const workspace_id = fixture.workspaceId
    const discovered = await call('list_workspaces', {})
    expect(discovered).toContainEqual(expect.objectContaining({ id: workspace_id }))
    const history = await call('read_workspace_messages', { workspace_id })
    let cursor = history.nextCursor as string | null
    const marker = `KOBO_SMOKE_${randomUUID().replaceAll('-', '')}`
    const args = {
      workspace_id,
      content: `Reply with exactly this marker and nothing else: ${marker}. Do not use any tools.`,
      idempotency_key: randomUUID(),
    }
    const receipt = await call('send_workspace_message', args)
    expect(receipt.accepted).toBe(true)
    let received = ''
    const fragments: Record<string, unknown>[] = []
    const deadline = Date.now() + 100_000
    while (Date.now() < deadline && !received.includes(marker)) {
      const page = await call('read_workspace_messages', { workspace_id, ...(cursor ? { after_cursor: cursor } : {}) })
      fragments.push(...(page.messages as Record<string, unknown>[]))
      received = fragments
        .filter((message) => message.role === 'assistant')
        .map((message) => message.text)
        .join('')
      cursor = page.nextCursor as string | null
      if (page.workspaceStatus === 'error' || page.workspaceStatus === 'quota')
        throw new Error(`Real engine entered ${page.workspaceStatus}: ${fixture.diagnostics()}`)
      if (!page.hasMore && !received.includes(marker)) await delay(500)
    }
    expect(received, `No real engine reply. ${fixture.diagnostics()}`).toContain(marker)
    expect(fragments.filter((message) => message.role === 'user')).toMatchObject([
      { source: { kind: 'mcp', clientName: 'Live HTTP client', transport: 'http' } },
    ])
    expect(await call('send_workspace_message', args)).toEqual({ ...receipt, replayed: true })
    await stdio.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ['--import', 'tsx', 'src/mcp-server/kobo-tasks-server.ts'],
        env: {
          PATH: process.env.PATH ?? '',
          KOBO_HOME: fixture.home,
          KOBO_DB_PATH: fixture.dbPath,
          KOBO_WORKSPACE_ID: '',
          KOBO_BACKEND_URL: url,
        },
        stderr: 'pipe',
      }),
    )
    const viaStdio = await call('read_workspace_messages', { workspace_id }, stdio)
    expect((viaStdio.messages as { role: string }[]).filter((message) => message.role === 'user')).toHaveLength(1)
    await stdio.close()
    await client.close()
    await fixture.stop()
    const restarted = await fixture.start()
    client = new Client({ name: 'kobo-live-restart', version: '1' })
    await client.connect(new StreamableHTTPClientTransport(new URL(`${restarted}/api/mcp`)))
    expect(await call('send_workspace_message', args)).toEqual({ ...receipt, replayed: true })
    const finalHistory = await call('read_workspace_messages', { workspace_id })
    expect((finalHistory.messages as { role: string }[]).filter((message) => message.role === 'user')).toHaveLength(1)
  } finally {
    await stdio.close()
    await client.close()
    await fixture.cleanup()
  }
})
