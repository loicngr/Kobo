import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { validateCodeReviewArguments } from '../shared/code-review-tools.js'
import { isMemoryToolName, validateMemoryToolArguments } from '../shared/memory-tools.js'
import { isProgressBarTool, validateProgressBarArguments } from '../shared/progress-bar-tools.js'
import { isSprintTool } from '../shared/sprint-tools.js'
import { isWorkspaceCreationTool, validateWorkspaceCreationArguments } from '../shared/workspace-creation-tools.js'
import { validateDialogueArguments } from '../shared/workspace-dialogue-tools.js'
import {
  isWorkspaceGroupMessageTool,
  validateWorkspaceGroupMessageArguments,
} from '../shared/workspace-group-message-tools.js'
import { isWorkspaceLifecycleTool, validateWorkspaceLifecycleArguments } from '../shared/workspace-lifecycle-tools.js'
import { normalizeClientName } from '../shared/workspace-message-types.js'
import {
  isWorkspaceObservationTool,
  validateWorkspaceObservationArguments,
} from '../shared/workspace-observation-tools.js'

/** Stateless HTTP bridge: external stdio clients never own agent runtime state. */
export async function callWorkspaceDialogueTool(
  backendUrl: string,
  name: string,
  args: unknown,
  token?: string,
  clientName?: string,
) {
  if (isProgressBarTool(name)) {
    try {
      validateProgressBarArguments(name, args, true)
    } catch (error) {
      const data = {
        error: error instanceof Error ? error.message : 'Invalid arguments',
        status: 400,
        code: 'invalid_arguments',
      }
      return {
        isError: true,
        content: [{ type: 'text' as const, text: JSON.stringify(data) }],
        structuredContent: data,
      }
    }
  }
  if (isSprintTool(name) && (!args || typeof args !== 'object' || Array.isArray(args)))
    throw new Error('Invalid sprint tool arguments')
  const arguments_ = isSprintTool(name)
    ? (args as Record<string, unknown>)
    : isWorkspaceObservationTool(name)
      ? validateWorkspaceObservationArguments(name, args)
      : name === 'start_code_review'
        ? validateCodeReviewArguments(args)
        : isMemoryToolName(name)
          ? validateMemoryToolArguments(name, args, true)
          : isProgressBarTool(name)
            ? (args as Record<string, unknown>)
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
  const timeout =
    isWorkspaceCreationTool(name) || isWorkspaceLifecycleTool(name) || name === 'start_code_review'
      ? 15 * 60_000
      : name === 'list_agent_options' && arguments_.engine === 'mistral-vibe'
        ? 90_000
        : 30_000
  const signal = AbortSignal.timeout(timeout)
  const transport = new StreamableHTTPClientTransport(new URL(`${backendUrl.replace(/\/$/, '')}/api/mcp`), {
    requestInit: {
      signal,
      redirect: 'error',
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
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

/** Discovery uses the same principal and live grants as execution. */
export async function listWorkspaceDialogueTools(backendUrl: string, token?: string, clientName?: string) {
  const client = new Client({ name: 'kobo-stdio-bridge', version: '1.0.0' })
  const signal = AbortSignal.timeout(30_000)
  const transport = new StreamableHTTPClientTransport(new URL(`${backendUrl.replace(/\/$/, '')}/api/mcp`), {
    requestInit: {
      signal,
      redirect: 'error',
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        'X-Kobo-Client-Name': encodeURIComponent(normalizeClientName(clientName)),
        'X-Kobo-Client-Name-Encoding': 'uri',
        'X-Kobo-Client-Transport': 'stdio',
      },
    },
  })
  try {
    await client.connect(transport, { signal })
    return await client.listTools({}, { signal, timeout: 30_000 })
  } finally {
    await client.close()
  }
}
