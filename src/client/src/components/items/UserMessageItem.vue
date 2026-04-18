<script setup lang="ts">
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import type { ConversationItem } from 'src/services/agent-event-view'
import { computed } from 'vue'

const props = defineProps<{ item: Extract<ConversationItem, { type: 'user' }> }>()

const isSystemPrompt = computed(() => props.item.sender === 'system-prompt')

const html = computed(() => {
  const raw = marked.parse(props.item.content, { async: false, breaks: true, gfm: true }) as string
  return DOMPurify.sanitize(raw)
})
</script>

<template>
  <!-- System prompt: collapsed by default inside its own turn card -->
  <q-expansion-item
    v-if="isSystemPrompt"
    dense
    dense-toggle
    :label="$t('chat.systemPrompt')"
    header-class="text-grey-5 text-caption"
  >
    <!-- eslint-disable-next-line vue/no-v-html -->
    <div class="q-py-xs markdown-user-prompt" v-html="html" />
  </q-expansion-item>

  <!-- Regular user chat message: plain markdown inside the user turn card -->
  <div v-else class="markdown-message">
    <!-- eslint-disable-next-line vue/no-v-html -->
    <div v-html="html" />
  </div>
</template>

<style scoped>
.markdown-message {
  color: #e0e0e0;
  font-size: 13px;
  line-height: 1.55;
  word-break: break-word;
  overflow-wrap: anywhere;
  min-width: 0;
  max-width: 100%;
}
.markdown-message :deep(*) {
  max-width: 100%;
}
.markdown-message :deep(code) {
  word-break: break-all;
}
.markdown-message :deep(p) {
  margin: 0 0 0.4em;
}
.markdown-message :deep(p:last-child) {
  margin-bottom: 0;
}
.markdown-message :deep(code) {
  background: rgba(0, 0, 0, 0.25);
  padding: 0.1em 0.3em;
  border-radius: 3px;
}
.markdown-message :deep(h1),
.markdown-message :deep(h2),
.markdown-message :deep(h3),
.markdown-message :deep(h4),
.markdown-message :deep(h5),
.markdown-message :deep(h6) {
  margin: 0.4em 0 0.25em;
  line-height: 1.3;
  font-weight: 600;
}
.markdown-message :deep(h1) {
  font-size: 1.25em;
}
.markdown-message :deep(h2) {
  font-size: 1.15em;
}
.markdown-message :deep(h3) {
  font-size: 1.08em;
}
.markdown-message :deep(h4),
.markdown-message :deep(h5),
.markdown-message :deep(h6) {
  font-size: 1em;
}
.markdown-user-prompt {
  color: #aaa;
  font-size: 12px;
  font-style: italic;
}
.markdown-user-prompt :deep(p) {
  margin: 0 0 0.4em;
}
.markdown-user-prompt :deep(code) {
  background: rgba(255, 255, 255, 0.08);
  padding: 0.1em 0.3em;
  border-radius: 3px;
  font-style: normal;
}
</style>
