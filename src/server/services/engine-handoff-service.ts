import { execFileSync } from 'node:child_process'
import { getDb } from '../db/index.js'
import type { WorkspaceWithTasks } from './workspace-service.js'

function runGit(worktreePath: string, args: string): string {
  try {
    return execFileSync('git', args.split(' '), { cwd: worktreePath, encoding: 'utf8', timeout: 10_000 }).trim()
  } catch {
    return ''
  }
}

function recentConversation(workspaceId: string): string {
  const rows = getDb()
    .prepare(
      `SELECT type, payload FROM ws_events
       WHERE workspace_id = ?
         AND (type = 'user:message' OR (type = 'agent:event' AND json_extract(payload, '$.kind') = 'message:text'))
       ORDER BY rowid DESC LIMIT 6`,
    )
    .all(workspaceId) as Array<{ type: string; payload: string }>
  return rows
    .reverse()
    .flatMap((row) => {
      try {
        const payload = JSON.parse(row.payload) as { content?: unknown; text?: unknown }
        const text =
          typeof payload.content === 'string' ? payload.content : typeof payload.text === 'string' ? payload.text : ''
        return text ? [text.slice(0, 1600)] : []
      } catch {
        return []
      }
    })
    .join('\n\n')
}

/** Build a deterministic, secret-free handoff for a fresh session on another engine. */
export function buildEngineHandoff(workspace: WorkspaceWithTasks, sourceEngine: string, targetEngine: string): string {
  const taskLines = workspace.tasks.length
    ? workspace.tasks.map((task) => `- [${task.status === 'done' ? 'x' : ' '}] ${task.title}`).join('\n')
    : '- No Kōbō task recorded.'
  const changedFiles = runGit(workspace.worktreePath, 'status --short') || 'No uncommitted changes detected.'
  const diffStat = runGit(workspace.worktreePath, 'diff --stat') || 'No uncommitted diff stat available.'
  const history = recentConversation(workspace.id) || 'No recent conversation message available.'

  return `# Kōbō engine handoff\n\nYou are taking over this workspace from ${sourceEngine} using ${targetEngine}. Work in the existing worktree and verify the repository state before making changes.\n\n## Objective\n${workspace.description ?? workspace.name}\n\n## Tasks\n${taskLines}\n\n## Git state\n- Branch: ${workspace.workingBranch}\n- Base: ${workspace.sourceBranch}\n- Worktree: ${workspace.worktreePath}\n\nChanged files:\n\`\`\`\n${changedFiles}\n\`\`\`\n\nDiff summary:\n\`\`\`\n${diffStat}\n\`\`\`\n\n## Recent conversation\n${history}\n\n## Recover more context\nIf this handoff is insufficient, use \`kobo__read_workspace_events_csv\` to read the previous workspace conversation in pages (optionally filter by \`session_id\`). Use \`kobo__search_codebase\` to find a precise past decision or user request. Read only the context needed, then continue the task.\n`
}
