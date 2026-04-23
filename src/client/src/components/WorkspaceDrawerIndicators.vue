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
</template>
