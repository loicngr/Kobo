<script setup lang="ts">
import { useDevServerStore } from 'src/stores/dev-server'
import type { Workspace } from 'src/stores/workspace'
import { useWorkspaceStore } from 'src/stores/workspace'
import { useI18n } from 'vue-i18n'

defineProps<{ workspace: Workspace }>()

const devServerStore = useDevServerStore()
const workspaceStore = useWorkspaceStore()
const { t } = useI18n()
</script>

<template>
  <div
    v-if="devServerStore.getStatus(workspace.id)?.status === 'running'"
    class="dd-dot dd-dot--running"
  />
  <q-icon
    v-if="workspaceStore.pendingWakeups[workspace.id]"
    name="schedule"
    size="14px"
    color="amber-4"
  >
    <q-tooltip>{{ t('wakeup.pendingIndicator') }}</q-tooltip>
  </q-icon>
  <q-icon
    v-if="workspaceStore.prStates[workspace.id] === 'OPEN'"
    name="merge_type"
    size="14px"
    color="green-5"
  >
    <q-tooltip>{{ t('workspaceList.prOpen') }}</q-tooltip>
  </q-icon>
  <q-icon
    v-if="workspaceStore.autoLoopStates[workspace.id]?.auto_loop"
    name="autorenew"
    size="14px"
    :color="workspaceStore.autoLoopStates[workspace.id]?.auto_loop_ready ? 'amber-4' : 'indigo-4'"
    class="auto-loop-spin"
  >
    <q-tooltip>
      {{ workspaceStore.autoLoopStates[workspace.id]?.auto_loop_ready ? t('autoLoop.running') : t('autoLoop.preparing') }}
    </q-tooltip>
  </q-icon>
</template>

<style scoped lang="scss">
/* Custom CSS is allowed here because Quasar has no built-in "spin icon"
   helper and the rotation is what signals "live work in progress" at a
   glance. Scoped so no leakage. */
.auto-loop-spin {
  animation: auto-loop-spin 2s linear infinite;
}
@keyframes auto-loop-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
</style>
