<script setup lang="ts">
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import MessageChoices from 'src/components/MessageChoices.vue'
import type { ConversationItem } from 'src/services/agent-event-view'
import { useDocumentsStore } from 'src/stores/documents'
import { useWorkspaceStore } from 'src/stores/workspace'
import { detectChoices } from 'src/utils/detect-choices'
import { injectDocumentLinks } from 'src/utils/inject-document-links'
import { computed } from 'vue'

const props = defineProps<{
  item: Extract<ConversationItem, { type: 'text' }>
  /** True when this message belongs to the most recent turn in the feed.
      Drives whether multiple-choice buttons are still clickable: once a
      newer message arrives, old prompts go inert so a click on a stale
      A/B/C button doesn't reply to a question the agent has moved past. */
  isLatestTurn?: boolean
}>()

const documentsStore = useDocumentsStore()
const workspaceStore = useWorkspaceStore()

const knownDocumentPaths = computed(() => {
  const wsId = workspaceStore.selectedWorkspaceId
  if (!wsId) return [] as string[]
  return documentsStore.documentsFor(wsId).map((d) => d.path)
})

const html = computed(() => {
  const raw = marked.parse(props.item.text, { async: false, breaks: true, gfm: true }) as string
  const withLinks = injectDocumentLinks(raw, knownDocumentPaths.value)
  // Allow the data-document-path attribute through the sanitizer.
  return DOMPurify.sanitize(withLinks, { ADD_ATTR: ['data-document-path'] })
})

// Detect a multiple-choice block so we can render quick-reply buttons under
// the message. Computed so streaming updates are reflected as the agent
// finishes typing the choices. Returns null on plain prose / non-question
// content.
const choiceBlock = computed(() => detectChoices(props.item.text))

function onMessageClick(event: MouseEvent) {
  const target = (event.target as HTMLElement | null)?.closest('.document-link') as HTMLElement | null
  if (!target) return
  event.preventDefault()
  const path = target.getAttribute('data-document-path')
  const wsId = workspaceStore.selectedWorkspaceId
  if (!path || !wsId) return
  void documentsStore.openDocumentByPath(wsId, path)
}
</script>

<template>
  <div class="markdown-message" @click="onMessageClick">
    <!-- eslint-disable-next-line vue/no-v-html -->
    <div v-html="html" />
    <q-spinner v-if="item.streaming" size="xs" class="q-ml-xs" />
    <MessageChoices
      v-if="choiceBlock"
      :choices="choiceBlock.choices"
      :active="!!isLatestTurn && !item.streaming"
    />
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
.markdown-message :deep(p) {
  margin: 0 0 0.5em;
}
.markdown-message :deep(p:last-child) {
  margin-bottom: 0;
}
.markdown-message :deep(pre) {
  background: rgba(0, 0, 0, 0.35);
  padding: 0.5em 0.75em;
  border-radius: 4px;
  overflow-x: auto;
  margin: 0.5em 0;
}
.markdown-message :deep(code) {
  background: rgba(0, 0, 0, 0.3);
  padding: 0.1em 0.3em;
  border-radius: 3px;
  font-size: 0.9em;
  word-break: break-all;
}
.markdown-message :deep(pre code) {
  background: transparent;
  padding: 0;
}
.markdown-message :deep(ul),
.markdown-message :deep(ol) {
  margin: 0.25em 0 0.5em;
  padding-left: 1.5em;
}
.markdown-message :deep(li) {
  margin: 0.15em 0;
}
.markdown-message :deep(a) {
  color: #7986cb;
  text-decoration: underline;
}
.markdown-message :deep(.document-link) {
  color: #9fa8da;
  text-decoration: underline dotted;
  cursor: pointer;
}
.markdown-message :deep(.document-link:hover) {
  color: #c5cae9;
  text-decoration: underline solid;
}
.markdown-message :deep(h1),
.markdown-message :deep(h2),
.markdown-message :deep(h3),
.markdown-message :deep(h4),
.markdown-message :deep(h5),
.markdown-message :deep(h6) {
  margin: 0.5em 0 0.3em;
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
.markdown-message :deep(blockquote) {
  border-left: 3px solid rgba(255, 255, 255, 0.2);
  padding-left: 0.75em;
  margin: 0.5em 0;
  color: rgba(255, 255, 255, 0.7);
}
.markdown-message :deep(table) {
  border-collapse: collapse;
  margin: 0.5em 0;
}
.markdown-message :deep(th),
.markdown-message :deep(td) {
  border: 1px solid rgba(255, 255, 255, 0.15);
  padding: 0.25em 0.5em;
}
</style>
