<script setup lang="ts">
import type { Turn } from 'src/services/conversation-turns'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import SessionEventItem from './items/SessionEventItem.vue'
import TextMessageItem from './items/TextMessageItem.vue'
import ThinkingItem from './items/ThinkingItem.vue'
import ToolCallItem from './items/ToolCallItem.vue'
import UserMessageItem from './items/UserMessageItem.vue'

const props = defineProps<{ turn: Turn }>()
const { t } = useI18n()

interface HeaderMeta {
  label: string
  accent: string
  badgeClass: string
}

const header = computed<HeaderMeta>(() => {
  switch (props.turn.speaker) {
    case 'user':
      return { label: t('chat.you'), accent: '#ce93d8', badgeClass: 'turn-badge-user' }
    case 'agent':
      return { label: t('chat.agent'), accent: '#7986cb', badgeClass: 'turn-badge-agent' }
    case 'system-prompt':
      return { label: t('chat.systemPrompt'), accent: '#757575', badgeClass: 'turn-badge-system' }
    case 'session':
      return { label: t('chat.session'), accent: '#616161', badgeClass: 'turn-badge-session' }
  }
})

const timeLabel = computed(() => {
  if (!props.turn.ts) return ''
  const d = new Date(props.turn.ts)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
})

// Count non-text items (tools + thinking) for the header badge
const actionCount = computed(() => props.turn.items.filter((i) => i.type === 'tool').length)
</script>

<template>
  <div
    class="turn-card"
    :class="{ 'turn-card--user': turn.speaker === 'user' }"
    :style="{ '--turn-accent': header.accent }"
  >
    <div class="turn-header">
      <span class="turn-badge" :class="header.badgeClass">{{ header.label }}</span>
      <span v-if="timeLabel" class="turn-time">{{ timeLabel }}</span>
      <span v-if="actionCount > 0" class="turn-actions">
        · {{ t('chat.nActions', { n: actionCount }) }}
      </span>
    </div>
    <div class="turn-body">
      <template v-for="(item, i) in turn.items" :key="i">
        <TextMessageItem v-if="item.type === 'text'" :item="item" />
        <ThinkingItem v-else-if="item.type === 'thinking'" :item="item" />
        <ToolCallItem v-else-if="item.type === 'tool'" :item="item" />
        <UserMessageItem v-else-if="item.type === 'user'" :item="item" />
        <SessionEventItem v-else-if="item.type === 'session'" :item="item" />
      </template>
    </div>
  </div>
</template>

<style scoped>
.turn-card {
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-left: 3px solid var(--turn-accent);
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.02);
  margin: 14px 0;
  overflow: hidden;
  /* Prevent long tokens in code/file paths from blowing past the parent
     width. Children use word-break / text-overflow to wrap. */
  min-width: 0;
  max-width: 100%;
}
.turn-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  background: rgba(255, 255, 255, 0.03);
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
  font-size: 11px;
  color: #888;
}
.turn-badge {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.3px;
  padding: 2px 8px;
  border-radius: 3px;
}
.turn-badge-user {
  background: rgba(206, 147, 216, 0.15);
  color: #ce93d8;
}
.turn-badge-agent {
  background: rgba(121, 134, 203, 0.15);
  color: #7986cb;
}
.turn-badge-system {
  background: rgba(117, 117, 117, 0.2);
  color: #bdbdbd;
  font-style: italic;
}
.turn-badge-session {
  background: rgba(97, 97, 97, 0.2);
  color: #9e9e9e;
}
.turn-time {
  color: #666;
  font-family: 'SF Mono', Menlo, Consolas, monospace;
  font-size: 11px;
}
.turn-actions {
  color: #777;
  font-size: 11px;
}
.turn-body {
  padding: 14px 18px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
  /* Flex items default to min-width: auto which lets them grow past the
     container. Force shrinking so long inline content wraps instead of
     pushing the card horizontally. */
}
.turn-body > * {
  min-width: 0;
  max-width: 100%;
}
/* Tool rows group tighter than free-flow items to preserve their "action
   list" feel without losing the turn's overall breathing room. */
.turn-body :deep(.tool-row + .tool-row) {
  margin-top: -8px;
}
</style>
