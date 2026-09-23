<template>
  <div class="agent-error-item">
    <q-icon name="error_outline" size="16px" class="agent-error-item__icon" />
    <div class="agent-error-item__body">
      <div class="agent-error-item__title">{{ $t(titleKey) }}</div>
      <div class="agent-error-item__message">{{ item.message }}</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { ConversationItem } from 'src/services/agent-event-view'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps<{ item: Extract<ConversationItem, { type: 'error' }> }>()
const { te } = useI18n()

// An unknown category must never render a raw key on screen.
const titleKey = computed(() => {
  const key = `agent.error.${props.item.category}`
  return te(key) ? key : 'agent.error.other'
})
</script>

<style scoped lang="scss">
.agent-error-item {
  display: flex;
  gap: var(--kobo-space-sm);
  align-items: flex-start;
  padding: var(--kobo-space-sm) var(--kobo-space-md);
  border-left: 2px solid var(--kobo-danger);
  background: var(--kobo-surface-2);
  border-radius: var(--kobo-radius-sm);
}

.agent-error-item__icon {
  color: var(--kobo-danger);
  flex: 0 0 auto;
  margin-top: 2px;
}

.agent-error-item__body {
  min-width: 0;
}

.agent-error-item__title {
  color: var(--kobo-text);
  font-weight: 600;
}

.agent-error-item__message {
  color: var(--kobo-text-2);
  font-family: var(--kobo-font-mono);
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
