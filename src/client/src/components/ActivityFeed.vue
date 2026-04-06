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
const isLoadingMore = ref(false)
const expandedItems = ref<Set<string>>(new Set())

// Detect options in agent text messages (patterns like "- **A —" or "- **B —")
interface ParsedOption {
  key: string
  label: string
}

function parseOptions(content: string): { textBefore: string; options: ParsedOption[] } | null {
  // Pattern 1: "- **A — Description**"
  const letterRegex = /^-\s*\*\*([A-Z])\s*[—–-]\s*(.+?)\*\*/gm
  const letterMatches = [...content.matchAll(letterRegex)]
  if (letterMatches.length >= 2) {
    const firstMatchIndex = content.indexOf(letterMatches[0][0])
    return {
      textBefore: content.substring(0, firstMatchIndex).trim(),
      options: letterMatches.map((m) => ({
        key: m[1],
        label: `${m[1]} — ${m[2]}`,
      })),
    }
  }

  // Pattern 2: "1. **Label** — Description" or "1. **Label —** Description"
  const numberedRegex = /^\d+\.\s*\*\*(.+?)\*\*\s*[—–-]\s*(.+)/gm
  const numberedMatches = [...content.matchAll(numberedRegex)]
  if (numberedMatches.length >= 2) {
    const firstMatchIndex = content.indexOf(numberedMatches[0][0])
    return {
      textBefore: content.substring(0, firstMatchIndex).trim(),
      options: numberedMatches.map((m, i) => ({
        key: String(i + 1),
        label: `${m[1]} — ${m[2]}`,
      })),
    }
  }

  // Pattern 3: "- **Label** — Description" or "- **Label** (extra) — Description"
  // Use [^\S\n] instead of \s to prevent matching across line boundaries
  const bulletBoldRegex = /^[-•][^\S\n]*\*\*(.+?)\*\*[^\S\n]*(?:\([^)]*\)[^\S\n]*)?[—–-][^\S\n]*(.+)/gm
  const bulletBoldMatches = [...content.matchAll(bulletBoldRegex)]
  if (bulletBoldMatches.length >= 2) {
    const firstMatchIndex = content.indexOf(bulletBoldMatches[0][0])
    return {
      textBefore: content.substring(0, firstMatchIndex).trim(),
      options: bulletBoldMatches.map((m, i) => ({
        key: String(i + 1),
        label: `${m[1]} — ${m[2]}`,
      })),
    }
  }

  // Pattern 4: "- **Label**" or "- **Label** (extra)" — simple bold bullet list without description
  const simpleBulletRegex = /^[-•][^\S\n]*\*\*(.+?)\*\*[^\S\n]*(?:\(([^)]*)\))?[^\S\n]*$/gm
  const simpleBulletMatches = [...content.matchAll(simpleBulletRegex)]
  if (simpleBulletMatches.length >= 2) {
    const firstMatchIndex = content.indexOf(simpleBulletMatches[0][0])
    return {
      textBefore: content.substring(0, firstMatchIndex).trim(),
      options: simpleBulletMatches.map((m, i) => ({
        key: String(i + 1),
        label: m[2] ? `${m[1]} (${m[2]})` : m[1],
      })),
    }
  }

  return null
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

// Show AskUserQuestion buttons only if the user hasn't replied yet.
// Scan backwards: user message before finding the question → answered.
// AskUserQuestion found first → active. Everything else is skipped.
const activeAskId = computed(() => {
  const items = store.activityFeed
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    if (item.meta?.sender === 'user') return null
    if (item.type === 'tool_use' && item.content === 'AskUserQuestion') return item.id
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

  const targetIdx = userItems[userMessageCursor.value].idx
  const targetId = userItems[userMessageCursor.value].item.id

  // Ensure the target item is loaded (increase displayCount if needed)
  const itemsFromEnd = items.length - targetIdx
  if (itemsFromEnd > displayCount.value) {
    displayCount.value = Math.min(itemsFromEnd + 10, items.length)
  }

  // Wait for DOM update before scrolling
  nextTick(() => {
    const el = feedContainer.value?.querySelector(`[data-item-id="${targetId}"]`)
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  })
}

// Reset cursor when workspace changes (not on every new message)
watch(
  () => store.selectedWorkspaceId,
  () => {
    userMessageCursor.value = -1
  },
)

// Infinite scroll: only render the last N items, load more when user scrolls up
const INITIAL_COUNT = 50
const LOAD_STEP = 50
const displayCount = ref(INITIAL_COUNT)

// Reset display count when workspace changes (but not when new items arrive)
watch(
  () => store.selectedWorkspaceId,
  () => {
    displayCount.value = INITIAL_COUNT
  },
)

const visibleItems = computed(() => {
  const items = store.activityFeed
  if (items.length <= displayCount.value) return items
  return items.slice(-displayCount.value)
})

// Auto-scroll: stick to bottom unless user scrolled up
const isUserScrolledUp = ref(false)

function onFeedScroll() {
  const el = feedContainer.value
  if (!el) return
  // Consider "at bottom" if within 50px of the bottom
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50
  isUserScrolledUp.value = !atBottom

  // Load more older items when user scrolls near the top
  if (el.scrollTop < 200 && !isLoadingMore.value) {
    const total = store.activityFeed.length
    if (displayCount.value < total) {
      isLoadingMore.value = true
      const prevScrollHeight = el.scrollHeight
      displayCount.value = Math.min(displayCount.value + LOAD_STEP, total)
      // Preserve scroll position after new items are prepended
      nextTick(() => {
        if (feedContainer.value) {
          feedContainer.value.scrollTop += feedContainer.value.scrollHeight - prevScrollHeight
        }
        isLoadingMore.value = false
      })
    }
  }
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

function toolDisplayName(item: ActivityItem): string {
  if (item.content === 'Skill' && item.meta) {
    const input = (item.meta as Record<string, unknown>).input as Record<string, unknown> | undefined
    if (input && typeof input.skill === 'string') return `Skill — ${input.skill}`
  }
  return item.content
}

function toolDescription(item: ActivityItem): string {
  if (!item.meta) return ''
  const input = (item.meta as Record<string, unknown>).input as Record<string, unknown> | undefined
  if (input && typeof input.description === 'string') return input.description
  return ''
}

interface AskUserOption {
  label: string
  description?: string
}

interface AskUserQuestion {
  question: string
  options: AskUserOption[]
}

function getAskUserQuestions(item: ActivityItem): AskUserQuestion[] | null {
  if (item.type !== 'tool_use' || item.content !== 'AskUserQuestion') return null
  const input = (item.meta as Record<string, unknown>)?.input as Record<string, unknown> | undefined
  if (!input?.questions || !Array.isArray(input.questions)) return null
  const questions = input.questions as Array<Record<string, unknown>>
  return questions
    .filter((q) => Array.isArray(q.options) && q.options.length > 0)
    .map((q) => ({
      question: (q.question as string) ?? '',
      options: (q.options as Array<Record<string, unknown>>).map((o) => ({
        label: (o.label as string) ?? '',
        description: (o.description as string) ?? '',
      })),
    }))
}

function sendQuestionAnswer(label: string) {
  const workspaceId = store.selectedWorkspaceId
  if (!workspaceId) return
  wsStore.sendChatMessage(workspaceId, label)
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

function hasSystemDetails(item: ActivityItem): boolean {
  if (item.type !== 'system' || !item.meta) return false
  return Object.keys(item.meta).length > 0
}

function formatSystemDetails(item: ActivityItem): string {
  if (!item.meta) return ''
  try {
    return JSON.stringify(item.meta, null, 2)
  } catch {
    return ''
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

    <!-- Loading indicator shown at the top when user scrolls up and more items are available -->
    <div v-if="isLoadingMore" class="row justify-center q-my-sm">
      <q-spinner-dots size="24px" color="grey-6" />
    </div>
    <div
      v-for="item in visibleItems"
      :key="item.id"
      :data-item-id="item.id"
      class="af-item text-caption rounded-borders"
      :class="itemClass(item)"
    >
      <!-- Tool use: AskUserQuestion -->
      <template v-if="item.type === 'tool_use' && getAskUserQuestions(item)">
        <div class="af-tool row items-center q-gutter-xs">
          <q-icon name="help_outline" size="14px" color="indigo-4" />
          <span class="af-tool-label text-indigo-4">Question</span>
          <q-space />
          <span class="af-time">{{ formatTime(item.timestamp) }}</span>
        </div>
        <div v-for="(q, qi) in getAskUserQuestions(item)" :key="qi" class="q-mt-sm">
          <div v-if="q.question" class="text-grey-4 q-mb-xs">{{ q.question }}</div>
          <div class="af-ask-options-list q-mb-sm">
            <div v-for="(opt, oi) in q.options" :key="oi" class="af-ask-option-item text-caption text-grey-5">
              <span class="text-weight-bold text-grey-3">{{ oi + 1 }}. {{ opt.label }}</span>
              <span v-if="opt.description"> — {{ opt.description }}</span>
            </div>
          </div>
          <div v-if="item.id === activeAskId" class="af-ask-buttons q-gutter-xs">
            <q-btn
              v-for="(opt, oi) in q.options"
              :key="opt.label"
              no-caps
              outline
              dense
              color="indigo-4"
              class="af-option-btn"
              @click="sendQuestionAnswer(`${oi + 1}. ${opt.label}`)"
            >
              {{ opt.label }}
            </q-btn>
          </div>
        </div>
      </template>

      <!-- Tool use: generic -->
      <template v-else-if="item.type === 'tool_use'">
        <div
          class="af-tool row items-center q-gutter-xs"
          :class="{ 'cursor-pointer': hasExpandableArgs(item) }"
          @click="hasExpandableArgs(item) && toggleExpand(item.id)"
        >
          <q-icon :name="iconForToolUse(item.content)" size="14px" color="grey-6" />
          <span class="af-tool-label text-grey-7">{{ toolDisplayName(item) }}</span>
          <span v-if="toolDescription(item)" class="af-tool-desc text-grey-8">— {{ toolDescription(item) }}</span>
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
        <div class="af-text-content af-markdown" v-html="renderMarkdown(item.content)" />
        <!-- Quick-reply buttons when options detected -->
        <div
          v-if="getCachedOptions(item.id, item.content) && item.id === lastTextItemId"
          class="af-options q-mt-sm q-gutter-xs"
        >
          <q-btn
            v-for="opt in getCachedOptions(item.id, item.content)!.options"
            :key="opt.key"
            no-caps
            outline
            dense
            color="indigo-4"
            class="af-option-btn"
            @click="sendOptionChoice(`${opt.key}. ${opt.label}`)"
          >
            {{ opt.label }}
          </q-btn>
        </div>
      </template>

      <!-- System -->
      <template v-else-if="item.type === 'system'">
        <div
          class="row items-center"
          :class="{ 'cursor-pointer': hasSystemDetails(item) }"
          @click="hasSystemDetails(item) && toggleExpand(item.id)"
        >
          <q-icon name="info" size="14px" color="amber-6" class="q-mr-xs" />
          <span class="af-system-content text-caption text-amber-6">{{ item.content }}</span>
          <q-icon
            v-if="hasSystemDetails(item)"
            :name="isExpanded(item.id) ? 'expand_less' : 'expand_more'"
            size="14px"
            color="amber-8"
            class="q-ml-xs"
          />
          <q-space />
          <span class="af-time">{{ formatTime(item.timestamp) }}</span>
        </div>
        <div v-if="isExpanded(item.id) && hasSystemDetails(item)" class="af-system-details q-mt-xs rounded-borders">
          <pre class="af-args-pre">{{ formatSystemDetails(item) }}</pre>
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
      <q-tooltip>Go to previous message</q-tooltip>
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

.af-tool-desc {
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.af-ask-option-item {
  padding: 2px 0;
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

.af-system-details {
  padding: 6px 8px;
  background-color: rgba(255, 255, 255, 0.04);
  overflow-x: auto;
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
