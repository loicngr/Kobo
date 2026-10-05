<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type { MemoryEntry } from '../../../../shared/memory'

withDefaults(defineProps<{ entries: MemoryEntry[]; disabled?: boolean }>(), { disabled: false })
const emit = defineEmits<{
  edit: [entry: MemoryEntry]
  delete: [entry: MemoryEntry]
  promote: [entry: MemoryEntry]
}>()
const { t } = useI18n()
</script>

<template>
  <div class="memory-entry-list">
    <p v-if="entries.length === 0" class="memory-empty">{{ t('memory.entry.empty') }}</p>
    <article v-for="entry in entries" :key="entry.id" class="memory-entry">
      <div class="memory-entry__content">
        <h3>{{ entry.title }}</h3>
        <p class="memory-entry__key">{{ entry.key }} · {{ t('memory.entry.revision', { revision: entry.revision }) }}</p>
        <p class="memory-entry__body">{{ entry.body }}</p>
      </div>
      <div class="memory-entry__actions">
        <button type="button" :aria-label="t('memory.entry.editAria', { title: entry.title })" :disabled="disabled" @click="emit('edit', entry)">
          {{ t('memory.entry.edit') }}
        </button>
        <button type="button" :aria-label="t('memory.entry.deleteAria', { title: entry.title })" :disabled="disabled" @click="emit('delete', entry)">
          {{ t('memory.entry.delete') }}
        </button>
        <button type="button" :aria-label="t('memory.entry.promoteAria', { title: entry.title })" :disabled="disabled" @click="emit('promote', entry)">
          {{ t('memory.entry.promote') }}
        </button>
      </div>
    </article>
  </div>
</template>

<style scoped>
.memory-entry-list { display: grid; gap: var(--kobo-space-md); }
.memory-entry { display: flex; justify-content: space-between; gap: var(--kobo-space-lg); padding: var(--kobo-space-md); border: 1px solid var(--kobo-border-subtle); border-radius: var(--kobo-radius-md); background: var(--kobo-surface); }
.memory-entry h3, .memory-entry p { margin: 0; }
.memory-entry h3 { font-size: 1rem; line-height: 1.5; font-weight: 600; }
.memory-entry__content { min-width: 0; }
.memory-entry__body { margin-top: var(--space-2, 8px) !important; white-space: pre-wrap; overflow-wrap: anywhere; }
.memory-entry__key { color: var(--kobo-text-2); font-size: 0.875rem; }
.memory-entry__actions { display: flex; align-items: start; flex-wrap: wrap; gap: var(--kobo-space-sm); }
.memory-empty { color: var(--kobo-text-2); }
@media (max-width: 600px) { .memory-entry { flex-direction: column; } }
</style>
