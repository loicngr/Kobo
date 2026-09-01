<template>
  <q-btn no-caps dense outline color="primary" icon="swap_horiz" :label="$t('workspacePage.switchEngine')" :disable="workspace.archivedAt !== null" class="full-width q-mb-xs" @click="open">
    <q-tooltip>{{ $t('workspacePage.switchEngineHint') }}</q-tooltip>
  </q-btn>
  <q-dialog v-model="isOpen" persistent>
    <q-card dark class="engine-switch-card">
      <q-card-section class="row items-start q-pb-sm"><div class="col"><div class="text-subtitle1">{{ $t('workspacePage.switchEngineTitle') }}</div><div class="text-caption text-kobo-2 q-mt-xs">{{ $t('workspacePage.switchEngineWarning') }}</div></div><q-btn flat round dense icon="close" :disable="switching" @click="isOpen = false" /></q-card-section>
      <q-card-section class="q-pt-none">
        <div class="row q-col-gutter-sm">
          <div class="col-12"><q-select v-model="engineId" :options="engineOptions" emit-value map-options dark dense outlined :label="$t('workspacePage.engineLabel')" /></div>
          <div class="col-12 col-sm-4 flex"><q-select v-model="model" :options="modelOptions" emit-value map-options dark dense outlined class="engine-switch-field full-width" :label="$t('engine.model')" /></div>
          <div class="col-12 col-sm-4 flex"><q-select v-model="effort" :options="effortOptions" emit-value map-options dark dense outlined class="engine-switch-field full-width" :label="$t('engine.effort')" /></div>
          <div class="col-12 col-sm-4 flex"><q-select v-model="permissionMode" :options="permissionOptions" emit-value map-options dark dense outlined class="engine-switch-field full-width" :label="$t('agentPermissionMode.label')" /></div>
        </div>
        <q-expansion-item default-opened dense dense-toggle icon="description" :label="$t('workspacePage.engineHandoff')" header-class="text-kobo-1">
          <q-spinner v-if="handoffLoading" size="20px" color="primary" class="q-ma-sm" />
          <q-input v-else v-model="handoff" type="textarea" autogrow dark outlined class="q-mt-xs" :hint="$t('workspacePage.engineHandoffHint')" />
        </q-expansion-item>
      </q-card-section>
      <q-card-actions align="right"><q-btn flat :label="$t('common.cancel')" :disable="switching" @click="isOpen = false" /><q-btn color="primary" :label="$t('workspacePage.confirmSwitchEngine')" :loading="switching" :disable="handoffLoading || !handoff.trim()" @click="confirm" /></q-card-actions>
    </q-card>
  </q-dialog>
</template>

<script setup lang="ts">
import { useQuasar } from 'quasar'
import { EFFORT_OPTION_DEFS_BY_ENGINE } from 'src/constants/efforts'
import { MODEL_OPTION_DEFS, MODEL_OPTION_DEFS_BY_ENGINE } from 'src/constants/models'
import { PERMISSION_MODES_BY_ENGINE } from 'src/constants/permissionModes'
import { useWorkspaceStore, type Workspace } from 'src/stores/workspace'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

type AgentPermissionModeValue = 'plan' | 'bypass' | 'strict' | 'interactive'
const props = defineProps<{ workspace: Workspace }>()
const store = useWorkspaceStore()
const $q = useQuasar()
const { t } = useI18n()
const isOpen = ref(false)
const switching = ref(false)
const handoffLoading = ref(false)
const engineId = ref('codex')
const model = ref('')
const effort = ref('auto')
const permissionMode = ref<AgentPermissionModeValue>('plan')
const handoff = ref('')
const engineOptions = computed(() => [
  { value: 'claude-code', label: t('workspacePage.engineClaude'), disable: props.workspace.engine === 'claude-code' },
  { value: 'codex', label: t('workspacePage.engineCodex'), disable: props.workspace.engine === 'codex' },
])
const modelOptions = computed(() =>
  (MODEL_OPTION_DEFS_BY_ENGINE[engineId.value] ?? MODEL_OPTION_DEFS).map((option) => ({
    label: t(option.i18nLabelKey),
    value: option.value,
  })),
)
const effortOptions = computed(() =>
  (EFFORT_OPTION_DEFS_BY_ENGINE[engineId.value] ?? EFFORT_OPTION_DEFS_BY_ENGINE['claude-code']).map((option) => ({
    label: t(option.i18nLabelKey),
    value: option.value,
  })),
)
const permissionOptions = computed(() =>
  (PERMISSION_MODES_BY_ENGINE[engineId.value] ?? PERMISSION_MODES_BY_ENGINE['claude-code']).map((value) => ({
    label: t(`agentPermissionMode.${value}`),
    value,
  })),
)
function resetOptions() {
  model.value = modelOptions.value[0]?.value ?? ''
  effort.value = 'auto'
  permissionMode.value = (permissionOptions.value[0]?.value ?? 'plan') as AgentPermissionModeValue
}
async function loadHandoff() {
  if (engineId.value === props.workspace.engine) return
  handoffLoading.value = true
  try {
    handoff.value = await store.previewEngineHandoff(props.workspace.id, engineId.value)
  } catch (error) {
    $q.notify({
      type: 'negative',
      message: error instanceof Error ? error.message : t('workspacePage.switchEngineFailed'),
      position: 'top',
    })
  } finally {
    handoffLoading.value = false
  }
}
function open() {
  engineId.value = props.workspace.engine === 'claude-code' ? 'codex' : 'claude-code'
  resetOptions()
  handoff.value = ''
  isOpen.value = true
  void loadHandoff()
}
async function confirm() {
  switching.value = true
  try {
    const result = await store.switchEngine(props.workspace.id, {
      engine: engineId.value,
      model: model.value,
      reasoningEffort: effort.value,
      agentPermissionMode: permissionMode.value,
      handoff: handoff.value,
    })
    store.selectSession(result.sessionId)
    isOpen.value = false
  } catch (error) {
    $q.notify({
      type: 'negative',
      message: error instanceof Error ? error.message : t('workspacePage.switchEngineFailed'),
      position: 'top',
    })
  } finally {
    switching.value = false
  }
}
watch(engineId, () => {
  resetOptions()
  if (isOpen.value) void loadHandoff()
})
</script>

<style scoped lang="scss">
.engine-switch-card { width: min(720px, calc(100vw - 32px)); }
.engine-switch-field :deep(.q-field__control) { min-height: 42px; }
</style>
