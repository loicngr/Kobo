import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { validateDialogueArguments } from '../shared/workspace-dialogue-tools.js'
import { normalizeClientName } from '../shared/workspace-message-types.js'

/** Stateless HTTP bridge: external stdio clients never own agent runtime state. */
export async function callWorkspaceDialogueTool(
  backendUrl: string,
  name: string,
  args: unknown,
  token?: string,
  clientName?: string,
) {
  const arguments_ = validateDialogueArguments(name, args)
  const client = new Client({ name: 'kobo-stdio-bridge', version: '1.0.0' })
  const signal = AbortSignal.timeout(30_000)
  const transport = new StreamableHTTPClientTransport(new URL(`${backendUrl.replace(/\/$/, '')}/api/mcp`), {
    requestInit: {
      signal,
      headers: {
        ...(token ? { 'X-Kobo-Token': token } : {}),
        'X-Kobo-Client-Name': encodeURIComponent(normalizeClientName(clientName)),
        'X-Kobo-Client-Name-Encoding': 'uri',
        'X-Kobo-Client-Transport': 'stdio',
      },
    },
  })
  try {
    await client.connect(transport, { signal })
    return await client.callTool({ name, arguments: arguments_ }, undefined, { signal })
  } finally {
    await client.close()
  }
}
