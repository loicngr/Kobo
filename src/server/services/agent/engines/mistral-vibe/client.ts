import type { ChildProcess } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import * as acp from '@agentclientprotocol/sdk'

export type VibeAcpConnection = acp.ClientConnection
export interface VibeAcpHandlers {
  sessionUpdate?: acp.ClientNotificationHandlersByMethod['session/update']
  requestPermission?: acp.ClientRequestHandlersByMethod['session/request_permission']
  createElicitation?: acp.ClientRequestHandlersByMethod['elicitation/create']
}

/** The SDK owns framing and incoming validation. Stderr never enters ACP. */
export function connectVibeAcp(child: ChildProcess, handlers: VibeAcpHandlers): VibeAcpConnection {
  if (!child.stdin || !child.stdout) throw new Error('Vibe ACP requires piped stdin and stdout')
  const app = acp.client({ name: 'kobo' })
  if (handlers.sessionUpdate) app.onNotification(acp.methods.client.session.update, handlers.sessionUpdate)
  if (handlers.requestPermission)
    app.onRequest(acp.methods.client.session.requestPermission, handlers.requestPermission)
  if (handlers.createElicitation) app.onRequest(acp.methods.client.elicitation.create, handlers.createElicitation)
  // Node and DOM disagree on BYOB generics; both adapters are standard Web Streams at runtime.
  const readable = Readable.toWeb(child.stdout) as unknown as Parameters<typeof acp.ndJsonStream>[1]
  return app.connect(acp.ndJsonStream(Writable.toWeb(child.stdin), readable))
}

/** Fluent SDK responses are unchecked; validate the fields this transport consumes. */
function validateResponse(method: acp.AgentRequestMethod, response: unknown): void {
  const value = response as Record<string, unknown> | null | undefined
  if (method === acp.methods.agent.initialize && value?.protocolVersion !== acp.PROTOCOL_VERSION) {
    throw new Error('Invalid Vibe ACP protocol version; ACP v1 is required')
  }
  if (
    method === acp.methods.agent.session.new &&
    (typeof value?.sessionId !== 'string' || value.sessionId.trim().length === 0)
  ) {
    throw new Error('Invalid Vibe ACP session identity')
  }
  if (
    method === acp.methods.agent.session.prompt &&
    (typeof value?.stopReason !== 'string' ||
      !['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled'].includes(value.stopReason))
  ) {
    throw new Error('Invalid Vibe ACP prompt stop reason')
  }
}

/** Use for all requests: initialization/setup are bounded, prompts have no absolute deadline. */
export async function requestVibeAcp<Method extends acp.AgentRequestMethod>(
  connection: VibeAcpConnection,
  method: Method,
  params: acp.AgentRequestParamsByMethod[Method],
): Promise<acp.AgentRequestResponsesByMethod[Method]> {
  const timeout = method === acp.methods.agent.initialize ? 20000 : 30000
  let timer: ReturnType<typeof setTimeout> | undefined
  const pending = connection.agent.request(method, params)
  try {
    const response = await (method === acp.methods.agent.session.prompt
      ? pending
      : Promise.race([
          pending,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              const error = new Error(`Vibe ACP ${method} timed out after ${timeout}ms`)
              reject(error)
            }, timeout)
          }),
        ]))
    validateResponse(method, response)
    return response
  } finally {
    clearTimeout(timer)
  }
}

/** Pass as runtime.stop's callback; the runtime still ends stdin and confirms process exit. */
export async function closeVibeAcpSession(
  connection: VibeAcpConnection,
  session: { sessionId: string; active: boolean; canClose: boolean },
): Promise<void> {
  if (session.active) await connection.agent.notify(acp.methods.agent.session.cancel, { sessionId: session.sessionId })
  if (session.canClose)
    await requestVibeAcp(connection, acp.methods.agent.session.close, { sessionId: session.sessionId })
}
