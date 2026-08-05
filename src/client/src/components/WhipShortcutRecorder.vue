<template>
  <div class="whip-shortcut-recorder">
    <div class="text-caption text-grey-5 q-mb-xs">{{ t('settings.whipShortcut') }}</div>
    <div class="row items-center no-wrap q-gutter-xs">
      <q-btn
        data-testid="whip-shortcut-recorder"
        dense
        no-caps
        outline
        color="deep-orange-5"
        :aria-label="accessibleLabel"
        :aria-pressed="recording"
        @click="startRecording"
      >
        <span data-testid="whip-shortcut-value">{{ displayValue }}</span>
        <q-tooltip>{{ t('settings.whipShortcutHint') }}</q-tooltip>
      </q-btn>
      <q-btn
        data-testid="whip-shortcut-reset"
        dense
        flat
        round
        size="sm"
        color="grey-5"
        icon="restart_alt"
        :aria-label="t('settings.whipShortcutReset')"
        @click="resetShortcut"
      >
        <q-tooltip>{{ t('settings.whipShortcutReset') }}</q-tooltip>
      </q-btn>
    </div>
    <div v-if="recording" role="status" aria-live="polite" class="q-sr-only">
      {{ t('settings.whipShortcutRecording') }}
    </div>
    <div v-if="errorMessage" role="alert" class="text-negative text-caption q-mt-xs">{{ errorMessage }}</div>
  </div>
</template>

<script setup lang="ts">
import { captureWhipShortcut, detectWhipShortcutPlatform, formatWhipShortcut } from 'src/utils/whip-shortcut'
import { computed, onBeforeUnmount, ref } from 'vue'
import { useI18n } from 'vue-i18n'

const DEFAULT_WHIP_SHORTCUT = 'mod+shift+x'

const props = defineProps<{ modelValue: string }>()
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()
const { t } = useI18n()
const platform = detectWhipShortcutPlatform()
const recording = ref(false)
const errorMessage = ref('')

const displayValue = computed(() =>
  recording.value ? t('settings.whipShortcutRecording') : formatWhipShortcut(props.modelValue, platform),
)
const accessibleLabel = computed(() =>
  recording.value
    ? t('settings.whipShortcutRecordingLabel')
    : t('settings.whipShortcutButtonLabel', { shortcut: displayValue.value }),
)

function stopRecording(): void {
  if (!recording.value) return
  recording.value = false
  window.removeEventListener('keydown', onCaptureKeydown, true)
}

function onCaptureKeydown(event: KeyboardEvent): void {
  event.preventDefault()
  event.stopPropagation()
  const result = captureWhipShortcut(event, platform)

  if (result.status === 'pending') return
  if (result.status === 'reserved') {
    errorMessage.value = t('settings.whipShortcutReserved')
    return
  }
  errorMessage.value = ''
  if (result.status === 'accepted') emit('update:modelValue', result.shortcut)
  stopRecording()
}

function startRecording(): void {
  if (recording.value) return
  errorMessage.value = ''
  recording.value = true
  window.addEventListener('keydown', onCaptureKeydown, true)
}

function resetShortcut(): void {
  stopRecording()
  errorMessage.value = ''
  emit('update:modelValue', DEFAULT_WHIP_SHORTCUT)
}

onBeforeUnmount(stopRecording)
</script>

<style scoped>
.whip-shortcut-recorder {
  min-width: 180px;
}
</style>
