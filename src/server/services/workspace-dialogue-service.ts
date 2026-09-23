import { nanoid } from 'nanoid'
import { validateDialogueArguments } from '../../shared/workspace-dialogue-tools.js'
import { type MessageSource, parseMessageSource } from '../../shared/workspace-message-types.js'
import { getDb } from '../db/index.js'
import { assertWorkspaceLifecycleAvailable } from '../utils/workspace-lifecycle-guard.js'
import { answerPendingQuestion, getPendingInputs } from './agent/orchestrator.js'
import { createMcpClientContext } from './mcp-client-context.js'
import { deliverKeyedMcpMessage } from './mcp-message-delivery-service.js'
import { deliverWorkspaceMessage } from './workspace-message-service.js'
import { getActiveSession, getWorkspace, listSessions, listTasks, listWorkspaces } from './workspace-service.js'

interface ConversationRow {
  id: string
  session_id: string | null
  type: string
  payload: string
  created_at: string
}
function readableMessage(row: ConversationRow) {
  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(row.payload)
  } catch {
    return []
  }
  if (!payload || typeof payload !== 'object') return []
  let text: string | undefined
  if (row.type === 'user:message' && typeof payload.content === 'string') text = payload.content
  if (row.type === 'agent:event' && payload.kind === 'message:text' && typeof payload.text === 'string')
    text = payload.text
  if (row.type === 'agent:output') {
    const content = (payload.message as { content?: unknown } | null)?.content
    if (Array.isArray(content))
      text = content
        .flatMap((block) => (block?.type === 'text' && typeof block.text === 'string' ? [block.text] : []))
        .join('\n')
  }
  return text === undefined
    ? []
    : [
        {
          id: row.id,
          sessionId: row.session_id,
          role: row.type === 'user:message' ? 'user' : 'assistant',
          text,
          messageId: typeof payload.messageId === 'string' ? payload.messageId : row.id,
          createdAt: row.created_at,
          ...(parseMessageSource(payload.source) ? { source: parseMessageSource(payload.source) } : {}),
          ...(typeof payload.clientMessageId === 'string' ? { clientMessageId: payload.clientMessageId } : {}),
        },
      ]
}

export async function executeWorkspaceDialogueTool(
  name: string,
  input: unknown,
  source: MessageSource = createMcpClientContext(),
): Promise<unknown> {
  const args = validateDialogueArguments(name, input)
  if (name === 'list_workspaces')
    return listWorkspaces(args.include_archived === true).map((ws) => ({
      id: ws.id,
      name: ws.name,
      status: ws.status,
      projectPath: ws.projectPath,
      archivedAt: ws.archivedAt,
    }))
  const workspaceId = args.workspace_id as string
  const workspace = getWorkspace(workspaceId)
  if (!workspace) throw new Error(`Workspace '${workspaceId}' not found`)
  if (name === 'get_workspace')
    return { workspace, tasks: listTasks(workspaceId), activeSession: getActiveSession(workspaceId) }
  if (name === 'list_workspace_sessions') return listSessions(workspaceId)
  if (name === 'get_workspace_questions') {
    const pending = getPendingInputs(workspaceId)
    return {
      questions: pending.filter((item) => item.kind === 'question'),
      requiresHumanApproval: pending[0]?.kind === 'permission',
    }
  }
  if (name === 'answer_workspace_question') {
    assertWorkspaceLifecycleAvailable(workspaceId)
    if (workspace.archivedAt || workspace.worktreePurgedAt)
      throw new Error('Restore the workspace before answering a question')
    const head = getPendingInputs(workspaceId)[0]
    if (head?.kind !== 'question' || head.toolCallId !== args.tool_call_id)
      throw new Error('The requested question is not the current pending question')
    await answerPendingQuestion(workspaceId, args.answers as Record<string, string>, args.tool_call_id as string, {
      source,
    })
    return { accepted: true }
  }
  if (name === 'send_workspace_message' && args.idempotency_key)
    return deliverKeyedMcpMessage(workspaceId, args.idempotency_key as string, {
      content: args.content as string,
      sessionId: args.session_id as string | undefined,
      source,
    })
  if (name === 'send_workspace_message')
    return {
      accepted: true,
      ...(await deliverWorkspaceMessage(workspaceId, {
        content: args.content as string,
        sessionId: args.session_id as string | undefined,
        clientMessageId: `mcp-${nanoid()}`,
        source,
      })),
    }
  const db = getDb()
  let after = 0
  if (args.after_cursor) {
    const cursor = db
      .prepare('SELECT rowid FROM ws_events WHERE id = ? AND workspace_id = ?')
      .get(args.after_cursor, workspaceId) as { rowid: number } | undefined
    if (!cursor)
      throw new Error('Unknown or expired history cursor for this workspace; restart reading without after_cursor')
    after = cursor.rowid
  }
  const limit = (args.limit as number | undefined) ?? 100
  const params: (string | number)[] = [workspaceId, after]
  if (args.session_id) params.push(args.session_id as string)
  params.push(limit + 1)
  const rows = db
    .prepare(`SELECT id,session_id,type,payload,created_at FROM ws_events WHERE workspace_id = ? AND rowid > ?
    ${args.session_id ? 'AND (session_id = ? OR session_id IS NULL)' : ''} ORDER BY rowid LIMIT ?`)
    .all(...params) as ConversationRow[]
  const page = rows.slice(0, limit)
  return {
    messages: page.flatMap(readableMessage),
    nextCursor: page.at(-1)?.id ?? args.after_cursor ?? null,
    hasMore: rows.length > limit,
    workspaceStatus: workspace.status,
    activeSessionId: getActiveSession(workspaceId)?.id ?? null,
  }
}
