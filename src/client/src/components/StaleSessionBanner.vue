<template>
  <q-banner v-if="visible" class="bg-indigo-9 text-white q-ma-sm" rounded>
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
import { isBusyStatus } from 'src/utils/workspace-status'
import { computed } from 'vue'

const props = defineProps<{ workspaceId: string }>()
const store = useWorkspaceStore()

// Whatever spawned them, multiple sessions accumulate per workspace and the
// chat input sends to the *selected* session. Viewing an older one therefore
// risks resuming the wrong conversation without noticing. Warn on any
// non-latest session and offer a one-click jump to the current one.
const visible = computed<boolean>(() => {
  if (!store.selectedSessionId || store.sessions.length < 2) return false

  const latest = store.sessions[0]
  return !!latest && latest.id !== store.selectedSessionId
})

// Auto-loop has its own framing (the agent is actively working in the latest
// session); the manual case is a plain "you're not on the latest" caution.
const mode = computed<'autoloop' | 'stale'>(() => {
  const ws = store.workspaces.find((w) => w.id === props.workspaceId)
  const autoLoopBusy = !!ws && isBusyStatus(ws.status) && store.autoLoopStates[props.workspaceId]?.auto_loop === true
  return autoLoopBusy ? 'autoloop' : 'stale'
})

function jumpToLatest(): void {
  const latest = store.sessions[0]
  if (latest) store.selectSession(latest.id)
}
</script>
