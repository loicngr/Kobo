<template>
  <q-dialog :model-value="modelValue" :persistent="loading" @update:model-value="emit('update:modelValue', $event)">
    <q-card class="handoff-card text-kobo-1">
      <q-card-section>
        <div class="text-h6">{{ $t(mode === 'fresh' ? 'handoff.freshTitle' : 'handoff.switchTitle') }}</div>
        <div class="text-body2 text-kobo-2 q-mt-xs">{{ $t('handoff.warning') }}</div>
      </q-card-section>
      <q-separator dark />
      <q-card-section>
        <div class="row q-col-gutter-sm q-mb-md">
          <div class="col-12 col-sm-6">
            <q-select v-model="engine" data-test="handoff-engine" :options="engineOptions" :label="$t('engine.select')" :disable="loading" emit-value map-options outlined dark dense />
          </div>
          <div class="col-12 col-sm-6">
            <q-select v-model="model" data-test="handoff-model" :options="modelOptions" :loading="nativeOptions.loading" :label="$t('engine.model')" :disable="loading" emit-value map-options outlined dark dense />
          </div>
          <div class="col-12 col-sm-6">
            <q-select v-model="reasoningEffort" :options="effortOptions" :loading="nativeOptions.loading" :label="$t('engine.effort')" :disable="loading" emit-value map-options outlined dark dense />
          </div>
          <div class="col-12 col-sm-6">
            <q-select v-model="agentPermissionMode" :options="permissionOptions" :label="$t('agentPermissionMode.label')" :disable="loading" emit-value map-options outlined dark dense />
          </div>
        </div>
        <div v-if="engine === 'mistral-vibe'" class="text-caption text-kobo-3 q-mb-sm">{{ $t('engine.mistralNativeHint') }}<div role="status">{{ nativeOptions.message }} <q-btn v-if="nativeOptions.message && !nativeOptions.loading" flat dense size="sm" :label="$t('common.retry')" @click="nativeOptions.refresh" /></div></div>
        <q-toggle v-model="generateSummary" :disable="loading || !canGenerateSummary" :label="$t('handoff.generate')" color="primary" dark />
        <div class="text-caption text-kobo-3 q-mt-xs">{{ $t(canGenerateSummary ? 'handoff.generateHint' : 'handoff.nativeHistoryHint') }}</div>
      </q-card-section>
      <q-card-actions align="right" class="q-pa-md">
        <q-btn flat no-caps :label="$t('common.cancel')" color="kobo-2" :disable="loading" @click="emit('update:modelValue', false)" />
        <q-btn data-test="handoff-submit" no-caps color="primary" :label="$t('handoff.start')" :loading="loading" :disable="loading || !model || !validPermissionMode" @click="submit" />
      </q-card-actions>
    </q-card>
  </q-dialog>
</template>

<script setup lang="ts">
import { useMistralOptions } from 'src/composables/use-mistral-options'
import { EFFORT_OPTION_DEFS_BY_ENGINE } from 'src/constants/efforts'
import { supportsReadOnly } from 'src/constants/engineFeatures'
import { MODEL_OPTION_DEFS_BY_ENGINE } from 'src/constants/models'
import { PERMISSION_MODES_BY_ENGINE } from 'src/constants/permissionModes'
import { useSettingsStore } from 'src/stores/settings'
import type { Workspace } from 'src/stores/workspace'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { HandoffConfiguration, SessionHandoffRequest } from '../../../shared/session-handoff'

const props = defineProps<{
  modelValue: boolean
  workspace: Workspace
  sourceSessionId: string | null
  mode: 'fresh' | 'switch'
  loading: boolean
}>()
const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void
  (e: 'submit', value: SessionHandoffRequest): void
}>()
const { t } = useI18n()
const settings = useSettingsStore()
const engine = ref('claude-code')
const model = ref('auto')
const reasoningEffort = ref('auto')
const agentPermissionMode = ref<HandoffConfiguration['agentPermissionMode']>('bypass')
const generateSummary = ref(true)
const canGenerateSummary = computed(() => supportsReadOnly(props.workspace.engine))
let capturedSourceSessionId: string | null = null
let requestId = ''
let requestFingerprint = ''
const engineOptions = computed(() => [
  { value: 'claude-code', label: t('workspacePage.engineClaude') },
  { value: 'codex', label: t('workspacePage.engineCodex') },
  { value: 'mistral-vibe', label: t('workspacePage.engineMistral') },
])
const nativeOptions = useMistralOptions(() => ({
  engine: engine.value,
  workspaceId: props.workspace.id,
  model: model.value,
  reasoningEffort: reasoningEffort.value,
  agentPermissionMode: agentPermissionMode.value,
  enabled: props.modelValue,
}))
const modelOptions = computed(() => {
  if (engine.value === 'mistral-vibe') return nativeOptions.models
  const options = (MODEL_OPTION_DEFS_BY_ENGINE[engine.value] ?? []).map((entry) => ({
    value: entry.value,
    label: t(entry.i18nLabelKey),
  }))
  if (props.workspace.engine === engine.value && !options.some((option) => option.value === props.workspace.model))
    options.push({ value: props.workspace.model, label: props.workspace.model })
  return options
})
const effortOptions = computed(() =>
  engine.value === 'mistral-vibe'
    ? nativeOptions.efforts
    : (EFFORT_OPTION_DEFS_BY_ENGINE[engine.value] ?? []).map((entry) => ({
        value: entry.value,
        label: t(entry.i18nLabelKey),
      })),
)
const permissionOptions = computed(() =>
  (PERMISSION_MODES_BY_ENGINE[engine.value] ?? []).map((value) => ({
    value,
    label: t(`agentPermissionMode.${value}`),
  })),
)
const validPermissionMode = computed(() =>
  permissionOptions.value.some((option) => option.value === agentPermissionMode.value),
)
watch(
  engine,
  () => {
    const current = props.workspace
    const configuredDefault = settings.global.defaultModelByEngine[engine.value]
    model.value =
      current.engine === engine.value
        ? current.model
        : (engine.value === 'mistral-vibe' && configuredDefault) ||
            modelOptions.value.some((option) => option.value === configuredDefault)
          ? configuredDefault!
          : 'auto'
    reasoningEffort.value = current.engine === engine.value ? current.reasoningEffort : 'auto'
    // Preserve unsupported Plan until the user explicitly selects a native execution mode.
  },
  { flush: 'sync' },
)
watch(
  [() => props.modelValue, () => props.workspace.id],
  ([open]) => {
    if (!open) return
    capturedSourceSessionId = props.sourceSessionId
    requestId = ''
    requestFingerprint = ''
    engine.value = props.workspace.engine
    model.value = props.workspace.model
    reasoningEffort.value = props.workspace.reasoningEffort
    agentPermissionMode.value = props.workspace.agentPermissionMode
    generateSummary.value = canGenerateSummary.value
  },
  { immediate: true },
)
function submit() {
  if (props.loading || !model.value || !validPermissionMode.value) return
  const input = {
    sourceSessionId: capturedSourceSessionId,
    generateSummary: canGenerateSummary.value && generateSummary.value,
    target: {
      engine: engine.value,
      model: model.value,
      reasoningEffort: reasoningEffort.value,
      agentPermissionMode: agentPermissionMode.value,
    },
  }
  const fingerprint = JSON.stringify(input)
  if (fingerprint !== requestFingerprint) {
    // getRandomValues also works on the optional HTTP LAN origin.
    requestId = Array.from(crypto.getRandomValues(new Uint32Array(4)), (value) => value.toString(16)).join('-')
    requestFingerprint = fingerprint
  }
  emit('submit', { ...input, requestId })
}
</script>

<style scoped>
.handoff-card {
  width: 720px;
  max-width: calc(100vw - 2 * var(--kobo-space-lg));
  background: var(--kobo-surface);
}
</style>
