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
    v-if="cronCount > 0"
    name="event_repeat"
    size="14px"
    color="cyan-4"
  >
    <q-tooltip>{{ t('cron.pendingIndicator', { n: cronCount }) }}</q-tooltip>
  </q-icon>
  <q-icon
    v-if="prSnapshot?.state === 'OPEN'"
    name="merge_type"
    size="14px"
    :color="prIconColor"
    class="cursor-pointer"
    @click.stop="openPr"
  >
    <q-tooltip>{{ prTooltip }}</q-tooltip>
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

<script setup lang="ts">
import { useDevServerStore } from 'src/stores/dev-server'
import type { Workspace } from 'src/stores/workspace'
import { useWorkspaceStore } from 'src/stores/workspace'
import { isChangesRequestedBlocking } from 'src/utils/pr-status'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps<{ workspace: Workspace }>()

const devServerStore = useDevServerStore()
const workspaceStore = useWorkspaceStore()
const { t } = useI18n()

const cronCount = computed(() => workspaceStore.autoLoopStates[props.workspace.id]?.crons_count ?? 0)

const prSnapshot = computed(() => workspaceStore.prSnapshots[props.workspace.id])
const prIconColor = computed(() => {
  const s = prSnapshot.value
  if (!s) return 'green-5'
  return isChangesRequestedBlocking(s) ? 'red-5' : 'green-5'
})
const prTooltip = computed(() => {
  const s = prSnapshot.value
  if (!s) return ''
  if (isChangesRequestedBlocking(s)) {
    return t('workspaceList.prChangesRequested', { n: s.number })
  }
  return t('workspaceList.prOpen', { n: s.number })
})

function openPr(): void {
  const url = prSnapshot.value?.url
  if (url) window.open(url, '_blank', 'noopener,noreferrer')
}
</script>

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

/* Dev-server "running" indicator — 6px green dot with a soft glow.
   Defined here (not in WorkspaceList.vue) so the scoped CSS reaches
   the actual DOM node rendered by THIS component. */
.dd-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}
.dd-dot--running {
  background-color: #22c55e;
  box-shadow: 0 0 4px rgba(34, 197, 94, 0.5);
}
</style>
