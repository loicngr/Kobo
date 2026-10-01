import { getDb } from '../db/index.js'
import { getWorkingTreeDiffStatsAsync, getWorkingTreePorcelainAsync } from '../utils/git-ops.js'
import type { WorkspaceWithTasks } from './workspace-service.js'

const MAX_RECENT_MESSAGES = 6
const MAX_HISTORY_ROWS = 10_000
const MAX_MESSAGE_CHARS = 2_000
const MAX_CONVERSATION_CHARS = 12_000
const TRUNCATED = '[Earlier text omitted]\n'

interface ConversationRow {
  ordinal: number
  id: string
  session_id: string | null
  type: string
  payload: string
}
interface ConversationFragment {
  key: string
  role: 'user' | 'assistant'
  text: string
  complete: boolean
}
interface RecentMessage extends ConversationFragment {
  ordinal: number
  truncated: boolean
}

/** Normalized text events are deltas; a non-streaming snapshot is complete. */
function readableFragment(row: ConversationRow): ConversationFragment | null {
  try {
    const payload = JSON.parse(row.payload) as Record<string, unknown> | null
    if (!payload || typeof payload !== 'object') return null
    if (
      row.type === 'user:message' &&
      typeof payload.content === 'string' &&
      (payload.sender === undefined || payload.sender === 'user')
    ) {
      return { key: `user:${row.id}`, role: 'user', text: payload.content, complete: true }
    }
    if (row.type === 'agent:event' && payload.kind === 'message:text' && typeof payload.text === 'string') {
      return {
        // A resumed/native session may reuse the same message id elsewhere.
        key: JSON.stringify([row.session_id, typeof payload.messageId === 'string' ? payload.messageId : row.id]),
        role: 'assistant',
        text: payload.text,
        complete: payload.streaming === false,
      }
    }
  } catch {
    // Historical damaged rows are not evidence of a conversation message.
  }
  return null
}

function boundedText(text: string, limit: number): string {
  if (text.length <= limit) return text
  const marker = '\n[Middle text omitted]\n'
  const available = Math.max(0, limit - marker.length)
  const first = Math.ceil(available / 2)
  return `${text.slice(0, first)}${marker}${text.slice(-(available - first))}`.slice(0, limit)
}

function recentConversation(workspaceId: string, sessionId?: string | null): string {
  const db = getDb()
  const filter = 'workspace_id = ? AND (? IS NULL OR session_id = ?)'
  const parameters = [workspaceId, sessionId ?? null, sessionId ?? null]
  // Pin the most recent real user message independently of streaming volume.
  const userRows = db
    .prepare(
      `SELECT rowid AS ordinal, id, type, payload, session_id FROM ws_events
       WHERE ${filter} AND type = 'user:message' ORDER BY rowid DESC`,
    )
    .iterate(...parameters) as Iterable<ConversationRow>
  let latestUser: RecentMessage | undefined
  for (const row of userRows) {
    const fragment = readableFragment(row)
    if (!fragment?.text) continue
    latestUser = { ...fragment, ordinal: row.ordinal, truncated: false }
    break
  }

  const rows = db
    .prepare(
      `SELECT rowid AS ordinal, id, type, payload, session_id FROM ws_events
       WHERE ${filter} AND type IN ('user:message', 'agent:event')
       ORDER BY rowid DESC LIMIT ?`,
    )
    .iterate(...parameters, MAX_HISTORY_ROWS + 1) as Iterable<ConversationRow>
  const messages = new Map<string, RecentMessage>()
  let scanned = 0
  let historyTruncated = false
  for (const row of rows) {
    if (++scanned > MAX_HISTORY_ROWS) {
      historyTruncated = true
      break
    }
    const fragment = readableFragment(row)
    if (!fragment?.text) continue
    const existing = messages.get(fragment.key)
    if (existing) {
      existing.ordinal = row.ordinal
      if (existing.complete) continue
      const merged = fragment.text + existing.text
      existing.text = merged.slice(-MAX_MESSAGE_CHARS)
      existing.truncated ||= merged.length > MAX_MESSAGE_CHARS
      existing.complete = fragment.complete
    } else if (messages.size < MAX_RECENT_MESSAGES) {
      messages.set(fragment.key, {
        ...fragment,
        ordinal: row.ordinal,
        text: fragment.text.slice(-MAX_MESSAGE_CHARS),
        truncated: fragment.text.length > MAX_MESSAGE_CHARS,
      })
    }
  }

  const selected: Array<{ ordinal: number; text: string }> = []
  const warning = historyTruncated
    ? '\n\n[Conversation history truncated; recover older context from the source session.]'
    : ''
  let remaining = MAX_CONVERSATION_CHARS - warning.length
  if (latestUser) {
    const pinned = `Latest user instruction:\n${boundedText(latestUser.text, 6_000)}`
    selected.push({ ordinal: latestUser.ordinal, text: pinned })
    remaining -= pinned.length + 2
    messages.delete(latestUser.key)
  }
  const newestFirst = [...messages.values()].sort((a, b) => b.ordinal - a.ordinal)
  for (const message of newestFirst) {
    const label = message.role === 'assistant' ? 'Assistant:\n' : 'User:\n'
    if (remaining <= label.length + TRUNCATED.length + 2) break
    const text = message.truncated ? TRUNCATED + message.text : message.text
    const rendered = label + boundedText(text, Math.min(MAX_MESSAGE_CHARS, remaining - label.length - 2))
    selected.push({ ordinal: message.ordinal, text: rendered })
    remaining -= rendered.length + 2
  }
  return (
    selected
      .sort((a, b) => a.ordinal - b.ordinal)
      .map((message) => message.text)
      .join('\n\n') + warning
  )
}

/** Build a deterministic, secret-free handoff for a fresh session on another engine. */
export async function buildEngineHandoff(
  workspace: WorkspaceWithTasks,
  sourceEngine: string,
  targetEngine: string,
  sourceSessionId?: string | null,
): Promise<string> {
  const taskLines = workspace.tasks.length
    ? workspace.tasks.map((task) => `- [${task.status === 'done' ? 'x' : ' '}] ${task.title}`).join('\n')
    : '- No Kōbō task recorded.'
  const [status, diff] = await Promise.allSettled([
    getWorkingTreePorcelainAsync(workspace.worktreePath),
    getWorkingTreeDiffStatsAsync(workspace.worktreePath),
  ])
  const changedFiles =
    status.status === 'fulfilled'
      ? status.value.trim() || 'No uncommitted changes detected.'
      : 'Git state unavailable. Verify the working tree before making changes.'
  const diffStat =
    diff.status === 'fulfilled'
      ? diff.value.trim() || 'No uncommitted diff stat available.'
      : 'Git state unavailable. Run git diff --stat to recover the summary.'
  const history = recentConversation(workspace.id, sourceSessionId) || 'No recent conversation message available.'

  return `# Kōbō engine handoff\n\nYou are taking over this workspace from ${sourceEngine} using ${targetEngine}. Work in the existing worktree and verify the repository state before making changes.\n\n## Objective\n${workspace.description ?? workspace.name}\n\n## Tasks\n${taskLines}\n\n## Git state\n- Branch: ${workspace.workingBranch}\n- Base: ${workspace.sourceBranch}\n- Worktree: ${workspace.worktreePath}\n\nChanged files:\n\`\`\`\n${changedFiles}\n\`\`\`\n\nDiff summary:\n\`\`\`\n${diffStat}\n\`\`\`\n\n## Recent conversation\n${history}\n\n## Recover more context\nIf this handoff is insufficient, use \`kobo__read_workspace_events_csv\` to read the previous workspace conversation in pages (optionally filter by \`session_id\`). Use \`kobo__search_codebase\` to find a precise past decision or user request. Read only the context needed, then continue the task.\n`
}
