<script setup lang="ts">
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import type { ConversationItem } from 'src/services/agent-event-view'
import { computed } from 'vue'

const props = defineProps<{ item: Extract<ConversationItem, { type: 'thinking' }> }>()

const preview = computed(() => props.item.text.trim().slice(0, 100))
const hasContent = computed(() => props.item.text.trim().length > 0)
const needsExpand = computed(() => props.item.text.trim().length > 100)

const html = computed(() => {
  const raw = marked.parse(props.item.text, { async: false, breaks: true, gfm: true }) as string
  return DOMPurify.sanitize(raw)
})
</script>

<template>
  <div v-if="hasContent" class="text-caption text-grey-5" style="font-style: italic;">
    <q-expansion-item
      v-if="needsExpand"
      dense
      dense-toggle
      :label="preview"
      header-class="text-grey-5 text-caption"
      style="font-style: italic;"
    >
      <!-- eslint-disable-next-line vue/no-v-html -->
      <div class="q-py-xs markdown-thinking" v-html="html" />
    </q-expansion-item>
    <span v-else style="white-space: pre-wrap;">{{ item.text }}</span>
  </div>
</template>

<style scoped>
.markdown-thinking :deep(p) {
  margin: 0 0 0.4em;
}
.markdown-thinking :deep(p:last-child) {
  margin-bottom: 0;
}
.markdown-thinking :deep(code) {
  background: rgba(255, 255, 255, 0.08);
  padding: 0.1em 0.3em;
  border-radius: 3px;
}
</style>
