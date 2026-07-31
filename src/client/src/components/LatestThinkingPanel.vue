<template>
  <div v-if="thinking" class="latest-thinking-panel q-px-md q-pb-sm">
    <ThinkingItem :item="thinking" />
  </div>
</template>

<script setup lang="ts">
import { foldEvents, getLatestThinkingItem } from 'src/services/agent-event-view'
import { useAgentStreamStore } from 'src/stores/agent-stream'
import { useSettingsStore } from 'src/stores/settings'
import { useWorkspaceStore } from 'src/stores/workspace'
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

const thinking = computed(() => {
  if (!settings.global.showThinkingBlocks) return null

  const events = stream.eventsFor(props.workspaceId)
  const timestamps = stream.timestampsFor(props.workspaceId)
  const sessionIds = stream.sessionIdsFor(props.workspaceId)
  const currentEvents = events.filter((_, index) => sessionMatches(sessionIds[index]))
  const currentTimestamps = timestamps.filter((_, index) => sessionMatches(sessionIds[index]))

  return getLatestThinkingItem(foldEvents(currentEvents, currentTimestamps, false))
})
</script>

<style scoped>
.latest-thinking-panel {
  border-top: 1px solid rgba(255, 255, 255, 0.06);
}
</style>
