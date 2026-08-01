<template>
  <div v-if="isVisible" class="latest-thinking-panel q-px-md q-pb-sm">
    <ThinkingItem :item="displayThinking" />
  </div>
</template>

<script setup lang="ts">
import { useAgentStreamStore } from 'src/stores/agent-stream'
import { useSettingsStore } from 'src/stores/settings'
import { useWorkspaceStore } from 'src/stores/workspace'
import { isBusyStatus } from 'src/utils/workspace-status'
import { computed } from 'vue'
import ThinkingItem from './items/ThinkingItem.vue'

const props = defineProps<{ workspaceId: string }>()
const stream = useAgentStreamStore()
const settings = useSettingsStore()
const workspaceStore = useWorkspaceStore()

const selectedSessionId = computed(() => workspaceStore.selectedSessionId)
const selectedSessionLegacyTag = computed(() => {
  const session = workspaceStore.sessions.find((item) => item.id === selectedSessionId.value)
  return session?.engineSessionId ?? null
})
const isFirstSelectedSession = computed(() => {
  const sessions = workspaceStore.sessions
  return sessions.length > 0 && selectedSessionId.value === sessions[sessions.length - 1]?.id
})

function sessionMatches(sessionId: string | null | undefined): boolean {
  if (!selectedSessionId.value) return true
  if (!sessionId) return isFirstSelectedSession.value
  return sessionId === selectedSessionId.value || sessionId === selectedSessionLegacyTag.value
}

const latestThinking = computed(() => {
  const events = stream.eventsFor(props.workspaceId)
  const timestamps = stream.timestampsFor(props.workspaceId)
  const sessionIds = stream.sessionIdsFor(props.workspaceId)

  // A thinking panel represents the engine's current activity, not its most
  // recent historical thought. The first non-thinking event means it moved on
  // to a tool call, an answer, or another phase and the panel must disappear.
  for (let index = events.length - 1; index >= 0; index--) {
    if (!sessionMatches(sessionIds[index])) continue
    const event = events[index]
    if (event.kind !== 'message:thinking') return null
    return {
      type: 'thinking' as const,
      messageId: event.messageId,
      text: event.text,
      ts: timestamps[index],
    }
  }
  return null
})

const isVisible = computed(
  () =>
    settings.global.showThinkingBlocks &&
    isBusyStatus(workspaceStore.selectedWorkspace?.status) &&
    latestThinking.value !== null,
)

// Some engines signal a thinking phase without exposing its details. In that
// case, show the lightweight activity label for that phase only.
const displayThinking = computed(
  () => latestThinking.value ?? { type: 'thinking' as const, messageId: 'no-thinking-details', text: '' },
)
</script>

<style scoped>
.latest-thinking-panel {
  border-top: 1px solid rgba(255, 255, 255, 0.06);
}
</style>
