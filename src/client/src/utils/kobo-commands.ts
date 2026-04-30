import type { useWebSocketStore } from 'src/stores/websocket'
import type { useWorkspaceStore } from 'src/stores/workspace'
import { AUTO_LOOP_GROOMING_STEPS, AUTO_LOOP_HARD_RULES } from '../../../shared/auto-loop-prompts'

const CHECK_PROGRESS_PROMPT = `Review your progress on the tasks and acceptance criteria. Use the kobo-tasks MCP server: call list_tasks() to check the current status, then update any tasks you have completed using mark_task_done(). Report what is done and what remains.

Then suggest concrete next actions. Format them exactly like this so I can click on them:

1. **Short label** → Description of the action
2. **Short label** → Description of the action`

const PREP_AUTOLOOP_PROMPT = `You are preparing this workspace for Kōbō auto-loop mode. This is a GROOMING session only — DO NOT implement anything, DO NOT write or edit code, DO NOT run tests or builds, DO NOT invoke \`superpowers:executing-plans\` or any implementation skill. Your ONLY job is to curate the Kōbō task list via MCP tools.

${AUTO_LOOP_GROOMING_STEPS}

${AUTO_LOOP_HARD_RULES}`

/** Map of Kobo built-in slash commands. */
export const KOBO_COMMANDS: Record<string, { prompt: string; descriptionKey: string }> = {
  '/kobo-check-progress': {
    prompt: CHECK_PROGRESS_PROMPT,
    descriptionKey: 'koboCommand.checkProgressDesc',
  },
  '/kobo-prep-autoloop': {
    prompt: PREP_AUTOLOOP_PROMPT,
    descriptionKey: 'koboCommand.prepAutoloopDesc',
  },
}

/** Send the check-progress prompt to the agent and add it to the activity feed. */
export function sendCheckProgress(
  workspaceId: string,
  wsStore: ReturnType<typeof useWebSocketStore>,
  workspaceStore: ReturnType<typeof useWorkspaceStore>,
): void {
  wsStore.sendChatMessage(workspaceId, CHECK_PROGRESS_PROMPT)
  workspaceStore.markRead(workspaceId)
  workspaceStore.addActivityItem(workspaceId, {
    id: `user-${Date.now()}`,
    type: 'text',
    content: CHECK_PROGRESS_PROMPT,
    timestamp: new Date().toISOString(),
    meta: { sender: 'user', pending: true },
  })
}

/** Send the prep-autoloop grooming prompt. Forces auto-accept (persisted + per-message override)
 * because plan mode blocks the MCP tools the grooming session needs (kobo__list_tasks,
 * kobo__create_task, kobo__mark_auto_loop_ready).
 *
 * Fetches the project-aware grooming prompt from the server (which composes E2E review
 * step when configured). Falls back to the local PREP_AUTOLOOP_PROMPT constant on error. */
export async function sendPrepAutoloop(
  workspaceId: string,
  wsStore: ReturnType<typeof useWebSocketStore>,
  workspaceStore: ReturnType<typeof useWorkspaceStore>,
): Promise<void> {
  try {
    await workspaceStore.updatePermissionMode(workspaceId, 'auto-accept')
  } catch {
    // best-effort — the per-message override below is the safety net
  }

  let prompt = PREP_AUTOLOOP_PROMPT
  try {
    const res = await fetch(`/api/workspaces/${workspaceId}/prep-autoloop-prompt`, { cache: 'no-store' })
    if (res.ok) {
      const data = (await res.json()) as { prompt?: string }
      if (data.prompt) prompt = data.prompt
    }
  } catch {
    // best-effort — the local PREP_AUTOLOOP_PROMPT default still applies
  }

  wsStore.sendChatMessage(workspaceId, prompt, undefined, 'auto-accept')
  workspaceStore.markRead(workspaceId)
  workspaceStore.addActivityItem(workspaceId, {
    id: `user-${Date.now()}`,
    type: 'text',
    content: prompt,
    timestamp: new Date().toISOString(),
    meta: { sender: 'user', pending: true },
  })
}
