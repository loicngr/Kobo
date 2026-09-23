<template>
  <span v-if="liveness" class="agent-liveness agent-liveness--live">
    <template v-if="liveness.status === 'stopping'">{{ $t('workspacePage.agentStopping') }}</template>
    <template v-else>{{ $t('workspacePage.lastAgentEvent', { when: lastEventLabel }) }}</template>
  </span>
  <span v-else-if="isStale" class="agent-liveness agent-liveness--stale">
    <q-icon name="warning_amber" size="14px" />
    {{ $t('workspacePage.agentNotRunning') }}
  </span>
</template>

<script setup lang="ts">
import { type AgentLiveness, useWorkspaceStore } from 'src/stores/workspace'
import { useTimeAgo } from 'src/utils/formatters'
import { shouldWarnAgentNotRunning } from 'src/utils/workspace-status'
import { computed, onUnmounted, ref } from 'vue'

const props = defineProps<{ workspaceId: string; status: string }>()
const store = useWorkspaceStore()
const { timeAgo } = useTimeAgo()

const liveness = computed<AgentLiveness | null>(() => store.agentLiveness[props.workspaceId] ?? null)

// The column says "busy" but memory holds no controller: that is exactly the
// orphaned-workspace shape, and it used to be invisible from the UI. Shared
// with AgentBusyBanner.vue via `shouldWarnAgentNotRunning` so both surfaces
// agree on what "stale" means instead of each re-deriving it. Gated on
// `agentLivenessLoaded` so an unconfirmed liveness read (e.g. the HTTP
// round trip right after a WebSocket status flip) is never mistaken for a
// confirmed absence — see `shouldWarnAgentNotRunning`'s doc comment.
const isStale = computed(() =>
  shouldWarnAgentNotRunning(
    props.status,
    store.agentLivenessLoaded[props.workspaceId] === true,
    liveness.value !== null,
  ),
)

// `timeAgo` reads Date.now() and is therefore not reactive on its own — tick a
// ref so a silent agent's label keeps ageing on screen.
const nowTick = ref(Date.now())
const tickTimer = setInterval(() => {
  nowTick.value = Date.now()
}, 15_000)
onUnmounted(() => clearInterval(tickTimer))

const lastEventLabel = computed(() => {
  const live = liveness.value
  if (!live) return ''
  void nowTick.value
  return timeAgo(live.lastEventAt)
})
</script>

<style scoped lang="scss">
.agent-liveness {
  display: inline-flex;
  align-items: center;
  gap: var(--kobo-space-xs);
  font-size: 12px;
  white-space: nowrap;
}

.agent-liveness--live {
  color: var(--kobo-text-3);
}

.agent-liveness--stale {
  color: var(--kobo-warning);
}
</style>
