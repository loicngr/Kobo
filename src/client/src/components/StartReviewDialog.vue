<template>
  <q-dialog :model-value="modelValue" @update:model-value="emit('update:modelValue', $event)">
    <q-card class="text-kobo-1" style="min-width: 480px; background: var(--kobo-surface);">
      <q-card-section>
        <div class="text-h6">{{ $t('review.title') }}</div>
        <div class="text-body2 text-kobo-2 q-mt-xs">{{ $t('review.subtitle') }}</div>
      </q-card-section>

      <q-separator dark />

      <q-card-section class="q-pt-md">
        <q-input
          v-model="additionalInstructions"
          type="textarea"
          :label="$t('review.additionalInstructions')"
          :placeholder="$t('review.additionalInstructionsPlaceholder')"
          :rows="4"
          outlined
          dark
          color="primary"
        />
      </q-card-section>

      <q-card-section class="q-pt-none">
        <q-toggle v-model="newSession" :label="$t('review.newSession')" color="primary" dark />
        <div class="text-caption text-kobo-3 q-mt-xs">{{ $t('review.newSessionHint') }}</div>
      </q-card-section>

      <q-card-actions align="right" class="q-pa-md">
        <q-btn flat no-caps :label="$t('review.cancel')" color="kobo-2" @click="cancel" />
        <q-btn
          no-caps
          color="primary"
          :label="$t('review.start')"
          :loading="loading"
          @click="submit"
        />
      </q-card-actions>
    </q-card>
  </q-dialog>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'

const props = defineProps<{
  modelValue: boolean
  loading: boolean
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void
  (e: 'submit', v: { additionalInstructions: string; newSession: boolean }): void
}>()

const additionalInstructions = ref('')
const newSession = ref(false)

// Reset internal state every time the dialog reopens
watch(
  () => props.modelValue,
  (open) => {
    if (open) {
      additionalInstructions.value = ''
      newSession.value = false
    }
  },
)

function cancel() {
  emit('update:modelValue', false)
}

function submit() {
  emit('submit', {
    additionalInstructions: additionalInstructions.value,
    newSession: newSession.value,
  })
}
</script>
