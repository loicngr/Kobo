<script setup lang="ts">
import { useWorkspaceStore } from 'src/stores/workspace'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
const store = useWorkspaceStore()

const now = ref(Date.now())
let tickInterval: ReturnType<typeof setInterval> | null = null

onMounted(() => {
  tickInterval = setInterval(() => {
    now.value = Date.now()
  }, 1000)
})

onBeforeUnmount(() => {
  if (tickInterval) clearInterval(tickInterval)
})

const wakeup = computed(() => {
  const ws = store.selectedWorkspace
  if (!ws) return null
  return store.pendingWakeups[ws.id] ?? null
})

// Visible whenever a wakeup is pending — including while the agent is still
// running. The agent typically schedules a wake-up DURING a turn (e.g. "I'll
// check back in 5 minutes after the test run") so the user wants to see
// the countdown immediately, not only after the current session ends.
const isVisible = computed(() => {
  const ws = store.selectedWorkspace
  if (!ws) return false
  return !!wakeup.value
})

const remainingSeconds = computed(() => {
  if (!wakeup.value) return 0
  const delta = Math.ceil((new Date(wakeup.value.targetAt).getTime() - now.value) / 1000)
  return Math.max(0, delta)
})

const display = computed(() => {
  if (remainingSeconds.value === 0) return t('wakeup.firing')
  return t('wakeup.scheduledIn', { n: remainingSeconds.value })
})

function onCancel(): void {
  const ws = store.selectedWorkspace
  if (!ws) return
  void store.cancelPendingWakeup(ws.id)
}
</script>

<template>
  <div v-if="isVisible" class="row items-center q-pa-xs q-px-sm bg-dark text-grey-5 text-caption">
    <q-icon name="schedule" size="14px" color="amber-4" class="q-mr-sm" />
    <span>
      {{ display }}
      <q-tooltip v-if="wakeup?.reason" anchor="top middle" self="bottom middle" :offset="[0, 6]">
        {{ t('wakeup.reason', { reason: wakeup.reason }) }}
      </q-tooltip>
    </span>
    <q-space />
    <q-btn
      flat
      dense
      round
      size="xs"
      icon="close"
      color="grey-5"
      :aria-label="t('wakeup.cancel')"
      @click="onCancel"
    >
      <q-tooltip>{{ t('wakeup.cancel') }}</q-tooltip>
    </q-btn>
  </div>
</template>
