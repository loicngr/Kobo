<script setup lang="ts">
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import { useWebSocketStore } from 'src/stores/websocket'
import type { ActivityItem } from 'src/stores/workspace'
import { useWorkspaceStore } from 'src/stores/workspace'
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

function renderMarkdown(text: string): string {
  const html = marked.parse(text, { async: false, breaks: true, gfm: true }) as string
  return DOMPurify.sanitize(html)
}

const { t } = useI18n()
const store = useWorkspaceStore()
const wsStore = useWebSocketStore()
const feedContainer = ref<HTMLElement | null>(null)
const isLoadingMore = ref(false)
const expandedItems = ref<Set<string>>(new Set())

// Cache for getAskUserQuestions — avoids double-call in v-if + v-for
const askUserCache = new Map<string, AskUserQuestion[] | null>()
function getCachedAskUser(itemId: string, item: ActivityItem): AskUserQuestion[] | null {
  if (!askUserCache.has(itemId)) {
    askUserCache.set(itemId, getAskUserQuestions(item))
  }
  return askUserCache.get(itemId)!
}

// Cache for renderMarkdown — avoids re-rendering on every re-render
const markdownCache = new Map<string, string>()
function getCachedMarkdown(id: string, content: string): string {
  if (!markdownCache.has(id)) {
    markdownCache.set(id, renderMarkdown(content))
  }
  return markdownCache.get(id)!
}

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

// Multi-question answer selection state: Map<itemId, Map<questionIndex, selectedOptionIndex>>
const askSelections = ref(new Map<string, Map<number, number>>())

function toggleAskSelection(itemId: string, questionIndex: number, optionIndex: number) {
  if (!askSelections.value.has(itemId)) {
    askSelections.value.set(itemId, new Map())
  }
  const selections = askSelections.value.get(itemId)!
  if (selections.get(questionIndex) === optionIndex) {
    selections.delete(questionIndex)
  } else {
    selections.set(questionIndex, optionIndex)
  }
}

function isAskSelected(itemId: string, questionIndex: number, optionIndex: number): boolean {
  return askSelections.value.get(itemId)?.get(questionIndex) === optionIndex
}

function hasAnySelection(itemId: string): boolean {
  const sel = askSelections.value.get(itemId)
  return !!sel && sel.size > 0
}

function sendAskAnswers(itemId: string, questions: AskUserQuestion[]) {
  const workspaceId = store.selectedWorkspaceId
  if (!workspaceId) return
  const selections = askSelections.value.get(itemId)
  if (!selections || selections.size === 0) return

  const lines: string[] = []
  for (const [qi, oi] of selections.entries()) {
    const q = questions[qi]
    if (!q) continue
    const opt = q.options[oi]
    if (!opt) continue
    lines.push(`${q.question}: ${opt.label}`)
  }
  if (lines.length > 0) {
    wsStore.sendChatMessage(workspaceId, lines.join('\n'))
  }
}

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

// Reset cursor and clear caches when workspace changes (not on every new message)
watch(
  () => store.selectedWorkspaceId,
  () => {
    userMessageCursor.value = -1
    askUserCache.clear()
    askSelections.value.clear()
    markdownCache.clear()
    lastScrollTop = 0
    isLoadingMore.value = false
  },
)

// Infinite scroll: only render the last N items, load more when user scrolls up
const INITIAL_COUNT = 50
const LOAD_STEP = 50
const displayCount = ref(INITIAL_COUNT)

const visibleItems = computed(() => {
  const items = store.activityFeed
  if (items.length <= displayCount.value) return items
  return items.slice(-displayCount.value)
})

// Reset display count when workspace changes (but not when new items arrive)
watch(
  () => store.selectedWorkspaceId,
  () => {
    displayCount.value = INITIAL_COUNT
  },
)

// Clean up caches for items ejected by MAX_FEED_ITEMS cap (I2)
watch(
  visibleItems,
  (items) => {
    const visibleIds = new Set(items.map((i) => i.id))
    for (const key of askUserCache.keys()) {
      if (!visibleIds.has(key)) askUserCache.delete(key)
    }
    for (const key of askSelections.value.keys()) {
      if (!visibleIds.has(key)) askSelections.value.delete(key)
    }
    for (const key of markdownCache.keys()) {
      if (!visibleIds.has(key)) markdownCache.delete(key)
    }
  },
  { flush: 'post' },
)

// Auto-scroll: stick to bottom unless user scrolled up.
// We track the previous scrollTop to distinguish user scrolls (up) from
// programmatic/content-growth scrolls that shift the position.
const isUserScrolledUp = ref(false)
let lastScrollTop = 0

function onFeedScroll() {
  const el = feedContainer.value
  if (!el) return
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50

  if (atBottom) {
    // User scrolled back to the bottom — re-enable auto-scroll
    isUserScrolledUp.value = false
  } else if (el.scrollTop < lastScrollTop) {
    // User scrolled UP — disable auto-scroll
    isUserScrolledUp.value = true
  }
  // If scrollTop increased (content grew or programmatic scroll), don't change the flag

  lastScrollTop = el.scrollTop

  // Load more older items when user scrolls near the top
  if (el.scrollTop < 200 && !isLoadingMore.value) {
    const total = store.activityFeed.length
    if (displayCount.value < total) {
      // Reveal more in-memory items first
      isLoadingMore.value = true
      const prevScrollHeight = el.scrollHeight
      displayCount.value = Math.min(displayCount.value + LOAD_STEP, total)
      nextTick(() => {
        if (feedContainer.value) {
          feedContainer.value.scrollTop += feedContainer.value.scrollHeight - prevScrollHeight
        }
        isLoadingMore.value = false
      })
    } else if (store.selectedWorkspaceId && store.hasMoreEvents[store.selectedWorkspaceId] !== false) {
      // All in-memory items shown — fetch older events from server
      isLoadingMore.value = true
      const prevScrollHeight = el.scrollHeight
      store.fetchOlderEvents(store.selectedWorkspaceId).then((loaded) => {
        if (loaded) {
          // More items were added to the feed — increase display count
          displayCount.value = store.activityFeed.length
          nextTick(() => {
            if (feedContainer.value) {
              feedContainer.value.scrollTop += feedContainer.value.scrollHeight - prevScrollHeight
            }
            isLoadingMore.value = false
          })
        } else {
          isLoadingMore.value = false
        }
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

function jumpToBottom() {
  isUserScrolledUp.value = false
  displayCount.value = INITIAL_COUNT
  nextTick(() => {
    const el = feedContainer.value
    if (el) el.scrollTop = el.scrollHeight
  })
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
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

// ── Inline diff rendering for Edit/Write tool calls ───────────────────────────

interface FileChangeInfo {
  toolName: 'Edit' | 'Write' | 'Bash:rm'
  filePath: string
  oldString?: string
  newString?: string
  content?: string
  replaceAll?: boolean
  additions: number
  deletions: number
}

function getFileChangeInfo(item: ActivityItem): FileChangeInfo | null {
  if (item.type !== 'tool_use') return null
  const input = (item.meta as Record<string, unknown>)?.input as Record<string, unknown> | undefined

  if (item.content === 'Edit') {
    if (!input?.file_path) return null
    const filePath = input.file_path as string
    const oldStr = (input.old_string as string) ?? ''
    const newStr = (input.new_string as string) ?? ''
    const oldLines = oldStr.split('\n')
    const newLines = newStr.split('\n')
    return {
      toolName: 'Edit',
      filePath,
      oldString: oldStr,
      newString: newStr,
      replaceAll: (input.replace_all as boolean) ?? false,
      additions: newLines.length,
      deletions: oldLines.length,
    }
  }

  if (item.content === 'Write') {
    if (!input?.file_path) return null
    const filePath = input.file_path as string
    const content = (input.content as string) ?? ''
    const lines = content.split('\n').length
    return {
      toolName: 'Write',
      filePath,
      content,
      additions: lines,
      deletions: 0,
    }
  }

  // Bash — detect rm/unlink commands
  if (item.content === 'Bash') {
    const cmd = (input?.command as string) ?? ''
    const rmMatch = cmd.match(/^\s*rm\s+(?:-[a-zA-Z]*\s+)*(.+)/)
    if (rmMatch) {
      const filePath = rmMatch[1].trim().replace(/["']/g, '')
      return {
        toolName: 'Bash:rm',
        filePath,
        additions: 0,
        deletions: 1,
      }
    }
  }

  return null
}

function shortenFilePath(filePath: string): string {
  const ws = store.selectedWorkspace
  if (ws) {
    const worktreePrefix = `${ws.projectPath}/.worktrees/${ws.workingBranch}/`
    if (filePath.startsWith(worktreePrefix)) return filePath.slice(worktreePrefix.length)
    if (filePath.startsWith(`${ws.projectPath}/`)) return filePath.slice(ws.projectPath.length + 1)
  }
  // For any absolute path, show only the last 3 segments
  if (filePath.startsWith('/') && filePath.split('/').length > 4) {
    const parts = filePath.split('/')
    return `…/${parts.slice(-3).join('/')}`
  }
  return filePath
}

function fileBasename(filePath: string): string {
  return filePath.split('/').pop() ?? filePath
}

function fileExtension(filePath: string): string {
  const name = fileBasename(filePath)
  const dot = name.lastIndexOf('.')
  return dot >= 0 ? name.substring(dot + 1) : ''
}

function langIconForExt(ext: string): string {
  const map: Record<string, string> = {
    ts: 'JS',
    tsx: 'TS',
    js: 'JS',
    jsx: 'JS',
    vue: 'VU',
    py: 'PY',
    rs: 'RS',
    go: 'GO',
    java: 'JA',
    php: 'PH',
    css: 'CS',
    scss: 'SC',
    html: 'HT',
    md: 'MD',
    json: 'JS',
    sql: 'SQ',
    sh: 'SH',
    yaml: 'YA',
    yml: 'YA',
    toml: 'TM',
  }
  return map[ext.toLowerCase()] ?? ext.substring(0, 2).toUpperCase()
}

function iconColorForExt(ext: string): string {
  const map: Record<string, string> = {
    ts: 'blue-5',
    tsx: 'blue-5',
    js: 'yellow-8',
    jsx: 'yellow-8',
    vue: 'green-5',
    py: 'blue-4',
    rs: 'orange-5',
    go: 'cyan-5',
    java: 'red-5',
    php: 'indigo-4',
    css: 'purple-4',
    scss: 'pink-4',
    html: 'orange-4',
    md: 'grey-5',
    json: 'yellow-6',
  }
  return map[ext.toLowerCase()] ?? 'grey-5'
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
      return t('activityFeed.initialPrompt')
    case 'user':
      return t('activityFeed.you')
    default:
      return t('activityFeed.agent')
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
  if (!input) return ''
  if (typeof input.description === 'string') return input.description
  if (typeof input.file_path === 'string') return shortenFilePath(input.file_path as string)
  if (typeof input.pattern === 'string') {
    const base = typeof input.path === 'string' ? `${shortenFilePath(input.path as string)}/` : ''
    return `${base}${input.pattern}`
  }
  if (typeof input.path === 'string') return shortenFilePath(input.path as string)
  if (typeof input.command === 'string') {
    const cmd = input.command as string
    return cmd.length > 80 ? `${cmd.slice(0, 80)}…` : cmd
  }
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

// M11: extract template .some() into a computed
const hasUserMessages = computed(() => store.activityFeed.some((i) => i.meta?.sender === 'user'))

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
      <div class="text-grey-6 q-mt-md text-body2">{{ $t('activityFeed.empty') }}</div>
      <div class="text-grey-8 text-caption q-mt-xs">
        {{ $t('activityFeed.emptyHint') }}
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
      <template v-if="item.type === 'tool_use' && getCachedAskUser(item.id, item)">
        <div class="af-tool row items-center q-gutter-xs">
          <q-icon name="help_outline" size="14px" color="indigo-4" />
          <span class="af-tool-label text-indigo-4">{{ $t('activityFeed.question') }}</span>
          <q-space />
          <span class="af-time">{{ formatTime(item.timestamp) }}</span>
        </div>
        <div v-for="(q, qi) in getCachedAskUser(item.id, item)" :key="qi" class="q-mt-sm">
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
              dense
              :outline="!isAskSelected(item.id, qi, oi)"
              :unelevated="isAskSelected(item.id, qi, oi)"
              :color="isAskSelected(item.id, qi, oi) ? 'indigo-6' : 'indigo-4'"
              :text-color="isAskSelected(item.id, qi, oi) ? 'white' : undefined"
              class="af-option-btn"
              @click="toggleAskSelection(item.id, qi, oi)"
            >
              {{ opt.label }}
            </q-btn>
          </div>
        </div>
        <div v-if="item.id === activeAskId" class="q-mt-sm row justify-end">
          <q-btn
            no-caps
            unelevated
            dense
            color="indigo-6"
            :label="$t('activityFeed.sendAnswers')"
            icon="send"
            :disable="!hasAnySelection(item.id)"
            @click="sendAskAnswers(item.id, getCachedAskUser(item.id, item)!)"
          />
        </div>
      </template>

      <!-- Tool use: Edit / Write — inline diff -->
      <template v-else-if="item.type === 'tool_use' && getFileChangeInfo(item)">
        <div
          class="af-file-change cursor-pointer"
          @click="toggleExpand(item.id)"
        >
          <div class="af-file-header row items-center no-wrap q-gutter-xs">
            <span
              class="af-lang-badge"
              :class="`text-${iconColorForExt(fileExtension(getFileChangeInfo(item)!.filePath))}`"
            >{{ langIconForExt(fileExtension(getFileChangeInfo(item)!.filePath)) }}</span>
            <span class="af-file-path text-grey-4 ellipsis">{{ shortenFilePath(getFileChangeInfo(item)!.filePath) }}</span>
            <span class="af-diff-stats">
              <span v-if="getFileChangeInfo(item)!.additions" class="text-green-5">+{{ getFileChangeInfo(item)!.additions }}</span>
              <span v-if="getFileChangeInfo(item)!.deletions" class="text-red-5 q-ml-xs">-{{ getFileChangeInfo(item)!.deletions }}</span>
            </span>
            <q-icon
              :name="isExpanded(item.id) ? 'expand_less' : 'expand_more'"
              size="14px"
              color="grey-6"
            />
            <q-space />
            <span class="af-time">{{ formatTime(item.timestamp) }}</span>
          </div>
          <div v-if="isExpanded(item.id)" class="af-diff-body q-mt-xs" @click.stop>
            <template v-if="getFileChangeInfo(item)!.toolName === 'Edit'">
              <div
                v-for="(line, li) in (getFileChangeInfo(item)!.oldString ?? '').split('\n')"
                :key="`del-${li}`"
                class="af-diff-line af-diff-del"
              ><span class="af-diff-sign">-</span>{{ line }}</div>
              <div
                v-for="(line, li) in (getFileChangeInfo(item)!.newString ?? '').split('\n')"
                :key="`add-${li}`"
                class="af-diff-line af-diff-add"
              ><span class="af-diff-sign">+</span>{{ line }}</div>
            </template>
            <template v-else-if="getFileChangeInfo(item)!.toolName === 'Bash:rm'">
              <div class="af-diff-line af-diff-del"><span class="af-diff-sign">-</span>File deleted</div>
            </template>
            <template v-else>
              <div
                v-for="(line, li) in (getFileChangeInfo(item)!.content ?? '').split('\n').slice(0, 30)"
                :key="`w-${li}`"
                class="af-diff-line af-diff-add"
              ><span class="af-diff-sign">+</span>{{ line }}</div>
              <div
                v-if="(getFileChangeInfo(item)!.content ?? '').split('\n').length > 30"
                class="af-diff-line text-grey-7 text-italic"
              >… {{ (getFileChangeInfo(item)!.content ?? '').split('\n').length - 30 }} more lines</div>
            </template>
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
        <div class="af-text-content af-markdown" v-html="getCachedMarkdown(item.id, item.content)" />
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

    <!-- Sticky bottom buttons -->
    <div class="scroll-buttons">
      <q-btn
        v-if="hasUserMessages"
        round
        dense
        size="sm"
        icon="person_search"
        color="indigo-8"
        class="scroll-btn"
        @click="scrollToPreviousUserMessage"
      >
        <q-tooltip>{{ $t('activityFeed.goToPrevious') }}</q-tooltip>
      </q-btn>
      <q-btn
        v-if="isUserScrolledUp"
        round
        dense
        size="sm"
        icon="keyboard_double_arrow_down"
        color="indigo-8"
        class="scroll-btn"
        @click="jumpToBottom"
      >
        <q-tooltip>{{ $t('activityFeed.scrollToBottom') }}</q-tooltip>
      </q-btn>
    </div>
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

// File change (Edit/Write) inline diff
.af-file-change {
  padding: 6px 8px;
  background: rgba(255, 255, 255, 0.03);
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.06);
}

.af-file-header {
  font-size: 11px;
  font-family: 'Roboto Mono', monospace;
}

.af-lang-badge {
  font-size: 9px;
  font-weight: 700;
  font-family: 'Roboto Mono', monospace;
  background: rgba(255, 255, 255, 0.06);
  padding: 1px 4px;
  border-radius: 3px;
  min-width: 20px;
  text-align: center;
}

.af-file-path {
  font-size: 11px;
  max-width: 70%;
}

.af-diff-stats {
  font-size: 10px;
  font-family: 'Roboto Mono', monospace;
  white-space: nowrap;
}

.af-diff-body {
  background: rgba(0, 0, 0, 0.2);
  border-radius: 4px;
  padding: 4px 0;
  max-height: 300px;
  overflow-y: auto;
  overflow-x: auto;
}

.af-diff-line {
  font-family: 'Roboto Mono', monospace;
  font-size: 10px;
  padding: 0 8px;
  white-space: pre;
  line-height: 1.5;
  min-width: fit-content;
}

.af-diff-sign {
  display: inline-block;
  width: 12px;
  user-select: none;
}

.af-diff-del {
  background: rgba(248, 81, 73, 0.1);
  color: #f85149;
}

.af-diff-add {
  background: rgba(63, 185, 80, 0.1);
  color: #3fb950;
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
.scroll-buttons {
  position: sticky;
  bottom: 8px;
  align-self: flex-end;
  margin-right: 8px;
  display: flex;
  gap: 6px;
}

.scroll-btn {
  opacity: 0.7;
  transition: opacity 0.15s;

  &:hover {
    opacity: 1;
  }
}
</style>
