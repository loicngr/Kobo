import type { useWebSocketStore } from 'src/stores/websocket'
import type { useWorkspaceStore } from 'src/stores/workspace'

const CHECK_PROGRESS_PROMPT = `Review your progress on the tasks and acceptance criteria. Use the kobo-tasks MCP server: call list_tasks() to check the current status, then update any tasks you have completed using mark_task_done(). Report what is done and what remains.

Then suggest concrete next actions. Format them exactly like this so I can click on them:

1. **Short label** → Description of the action
2. **Short label** → Description of the action`

/** Map of Kobo built-in slash commands. */
export const KOBO_COMMANDS: Record<string, { prompt: string; descriptionKey: string }> = {
  '/kobo-check-progress': {
    prompt: CHECK_PROGRESS_PROMPT,
    descriptionKey: 'koboCommand.checkProgressDesc',
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
