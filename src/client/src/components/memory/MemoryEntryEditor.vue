<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { MemoryEntry } from '../../../../shared/memory'

const props = withDefaults(
  defineProps<{
    scopeId: string
    entry?: MemoryEntry | null
    saving?: boolean
    conflict?: boolean
    error?: string
  }>(),
  { entry: null, saving: false, conflict: false, error: '' },
)
const emit = defineEmits<{
  save: [value: { scopeId: string; key: string; title: string; body: string; expectedRevision?: number }]
  cancel: []
  reload: []
  rebase: [revision: number]
}>()
const { t } = useI18n()
const draft = ref({ key: '', title: '', body: '' })
const baseline = ref({ key: '', title: '', body: '' })
const baseRevision = ref<number | undefined>()
const dirty = computed(
  () =>
    draft.value.key !== baseline.value.key ||
    draft.value.title !== baseline.value.title ||
    draft.value.body !== baseline.value.body,
)

function readEntry(entry: MemoryEntry | null | undefined): void {
  const value = { key: entry?.key ?? '', title: entry?.title ?? '', body: entry?.body ?? '' }
  baseline.value = value
  draft.value = { ...value }
  baseRevision.value = entry?.revision
}

watch(
  () => [props.entry, props.scopeId] as const,
  ([entry, scopeId], previous) => {
    const identityChanged = entry?.id !== previous?.[0]?.id || scopeId !== previous?.[1]
    if (identityChanged || !dirty.value) readEntry(entry)
  },
  { immediate: true },
)

function submit(): void {
  if (props.saving || !draft.value.key.trim() || !draft.value.title.trim() || !draft.value.body.trim()) return
  emit('save', {
    scopeId: props.scopeId,
    ...draft.value,
    ...(baseRevision.value !== undefined ? { expectedRevision: baseRevision.value } : {}),
  })
}

function reloadCurrent(): void {
  readEntry(props.entry)
  emit('reload')
}

function rebaseDraft(): void {
  if (!props.entry) return
  baseRevision.value = props.entry.revision
  emit('rebase', props.entry.revision)
}
</script>

<template>
  <form class="memory-entry-editor" @submit.prevent="submit">
    <label>
      <span>{{ t('memory.editor.key') }}</span>
      <input v-model="draft.key" name="key" maxlength="80" required :disabled="saving" />
    </label>
    <label>
      <span>{{ t('memory.editor.title') }}</span>
      <input v-model="draft.title" name="title" maxlength="160" required :disabled="saving" />
    </label>
    <label>
      <span>{{ t('memory.editor.body') }}</span>
      <textarea v-model="draft.body" name="body" maxlength="2000" rows="5" required :disabled="saving" />
    </label>
    <p v-if="error" role="alert">{{ error }}</p>
    <div v-if="conflict" class="memory-editor-conflict" role="alert">
      <p>{{ t('memory.editor.conflict') }}</p>
      <button type="button" :disabled="saving" @click="reloadCurrent">{{ t('memory.editor.reload') }}</button>
      <button type="button" :disabled="saving || !entry" @click="rebaseDraft">{{ t('memory.editor.rebase') }}</button>
    </div>
    <div class="memory-editor-actions">
      <button type="submit" :disabled="saving || !dirty">{{ saving ? t('memory.editor.saving') : t('memory.editor.save') }}</button>
      <button type="button" :disabled="saving" @click="emit('cancel')">{{ t('memory.editor.cancel') }}</button>
    </div>
  </form>
</template>

<style scoped>
.memory-entry-editor { display: grid; gap: var(--kobo-space-md); }
.memory-entry-editor label { display: grid; gap: var(--kobo-space-sm); }
.memory-entry-editor input, .memory-entry-editor textarea { width: 100%; box-sizing: border-box; padding: var(--kobo-space-sm); color: var(--kobo-text); background: var(--kobo-surface); border: 1px solid var(--kobo-border-subtle); border-radius: var(--kobo-radius-sm); }
.memory-editor-actions, .memory-editor-conflict { display: flex; flex-wrap: wrap; gap: var(--kobo-space-sm); }
.memory-editor-conflict { padding: var(--kobo-space-md); border-inline-start: 3px solid var(--kobo-warning); background: var(--kobo-surface-2); }
.memory-editor-conflict p { flex-basis: 100%; margin: 0; }
</style>
