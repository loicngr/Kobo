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
 * accessible (uses the neutral Standard suite). */
const PREP_AUTOLOOP_PROMPT_STATIC = `${getGroomingIntro('standard')}\n\n${PREP_AUTOLOOP_BODY}`

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

/** Send the project-aware grooming prompt without changing the user's permission mode.
 * Falls back to the local suite-aware prompt when the server is unavailable. */
export async function sendPrepAutoloop(
  workspaceId: string,
  wsStore: ReturnType<typeof useWebSocketStore>,
  workspaceStore: ReturnType<typeof useWorkspaceStore>,
): Promise<void> {
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

  wsStore.sendChatMessage(workspaceId, prompt)
  workspaceStore.markRead(workspaceId)
  workspaceStore.addActivityItem(workspaceId, {
    id: `user-${Date.now()}`,
    type: 'text',
    content: prompt,
    timestamp: new Date().toISOString(),
    meta: { sender: 'user', pending: true },
  })
}
