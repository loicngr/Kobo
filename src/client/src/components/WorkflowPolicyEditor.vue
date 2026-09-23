<template>
  <section class="q-mb-md" :aria-label="$t('workflow.title')">
    <div class="text-subtitle2 q-mb-xs">{{ $t('workflow.title') }}</div>
    <p class="text-caption">{{ $t('workflow.hint') }}</p>
    <q-select v-for="action in WORKFLOW_ACTIONS" :key="action" class="q-mb-sm" outlined dense
      :label="$t(`workflow.${action}`)" :model-value="modelValue[action] ?? ''" :options="options"
      emit-value map-options @update:model-value="update(action, $event)" />
  </section>
</template>
<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  WORKFLOW_ACTIONS,
  type WorkflowAction,
  type WorkflowMode,
  type WorkflowPolicy,
} from '../../../shared/workflow-policy'

const props = defineProps<{ modelValue: Partial<WorkflowPolicy>; inherit?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [value: Partial<WorkflowPolicy>] }>()
const { t } = useI18n()
const options = computed(() => [
  ...(props.inherit ? [{ label: t('workflow.inherit'), value: '' }] : []),
  { label: t('workflow.manual'), value: 'manual' },
  { label: t('workflow.automatic'), value: 'automatic' },
])
function update(action: WorkflowAction, value: WorkflowMode | '') {
  const policy = { ...props.modelValue }
  if (value) policy[action] = value
  else delete policy[action]
  emit('update:modelValue', policy)
}
</script>
