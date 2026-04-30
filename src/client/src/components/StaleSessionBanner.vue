<template>
  <q-banner v-if="visible" class="bg-indigo-9 text-white q-ma-sm" rounded>
    <template #avatar>
      <q-icon name="loop" />
    </template>
    <div class="text-subtitle2">{{ $t('staleSessionBanner.title') }}</div>
    <div class="text-caption">{{ $t('staleSessionBanner.message') }}</div>
    <template #action>
      <q-btn flat dense no-caps :label="$t('staleSessionBanner.switchToCurrent')" @click="jumpToLatest" />
    </template>
  </q-banner>
</template>

<script setup lang="ts">
import { useWorkspaceStore } from 'src/stores/workspace'
import { isBusyStatus } from 'src/utils/workspace-status'
import { computed } from 'vue'

const props = defineProps<{ workspaceId: string }>()
const store = useWorkspaceStore()

// Auto-loop spawns a fresh session per iteration; if the user lags behind on
// an older session, the live feed is silently stale. Surface that and offer
// a one-click jump to the current one.
const visible = computed<boolean>(() => {
  if (!store.selectedSessionId || store.sessions.length < 2) return false

  const latest = store.sessions[0]
  if (!latest || latest.id === store.selectedSessionId) return false

  const ws = store.workspaces.find((w) => w.id === props.workspaceId)
  if (!ws) return false
  if (!isBusyStatus(ws.status)) return false

  return store.autoLoopStates[props.workspaceId]?.auto_loop === true
})

function jumpToLatest(): void {
  const latest = store.sessions[0]
  if (latest) store.selectSession(latest.id)
}
</script>
