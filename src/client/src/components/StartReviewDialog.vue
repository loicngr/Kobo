<template>
  <q-dialog :model-value="modelValue" @update:model-value="emit('update:modelValue', $event)">
    <q-card class="text-grey-3" style="min-width: 480px; background: #1e1e3a;">
      <q-card-section>
        <div class="text-h6">{{ $t('review.title') }}</div>
        <div class="text-body2 text-grey-5 q-mt-xs">{{ $t('review.subtitle') }}</div>
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
          color="indigo-4"
        />
      </q-card-section>

      <q-card-section class="q-pt-none">
        <q-toggle v-model="newSession" :label="$t('review.newSession')" color="indigo-4" dark />
        <div class="text-caption text-grey-6 q-mt-xs">{{ $t('review.newSessionHint') }}</div>
      </q-card-section>

      <q-card-actions align="right" class="q-pa-md">
        <q-btn flat no-caps :label="$t('review.cancel')" color="grey-5" @click="cancel" />
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
