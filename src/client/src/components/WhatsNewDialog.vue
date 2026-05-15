<template>
  <q-dialog
    :model-value="modelValue"
    @update:model-value="$emit('update:modelValue', $event)"
  >
    <q-card class="text-grey-3" style="min-width: 480px; max-width: 90vw; background: #1e1e3a;">
      <q-card-section class="row items-center q-pb-none">
        <q-icon name="auto_awesome" size="sm" color="indigo-4" class="q-mr-sm" />
        <div class="text-h6">{{ $t('whatsNew.title') }}</div>
        <q-space />
        <q-btn v-close-popup flat dense round icon="close" color="grey-5" />
      </q-card-section>

      <q-card-section style="max-height: 60vh; overflow-y: auto;">
        <div v-for="entry in versions" :key="entry.version" class="q-mb-md">
          <div class="text-subtitle2 text-indigo-3 q-mb-xs">{{ entry.version }}</div>
          <!-- eslint-disable-next-line vue/no-v-html -->
          <div class="whats-new-notes" v-html="renderNotes(entry.notes)" />
        </div>
      </q-card-section>

      <q-card-actions align="right">
        <q-btn v-close-popup flat :label="$t('common.close')" color="primary" />
      </q-card-actions>
    </q-card>
  </q-dialog>
</template>

<script setup lang="ts">
import type { ChangelogEntry } from 'src/composables/use-whats-new'
import { renderChatMarkdown } from 'src/utils/render-chat-markdown'

defineProps<{
  modelValue: boolean
  versions: ChangelogEntry[]
}>()
defineEmits<{ 'update:modelValue': [value: boolean] }>()

function renderNotes(notes: string): string {
  return renderChatMarkdown(notes)
}
</script>

<style scoped>
.whats-new-notes {
  color: #cfcfe0;
  font-size: 13px;
  line-height: 1.55;
}
.whats-new-notes :deep(ul) {
  margin: 0;
  padding-left: 1.2em;
}
.whats-new-notes :deep(li) {
  margin: 0.2em 0;
}
.whats-new-notes :deep(code) {
  background: rgba(0, 0, 0, 0.25);
  padding: 0.1em 0.3em;
  border-radius: 3px;
}
</style>
