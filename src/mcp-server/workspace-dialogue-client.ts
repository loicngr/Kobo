import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { isMemoryToolName, validateMemoryToolArguments } from '../shared/memory-tools.js'
import { isWorkspaceCreationTool, validateWorkspaceCreationArguments } from '../shared/workspace-creation-tools.js'
import { validateDialogueArguments } from '../shared/workspace-dialogue-tools.js'
import {
  isWorkspaceGroupMessageTool,
  validateWorkspaceGroupMessageArguments,
} from '../shared/workspace-group-message-tools.js'
import { isWorkspaceLifecycleTool, validateWorkspaceLifecycleArguments } from '../shared/workspace-lifecycle-tools.js'
import { normalizeClientName } from '../shared/workspace-message-types.js'

/** Stateless HTTP bridge: external stdio clients never own agent runtime state. */
export async function callWorkspaceDialogueTool(
  backendUrl: string,
  name: string,
  args: unknown,
  token?: string,
  clientName?: string,
) {
  const arguments_ = isMemoryToolName(name)
    ? validateMemoryToolArguments(name, args, true)
    : isWorkspaceCreationTool(name)
      ? validateWorkspaceCreationArguments(name, args)
      : isWorkspaceLifecycleTool(name)
        ? validateWorkspaceLifecycleArguments(name, args)
        : isWorkspaceGroupMessageTool(name)
          ? validateWorkspaceGroupMessageArguments(name, args)
          : validateDialogueArguments(name, args)
  const client = new Client({ name: 'kobo-stdio-bridge', version: '1.0.0' })
  // Creation can include forge reads, worktree setup and user setup scripts.
  // A timed-out creation is ambiguous and must never be retried automatically.
  const timeout = isWorkspaceCreationTool(name) || isWorkspaceLifecycleTool(name) ? 15 * 60_000 : 30_000
  const signal = AbortSignal.timeout(timeout)
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
    return await client.callTool({ name, arguments: arguments_ }, undefined, { signal, timeout })
  } finally {
    await client.close()
  }
}
