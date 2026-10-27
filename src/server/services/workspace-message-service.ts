import { type McpAttachment, validateMcpAttachments } from '../../shared/mcp-attachments.js'
import type { MessageSource } from '../../shared/workspace-message-types.js'
import { assertWorkspaceLifecycleAvailable, withWorkspaceLifecycleGuard } from '../utils/workspace-lifecycle-guard.js'
import { assertEngineConfigurationSupported } from './agent/engines/configuration.js'
import { resolveEngine } from './agent/engines/registry.js'
import {
  assertImmediateMessageSupported,
  isAgentUnavailableError,
  isParallelReviewSession,
  isShuttingDown,
  sendMessage,
  startAgent,
} from './agent/orchestrator.js'
import { attachmentReference, removeAttachments, type SavedAttachment, saveAttachments } from './attachment-service.js'
import { hasLoopMessage } from './auto-loop-message-service.js'
import * as autoLoop from './auto-loop-service.js'
import { createChatReceipt } from './chat-receipt-service.js'
import { preflightMistralConfiguration } from './mistral-options-service.js'
import { getParallelReviewSourceConfiguration } from './parallel-review-service.js'
import { emitEphemeral } from './websocket-service.js'
import { getActiveSession, getWorkspace, updateWorkspaceStatus } from './workspace-service.js'

export interface WorkspaceMessage {
  source?: MessageSource
  content: string
  attachments?: McpAttachment[]
  sessionId?: string
  clientMessageId?: string
  force?: boolean
  delivery?: 'immediate' | 'next_iteration'
  agentPermissionModeOverride?: 'plan' | 'bypass' | 'strict' | 'interactive'
}

/** Shared delivery for WebSocket chat and external MCP clients. */
export async function deliverWorkspaceMessage(
  workspaceId: string,
  message: WorkspaceMessage,
  hooks?: { beforeDispatch?: () => void; persist?: (payload: unknown, sessionId?: string) => void },
): Promise<{ sessionId?: string }> {
  // Keep the caller's original content unchanged for durable idempotency fingerprints.
  message = { ...message }
  const receipt = createChatReceipt(workspaceId, message, hooks?.persist)
  let saved: SavedAttachment[] = []
  let attachmentWorktree: string | undefined
  let dispatched = false
  let reviewTarget = false
  const beforeDispatch = () => {
    if (saved.length) {
      assertWorkspaceLifecycleAvailable(workspaceId)
      const current = getWorkspace(workspaceId)
      if (!current || current.archivedAt || current.worktreePurgedAt || current.worktreePath !== attachmentWorktree)
        throw new Error('Workspace changed before attachment delivery')
      if (
        (!reviewTarget && (current.status === 'compacting' || current.status === 'awaiting-user')) ||
        isShuttingDown()
      )
        throw new Error('Workspace is not ready to receive a message')
    }
    hooks?.beforeDispatch?.()
    dispatched = true
  }
  let reason: string | undefined
  try {
    const attachments = validateMcpAttachments(message.attachments)
    if (!message.content.trim() && !attachments.length) throw new Error('Message content must not be empty')
    if (isShuttingDown()) throw new Error('Kōbō is shutting down')
    assertWorkspaceLifecycleAvailable(workspaceId)
    const workspace = getWorkspace(workspaceId)
    if (!workspace) throw new Error(`Workspace '${workspaceId}' not found`)
    if (workspace.archivedAt || workspace.worktreePurgedAt)
      throw new Error('Restore the workspace before sending a message')
    reviewTarget = !!message.sessionId && isParallelReviewSession(workspaceId, message.sessionId)
    if (reviewTarget && message.delivery === 'next_iteration')
      throw new Error('Review messages require immediate delivery')
    if (message.delivery === 'next_iteration') {
      if (attachments.length) throw new Error('Attachments require immediate delivery')
      if (!message.clientMessageId) throw new Error('clientMessageId is required for queued delivery')
      const acceptedBefore = hasLoopMessage(workspaceId, message.clientMessageId)
      if (!acceptedBefore) {
        if (!workspace.autoLoop) throw new Error('Auto-loop is not enabled')
        hooks?.beforeDispatch?.()
      }
      if (!autoLoop.queueInstruction(workspaceId, message.content, message.clientMessageId, message.source))
        throw new Error('Auto-loop is not enabled')
      if (!acceptedBefore) receipt.accept()
      else emitEphemeral(workspaceId, 'chat:accepted', { clientMessageId: message.clientMessageId })
      return {}
    }
    if (!reviewTarget && workspace.status === 'compacting') {
      reason = 'compacting'
      throw new Error('Workspace is compacting its context; wait until compaction finishes before sending a message')
    }
    if (!reviewTarget && workspace.status === 'awaiting-user') {
      reason = 'awaiting-user'
      throw new Error('Answer the pending question or permission request before sending a chat message')
    }
    const sourceConfiguration = reviewTarget
      ? null
      : getParallelReviewSourceConfiguration(
          workspaceId,
          message.sessionId ?? getActiveSession(workspaceId)?.id,
          workspace.engine,
        )
    const configuration = sourceConfiguration ?? workspace
    if (!reviewTarget && configuration.engine === 'mistral-vibe') {
      assertEngineConfigurationSupported(resolveEngine(configuration.engine), {
        model: configuration.model,
        reasoningEffort: configuration.reasoningEffort,
        agentPermissionMode: message.agentPermissionModeOverride ?? configuration.agentPermissionMode,
      })
    }
    if (!reviewTarget) assertImmediateMessageSupported(workspaceId)
    if (!reviewTarget && configuration.engine === 'mistral-vibe') {
      await preflightMistralConfiguration(
        configuration.engine,
        { workspaceId },
        {
          model: configuration.model,
          reasoningEffort: configuration.reasoningEffort,
          agentPermissionMode: message.agentPermissionModeOverride ?? configuration.agentPermissionMode,
        },
        true,
      )
    }
    if (attachments.length) {
      attachmentWorktree = workspace.worktreePath
      await withWorkspaceLifecycleGuard(workspaceId, async () => {
        const files = attachments.map(
          (file) => new File([Buffer.from(file.data_base64, 'base64')], file.name, { type: file.mime_type }),
        )
        saved = await saveAttachments(workspace.worktreePath, files)
      })
      assertWorkspaceLifecycleAvailable(workspaceId)
      const current = getWorkspace(workspaceId)
      if (!current || current.archivedAt || current.worktreePurgedAt || current.worktreePath !== attachmentWorktree)
        throw new Error('Workspace changed while saving attachments')
      if (
        (!reviewTarget && (current.status === 'compacting' || current.status === 'awaiting-user')) ||
        isShuttingDown()
      )
        throw new Error('Workspace is not ready to receive a message')
      message.content = [message.content.trim(), ...saved.map(attachmentReference)].filter(Boolean).join('\n\n')
      // Binary data never belongs in the chat receipt or agent prompt.
      delete message.attachments
    }
    if (reviewTarget) {
      await sendMessage(workspaceId, message.content, message.sessionId, beforeDispatch)
      receipt.accept(message.sessionId)
      return { sessionId: message.sessionId }
    }
    const trackDispatch = !!hooks?.beforeDispatch || saved.length > 0
    const loop = autoLoop.getStatus(workspaceId)
    let sessionId = message.sessionId ?? getActiveSession(workspaceId)?.id
    try {
      if (trackDispatch) await sendMessage(workspaceId, message.content, message.sessionId, beforeDispatch)
      else await sendMessage(workspaceId, message.content, message.sessionId)
    } catch (error) {
      if (!isAgentUnavailableError(error instanceof Error ? error.message : String(error))) throw error
      // Re-read after asynchronous delivery: metadata may have changed meanwhile.
      assertWorkspaceLifecycleAvailable(workspaceId)
      const current = getWorkspace(workspaceId)
      if (!current || current.archivedAt || current.worktreePurgedAt) throw new Error('Workspace is unavailable')
      const resumedSource = getParallelReviewSourceConfiguration(workspaceId, message.sessionId, current.engine)
      const resumeConfiguration = resumedSource ?? current
      const started = startAgent(
        workspaceId,
        current.worktreePath,
        message.content,
        resumeConfiguration.model,
        true,
        message.agentPermissionModeOverride ?? resumeConfiguration.agentPermissionMode,
        message.sessionId,
        resumeConfiguration.reasoningEffort,
        trackDispatch ? beforeDispatch : undefined,
        resumedSource ? { engineOverride: resumedSource.engine } : undefined,
      )
      updateWorkspaceStatus(workspaceId, 'executing')
      sessionId = message.sessionId ?? started.agentSessionId
    }
    if (loop.auto_loop && loop.auto_loop_ready) autoLoop.disable(workspaceId, 'user-action')
    receipt.accept(sessionId)
    return { sessionId }
  } catch (error) {
    // Once dispatch may have happened, keep files available to the agent even if
    // acknowledgement failed. Only remove files from a definitively rejected send.
    if (saved.length && attachmentWorktree && !dispatched) {
      const worktree = attachmentWorktree
      try {
        await withWorkspaceLifecycleGuard(workspaceId, async () => {
          const current = getWorkspace(workspaceId)
          if (!current || current.worktreePurgedAt || current.worktreePath !== worktree) return
          for (const warning of await removeAttachments(worktree, saved))
            console.warn(`[message-attachments] ${warning}`)
        })
      } catch {
        // A competing lifecycle operation owns the checkout now; do not touch it.
      }
    }
    receipt.reject(error instanceof Error ? error.message : String(error), reason)
    throw error
  }
}
