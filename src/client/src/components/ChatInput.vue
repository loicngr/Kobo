<script setup lang="ts">
import type { QInput } from 'quasar'
import { useQuasar } from 'quasar'
import { useTemplatesStore } from 'src/stores/templates'
import { useWebSocketStore } from 'src/stores/websocket'
import { useWorkspaceStore } from 'src/stores/workspace'
import { KOBO_COMMANDS } from 'src/utils/kobo-commands'
import { buildTemplateVars, expandTemplate } from 'src/utils/expand-template'
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps<{
  workspaceId: string
}>()

const { t } = useI18n()
const $q = useQuasar()
const store = useWorkspaceStore()
const wsStore = useWebSocketStore()
const templatesStore = useTemplatesStore()
const message = ref('')

// Chat input element ref (for caret position access)
const chatInputRef = ref<InstanceType<typeof QInput> | null>(null)

/**
 * Returns the underlying `<textarea>` (or `<input>`) element of the chat
 * input, using Quasar's public API. Returns null before the component has
 * mounted or if the input hasn't been rendered yet.
 */
function getChatInputEl(): HTMLTextAreaElement | HTMLInputElement | null {
  const inst = chatInputRef.value
  if (!inst) return null
  // getNativeElement() is the documented Quasar v2 method — returns the
  // underlying DOM element held by the component.
  const el = inst.getNativeElement?.()
  return (el as HTMLTextAreaElement | HTMLInputElement | null) ?? null
}

// Skills autocomplete
const skills = ref<string[]>([])
const showSkills = ref(false)
const skillFilter = ref('')
const selectedSkillIndex = ref(0)

// Dropdown item type
interface DropdownItem {
  type: 'skill' | 'kobo' | 'template'
  name: string
  description?: string
}

const groupedDropdown = computed<{ skills: DropdownItem[]; kobo: DropdownItem[]; templates: DropdownItem[] }>(() => {
  const q = skillFilter.value.toLowerCase()
  const matches = (name: string) => (q === '' ? true : name.toLowerCase().includes(q))

  // Claude skills come from the existing `skills.value` list (no description available)
  const claudeSkills = skills.value
    .filter((s) => matches(s))
    .map<DropdownItem>((s) => ({ type: 'skill', name: s }))

  // Kōbō commands (without the leading "/") — KOBO_COMMANDS keys include the slash
  const koboCommands = Object.keys(KOBO_COMMANDS)
    .map((k) => k.replace(/^\//, ''))
    .filter((k) => matches(k))
    .map<DropdownItem>((name) => ({ type: 'kobo', name }))

  // User templates
  const templates = templatesStore.templates
    .filter((t) => matches(t.slug))
    .map<DropdownItem>((t) => ({ type: 'template', name: t.slug, description: t.description }))

  return { skills: claudeSkills, kobo: koboCommands, templates }
})

// Flat list used for keyboard navigation (skips empty sections implicitly)
const flatDropdown = computed(() => [
  ...groupedDropdown.value.skills,
  ...groupedDropdown.value.kobo,
  ...groupedDropdown.value.templates,
])

// Clamp `selectedSkillIndex` when the filtered list shrinks
watch(
  () => flatDropdown.value.length,
  (len) => {
    if (len === 0) {
      selectedSkillIndex.value = 0
      return
    }
    if (selectedSkillIndex.value >= len) {
      selectedSkillIndex.value = len - 1
    }
  },
)

// Image upload
interface PendingImage {
  tempId: string
  uid?: string
  path?: string
  originalName: string
  status: 'uploading' | 'ready' | 'error'
}

const pendingImages = ref<PendingImage[]>([])
const fileInputRef = ref<HTMLInputElement | null>(null)
const isDragging = ref(false)

const ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']

async function uploadImage(file: File) {
  if (!ALLOWED_TYPES.includes(file.type)) return

  const tempId = crypto.randomUUID()
  const pending: PendingImage = {
    tempId,
    originalName: file.name || 'pasted-image.png',
    status: 'uploading',
  }
  pendingImages.value.push(pending)

  try {
    const formData = new FormData()
    formData.append('image', file)

    const res = await fetch(`/api/workspaces/${props.workspaceId}/images`, {
      method: 'POST',
      body: formData,
    })

    if (!res.ok) {
      const err = await res.json()
      throw new Error(err.error || 'Upload failed')
    }

    const data = await res.json()
    const entry = pendingImages.value.find((p) => p.tempId === tempId)
    if (entry) {
      entry.uid = data.uid
      entry.path = data.path
      entry.status = 'ready'
    }
  } catch {
    const entry = pendingImages.value.find((p) => p.tempId === tempId)
    if (entry) entry.status = 'error'
  }
}

async function removeImage(tempId: string) {
  const entry = pendingImages.value.find((p) => p.tempId === tempId)
  if (entry?.uid) {
    try {
      await fetch(`/api/workspaces/${props.workspaceId}/images/${entry.uid}`, { method: 'DELETE' })
    } catch {
      /* best-effort */
    }
  }
  pendingImages.value = pendingImages.value.filter((p) => p.tempId !== tempId)
}

function onPaste(event: ClipboardEvent) {
  if (!event.clipboardData) return
  for (const item of Array.from(event.clipboardData.items)) {
    if (item.type.startsWith('image/')) {
      const file = item.getAsFile()
      if (file) uploadImage(file)
    }
  }
}

function onDrop(event: DragEvent) {
  event.preventDefault()
  isDragging.value = false
  if (!event.dataTransfer) return
  for (const file of Array.from(event.dataTransfer.files)) {
    if (ALLOWED_TYPES.includes(file.type)) uploadImage(file)
  }
}

function onDragOver(event: DragEvent) {
  event.preventDefault()
  isDragging.value = true
}

function onDragLeave() {
  isDragging.value = false
}

function onFileSelected(event: Event) {
  const input = event.target as HTMLInputElement
  if (!input.files) return
  for (const file of Array.from(input.files)) {
    uploadImage(file)
  }
  input.value = ''
}

const hasUploading = computed(() => pendingImages.value.some((p) => p.status === 'uploading'))

const currentSession = computed(() =>
  store.sessions.find((s) => s.id === store.selectedSessionId) ?? null
)

let lastSkillsFetch = 0

async function fetchSkills() {
  const now = Date.now()
  if (now - lastSkillsFetch < 5000) return
  lastSkillsFetch = now
  try {
    const res = await fetch('/api/skills')
    if (res.ok) skills.value = await res.json()
  } catch {
    /* ignore */
  }
}

onMounted(fetchSkills)

// Watch for chatDraft changes (e.g. from DiffViewer "Add to chat")
watch(
  () => store.chatDraft,
  (draft) => {
    if (draft) {
      message.value = message.value ? `${message.value}\n${draft}` : draft
      store.chatDraft = ''
    }
  },
)

/**
 * Returns the slug fragment preceding the current caret position if the user
 * is currently typing a slash command. For example:
 *   - "/rev|"          → "rev"
 *   - "bug, /rev|ed"   → "rev"   (caret after "rev")
 *   - "hello"          → null
 *   - "/review-quality" → "review-quality"
 */
function getSlashFragmentBeforeCaret(): string | null {
  const el = getChatInputEl()
  if (!el) return null
  const caret = el.selectionStart ?? message.value.length
  const before = message.value.slice(0, caret)
  const match = before.match(/\/([\w-]*)$/)
  return match ? match[1] : null
}

// Watch for / anywhere before caret to trigger autocomplete
watch(message, async () => {
  // Run after the DOM has settled so selectionStart reflects the new caret
  await nextTick()
  const fragment = getSlashFragmentBeforeCaret()
  if (fragment !== null) {
    await fetchSkills()
    skillFilter.value = fragment
    showSkills.value = true
    selectedSkillIndex.value = 0
  } else {
    showSkills.value = false
  }
})

function replaceSlashFragmentWith(expanded: string) {
  const el = getChatInputEl()
  if (!el) {
    // No DOM access — fall back to replacing the whole input
    message.value = expanded
    return
  }
  const caret = el.selectionStart ?? message.value.length
  const before = message.value.slice(0, caret)
  const after = message.value.slice(caret)
  const match = before.match(/\/[\w-]*$/)
  if (!match) {
    // No slash fragment found — fall back to whole-input replacement
    message.value = expanded
    return
  }
  const fragmentStart = match.index ?? caret
  message.value = message.value.slice(0, fragmentStart) + expanded + after
  // Move caret to the end of the inserted text
  void nextTick(() => {
    const newPos = fragmentStart + expanded.length
    el.focus()
    el.setSelectionRange(newPos, newPos)
  })
}

function selectDropdownItem(item: DropdownItem | undefined) {
  if (!item) return

  if (item.type === 'template') {
    const template = templatesStore.templates.find((t) => t.slug === item.name)
    if (!template) return

    // Gather variables from the workspace store.
    const workspace = store.workspaces.find((w) => w.id === props.workspaceId) ?? null
    const gitStats = store.gitStatsCache[props.workspaceId] ?? null

    // Compute the session display name matching what WorkspacePage shows:
    // sessions are displayed in startedAt-ASC order and labelled "Session #N"
    // where N = store.sessions.length - index (so the newest gets the highest
    // number). See pages/WorkspacePage.vue sessionOptions computed.
    const currentSessionVal = store.sessions.find((s) => s.id === store.selectedSessionId) ?? null
    let sessionName: string | null = null
    if (currentSessionVal) {
      if (currentSessionVal.name) {
        sessionName = currentSessionVal.name
      } else {
        const idx = store.sessions.findIndex((s) => s.id === currentSessionVal.id)
        sessionName = t('workspacePage.session', { n: store.sessions.length - idx })
      }
    }

    // GitStats from the server does NOT include `prNumber` — we derive it from
    // `prUrl` (format: https://host/org/repo/pull/<N>) to avoid a backend change.
    let prNumber: number | undefined
    if (gitStats?.prUrl) {
      const match = gitStats.prUrl.match(/\/pull\/(\d+)/)
      if (match) prNumber = parseInt(match[1], 10)
    }

    const vars = buildTemplateVars({
      workspace: workspace
        ? {
            name: workspace.name,
            workingBranch: workspace.workingBranch,
            sourceBranch: workspace.sourceBranch,
            projectPath: workspace.projectPath,
          }
        : null,
      gitStats: gitStats
        ? {
            commitCount: gitStats.commitCount,
            unpushedCount: gitStats.unpushedCount,
            filesChanged: gitStats.filesChanged,
            insertions: gitStats.insertions,
            deletions: gitStats.deletions,
            prNumber,
            prUrl: gitStats.prUrl,
            prState: gitStats.prState,
          }
        : null,
      sessionName,
    })
    const expanded = expandTemplate(template.content, vars)
    replaceSlashFragmentWith(expanded)
    showSkills.value = false
    return
  }

  // Skills Claude + Kōbō commands: insert `/name` (complete the fragment)
  const asCommand = `/${item.name}`
  if (item.type === 'kobo' && KOBO_COMMANDS[asCommand]) {
    // Kōbō commands auto-send — preserve the existing behavior
    message.value = asCommand
    showSkills.value = false
    sendMessage()
    return
  }
  // Claude skills: just complete the fragment in the input, user hits Enter to send
  replaceSlashFragmentWith(`${asCommand} `)
  showSkills.value = false
}

const isDisabled = computed(() => {
  return !props.workspaceId
})

// Message history (arrow up/down to cycle through previous messages)
const messageHistory = ref<string[]>(JSON.parse(localStorage.getItem('kobo:chatHistory') ?? '[]'))
const historyIndex = ref(-1)
const savedDraft = ref('')

function pushToHistory(text: string) {
  if (!text) return
  // Avoid consecutive duplicates
  if (messageHistory.value[0] === text) return
  messageHistory.value.unshift(text)
  if (messageHistory.value.length > 50) messageHistory.value.pop()
  localStorage.setItem('kobo:chatHistory', JSON.stringify(messageHistory.value))
}

function resetHistoryNav() {
  historyIndex.value = -1
  savedDraft.value = ''
}

function koboDescription(skill: string): string {
  const key = KOBO_COMMANDS[`/${skill}`]?.descriptionKey
  return key ? t(key) : ''
}

async function sendMessage() {
  const text = message.value.trim()
  if ((!text && pendingImages.value.length === 0) || isDisabled.value || hasUploading.value) return

  const session = currentSession.value

  // Intercept Kobo built-in commands
  const koboCmd = KOBO_COMMANDS[text]
  if (koboCmd) {
    wsStore.sendChatMessage(props.workspaceId, koboCmd.prompt, store.selectedSessionId ?? undefined)
    store.markRead(props.workspaceId)
    store.addActivityItem(props.workspaceId, {
      id: `user-${Date.now()}`,
      type: 'text',
      content: koboCmd.prompt,
      timestamp: new Date().toISOString(),
      sessionId: store.selectedSessionId ?? undefined,
      meta: { sender: 'user', pending: true },
    })
    pushToHistory(text)
    resetHistoryNav()
    message.value = ''
    return
  }

  const imageTags = pendingImages.value
    .filter((p) => p.status === 'ready' && p.path)
    .map((p) => `[image: ${p.path}]`)
    .join(' ')

  const composedText = imageTags ? `${text} ${imageTags}`.trim() : text
  const sessionTag = store.selectedSessionId ?? undefined

  // Early guard: completed/error session without claudeSessionId can't be resumed.
  if (
    (session?.status === 'completed' || session?.status === 'error') &&
    !session.claudeSessionId
  ) {
    $q.notify({
      type: 'warning',
      message: t('workspacePage.sessionEndedNotice'),
      position: 'top',
      timeout: 5000,
    })
    return
  }

  // Add the optimistic local item BEFORE sending so the WS user:message event
  // (which the backend may emit synchronously during /start) can find it via
  // the dedup pass and update its id instead of creating a duplicate.
  const optimisticId = `user-${Date.now()}`
  store.markRead(props.workspaceId)
  store.addActivityItem(props.workspaceId, {
    id: optimisticId,
    type: 'text',
    content: composedText,
    timestamp: new Date().toISOString(),
    sessionId: sessionTag,
    meta: { sender: 'user', pending: true },
  })

  const savedText = text
  pushToHistory(text)
  resetHistoryNav()
  message.value = ''
  pendingImages.value = []

  // On failure: roll back the optimistic item and restore the input so the
  // user doesn't lose their message. Only applies to HTTP flows that can fail
  // before the WS event arrives to upgrade the pending item.
  const rollback = (err: unknown, contextMsg: string) => {
    console.error(`[ChatInput] ${contextMsg} failed:`, err)
    store.removeActivityItem(props.workspaceId, optimisticId)
    message.value = savedText
    const serverMsg = err instanceof Error ? err.message : null
    $q.notify({
      type: 'negative',
      message: serverMsg ?? t('workspacePage.startFailed'),
      position: 'top',
      timeout: 6000,
    })
  }

  if (session?.status === 'idle') {
    // First message on an idle session — start a fresh agent for it
    try {
      await store.startWorkspace(props.workspaceId, composedText, session.id)
      await store.fetchSessions(props.workspaceId)
    } catch (err) {
      rollback(err, 'startWorkspace')
    }
  } else if (session?.status === 'completed' || session?.status === 'error') {
    // Continue an ended session — resume the underlying Claude conversation
    try {
      await store.startWorkspace(props.workspaceId, composedText, session.id, true)
      await store.fetchSessions(props.workspaceId)
    } catch (err) {
      rollback(err, 'resume session')
    }
  } else {
    wsStore.sendChatMessage(props.workspaceId, composedText, store.selectedSessionId ?? undefined)
  }
}

function onKeydown(event: KeyboardEvent) {
  if (showSkills.value && flatDropdown.value.length > 0) {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      selectedSkillIndex.value = Math.min(selectedSkillIndex.value + 1, flatDropdown.value.length - 1)
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      selectedSkillIndex.value = Math.max(selectedSkillIndex.value - 1, 0)
      return
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      selectDropdownItem(flatDropdown.value[selectedSkillIndex.value])
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      showSkills.value = false
      return
    }
  }

  // Arrow up/down to navigate message history (only when cursor is on first/last line)
  if (event.key === 'ArrowUp' && messageHistory.value.length > 0) {
    const textarea = event.target as HTMLTextAreaElement | null
    const cursorOnFirstLine =
      !textarea ||
      textarea.selectionStart <=
        (message.value.indexOf('\n') === -1 ? message.value.length : message.value.indexOf('\n'))
    if (!cursorOnFirstLine && historyIndex.value === -1) return
    event.preventDefault()
    if (historyIndex.value === -1) {
      savedDraft.value = message.value
    }
    if (historyIndex.value < messageHistory.value.length - 1) {
      historyIndex.value++
      message.value = messageHistory.value[historyIndex.value]
    }
    return
  }
  if (event.key === 'ArrowDown' && historyIndex.value >= 0) {
    event.preventDefault()
    historyIndex.value--
    message.value = historyIndex.value >= 0 ? messageHistory.value[historyIndex.value] : savedDraft.value
    return
  }

  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    sendMessage()
  }
}
</script>

<template>
  <div
    class="chat-input-container column q-pa-sm"
    :class="{ 'chat-input-dragging': isDragging }"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
    <!-- Pending images tags -->
    <div v-if="pendingImages.length > 0" class="row items-center q-gutter-xs q-mb-xs q-px-xs" style="flex-wrap: wrap;">
      <div
        v-for="img in pendingImages"
        :key="img.tempId"
        class="image-tag row items-center q-px-sm q-py-xs rounded-borders"
        :class="{
          'image-tag--uploading': img.status === 'uploading',
          'image-tag--ready': img.status === 'ready',
          'image-tag--error': img.status === 'error',
        }"
      >
        <q-spinner-dots v-if="img.status === 'uploading'" size="14px" color="grey-6" class="q-mr-xs" />
        <q-icon v-else-if="img.status === 'ready'" name="image" size="14px" color="green-6" class="q-mr-xs" />
        <q-icon v-else name="error" size="14px" color="red-6" class="q-mr-xs" />

        <span class="text-caption image-tag-label">
          {{ img.status === 'uploading' ? $t('chatInput.uploading') : (img.path || img.originalName) }}
        </span>

        <q-btn
          flat
          dense
          round
          size="xs"
          icon="close"
          class="q-ml-xs image-tag-close"
          @click="removeImage(img.tempId)"
        >
          <q-tooltip>{{ $t('tooltip.removeImage') }}</q-tooltip>
        </q-btn>
      </div>
    </div>

    <!-- Grouped slash autocomplete popup -->
    <div v-if="showSkills && flatDropdown.length > 0" class="skills-popup rounded-borders">
      <!-- Claude skills -->
      <template v-if="groupedDropdown.skills.length > 0">
        <div class="skills-section-header">{{ $t('chatInput.dropdownSkills') }}</div>
        <div
          v-for="item in groupedDropdown.skills"
          :key="`skill-${item.name}`"
          class="skill-item row items-center q-px-sm q-py-xs cursor-pointer"
          :class="{ 'skill-item--active': flatDropdown.indexOf(item) === selectedSkillIndex }"
          @mousedown.prevent="selectDropdownItem(item)"
        >
          <q-icon name="bolt" size="12px" color="indigo-4" class="q-mr-xs" />
          <span class="skill-name text-caption">{{ item.name }}</span>
        </div>
      </template>

      <!-- Kōbō commands -->
      <template v-if="groupedDropdown.kobo.length > 0">
        <div class="skills-section-header">{{ $t('chatInput.dropdownKobo') }}</div>
        <div
          v-for="item in groupedDropdown.kobo"
          :key="`kobo-${item.name}`"
          class="skill-item row items-center q-px-sm q-py-xs cursor-pointer"
          :class="{ 'skill-item--active': flatDropdown.indexOf(item) === selectedSkillIndex }"
          @mousedown.prevent="selectDropdownItem(item)"
        >
          <q-icon name="terminal" size="12px" color="teal-4" class="q-mr-xs" />
          <span class="skill-name text-caption">/{{ item.name }}</span>
          <span v-if="koboDescription(item.name)" class="skill-description text-caption text-grey-7 q-ml-xs">— {{ koboDescription(item.name) }}</span>
        </div>
      </template>

      <!-- User templates -->
      <template v-if="groupedDropdown.templates.length > 0">
        <div class="skills-section-header">{{ $t('chatInput.dropdownTemplates') }}</div>
        <div
          v-for="item in groupedDropdown.templates"
          :key="`tpl-${item.name}`"
          class="skill-item row items-center q-px-sm q-py-xs cursor-pointer"
          :class="{ 'skill-item--active': flatDropdown.indexOf(item) === selectedSkillIndex }"
          @mousedown.prevent="selectDropdownItem(item)"
        >
          <q-icon name="description" size="12px" color="amber-4" class="q-mr-xs" />
          <span class="skill-name text-caption">/{{ item.name }}</span>
          <span v-if="item.description" class="skill-description text-caption text-grey-7 q-ml-xs">— {{ item.description }}</span>
        </div>
      </template>
    </div>

    <div class="row items-end q-gutter-sm">
      <q-input
        ref="chatInputRef"
        v-model="message"
        dense
        dark
        borderless
        autogrow
        :placeholder="$t('chatInput.placeholder')"
        class="chat-input col rounded-borders"
        :disable="isDisabled"
        @keydown="onKeydown"
        @paste="onPaste"
      />

      <!-- Hidden file input -->
      <input
        ref="fileInputRef"
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        multiple
        style="display: none;"
        @change="onFileSelected"
      />

      <q-btn
        flat
        dense
        icon="attach_file"
        color="grey-6"
        :disable="isDisabled"
        @click="fileInputRef?.click()"
      >
        <q-tooltip>{{ $t('chatInput.attachImage') }}</q-tooltip>
      </q-btn>

      <q-btn
        flat
        dense
        icon="send"
        color="primary"
        :disable="isDisabled || (!message.trim() && pendingImages.length === 0) || hasUploading"
        @click="sendMessage"
      >
        <q-tooltip>{{ $t('tooltip.sendMessage') }}</q-tooltip>
      </q-btn>
    </div>
    <div class="chat-hint text-caption text-grey-8">
      <kbd>Enter</kbd> {{ $t('common.send') }} <span class="q-mx-xs">&middot;</span> <kbd>Shift+Enter</kbd> {{ $t('common.newLine') }} <span class="q-mx-xs">&middot;</span> <kbd>↑↓</kbd> {{ $t('common.history') }}
    </div>
  </div>
</template>

<style lang="scss" scoped>
.chat-input-container {
  background-color: #16162a;
  border-top: 1px solid #2a2a4a;
  min-height: 48px;
  position: relative;

  &.chat-input-dragging {
    outline: 2px dashed #6c63ff;
    outline-offset: -2px;
  }
}

.chat-input {
  background-color: #222244;
  padding: 4px 12px;

  :deep(.q-field__control) {
    min-height: 32px;
  }
  :deep(textarea),
  :deep(input) {
    color: #ccc;
    font-size: 13px;
  }
}

.skills-popup {
  position: absolute;
  bottom: calc(100% + 4px);
  left: 8px;
  right: 48px;
  max-height: 300px;
  overflow-y: auto;
  background-color: #1e1e3a;
  border: 1px solid #2a2a4a;
  box-shadow: 0 -4px 16px rgba(0, 0, 0, 0.4);
  z-index: 9999;
}

.skills-section-header {
  padding: 4px 12px;
  font-size: 10px;
  text-transform: uppercase;
  color: #6b7280;
  letter-spacing: 0.05em;
  border-top: 1px solid rgba(255, 255, 255, 0.05);

  &:first-child {
    border-top: none;
  }
}

.skill-item {
  font-family: 'Roboto Mono', monospace;

  &:hover,
  &--active {
    background-color: rgba(108, 99, 255, 0.15);
  }
}

.image-tag {
  font-family: 'Roboto Mono', monospace;
  font-size: 12px;
  line-height: 1;

  &--uploading {
    background-color: #2a2a4a;
    border: 1px solid #3a3a5a;
    color: #8888aa;
  }

  &--ready {
    background-color: #1a2a1a;
    border: 1px solid #2a4a2a;
    color: #6aaa6a;
  }

  &--error {
    background-color: #2a1a1a;
    border: 1px solid #4a2a2a;
    color: #aa6a6a;
  }
}

.image-tag-label {
  max-width: 250px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chat-hint {
  font-size: 10px;
  text-align: left;
  padding: 2px 4px 0;

  kbd {
    background-color: #2a2a4a;
    border-radius: 3px;
    padding: 1px 4px;
    font-family: 'Roboto Mono', monospace;
    font-size: 9px;
  }
}

.image-tag-close {
  color: #aa4444;
  opacity: 0.7;

  &:hover {
    opacity: 1;
  }
}
</style>
