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

  <!-- Regular user chat message: plain markdown inside the user turn card.
       Click delegation handles the image-lightbox — no per-image listener. -->
  <div v-else class="markdown-message" @click="onMessageClick">
    <!-- eslint-disable-next-line vue/no-v-html -->
    <div v-html="html" />
  </div>

  <!-- Image lightbox: opens when a user message image is clicked.
       Using a raw <img> instead of q-img + q-card because the latter's
       ratio/wrapping can collapse to 0×0 inside a q-dialog without an
       explicit :ratio prop, which is what made the earlier version show
       only the dim backdrop with no visible image. -->
  <q-dialog v-model="zoomOpen">
    <img
      v-if="zoomSrc"
      :src="zoomSrc"
      alt=""
      class="image-lightbox-img"
      @click="zoomOpen = false"
    />
  </q-dialog>
</template>

<script setup lang="ts">
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import type { ConversationItem } from 'src/services/agent-event-view'
import { useWorkspaceStore } from 'src/stores/workspace'
import { injectImagePreviews } from 'src/utils/inject-image-previews'
import { computed, ref } from 'vue'

const props = defineProps<{ item: Extract<ConversationItem, { type: 'user' }> }>()

const workspaceStore = useWorkspaceStore()

const isSystemPrompt = computed(() => props.item.sender === 'system-prompt')

const html = computed(() => {
  const withImages = injectImagePreviews(props.item.content, workspaceStore.selectedWorkspaceId ?? '')
  const raw = marked.parse(withImages, { async: false, breaks: true, gfm: true }) as string
  return DOMPurify.sanitize(raw)
})

// Lightbox state: clicking a rendered image opens it at full size in a
// maximized dialog. Escape or click on the backdrop closes it.
const zoomSrc = ref<string | null>(null)
const zoomOpen = ref(false)

function onMessageClick(event: MouseEvent) {
  const target = event.target as HTMLElement | null
  if (target?.tagName !== 'IMG') return
  const img = target as HTMLImageElement
  if (!img.src) return
  zoomSrc.value = img.src
  zoomOpen.value = true
}
</script>

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
.markdown-message :deep(img) {
  /* Small thumbnail — the message text stays the focus; clicking opens
     the lightbox for full-size viewing. */
  max-height: 100px;
  max-width: 180px;
  object-fit: contain;
  border-radius: 4px;
  display: block;
  margin: 0.3em 0;
  cursor: zoom-in;
  background: rgba(0, 0, 0, 0.2);
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

<!-- Non-scoped: the lightbox <img> is teleported by q-dialog outside this
     component's DOM tree, so a scoped rule wouldn't reach it. -->
<style lang="scss">
.image-lightbox-img {
  max-width: 92vw;
  max-height: 92vh;
  object-fit: contain;
  display: block;
  cursor: zoom-out;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.3);
}
</style>
