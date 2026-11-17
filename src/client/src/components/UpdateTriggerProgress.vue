<template>
  <div class="column q-gutter-xs">
    <q-linear-progress v-if="busy" indeterminate color="primary" :aria-label="$t('updateTrigger.dialogTitle')" />
    <!-- The live region stays in the DOM so that its text changes are announced. -->
    <div
      :role="live ? 'status' : undefined"
      :aria-live="live ? 'polite' : undefined"
      :class="warn ? 'text-warning' : 'text-kobo-2'"
      data-test="update-progress-text"
    >{{ text }}</div>
    <div v-if="trigger.step === 'reconnecting'" class="text-caption text-kobo-3">
      {{ $t('updateTrigger.signInAgain') }}
    </div>
    <div v-if="trigger.finished">
      <q-btn flat dense no-caps color="kobo-2" :label="$t('common.close')" data-test="update-dismiss" @click="dismiss" />
    </div>
  </div>
</template>
<script setup lang="ts">
import { useUpdateTriggerStore } from 'src/stores/update-trigger'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

withDefaults(defineProps<{ live?: boolean }>(), { live: true })
const emit = defineEmits<{ dismiss: [] }>()
const { t } = useI18n()
const trigger = useUpdateTriggerStore()

const busy = computed(() => trigger.step !== 'idle' && !trigger.finished)
const phase = computed(() => trigger.state?.status?.phase)
const warn = computed(
  () =>
    ['not-started', 'lost'].includes(trigger.step) ||
    (trigger.step === 'result' && ['refused', 'aborted', 'recovery-required'].includes(phase.value ?? '')),
)
const text = computed(() => (trigger.message ? t(trigger.message.key, trigger.message.params ?? {}) : ''))

function dismiss(): void {
  trigger.dismiss()
  emit('dismiss')
}
</script>
