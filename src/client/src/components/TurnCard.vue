<template>
  <div
    ref="cardEl"
    class="turn-card"
    :class="{ 'turn-card--user': turn.speaker === 'user', 'turn-card--highlighted': highlighted }"
    :data-event-ids="eventIds"
    :style="{ '--turn-accent': header.accent }"
  >
    <div class="turn-header">
      <span class="turn-badge" :class="header.badgeClass">{{ header.label }}</span>
      <span v-if="timeLabel" class="turn-time">{{ timeLabel }}</span>
      <template v-if="showUpdatedTime">
        <q-icon name="arrow_forward" size="10px" color="kobo-3" class="turn-time-arrow" />
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
      <template v-for="row in displayRows" :key="row.key">
        <q-expansion-item
          v-if="row.type === 'subagent'"
          class="turn-subagent-activity"
          dense
          :label="subagentActivityLabel(row.subagentName)"
          :caption="t('chat.nActions', { n: row.items.length })"
          :default-opened="highlighted && row.items.some((item) => item.eventIds?.some((id: string) => eventIds.includes(id)))"
        >
          <template #header>
            <q-item-section>
              <q-item-label class="row items-center no-wrap" :title="row.subagentName ?? undefined">
                <q-icon name="hub" size="16px" class="q-mr-xs">
                  <q-tooltip>{{ t('chat.subagentActivity') }}</q-tooltip>
                </q-icon>
                <span class="ellipsis">{{ subagentActivityLabel(row.subagentName) }}</span>
              </q-item-label>
              <q-item-label caption>{{ t('chat.nActions', { n: row.items.length }) }}</q-item-label>
            </q-item-section>
            <q-item-section side>
              <q-btn
                flat
                round
                dense
                size="sm"
                icon="open_in_new"
                :aria-label="t('chat.openSubagentActivity')"
                @click.stop="openSubagentActivity(row.items[0]!)"
              >
                <q-tooltip>{{ t('chat.openSubagentActivity') }}</q-tooltip>
              </q-btn>
            </q-item-section>
          </template>
          <div class="q-px-sm q-pb-sm">
            <template v-for="item in row.items" :key="itemKey(item)">
              <TextMessageItem v-if="item.type === 'text'" :item="item" />
              <ThinkingItem v-else-if="item.type === 'thinking'" :item="item" />
              <ToolCallItem v-else-if="item.type === 'tool'" :item="item" />
            </template>
          </div>
        </q-expansion-item>
        <template v-else>
          <TextMessageItem v-if="row.item.type === 'text'" :item="row.item" />
          <ThinkingItem v-else-if="row.item.type === 'thinking'" :item="row.item" />
          <ToolCallItem v-else-if="row.item.type === 'tool'" :item="row.item" />
          <UserMessageItem v-else-if="row.item.type === 'user'" :item="row.item" :workspace-id="workspaceId" />
          <SessionEventItem v-else-if="row.item.type === 'session'" :item="row.item" />
          <AgentErrorItem v-else-if="row.item.type === 'error'" :item="row.item" />
        </template>
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
        color="kobo-3"
        class="turn-scroll-top-btn"
        @click="scrollToTop"
      >
        <q-tooltip>{{ t('chat.scrollToTurnTop') }}</q-tooltip>
      </q-btn>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { ConversationItem } from 'src/services/agent-event-view'
import { itemKey, type Turn } from 'src/services/conversation-turns'
import { findSubagentForActivity } from 'src/services/subagent-activity'
import { openSubagentActivityKey } from 'src/services/subagent-activity-navigation'
import { useWorkspaceStore } from 'src/stores/workspace'
import { isHookSender } from 'src/utils/hook-events'
import { computed, inject, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import AgentErrorItem from './items/AgentErrorItem.vue'
import SessionEventItem from './items/SessionEventItem.vue'
import TextMessageItem from './items/TextMessageItem.vue'
import ThinkingItem from './items/ThinkingItem.vue'
import ToolCallItem from './items/ToolCallItem.vue'
import UserMessageItem from './items/UserMessageItem.vue'

const props = defineProps<{
  turn: Turn
  workspaceId: string
  highlighted?: boolean
}>()
const emit = defineEmits<{
  /** Emitted by the "scroll to top of this message" button — detail carries
      the absolute Y (relative to the scroll-content origin) to land on. */
  scrollTo: [y: number]
}>()
const { t } = useI18n()
const workspaceStore = useWorkspaceStore()
const openSubagentActivityInDrawer = inject(openSubagentActivityKey)

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
    case 'user': {
      const first = props.turn.items[0]
      const source = first?.type === 'user' ? first.source : undefined
      return {
        label: source ? t('chat.externalLlm', { name: source.clientName }) : t('chat.you'),
        accent: 'var(--kobo-turn-user)',
        badgeClass: 'turn-badge-user',
      }
    }
    case 'agent':
      return { label: t('chat.agent'), accent: 'var(--kobo-turn-agent)', badgeClass: 'turn-badge-agent' }
    case 'system-prompt':
      return { label: t('chat.systemPrompt'), accent: 'var(--kobo-text-3)', badgeClass: 'turn-badge-system' }
    case 'session':
      return { label: t('chat.session'), accent: 'var(--kobo-text-3)', badgeClass: 'turn-badge-session' }
    case 'script': {
      // The speaker is the generic 'script'; the precise label (cleanup /
      // archive / setup) comes from the first item's activity-feed sender.
      const first = props.turn.items[0]
      const sender = first?.type === 'user' ? first.sender : ''
      const label = isHookSender(sender)
        ? t('chat.hookScript', { event: sender.slice('hook:'.length) })
        : sender === 'archive'
          ? t('chat.archiveScript')
          : sender === 'setup'
            ? t('chat.setupScript')
            : t('chat.cleanupScript')
      return { label, accent: 'var(--kobo-success)', badgeClass: 'turn-badge-script' }
    }
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
const eventIds = computed(() => props.turn.items.flatMap((item) => item.eventIds ?? []).join(' '))

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

type SubagentConversationItem = Extract<ConversationItem, { type: 'text' | 'thinking' | 'tool' }>

type DisplayRow =
  | { type: 'item'; key: string; item: ConversationItem }
  | {
      type: 'subagent'
      key: string
      items: SubagentConversationItem[]
      subagentKey: string
      subagentName: string | null
    }

function subagentFor(item: SubagentConversationItem) {
  return findSubagentForActivity(
    item.origin,
    Object.values(workspaceStore.subagents[props.workspaceId] ?? {}),
    item.type === 'tool' ? item.toolCallId : undefined,
  )
}

function subagentActivityLabel(name: string | null): string {
  return name || t('chat.subagentActivity')
}

function isSubagentConversationItem(item: ConversationItem): item is SubagentConversationItem {
  return (item.type === 'text' || item.type === 'thinking' || item.type === 'tool') && item.origin?.kind === 'subagent'
}

const displayRows = computed<DisplayRow[]>(() => {
  const rows: DisplayRow[] = []
  // A parent action may land between two child events. Keep one fold per
  // sub-agent for the complete turn, even when the original stream interleaves.
  const subagentRows = new Map<string, Extract<DisplayRow, { type: 'subagent' }>>()
  for (const item of props.turn.items) {
    if (!isSubagentConversationItem(item)) {
      rows.push({ type: 'item', key: itemKey(item), item })
      continue
    }

    const subagent = subagentFor(item)
    const subagentKey = subagent?.toolUseId ?? item.origin?.toolCallId ?? item.origin?.threadId ?? itemKey(item)
    const existingRow = subagentRows.get(subagentKey)
    if (existingRow) {
      existingRow.items.push(item)
      continue
    }
    const row: Extract<DisplayRow, { type: 'subagent' }> = {
      type: 'subagent',
      key: `subagent:${itemKey(item)}`,
      items: [item],
      subagentKey,
      subagentName: subagent?.description || null,
    }
    subagentRows.set(subagentKey, row)
    rows.push(row)
  }
  return rows
})

function openSubagentActivity(item: SubagentConversationItem): void {
  if (!item.origin) return
  openSubagentActivityInDrawer?.({ origin: item.origin })
}

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
.turn-card--highlighted {
  animation: search-highlight 1.8s ease-out;
}
@keyframes search-highlight {
  0%, 45% { box-shadow: 0 0 0 2px rgba(129, 140, 248, 0.95), 0 0 22px rgba(129, 140, 248, 0.45); }
  100% { box-shadow: none; }
}
.turn-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  background: rgba(255, 255, 255, 0.03);
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
  font-size: 11px;
  color: var(--kobo-text-3);
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
  color: var(--kobo-turn-user);
}
.turn-badge-agent {
  background: rgba(121, 134, 203, 0.15);
  color: var(--kobo-turn-agent);
}
.turn-badge-system {
  background: rgba(117, 117, 117, 0.2);
  color: var(--kobo-text-2);
  font-style: italic;
}
.turn-badge-session {
  background: rgba(97, 97, 97, 0.2);
  color: var(--kobo-text-3);
}
.turn-badge-script {
  background: rgba(77, 182, 172, 0.15);
  color: var(--kobo-success);
}
.turn-time {
  color: var(--kobo-text-disabled);
  font-family: var(--kobo-font-mono);
  font-size: 11px;
}
.turn-time-arrow {
  margin: 0 -2px;
  opacity: 0.7;
}
.turn-time-updated {
  color: var(--kobo-text-3);
}
.turn-actions {
  color: var(--kobo-text-3);
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
