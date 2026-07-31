<template>
  <div v-if="hasContent" class="text-caption text-grey-5" style="font-style: italic;">
    <q-expansion-item
      v-if="needsExpand"
      dense
      dense-toggle
      default-opened
      class="thinking-expansion"
      header-class="text-grey-5 text-caption"
      style="font-style: italic;"
    >
      <template #header>
        <div class="thinking-label row items-center no-wrap">
          <q-icon name="psychology" size="14px" class="q-mr-xs" />
          <span>{{ t('thinking.label') }}</span>
        </div>
      </template>
      <!-- eslint-disable-next-line vue/no-v-html -->
      <div class="q-py-xs markdown-thinking" v-html="html" />
    </q-expansion-item>
    <span v-else style="white-space: pre-wrap;"><q-icon name="psychology" size="14px" class="q-mr-xs" />{{ item.text }}</span>
  </div>
</template>

<script setup lang="ts">
import type { ConversationItem } from 'src/services/agent-event-view'
import { renderChatMarkdown } from 'src/utils/render-chat-markdown'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps<{ item: Extract<ConversationItem, { type: 'thinking' }> }>()
const { t } = useI18n()

const hasContent = computed(() => props.item.text.trim().length > 0)
const needsExpand = computed(() => props.item.text.trim().length > 100)

const html = computed(() => {
  return renderChatMarkdown(props.item.text)
})
</script>

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
.thinking-expansion :deep(.q-item__section--side) {
  margin-left: auto;
}
</style>
