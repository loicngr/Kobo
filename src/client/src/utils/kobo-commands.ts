import { useSettingsStore } from 'src/stores/settings'
import type { useWebSocketStore } from 'src/stores/websocket'
import type { useWorkspaceStore } from 'src/stores/workspace'
import { AUTO_LOOP_GROOMING_STEPS, AUTO_LOOP_HARD_RULES } from '../../../shared/auto-loop-prompts'
import { getGroomingIntro } from '../../../shared/skill-suite-prompts'

const CHECK_PROGRESS_PROMPT = `Review your progress on the tasks and acceptance criteria. Use the kobo-tasks MCP server: call list_tasks() to check the current status, then update any tasks you have completed using mark_task_done(). Report what is done and what remains.

Then suggest concrete next actions. Format them exactly like this so I can click on them:

1. **Short label** → Description of the action
2. **Short label** → Description of the action`

/** The numbered grooming steps + hard rules — the body of the prep-autoloop
 * prompt, independent of the leading intro sentence (which is suite-aware). */
const PREP_AUTOLOOP_BODY = `${AUTO_LOOP_GROOMING_STEPS}

${AUTO_LOOP_HARD_RULES}`

/** Build the local fallback prep-autoloop prompt, picking the grooming intro
 * variant matching the user's chosen skill suite (with custom override when
 * `skillSuite === 'custom'`). The backend route
 * `/api/workspaces/:id/prep-autoloop-prompt` returns the canonical prompt
 * (which also honours the suite); this is only used when that fetch fails. */
function buildPrepAutoloopPrompt(): string {
  const store = useSettingsStore()
  const intro = getGroomingIntro(store.global.skillSuite, store.global.customAutoLoopGroomingIntro)
  return `${intro}\n\n${PREP_AUTOLOOP_BODY}`
}

/** Static fallback used in slash-command listings where no settings store is
 * accessible (always returns the `superpowers` variant — byte-identical to
 * the historical hardcoded constant). */
const PREP_AUTOLOOP_PROMPT_STATIC = `${getGroomingIntro('superpowers')}\n\n${PREP_AUTOLOOP_BODY}`

/** Map of Kobo built-in slash commands. */
export const KOBO_COMMANDS: Record<string, { prompt: string; descriptionKey: string }> = {
  '/kobo-check-progress': {
    prompt: CHECK_PROGRESS_PROMPT,
    descriptionKey: 'koboCommand.checkProgressDesc',
  },
  '/kobo-prep-autoloop': {
    prompt: PREP_AUTOLOOP_PROMPT_STATIC,
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
  // Promote 'plan' → 'bypass' so the prep-autoloop turn can run MCP tools
  // and edits (plan blocks them). Any other unified mode is honoured.
  try {
    const ws = workspaceStore.workspaces.find((w) => w.id === workspaceId)
    if (ws && ws.agentPermissionMode === 'plan') {
      await workspaceStore.updateAgentPermissionMode(workspaceId, 'bypass')
    }
  } catch {
    // best-effort — the per-message override below is the safety net
  }

  let prompt = buildPrepAutoloopPrompt()
  try {
    const res = await fetch(`/api/workspaces/${workspaceId}/prep-autoloop-prompt`, { cache: 'no-store' })
    if (res.ok) {
      const data = (await res.json()) as { prompt?: string }
      if (data.prompt) prompt = data.prompt
    }
  } catch {
    // best-effort — the local suite-aware fallback still applies
  }

  wsStore.sendChatMessage(workspaceId, prompt, undefined, 'bypass')
  workspaceStore.markRead(workspaceId)
  workspaceStore.addActivityItem(workspaceId, {
    id: `user-${Date.now()}`,
    type: 'text',
    content: prompt,
    timestamp: new Date().toISOString(),
    meta: { sender: 'user', pending: true },
  })
}
