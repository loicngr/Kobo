<template>
  <q-dialog :model-value="modelValue" :persistent="loading" @update:model-value="emit('update:modelValue', $event)">
    <q-card class="review-card text-kobo-1">
      <q-card-section>
        <div class="text-h6">{{ $t(scheduled ? 'autoLoop.finalReview.title' : 'review.title') }}</div>
        <div class="text-body2 text-kobo-2 q-mt-xs">{{ $t(scheduled ? 'autoLoop.finalReview.description' : 'review.subtitle') }}</div>
      </q-card-section>

      <q-separator dark />

      <q-card-section class="q-pt-md">
        <div class="row q-col-gutter-sm q-mb-md">
          <div class="col-12 col-sm-6">
            <q-select v-model="engine" :options="engineOptions" :label="$t('engine.select')" :disable="loading" emit-value map-options outlined dark dense />
          </div>
          <div class="col-12 col-sm-6">
            <q-select v-model="model" :options="modelOptions" :label="$t('engine.model')" :disable="loading" emit-value map-options outlined dark dense />
          </div>
          <div class="col-12 col-sm-6">
            <q-select v-model="reasoningEffort" :options="effortOptions" :label="$t('engine.effort')" :disable="loading" emit-value map-options outlined dark dense />
          </div>
          <div class="col-12 col-sm-6">
            <q-select
              :model-value="effectivePermissionMode"
              :options="permissionOptions"
              :label="$t('agentPermissionMode.label')"
              :disable="loading || returnToSession"
              emit-value
              map-options
              outlined
              dark
              dense
              @update:model-value="agentPermissionMode = $event"
            />
            <div v-if="returnToSession" class="text-caption text-kobo-3 q-mt-xs">{{ $t('review.readOnlyForced') }}</div>
          </div>
        </div>
        <q-input
          v-model="additionalInstructions"
          type="textarea"
          :disable="loading"
          :label="$t('review.additionalInstructions')"
          :placeholder="$t('review.additionalInstructionsPlaceholder')"
          :rows="4"
          outlined
          dark
          color="primary"
        />
      </q-card-section>

      <q-card-section v-if="!scheduled" class="q-pt-none">
        <q-toggle v-model="newSession" :disable="loading || forceNewSession" :label="$t('review.newSession')" color="primary" dark />
        <div class="text-caption text-kobo-3 q-mt-xs">{{ $t(forceNewSession ? 'review.newSessionRequired' : 'review.newSessionHint') }}</div>
        <template v-if="newSession">
          <q-toggle v-model="returnToSession" :disable="loading || !canReturnToSession" :label="$t('review.returnToSession')" color="primary" dark class="q-mt-md" />
          <div class="text-caption text-kobo-3 q-mt-xs">{{ $t(canReturnToSession ? 'review.returnToSessionHint' : 'review.returnUnavailable') }}</div>
        </template>
      </q-card-section>

      <q-card-actions align="right" class="q-pa-md">
        <q-btn flat no-caps :label="$t('review.cancel')" color="kobo-2" :disable="loading" @click="cancel" />
        <q-btn
          no-caps
          color="primary"
          :label="$t(scheduled ? 'autoLoop.finalReview.save' : 'review.start')"
          :loading="loading"
          :disable="!workspace || loading"
          @click="submit"
        />
      </q-card-actions>
    </q-card>
  </q-dialog>
</template>

<script setup lang="ts">
import { EFFORT_OPTION_DEFS_BY_ENGINE } from 'src/constants/efforts'
import { MODEL_OPTION_DEFS_BY_ENGINE } from 'src/constants/models'
import { PERMISSION_MODES_BY_ENGINE } from 'src/constants/permissionModes'
import { useSettingsStore } from 'src/stores/settings'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { AutoLoopReviewConfiguration } from '../../../shared/auto-loop-review'
import { type ReviewConfiguration, reviewConfigurationChanged, type StartReviewRequest } from '../../../shared/review'

const props = defineProps<{
  modelValue: boolean
  loading: boolean
  workspace: (ReviewConfiguration & { id: string }) | null
  canReturnToSession: boolean
  currentSession?: { engine?: string | null; model?: string | null } | null
  mode?: 'immediate' | 'auto-loop'
  scheduledConfiguration?: AutoLoopReviewConfiguration | null
}>()
const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void
  (e: 'submit', v: StartReviewRequest): void
}>()
const { t } = useI18n()
const settings = useSettingsStore()
const scheduled = computed(() => props.mode === 'auto-loop')
const additionalInstructions = ref('')
const requestedNewSession = ref(false)
const returnToSession = ref(false)
const engine = ref('claude-code')
const model = ref('auto')
const reasoningEffort = ref('auto')
const agentPermissionMode = ref<ReviewConfiguration['agentPermissionMode']>('bypass')
// A review that returns to the original session always runs read-only (the
// server enforces it too); the user's choice is kept for when the return is off.
const effectivePermissionMode = computed<ReviewConfiguration['agentPermissionMode']>(() =>
  scheduled.value || returnToSession.value ? 'plan' : agentPermissionMode.value,
)
const configuration = computed<ReviewConfiguration>(() => ({
  engine: engine.value,
  model: model.value,
  reasoningEffort: reasoningEffort.value,
  agentPermissionMode: effectivePermissionMode.value,
}))
const forceNewSession = computed(() => {
  const current = props.currentSession
  return (
    scheduled.value ||
    returnToSession.value ||
    (!!props.workspace && reviewConfigurationChanged(configuration.value, props.workspace)) ||
    (!!current?.engine && current.engine !== engine.value) ||
    (model.value !== 'auto' && !!current?.model && current.model !== model.value)
  )
})
const newSession = computed({
  get: () => requestedNewSession.value || forceNewSession.value,
  set: (value: boolean) => {
    requestedNewSession.value = value
  },
})
const engineOptions = computed(() => [
  { value: 'claude-code', label: t('workspacePage.engineClaude') },
  { value: 'codex', label: t('workspacePage.engineCodex') },
])
const modelOptions = computed(() => {
  const options = (MODEL_OPTION_DEFS_BY_ENGINE[engine.value] ?? []).map((d) => ({
    value: d.value,
    label: t(d.i18nLabelKey),
  }))
  // Existing custom models remain usable without adding them to the global catalogue.
  if (props.workspace?.engine === engine.value && !options.some((o) => o.value === props.workspace?.model))
    options.push({ value: props.workspace.model, label: props.workspace.model })
  const saved = props.scheduledConfiguration
  if (saved?.engine === engine.value && !options.some((o) => o.value === saved.model))
    options.push({ value: saved.model, label: saved.model })
  return options
})
const effortOptions = computed(() =>
  (EFFORT_OPTION_DEFS_BY_ENGINE[engine.value] ?? []).map((d) => ({ value: d.value, label: t(d.i18nLabelKey) })),
)
const permissionOptions = computed(() =>
  (PERMISSION_MODES_BY_ENGINE[engine.value] ?? []).map((value) => ({
    value,
    label: t(`agentPermissionMode.${value}`),
  })),
)
watch(
  engine,
  () => {
    const current = props.workspace
    const configuredDefault = settings.global.defaultModelByEngine[engine.value]
    model.value =
      current?.engine === engine.value
        ? current.model
        : modelOptions.value.some((o) => o.value === configuredDefault)
          ? configuredDefault!
          : 'auto'
    reasoningEffort.value = current?.engine === engine.value ? current.reasoningEffort : 'auto'
    if (!permissionOptions.value.some((o) => o.value === agentPermissionMode.value)) agentPermissionMode.value = 'plan'
  },
  { flush: 'sync' },
)
watch(
  [() => props.modelValue, () => props.workspace?.id],
  ([open]) => {
    if (!open) return
    const saved = scheduled.value ? props.scheduledConfiguration : null
    additionalInstructions.value = saved?.additionalInstructions ?? ''
    requestedNewSession.value = false
    returnToSession.value = scheduled.value
    if (props.workspace) {
      engine.value = props.workspace.engine
      model.value = props.workspace.model
      reasoningEffort.value = props.workspace.reasoningEffort
      agentPermissionMode.value = props.workspace.agentPermissionMode
    }
    if (saved) {
      engine.value = saved.engine
      model.value = saved.model
      reasoningEffort.value = saved.reasoningEffort
    }
  },
  { immediate: true },
)
watch(
  () => props.canReturnToSession,
  (allowed) => {
    if (!allowed && !scheduled.value) returnToSession.value = false
  },
)
function cancel() {
  if (!props.loading) emit('update:modelValue', false)
}
function submit() {
  if (props.loading || !props.workspace) return
  emit('submit', {
    ...configuration.value,
    additionalInstructions: additionalInstructions.value,
    newSession: newSession.value,
    returnToSession: scheduled.value || (returnToSession.value && props.canReturnToSession),
  })
}
</script>

<style scoped>
.review-card {
  width: 720px;
  max-width: calc(100vw - 2 * var(--kobo-space-lg));
  background: var(--kobo-surface);
}
</style>
