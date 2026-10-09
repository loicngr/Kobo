<template>
  <div class="final-review-settings">
    <q-toggle
      :model-value="!!modelValue" :disable="disabled || loading" color="primary"
      :label="t('autoLoop.finalReview.enabled')" @update:model-value="toggle"
    />
    <p class="text-caption text-kobo-3">{{ t('autoLoop.finalReview.hint') }}</p>
    <q-btn
      v-if="modelValue" flat dense no-caps :disable="disabled || loading"
      :label="t('autoLoop.finalReview.configure')" @click="open = true"
    />
    <StartReviewDialog
      v-model="open" mode="auto-loop" :loading="loading ?? false"
      :workspace="workspace" :scheduled-configuration="draftConfiguration ?? modelValue" :can-return-to-session="true"
      @submit="save"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { AutoLoopReviewConfiguration } from '../../../shared/auto-loop-review'
import type { ReviewConfiguration, StartReviewRequest } from '../../../shared/review'
import StartReviewDialog from './StartReviewDialog.vue'

const props = defineProps<{
  modelValue: AutoLoopReviewConfiguration | null
  workspace: ReviewConfiguration & { id: string }
  disabled?: boolean
  loading?: boolean
}>()
const emit = defineEmits<{ 'update:modelValue': [value: AutoLoopReviewConfiguration | null] }>()
const { t } = useI18n()
const open = ref(false)
const draftConfiguration = ref<AutoLoopReviewConfiguration | null>(null)
watch(
  () => props.modelValue,
  (value) => {
    if (JSON.stringify(value) === JSON.stringify(draftConfiguration.value)) draftConfiguration.value = null
  },
)
watch(
  () => props.workspace.id,
  () => {
    open.value = false
    draftConfiguration.value = null
  },
)
function toggle(enabled: boolean) {
  if (props.disabled || props.loading) return
  if (enabled) open.value = true
  else emit('update:modelValue', null)
}
function save(request: StartReviewRequest) {
  if (props.disabled || props.loading || !request.engine || !request.model || !request.reasoningEffort) return
  draftConfiguration.value = {
    engine: request.engine,
    model: request.model,
    reasoningEffort: request.reasoningEffort,
    additionalInstructions: request.additionalInstructions ?? '',
  }
  emit('update:modelValue', draftConfiguration.value)
  open.value = false
}
</script>

<style scoped>
.final-review-settings { padding-top: var(--kobo-space-sm); }
.final-review-settings p { margin: var(--kobo-space-xs) 0; }
</style>
