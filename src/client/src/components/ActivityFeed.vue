<script setup lang="ts">
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import { useWebSocketStore } from 'src/stores/websocket'
import type { ActivityItem } from 'src/stores/workspace'
import { useWorkspaceStore } from 'src/stores/workspace'
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'

function renderMarkdown(text: string): string {
  const html = marked.parse(text, { async: false, breaks: true, gfm: true }) as string
  return DOMPurify.sanitize(html)
}

const store = useWorkspaceStore()
const wsStore = useWebSocketStore()
const feedContainer = ref<HTMLElement | null>(null)
const expandedItems = ref<Set<string>>(new Set())

// Detect options in agent text messages (patterns like "- **A —" or "- **B —")
interface ParsedOption {
  key: string
  label: string
}

function parseOptions(content: string): { textBefore: string; options: ParsedOption[] } | null {
  // Match patterns like "- **A — Description**" or "- **A** — Description"
  const optionRegex = /^-\s*\*\*([A-Z])\s*[—–-]\s*(.+?)\*\*/gm
  const matches = [...content.matchAll(optionRegex)]
  if (matches.length < 2) return null // Need at least 2 options

  const firstMatchIndex = content.indexOf(matches[0][0])
  const textBefore = content.substring(0, firstMatchIndex).trim()

  const options: ParsedOption[] = matches.map((m) => ({
    key: m[1],
    label: `${m[1]} — ${m[2]}`,
  }))

  return { textBefore, options }
}

const parsedOptionsCache = new Map<string, ReturnType<typeof parseOptions>>()
function getCachedOptions(itemId: string, content: string) {
  if (!parsedOptionsCache.has(itemId)) {
    parsedOptionsCache.set(itemId, parseOptions(content))
  }
  return parsedOptionsCache.get(itemId)!
}

function sendOptionChoice(key: string) {
  const workspaceId = store.selectedWorkspaceId
  if (!workspaceId) return
  wsStore.sendChatMessage(workspaceId, key)
}

// Check if a text item is the latest and has options (only show buttons on the last one)
const lastTextItemId = computed(() => {
  const items = store.activityFeed
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].type === 'text') return items[i].id
  }
  return null
})

// Scroll to previous user message
const userMessageCursor = ref(-1)

function scrollToPreviousUserMessage() {
  const items = store.activityFeed
  const userItems = items.map((item, idx) => ({ item, idx })).filter(({ item }) => item.meta?.sender === 'user')

  if (userItems.length === 0) return

  // Move cursor backward (wraps around)
  if (userMessageCursor.value <= 0) {
    userMessageCursor.value = userItems.length - 1
  } else {
    userMessageCursor.value--
  }

  const targetId = userItems[userMessageCursor.value].item.id
  const el = feedContainer.value?.querySelector(`[data-item-id="${targetId}"]`)
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }
}

// Reset cursor when new items arrive
watch(
  () => store.activityFeed.length,
  () => {
    userMessageCursor.value = -1
  },
)

// Auto-scroll: stick to bottom unless user scrolled up
const isUserScrolledUp = ref(false)

function onFeedScroll() {
  const el = feedContainer.value
  if (!el) return
  // Consider "at bottom" if within 50px of the bottom
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50
  isUserScrolledUp.value = !atBottom
}

function scrollToBottom() {
  if (isUserScrolledUp.value) return
  const el = feedContainer.value
  if (!el) return
  el.scrollTop = el.scrollHeight
}

// Watch for new items and auto-scroll
watch(
  () => store.activityFeed.length,
  () => {
    nextTick(scrollToBottom)
  },
)

onMounted(() => {
  feedContainer.value?.addEventListener('scroll', onFeedScroll)
  nextTick(scrollToBottom)
})

onUnmounted(() => {
  feedContainer.value?.removeEventListener('scroll', onFeedScroll)
})

function formatTime(dateStr: string): string {
  const d = new Date(dateStr)
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function iconForToolUse(content: string): string {
  const lower = content.toLowerCase()
  if (lower.includes('read') || lower.includes('grep') || lower.includes('glob')) return 'search'
  if (lower.includes('write') || lower.includes('edit')) return 'edit'
  if (lower.includes('bash') || lower.includes('terminal')) return 'terminal'
  if (lower.includes('agent') || lower.includes('task')) return 'smart_toy'
  return 'build'
}

function itemClass(item: ActivityItem): string {
  switch (item.type) {
    case 'text': {
      if (item.meta?.sender === 'system-prompt') return 'af-item--prompt'
      if (item.meta?.sender === 'user') return 'af-item--user'
      return 'af-item--text'
    }
    case 'system':
      return 'af-item--system'
    case 'error':
      return 'af-item--error'
    case 'tool_use':
      return 'af-item--tool'
    case 'raw':
      return 'af-item--raw'
    default:
      return ''
  }
}

function senderLabel(item: ActivityItem): string {
  switch (item.meta?.sender) {
    case 'system-prompt':
      return 'Initial Prompt'
    case 'user':
      return 'You'
    default:
      return 'Agent'
  }
}

function senderColor(item: ActivityItem): string {
  switch (item.meta?.sender) {
    case 'system-prompt':
      return 'text-indigo-4'
    case 'user':
      return 'text-green-4'
    default:
      return 'text-blue-4'
  }
}

function hasExpandableArgs(item: ActivityItem): boolean {
  if (!item.meta) return false
  const meta = item.meta as Record<string, unknown>
  return meta.input !== undefined && meta.input !== null
}

function toggleExpand(itemId: string) {
  if (expandedItems.value.has(itemId)) {
    expandedItems.value.delete(itemId)
  } else {
    expandedItems.value.add(itemId)
  }
}

function isExpanded(itemId: string): boolean {
  return expandedItems.value.has(itemId)
}

function formatArgs(item: ActivityItem): string {
  if (!item.meta) return ''
  const meta = item.meta as Record<string, unknown>
  if (!meta.input) return ''
  try {
    return JSON.stringify(meta.input, null, 2)
  } catch {
    return String(meta.input)
  }
}
</script>

<template>
  <div ref="feedContainer" class="activity-feed q-pa-sm">
    <!-- Empty state -->
    <div
      v-if="store.activityFeed.length === 0"
      class="af-empty column items-center justify-center text-center q-pa-xl"
    >
      <q-icon name="forum" size="48px" color="grey-8" />
      <div class="text-grey-6 q-mt-md text-body2">No activity yet</div>
      <div class="text-grey-8 text-caption q-mt-xs">
        Start a workspace to see agent output here
      </div>
    </div>

    <!-- Feed items -->
    <div
      v-for="item in store.activityFeed"
      :key="item.id"
      :data-item-id="item.id"
      class="af-item text-caption rounded-borders"
      :class="itemClass(item)"
    >
      <!-- Tool use -->
      <template v-if="item.type === 'tool_use'">
        <div
          class="af-tool row items-center q-gutter-xs"
          :class="{ 'cursor-pointer': hasExpandableArgs(item) }"
          @click="hasExpandableArgs(item) && toggleExpand(item.id)"
        >
          <q-icon :name="iconForToolUse(item.content)" size="14px" color="grey-6" />
          <span class="af-tool-label text-grey-7">{{ item.content }}</span>
          <q-icon
            v-if="hasExpandableArgs(item)"
            :name="isExpanded(item.id) ? 'expand_less' : 'expand_more'"
            size="14px"
            color="grey-7"
          />
          <q-space />
          <span class="af-time">{{ formatTime(item.timestamp) }}</span>
        </div>
        <div v-if="isExpanded(item.id)" class="af-tool-args q-mt-xs rounded-borders">
          <pre class="af-args-pre">{{ formatArgs(item) }}</pre>
        </div>
      </template>

      <!-- Text (user or agent message) -->
      <template v-else-if="item.type === 'text'">
        <div class="af-text-header row items-center q-mb-xs">
          <span
            class="text-caption text-weight-bold"
            :class="senderColor(item)"
          >
            {{ senderLabel(item) }}
          </span>
          <q-spinner-dots v-if="item.meta?.pending" size="14px" color="grey-5" class="q-ml-sm" />
          <q-space />
          <span class="af-time">{{ formatTime(item.timestamp) }}</span>
        </div>
        <!-- Check for interactive options (A/B/C choices) -->
        <template v-if="getCachedOptions(item.id, item.content) && item.id === lastTextItemId">
          <div class="af-text-content af-markdown" v-html="renderMarkdown(getCachedOptions(item.id, item.content)!.textBefore)" />
          <div class="af-options q-mt-sm q-gutter-sm">
            <q-btn
              v-for="opt in getCachedOptions(item.id, item.content)!.options"
              :key="opt.key"
              no-caps
              outline
              dense
              color="indigo-4"
              class="af-option-btn"
              @click="sendOptionChoice(opt.key)"
            >
              <span class="text-weight-bold q-mr-xs">{{ opt.key }}</span>
              {{ opt.label.substring(opt.key.length + 3) }}
            </q-btn>
          </div>
        </template>
        <template v-else>
          <div class="af-text-content af-markdown" v-html="renderMarkdown(item.content)" />
        </template>
      </template>

      <!-- System -->
      <template v-else-if="item.type === 'system'">
        <div class="row items-center">
          <q-icon name="info" size="14px" color="amber-6" class="q-mr-xs" />
          <span class="af-system-content text-caption text-amber-6">{{ item.content }}</span>
          <q-space />
          <span class="af-time">{{ formatTime(item.timestamp) }}</span>
        </div>
      </template>

      <!-- Error -->
      <template v-else-if="item.type === 'error'">
        <div class="row items-center">
          <q-icon name="error" size="14px" color="red-5" class="q-mr-xs" />
          <span class="af-error-content text-red-5">{{ item.content }}</span>
          <q-space />
          <span class="af-time">{{ formatTime(item.timestamp) }}</span>
        </div>
      </template>

      <!-- Raw -->
      <template v-else>
        <div class="row items-center">
          <span class="af-raw-content text-grey-7">{{ item.content }}</span>
          <q-space />
          <span class="af-time">{{ formatTime(item.timestamp) }}</span>
        </div>
      </template>
    </div>

    <!-- Scroll to user message button -->
    <q-btn
      v-if="store.activityFeed.some(i => i.meta?.sender === 'user')"
      round
      dense
      size="sm"
      icon="person_search"
      color="indigo-8"
      class="scroll-to-user-btn"
      @click="scrollToPreviousUserMessage"
    >
      <q-tooltip>Go to your messages</q-tooltip>
    </q-btn>
  </div>
</template>

<style lang="scss" scoped>
.activity-feed {
  overflow-y: auto;
  overflow-x: hidden;
  display: flex;
  position: relative;
  flex-direction: column;
  gap: 4px;
}

.af-item {
  padding: 6px 10px;
  overflow-x: hidden;
  word-break: break-word;
  overflow-wrap: break-word;
  flex-shrink: 0;
}

.af-time {
  font-size: 10px;
  color: #555;
  flex-shrink: 0;
}

.af-tool-label {
  font-family: 'Roboto Mono', monospace;
  font-size: 11px;
}

.af-tool-args {
  padding: 6px 8px;
  background-color: rgba(255, 255, 255, 0.04);
  overflow-x: auto;
}

.af-args-pre {
  margin: 0;
  font-family: 'Roboto Mono', monospace;
  font-size: 10px;
  color: #888;
  white-space: pre-wrap;
  word-break: break-word;
}

// Text (agent)
.af-item--text {
  background-color: #1a2a3a;
  border-left: 3px solid #3b82f6;
}

.af-item--user {
  background-color: #1a2a1a;
  border-left: 3px solid #22c55e;
}

.af-item--prompt {
  background-color: #1a1a2e;
  border-left: 3px solid #6c63ff;
}

.af-text-content {
  color: #d0d0d0;
  word-break: break-word;
  line-height: 1.5;
}

.af-markdown {
  :deep(p) {
    margin: 0 0 8px 0;
    &:last-child { margin-bottom: 0; }
  }
  :deep(h1), :deep(h2), :deep(h3) {
    margin: 12px 0 6px 0;
    color: #e0e0e0;
  }
  :deep(h1) { font-size: 16px; }
  :deep(h2) { font-size: 14px; }
  :deep(h3) { font-size: 13px; }
  :deep(ul), :deep(ol) {
    margin: 4px 0;
    padding-left: 20px;
  }
  :deep(li) { margin: 2px 0; }
  :deep(code) {
    background-color: rgba(255, 255, 255, 0.08);
    padding: 1px 4px;
    border-radius: 3px;
    font-family: 'Roboto Mono', monospace;
    font-size: 11px;
  }
  :deep(pre) {
    background-color: rgba(0, 0, 0, 0.3);
    padding: 8px;
    border-radius: 4px;
    overflow-x: auto;
    margin: 6px 0;
    code {
      background: none;
      padding: 0;
    }
  }
  :deep(strong) { color: #fff; }
  :deep(a) { color: #6c63ff; }
  :deep(blockquote) {
    border-left: 3px solid #6c63ff;
    margin: 6px 0;
    padding: 4px 12px;
    color: #aaa;
  }
  :deep(table) {
    border-collapse: collapse;
    margin: 6px 0;
    font-size: 11px;
    th, td {
      border: 1px solid #2a2a4a;
      padding: 4px 8px;
    }
    th { background-color: rgba(255, 255, 255, 0.05); }
  }
}

// System
.af-item--system {
  background-color: #2a2a1a;
  border-left: 3px solid #f59e0b;
}

.af-system-content {
  white-space: pre-wrap;
}

// Error
.af-item--error {
  background-color: #2a1a1a;
  border-left: 3px solid #ef4444;
}

// Raw
.af-item--raw {
  font-family: 'Roboto Mono', monospace;
  white-space: pre-wrap;
}
.scroll-to-user-btn {
  position: sticky;
  bottom: 8px;
  align-self: flex-end;
  margin-right: 8px;
  opacity: 0.7;
  transition: opacity 0.15s;

  &:hover {
    opacity: 1;
  }
}
</style>
