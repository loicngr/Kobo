<script setup lang="ts">
import { useWebSocketStore } from 'src/stores/websocket'
import { useWorkspaceStore } from 'src/stores/workspace'
import type { DetectedChoice } from 'src/utils/detect-choices'

const props = defineProps<{
  choices: DetectedChoice[]
  /** When true, the buttons are interactive. Set to false on stale messages
      (i.e. another message has been posted after this one) so old multiple-
      choice prompts don't keep accepting clicks once the conversation has
      moved on. */
  active: boolean
}>()

const wsStore = useWebSocketStore()
const workspaceStore = useWorkspaceStore()

function onChoiceClick(choice: DetectedChoice) {
  if (!props.active) return
  const wsId = workspaceStore.selectedWorkspaceId
  if (!wsId) return
  // Format: "A. <full label>" — matches what the user would type by hand and
  // gives the agent the full label for context, not just the bare letter.
  const reply = `${choice.key}. ${choice.label}`
  const sessionId = workspaceStore.selectedSessionId ?? undefined
  wsStore.sendChatMessage(wsId, reply, sessionId)
  // Optimistic activity feed entry so the user sees their reply land instantly
  // (the WS round-trip then replaces the pending entry once the backend echoes it).
  workspaceStore.addActivityItem(wsId, {
    id: `user-${Date.now()}`,
    type: 'text',
    content: reply,
    timestamp: new Date().toISOString(),
    sessionId,
    meta: { sender: 'user', pending: true },
  })
}
</script>

<template>
  <div v-if="choices.length > 0 && active" class="message-choices q-mt-sm">
    <q-btn
      v-for="choice in choices"
      :key="choice.key"
      flat
      dense
      no-caps
      size="sm"
      color="indigo-3"
      class="message-choice-btn q-mr-xs q-mb-xs"
      @click="onChoiceClick(choice)"
    >
      <span class="choice-key text-weight-medium">{{ choice.key }}.</span>
      <span class="choice-label q-ml-xs ellipsis">{{ choice.label }}</span>
    </q-btn>
  </div>
</template>

<style scoped lang="scss">
.message-choices {
  display: flex;
  flex-wrap: wrap;
  align-items: stretch;
}
.message-choice-btn {
  // Outline style — discreet, doesn't compete with the message text.
  border: 1px solid rgba(129, 140, 248, 0.35);
  border-radius: 6px;
  background: rgba(129, 140, 248, 0.08);
  font-size: 12px;
  max-width: 360px;

  :deep(.q-btn__content) {
    flex-wrap: nowrap;
    justify-content: flex-start;
  }
}
.message-choice-btn:hover {
  background: rgba(129, 140, 248, 0.18);
}
.choice-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 320px;
}
</style>
