import type { MessageSource } from '../../shared/workspace-message-types.js'
import { assertWorkspaceLifecycleAvailable } from '../utils/workspace-lifecycle-guard.js'
import { isAgentUnavailableError, isShuttingDown, sendMessage, startAgent } from './agent/orchestrator.js'
import * as autoLoop from './auto-loop-service.js'
import { createChatReceipt } from './chat-receipt-service.js'
import { getActiveSession, getWorkspace, updateWorkspaceStatus } from './workspace-service.js'

export interface WorkspaceMessage {
  source?: MessageSource
  content: string
  sessionId?: string
  clientMessageId?: string
  force?: boolean
  agentPermissionModeOverride?: 'plan' | 'bypass' | 'strict' | 'interactive'
}

/** Shared delivery for WebSocket chat and external MCP clients. */
export async function deliverWorkspaceMessage(
  workspaceId: string,
  message: WorkspaceMessage,
  hooks?: { beforeDispatch?: () => void; persist?: (payload: unknown, sessionId?: string) => void },
): Promise<{ sessionId?: string }> {
  const receipt = createChatReceipt(workspaceId, message, hooks?.persist)
  let reason: string | undefined
  try {
    if (!message.content.trim()) throw new Error('Message content must not be empty')
    if (isShuttingDown()) throw new Error('Kōbō is shutting down')
    assertWorkspaceLifecycleAvailable(workspaceId)
    const workspace = getWorkspace(workspaceId)
    if (!workspace) throw new Error(`Workspace '${workspaceId}' not found`)
    if (workspace.archivedAt || workspace.worktreePurgedAt)
      throw new Error('Restore the workspace before sending a message')
    if (workspace.status === 'compacting') {
      reason = 'compacting'
      throw new Error('Workspace is compacting its context; wait until compaction finishes before sending a message')
    }
    if (workspace.status === 'awaiting-user') {
      reason = 'awaiting-user'
      throw new Error('Answer the pending question or permission request before sending a chat message')
    }
    const loop = autoLoop.getStatus(workspaceId)
    if (loop.auto_loop && loop.auto_loop_ready) autoLoop.disable(workspaceId, 'user-action')
    let sessionId = message.sessionId ?? getActiveSession(workspaceId)?.id
    try {
      if (hooks?.beforeDispatch)
        await sendMessage(workspaceId, message.content, message.sessionId, hooks.beforeDispatch)
      else await sendMessage(workspaceId, message.content, message.sessionId)
    } catch (error) {
      if (!isAgentUnavailableError(error instanceof Error ? error.message : String(error))) throw error
      // Re-read after asynchronous delivery: metadata may have changed meanwhile.
      assertWorkspaceLifecycleAvailable(workspaceId)
      const current = getWorkspace(workspaceId)
      if (!current || current.archivedAt || current.worktreePurgedAt) throw new Error('Workspace is unavailable')
      const started = startAgent(
        workspaceId,
        current.worktreePath,
        message.content,
        current.model,
        true,
        message.agentPermissionModeOverride ?? current.agentPermissionMode,
        message.sessionId,
        current.reasoningEffort,
        ...(hooks?.beforeDispatch ? [hooks.beforeDispatch] : []),
      )
      updateWorkspaceStatus(workspaceId, 'executing')
      sessionId = message.sessionId ?? started.agentSessionId
    }
    receipt.accept(sessionId)
    return { sessionId }
  } catch (error) {
    receipt.reject(error instanceof Error ? error.message : String(error), reason)
    throw error
  }
}
