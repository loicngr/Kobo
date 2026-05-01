<template>
  <div
    ref="cardEl"
    class="turn-card"
    :class="{ 'turn-card--user': turn.speaker === 'user' }"
    :style="{ '--turn-accent': header.accent }"
  >
    <div class="turn-header">
      <span class="turn-badge" :class="header.badgeClass">{{ header.label }}</span>
      <span v-if="timeLabel" class="turn-time">{{ timeLabel }}</span>
      <template v-if="showUpdatedTime">
        <q-icon name="arrow_forward" size="10px" color="grey-7" class="turn-time-arrow" />
        <span class="turn-time turn-time-updated">
          {{ updatedTimeLabel }}
          <q-tooltip>{{ t('chat.lastUpdatedAt', { time: updatedTimeLabel }) }}</q-tooltip>
        </span>
      </template>
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
    <!-- Scroll-to-top button: useful on long agent cards (many tool calls)
         to jump back to the initial text/status of the turn without
         dragging the scrollbar. Only shown when the card has enough items
         to warrant it. -->
    <div v-if="turn.items.length > 4" class="turn-scroll-top">
      <q-btn
        flat
        round
        dense
        size="xs"
        icon="arrow_upward"
        color="grey-6"
        class="turn-scroll-top-btn"
        @click="scrollToTop"
      >
        <q-tooltip>{{ t('chat.scrollToTurnTop') }}</q-tooltip>
      </q-btn>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { Turn } from 'src/services/conversation-turns'
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import SessionEventItem from './items/SessionEventItem.vue'
import TextMessageItem from './items/TextMessageItem.vue'
import ThinkingItem from './items/ThinkingItem.vue'
import ToolCallItem from './items/ToolCallItem.vue'
import UserMessageItem from './items/UserMessageItem.vue'

const props = defineProps<{
  turn: Turn
}>()
const emit = defineEmits<{
  /** Emitted by the "scroll to top of this message" button — detail carries
      the absolute Y (relative to the scroll-content origin) to land on. */
  scrollTo: [y: number]
}>()
const { t } = useI18n()

// Template ref on the card root — used by the "scroll to top of this message"
// button so it can compute the card's absolute Y inside the scroll content.
const cardEl = ref<HTMLElement | null>(null)

function scrollToTop() {
  const el = cardEl.value
  if (!el) return
  // q-scroll-area transforms `.q-scrollarea__content`; derive the card's
  // absolute Y in the content by diffing against the content root's top.
  const container = el.closest('.q-scrollarea') as HTMLElement | null
  const content = container?.querySelector<HTMLElement>('.q-scrollarea__content')
  if (!content) {
    el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    return
  }
  const cardY = el.getBoundingClientRect().top - content.getBoundingClientRect().top
  emit('scrollTo', Math.max(0, cardY - 8))
}

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

function formatTime(iso?: string, withSeconds = false): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleTimeString(
    undefined,
    withSeconds ? { hour: '2-digit', minute: '2-digit', second: '2-digit' } : { hour: '2-digit', minute: '2-digit' },
  )
}

const timeLabel = computed(() => formatTime(props.turn.ts))

// ISO timestamp of the last item in the turn — reflects when the card was
// most recently updated (new tool call, streaming text, etc.).
const updatedTimeIso = computed<string | null>(() => {
  const items = props.turn.items
  if (items.length === 0) return null
  for (let i = items.length - 1; i >= 0; i--) {
    const ts = (items[i] as { ts?: string }).ts
    if (ts) return ts
  }
  return null
})

// Display the "last update" time next to the start time as soon as the raw
// ISO timestamps differ. When the gap is under a minute (HH:MM match but
// still useful info), show seconds too — otherwise plain HH:MM.
const updatedTimeLabel = computed(() => {
  const startIso = props.turn.ts
  const endIso = updatedTimeIso.value
  if (!endIso || !startIso || endIso === startIso) return ''
  const start = new Date(startIso).getTime()
  const end = new Date(endIso).getTime()
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return ''
  const subMinute = end - start < 60_000
  return formatTime(endIso, subMinute)
})

const showUpdatedTime = computed(() => updatedTimeLabel.value !== '')

// Count non-text items (tools + thinking) for the header badge
const actionCount = computed(() => props.turn.items.filter((i) => i.type === 'tool').length)
</script>

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
.turn-time-arrow {
  margin: 0 -2px;
  opacity: 0.7;
}
.turn-time-updated {
  color: #8891a3;
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
.turn-scroll-top {
  display: flex;
  justify-content: flex-start;
  padding: 0 8px 6px;
}
.turn-scroll-top-btn {
  opacity: 0.5;
  transition: opacity 0.15s;
}
.turn-scroll-top-btn:hover {
  opacity: 1;
}
</style>
