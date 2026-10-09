<template>
  <section v-if="status" data-tour="ws-review-return" class="review-return-panel text-caption" :aria-label="t('reviewReturn.title')">
    <strong>{{ t('reviewReturn.title') }}</strong>
    <p role="status">{{ t(`reviewReturn.${status.phase}`) }}</p>
    <p v-if="status.error">{{ status.error }}</p>
    <div v-if="needsAttention" class="review-return-panel__actions">
      <q-btn
        flat dense no-caps size="sm" data-test="review-return-retry" :disable="busy"
        :label="t(status.phase === 'unknown' ? 'reviewReturn.retryUnknown' : 'reviewReturn.retry')"
        @click="resolve('retry')"
      />
      <q-btn
        flat dense no-caps size="sm" data-test="review-return-cancel" :disable="busy"
        :label="t('reviewReturn.cancel')" @click="resolve('cancel')"
      />
    </div>
    <p v-if="error" role="alert" class="review-return-panel__error">{{ error }}</p>
  </section>
</template>

<script setup lang="ts">
import { useAutoLoopReviewStore } from 'src/stores/auto-loop-review'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps<{ workspaceId: string }>()
const store = useAutoLoopReviewStore()
const { t } = useI18n()
const status = computed(() => store.returns[props.workspaceId])
const needsAttention = computed(() => status.value?.phase === 'unknown' || status.value?.phase === 'blocked')
const busy = ref(false)
const error = ref('')
let generation = 0
watch(
  () => props.workspaceId,
  (id) => {
    generation++
    busy.value = false
    error.value = ''
    // A failed load is not evidence of a pending review. Reconnect refreshes it.
    if (id) void store.fetchReturn(id).catch(() => {})
  },
  { immediate: true },
)

async function resolve(action: 'retry' | 'cancel') {
  if (busy.value || !needsAttention.value) return
  const current = generation
  busy.value = true
  error.value = ''
  try {
    await store.resolveReturn(props.workspaceId, action)
  } catch (cause) {
    if (current === generation) error.value = cause instanceof Error ? cause.message : t('reviewReturn.actionFailed')
  } finally {
    if (current === generation) busy.value = false
  }
}
</script>

<style scoped>
.review-return-panel {
  padding: var(--kobo-space-sm);
  color: var(--kobo-text-2);
  border-bottom: 1px solid var(--kobo-border-subtle);
}
.review-return-panel p { margin: var(--kobo-space-xs) 0; }
.review-return-panel__actions { display: flex; flex-wrap: wrap; gap: var(--kobo-space-sm); }
.review-return-panel__error { color: var(--kobo-danger); }
</style>
