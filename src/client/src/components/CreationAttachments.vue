<template>
  <div class="creation-attachments" @paste="onPaste" @dragover="onDragOver" @drop="onDrop">
    <slot />
    <div class="creation-attachments__toolbar">
      <input ref="fileInput" class="hidden" type="file" :accept="ATTACHMENT_ACCEPT" multiple :disabled="disabled" @change="onSelect" />
      <q-btn flat dense icon="attach_file" :label="$t('attachments.add')" :disable="disabled" @click="fileInput?.click()" />
      <span class="creation-attachments__hint">{{ $t('attachments.hint', { count: MAX_ATTACHMENTS, size: MAX_ATTACHMENT_BYTES / 1024 / 1024, total: MAX_ATTACHMENTS_BYTES / 1024 / 1024 }) }}</span>
    </div>
    <p v-if="error" class="creation-attachments__error" role="alert">{{ $t(`attachments.error.${error}`) }}</p>
    <ul v-if="previews.length" class="creation-attachments__list">
      <li v-for="(image, index) in previews" :key="image.url ?? index" class="creation-attachments__item">
        <img v-if="image.url" :src="image.url" :alt="image.file.name" class="creation-attachments__preview" />
        <q-icon v-else :name="image.file.name.toLowerCase().endsWith('.pdf') ? 'picture_as_pdf' : 'description'" class="creation-attachments__preview" aria-hidden="true" />
        <span class="creation-attachments__name" :title="image.file.name">{{ image.file.name }}</span>
        <q-btn flat dense icon="close" :aria-label="$t('attachments.remove')" :disable="disabled" @click="remove(index)">
          <q-tooltip>{{ $t('attachments.remove') }}</q-tooltip>
        </q-btn>
      </li>
    </ul>
  </div>
</template>

<script setup lang="ts">
import { onUnmounted, ref, watch } from 'vue'
import {
  ATTACHMENT_ACCEPT,
  type AttachmentError,
  attachmentFormat,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS,
  MAX_ATTACHMENTS_BYTES,
  validateAttachments,
} from '../../../shared/attachments'

const props = defineProps<{ modelValue: File[]; disabled?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [files: File[]] }>()
const fileInput = ref<HTMLInputElement | null>(null)
const error = ref<AttachmentError | null>(null)
const previews = ref<Array<{ file: File; url: string | null }>>([])
const urls = new Map<File, string>()

watch(
  () => props.modelValue,
  (files) => {
    for (const [file, url] of urls) {
      if (!files.includes(file)) {
        URL.revokeObjectURL(url)
        urls.delete(file)
      }
    }
    previews.value = files.map((file) => {
      if (attachmentFormat(file)?.kind !== 'image') return { file, url: null }
      let url = urls.get(file)
      if (!url) {
        url = URL.createObjectURL(file)
        urls.set(file, url)
      }
      return { file, url }
    })
  },
  { immediate: true },
)

onUnmounted(() => {
  for (const url of urls.values()) URL.revokeObjectURL(url)
})

function add(files: File[]) {
  if (props.disabled || files.length === 0) return
  const next = [...new Set([...props.modelValue, ...files])]
  error.value = validateAttachments(next)
  if (!error.value) emit('update:modelValue', next)
}

function remove(index: number) {
  if (props.disabled) return
  error.value = null
  emit(
    'update:modelValue',
    props.modelValue.filter((_, i) => i !== index),
  )
}

function onSelect(event: Event) {
  const input = event.target as HTMLInputElement
  add(Array.from(input.files ?? []))
  input.value = ''
}

function onPaste(event: ClipboardEvent) {
  const data = event.clipboardData
  if (!data) return
  const files = Array.from(data.items ?? [])
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null)
  if (files.length === 0) return
  // Preserve an accompanying plain-text caption; an image-only paste has no native text to insert.
  if (!data.getData('text/plain')) event.preventDefault()
  add(files)
}

function onDragOver(event: DragEvent) {
  if (event.dataTransfer?.types.includes('Files')) event.preventDefault()
}

function onDrop(event: DragEvent) {
  const files = Array.from(event.dataTransfer?.files ?? [])
  if (files.length === 0) return
  event.preventDefault()
  add(files)
}
</script>

<style lang="scss" scoped>
.creation-attachments__toolbar, .creation-attachments__item {
  display: flex;
  align-items: center;
  gap: var(--kobo-space-sm);
}
.creation-attachments__toolbar { flex-wrap: wrap; margin-top: var(--kobo-space-xs); }
.creation-attachments__hint { color: var(--kobo-text-3); font-size: inherit; }
.creation-attachments__error { color: var(--kobo-danger); margin: var(--kobo-space-xs) 0; }
.creation-attachments__list {
  display: flex;
  flex-wrap: wrap;
  gap: var(--kobo-space-sm);
  list-style: none;
  margin: var(--kobo-space-sm) 0 0;
  padding: 0;
}
.creation-attachments__item {
  min-width: 0;
  width: 100%;
  max-width: 100%;
  padding: var(--kobo-space-xs);
  background: var(--kobo-surface-2);
  border: 1px solid var(--kobo-border-subtle);
  border-radius: var(--kobo-radius-sm);
}
.creation-attachments__preview {
  flex-shrink: 0;
  width: var(--kobo-space-4xl);
  height: var(--kobo-space-4xl);
  object-fit: contain;
}
.creation-attachments__name {
  flex: 1;
  width: 0;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--kobo-text-2);
}
</style>
