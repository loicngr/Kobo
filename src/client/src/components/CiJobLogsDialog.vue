<template>
  <q-dialog :model-value="true" maximized @update:model-value="value => { if (!value) emit('close') }">
    <q-card class="ci-logs column text-kobo-1">
      <q-card-section class="row items-center q-gutter-sm">
        <div class="col ellipsis">{{ jobName }}</div>
        <q-btn flat round icon="open_in_new" :href="url" target="_blank" rel="noopener noreferrer" :aria-label="t('git.ciLogs.external')"><q-tooltip>{{ t('git.ciLogs.external') }}</q-tooltip></q-btn>
        <q-btn flat round icon="refresh" :loading="loading" :aria-label="t('tooltip.refreshLogs')" @click="retry" />
        <q-btn flat round icon="close" :aria-label="t('tooltip.closeDialog')" @click="emit('close')" />
      </q-card-section>
      <q-separator dark />
      <q-card-section class="q-py-sm">
        <div class="text-caption text-kobo-3">{{ t('git.ciLogs.notice') }}</div>
        <q-select v-model="step" :options="stepOptions" emit-value map-options dense outlined :label="t('git.ciLogs.step')" class="q-mt-sm">
          <template #option="{ itemProps, opt }">
            <q-item v-bind="itemProps">
              <q-item-section v-if="opt.icon" avatar><q-icon :name="opt.icon" :color="opt.color" /></q-item-section>
              <q-item-section><q-item-label>{{ opt.name || opt.label }}<span v-if="opt.state" :class="'text-' + opt.color"> · {{ opt.state }}</span></q-item-label></q-item-section>
            </q-item>
          </template>
          <template #selected-item="{ opt }">
            <span class="row items-center no-wrap q-gutter-xs">
              <q-icon v-if="opt.icon" :name="opt.icon" :color="opt.color" />
              <span>{{ opt.name || opt.label }}<span v-if="opt.state" :class="'text-' + opt.color"> · {{ opt.state }}</span></span>
            </span>
          </template>
        </q-select>
        <div v-if="data" :class="'text-' + ciStepAppearance(data.status, data.conclusion).color" class="text-caption q-mt-sm">{{ data.status }}<span v-if="data.conclusion"> · {{ data.conclusion }}</span></div>
        <div v-if="error" role="alert" class="text-negative q-mt-sm">{{ t('git.ciLogs.error') }}</div>
        <div v-if="retryStopped" role="status" class="text-warning text-caption">{{ t('git.ciLogs.retryStopped') }}</div>
        <div v-if="data?.truncated" class="text-warning text-caption">{{ t('git.ciLogs.truncated') }}</div>
        <q-checkbox v-model="follow" dense :label="t('git.ciLogs.follow')" class="q-mt-sm" />
      </q-card-section>
      <div ref="logElement" class="col scroll q-pa-md" :aria-busy="loading">
        <pre v-if="data?.logs" class="ci-logs__text"><span v-for="(span, index) in logSpans" :key="index" :style="span.style">{{ span.text }}</span></pre>
        <pre v-else-if="!error" class="ci-logs__text">{{ loading ? t('common.loading') : t('git.ciLogs.unavailable') }}</pre>
      </div>
    </q-card>
  </q-dialog>
</template>

<script setup lang="ts">
import { apiFetch } from 'src/utils/api'
import { ciLogSpans, ciStepAppearance } from 'src/utils/ci-log-format'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { CiJobLogs } from '../../../shared/ci-job-logs'

const props = defineProps<{ workspaceId: string; url: string; jobName: string }>()
const emit = defineEmits<{ close: [] }>()
const { t } = useI18n()
const data = ref<CiJobLogs | null>(null)
const step = ref<number | null>(null)
const loading = ref(false)
const error = ref(false)
const retryStopped = ref(false)
let retryCount = 0
const follow = ref(true)
const logElement = ref<HTMLElement | null>(null)
const logSpans = computed(() => ciLogSpans(data.value?.logs ?? ''))
const stepOptions = computed(() => [
  { label: t('git.ciLogs.all'), value: null },
  ...(data.value?.steps ?? []).map((item) => ({
    label: `${item.number}. ${item.name} · ${item.conclusion || item.status}`,
    value: item.number,
    name: `${item.number}. ${item.name}`,
    state: item.conclusion || item.status,
    ...ciStepAppearance(item.status, item.conclusion),
  })),
])
let controller: AbortController | null = null
let timer: ReturnType<typeof setTimeout> | undefined
let disposed = false

async function refresh() {
  if (disposed || loading.value || document.hidden) return
  clearTimeout(timer)
  const request = new AbortController()
  controller = request
  loading.value = true
  error.value = false
  try {
    const query = new URLSearchParams({ url: props.url })
    if (step.value !== null) query.set('step', String(step.value))
    const result = await apiFetch<CiJobLogs>(
      `/api/workspaces/${encodeURIComponent(props.workspaceId)}/ci-job-logs?${query}`,
      { signal: request.signal },
    )
    if (controller !== request || disposed) return
    data.value = result
    await nextTick()
    if (controller === request && follow.value && logElement.value)
      logElement.value.scrollTop = logElement.value.scrollHeight
  } catch {
    if (controller === request && !disposed) error.value = true
  } finally {
    if (controller === request && !disposed) {
      loading.value = false
      const waitingForLogs = data.value?.status === 'completed' && !data.value.available
      if (error.value || waitingForLogs) retryCount++
      else retryCount = 0
      retryStopped.value = retryCount >= 6
      if (!retryStopped.value && (error.value || waitingForLogs || data.value?.status !== 'completed'))
        timer = setTimeout(() => void refresh(), Math.min(30_000, Math.max(1, retryCount) * 10_000))
    }
  }
}
function retry() {
  retryCount = 0
  retryStopped.value = false
  void refresh()
}
function reset(keepSteps = false) {
  clearTimeout(timer)
  controller?.abort()
  controller = null
  loading.value = false
  data.value = keepSteps && data.value ? { ...data.value, logs: '', truncated: false } : null
  retry()
}
watch(step, () => reset(true))
watch(
  () => [props.workspaceId, props.url],
  () => {
    step.value = null
    reset()
  },
)
function onVisibility() {
  if (!document.hidden) void refresh()
  else clearTimeout(timer)
}
onMounted(() => {
  document.addEventListener('visibilitychange', onVisibility)
  void refresh()
})
onBeforeUnmount(() => {
  disposed = true
  clearTimeout(timer)
  controller?.abort()
  document.removeEventListener('visibilitychange', onVisibility)
})
</script>

<style scoped>
.ci-logs { background: var(--kobo-surface); }
.ci-logs__text { margin: 0; font-family: var(--kobo-font-mono); white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
