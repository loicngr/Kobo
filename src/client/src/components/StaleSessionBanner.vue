<template>
  <q-banner v-if="visible" class="bg-kobo-surface text-white q-ma-sm" rounded>
    <template #avatar>
      <q-icon :name="mode === 'autoloop' ? 'loop' : 'history'" />
    </template>
    <div class="text-subtitle2">
      {{ mode === 'autoloop' ? $t('staleSessionBanner.title') : $t('staleSessionBanner.staleTitle') }}
    </div>
    <div class="text-caption">
      {{ mode === 'autoloop' ? $t('staleSessionBanner.message') : $t('staleSessionBanner.staleMessage') }}
    </div>
    <template #action>
      <q-btn flat dense no-caps :label="$t('staleSessionBanner.switchToCurrent')" @click="jumpToLatest" />
    </template>
  </q-banner>
</template>

<script setup lang="ts">
import { useWorkspaceStore } from 'src/stores/workspace'
import { getCurrentSession } from 'src/utils/current-session'
import { isBusyStatus } from 'src/utils/workspace-status'
import { computed } from 'vue'

const props = defineProps<{ workspaceId: string }>()
const store = useWorkspaceStore()

const currentSession = computed(() =>
  getCurrentSession(store.sessions.filter((session) => session.workspaceId === props.workspaceId)),
)

// A temporary review may return to an older conversation. Compare with the
// last used session rather than the last created one, including after reload.
const visible = computed<boolean>(() => {
  if (!store.selectedSessionId || store.sessions.length < 2) return false
  return !!currentSession.value && currentSession.value.id !== store.selectedSessionId
})

// Auto-loop has its own framing (the agent is actively working in the latest
// session); the manual case is a plain "you're not on the latest" caution.
const mode = computed<'autoloop' | 'stale'>(() => {
  const ws = store.workspaces.find((w) => w.id === props.workspaceId)
  const autoLoopBusy = !!ws && isBusyStatus(ws.status) && store.autoLoopStates[props.workspaceId]?.auto_loop === true
  return autoLoopBusy ? 'autoloop' : 'stale'
})

function jumpToLatest(): void {
  if (currentSession.value) store.selectSession(currentSession.value.id)
}
</script>
