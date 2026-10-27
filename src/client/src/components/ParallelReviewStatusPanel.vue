<template>
  <section v-if="status && !dismissed" class="parallel-review-panel text-caption" :aria-label="t('parallelReview.title')">
    <div class="row items-center justify-between">
      <strong>{{ t('parallelReview.title') }}</strong>
      <q-btn v-if="terminal" flat dense no-caps size="sm" data-test="parallel-review-close" :label="t('common.close')" @click="dismiss" />
    </div>
    <p role="status">{{ t(`parallelReview.${status.phase}`) }} <span v-if="pendingInput">{{ t('parallelReview.awaitingInput') }}</span></p>
    <p v-if="statusError">{{ statusError }}</p>
    <div class="row q-gutter-sm">
      <q-btn flat dense no-caps size="sm" :label="t('parallelReview.open')" @click="openReview" />
      <q-btn v-if="['reviewing', 'closing'].includes(status.phase)" flat dense no-caps size="sm" :disable="busy" :label="t('parallelReview.stop')" @click="act('stop')" />
      <template v-if="status.returnToSession && ['ready', 'blocked', 'unknown'].includes(status.phase)">
        <q-btn flat dense no-caps size="sm" :disable="busy" :label="t(status.phase === 'unknown' ? 'reviewReturn.retryUnknown' : 'reviewReturn.retry')" @click="act('retry-return')" />
        <q-btn flat dense no-caps size="sm" :disable="busy" :label="t('reviewReturn.cancel')" @click="act('cancel-return')" />
      </template>
    </div>
    <p v-if="error" role="alert" class="text-negative">{{ error }}</p>
  </section>
</template>
<script setup lang="ts">
import { useParallelReviewStore } from 'src/stores/parallel-review'
import { useWorkspaceStore } from 'src/stores/workspace'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps<{ workspaceId: string }>()
const reviews = useParallelReviewStore()
const workspaces = useWorkspaceStore()
const { t } = useI18n()
const status = computed(() => reviews.statuses[props.workspaceId])
const terminal = computed(() => status.value?.phase === 'completed' || status.value?.phase === 'interrupted')
const dismissalKey = computed(() => `kobo:dismissed-parallel-review:${props.workspaceId}`)
const dismissedSessionId = ref<string | null>(null)
const dismissed = computed(() => terminal.value && dismissedSessionId.value === status.value?.reviewSessionId)
const statusError = computed(() =>
  status.value?.phase === 'interrupted' && status.value.error === 'Review did not complete'
    ? null
    : status.value?.error,
)
const pendingInput = computed(
  () => status.value && workspaces.peekPending(props.workspaceId, status.value.reviewSessionId),
)
const busy = ref(false)
const error = ref('')
let generation = 0
watch(
  () => [props.workspaceId, status.value?.reviewSessionId],
  () => {
    generation++
    busy.value = false
    error.value = ''
  },
)
watch(
  () => props.workspaceId,
  (id) => {
    try {
      dismissedSessionId.value = localStorage.getItem(dismissalKey.value)
    } catch {
      dismissedSessionId.value = null
    }
    if (id) void reviews.fetchStatus(id).catch(() => {})
  },
  { immediate: true },
)
function dismiss() {
  if (!terminal.value || !status.value) return
  dismissedSessionId.value = status.value.reviewSessionId
  try {
    localStorage.setItem(dismissalKey.value, dismissedSessionId.value)
  } catch {
    // The dismissal still applies for the current view.
  }
}
function openReview() {
  if (status.value && workspaces.selectedWorkspaceId === props.workspaceId)
    workspaces.selectSession(status.value.reviewSessionId)
}
async function act(action: 'stop' | 'retry-return' | 'cancel-return') {
  const review = status.value
  if (!review || busy.value) return
  const current = generation
  busy.value = true
  error.value = ''
  try {
    await reviews.act(props.workspaceId, review.reviewSessionId, action)
  } catch (cause) {
    if (generation === current) error.value = cause instanceof Error ? cause.message : t('reviewReturn.actionFailed')
  } finally {
    if (generation === current) busy.value = false
  }
}
</script>
<style scoped>
.parallel-review-panel {
  padding: var(--kobo-space-sm);
  color: var(--kobo-text-2);
  border-bottom: 1px solid var(--kobo-border-subtle);
}
.parallel-review-panel p { margin: var(--kobo-space-xs) 0; }
</style>
