<template>
  <div v-if="isVisible" class="row items-center q-pa-xs q-px-sm bg-dark text-grey-5 text-caption">
    <q-spinner-dots size="14px" color="indigo-4" class="q-mr-sm" />
    <span>{{ t('agentBusy.banner') }}</span>
    <span v-if="runningSubagentCount > 0" class="q-ml-xs">
      — {{ t('agentBusy.subagentsRunning', { n: runningSubagentCount }, runningSubagentCount) }}
    </span>
    <template v-if="runningSubagentCount > 0">
      <q-space />
      <span
        class="text-indigo-4 cursor-pointer"
        style="text-decoration: underline;"
        @click="viewSubagents"
      >
        {{ t('agentBusy.viewSubagents') }}
      </span>
    </template>
  </div>
</template>

<script setup lang="ts">
import { useWorkspaceStore } from 'src/stores/workspace'
import { isBusyStatus, shouldWarnAgentNotRunning } from 'src/utils/workspace-status'
import { computed, inject } from 'vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
const store = useWorkspaceStore()
const openDrawerTab = inject<(tab: string) => void>('openDrawerTab')

const runningSubagentCount = computed(() => store.currentSubagents.filter((s) => s.status === 'running').length)

// Only show the banner when the workspace itself is busy. Orphaned sub-agents
// (status=running on a workspace that has already completed) shouldn't keep
// the banner up — they're a sign we missed a termination event, not that
// anything is actually running. The running count is still rendered inside
// the banner text when the banner IS visible (i.e. workspace busy + subs running).
//
// The `status` column can also lie outright (F05-class bug): it claims busy
// while the server's live controller registry has no matching controller.
// AgentLivenessChip.vue is the authority on liveness — reuse the same
// `shouldWarnAgentNotRunning` derivation so this banner never contradicts it.
// A liveness entry absent from `store.agentLiveness` means "confirmed no
// controller" only once `store.agentLivenessLoaded` says a read has
// completed for this workspace's current status (see
// `shouldWarnAgentNotRunning`'s doc comment) — never merely because the data
// hasn't loaded yet, e.g. right after a message flips `status` to busy over
// WebSocket while the liveness confirmation is still an HTTP round trip away.
const isVisible = computed(() => {
  const ws = store.selectedWorkspace
  if (!ws) return false
  if (!isBusyStatus(ws.status)) return false
  if (shouldWarnAgentNotRunning(ws.status, store.agentLivenessLoaded[ws.id] === true, ws.id in store.agentLiveness))
    return false
  return !store.isAgentTurnSettled(ws.id)
})

function viewSubagents() {
  openDrawerTab?.('subagents')
}
</script>
