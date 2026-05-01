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
    <SlashSuggestionsPopup
      v-if="showSkills && flatDropdown.length > 0"
      class="chat-slash-popup"
      :grouped-dropdown="groupedDropdown"
      :flat-dropdown="flatDropdown"
      :selected-index="selectedSkillIndex"
      @select="selectDropdownItem"
    />

    <!-- Queued message banner -->
    <div
      v-if="isQueued"
      class="queue-banner row items-center q-pa-xs q-px-sm text-caption text-amber-6"
    >
      <q-icon name="schedule" size="14px" color="amber-6" class="q-mr-sm" />
      <span>{{ $t('chatInput.queueBanner') }}</span>
    </div>

    <!-- Auto-loop banner: input is locked while auto-loop is running.
         Prevents racy queued messages between iterations. -->
    <div
      v-if="isAutoLoopRunning"
      class="autoloop-banner row items-center no-wrap q-pa-xs q-px-sm text-caption text-indigo-3"
    >
      <q-icon name="all_inclusive" size="14px" color="indigo-4" class="q-mr-sm" />
      <span class="col">{{ $t('chatInput.autoLoopBanner') }}</span>
      <q-btn
        flat
        dense
        no-caps
        size="sm"
        icon="stop_circle"
        color="orange-4"
        :label="$t('chatInput.autoLoopStop')"
        :loading="stoppingAutoLoop"
        :disable="stoppingAutoLoop"
        @click="stopAutoLoopFromChat"
      />
    </div>

    <!-- SDK paused on canUseTool — force the user through the panel above. -->
    <div
      v-if="isAwaitingUser && !isAutoLoopRunning"
      class="awaiting-user-banner row items-center q-pa-xs q-px-sm text-caption text-amber-5"
    >
      <q-icon name="question_answer" size="14px" color="amber-5" class="q-mr-sm" />
      <span>{{ $t('chatInput.awaitingUserBanner') }}</span>
    </div>

    <div class="row items-center q-gutter-sm">
      <q-input
        ref="chatInputRef"
        v-model="message"
        dense
        dark
        borderless
        autogrow
        :readonly="isQueued"
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
        v-if="isQueued"
        flat
        dense
        icon="cancel"
        color="orange"
        @click="cancelQueue"
      >
        <q-tooltip>{{ $t('chatInput.cancelQueue') }}</q-tooltip>
      </q-btn>

      <q-btn
        v-else
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
    <div class="chat-hint row items-center text-caption text-grey-8">
      <div>
        <kbd>Enter</kbd> {{ $t('common.send') }} <span class="q-mx-xs">&middot;</span> <kbd>Shift+Enter</kbd> {{ $t('common.newLine') }} <span class="q-mx-xs">&middot;</span> <kbd>↑↓</kbd> {{ $t('common.history') }}
      </div>
      <q-space />
      <QuotaFooter class="q-mr-md" />
      <q-btn
        v-if="showInterrupt"
        flat
        dense
        no-caps
        size="sm"
        color="orange-4"
        icon="pause"
        :label="$t('workspacePage.interrupt')"
        :loading="interrupting"
        :disable="interrupting"
        @click="handleInterrupt"
      >
        <q-tooltip>{{ $t('workspacePage.interruptTooltip') }}</q-tooltip>
      </q-btn>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { QInput } from 'quasar'
import { useQuasar } from 'quasar'
import QuotaFooter from 'src/components/QuotaFooter.vue'
import SlashSuggestionsPopup from 'src/components/SlashSuggestionsPopup.vue'
import { type SlashDropdownItem, useSlashAutocomplete } from 'src/composables/use-slash-autocomplete'
import { useTemplatesStore } from 'src/stores/templates'
import { useWebSocketStore } from 'src/stores/websocket'
import { useWorkspaceStore } from 'src/stores/workspace'
import { buildTemplateVars, expandTemplate } from 'src/utils/expand-template'
import { KOBO_COMMANDS } from 'src/utils/kobo-commands'
import { isBusyStatus } from 'src/utils/workspace-status'
import { computed, nextTick, ref, watch } from 'vue'
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
const interrupting = ref(false)

const showInterrupt = computed(() => isBusyStatus(store.selectedWorkspace?.status))

async function handleInterrupt() {
  if (!props.workspaceId) return
  interrupting.value = true
  try {
    await store.interruptAgent(props.workspaceId)
    $q.notify({ type: 'info', message: t('workspacePage.interrupted'), position: 'top', timeout: 3000 })
  } catch (e) {
    const msg = e instanceof Error ? e.message : t('workspacePage.interruptFailed')
    $q.notify({ type: 'negative', message: msg, position: 'top', timeout: 6000 })
  } finally {
    interrupting.value = false
  }
}

const isAgentBusy = computed(() => isBusyStatus(store.selectedWorkspace?.status))

const isQueued = computed(() => !!store.queuedMessages[props.workspaceId])

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

// Slash autocomplete — state + computed lists handled by the composable.
// Selection logic (template expansion, kobo auto-send, …) stays here because
// it needs the workspace context which the composable can't see.
const {
  showSkills,
  skillFilter,
  selectedSkillIndex,
  groupedDropdown,
  flatDropdown,
  fetchSkills,
  detectSlashFragment,
  replaceFragmentWith,
  closeDropdown,
} = useSlashAutocomplete(message, () => getChatInputEl())

// Image upload
interface PendingImage {
  tempId: string
  uid?: string
  path?: string
  originalName: string
  placeholder: string // the `[image: xxx]` token as it appears in the textarea
  status: 'uploading' | 'ready' | 'error'
}

const pendingImages = ref<PendingImage[]>([])
const fileInputRef = ref<HTMLInputElement | null>(null)
const isDragging = ref(false)

const ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']

function insertTextAtCaret(text: string) {
  const el = getChatInputEl()
  const caret = el?.selectionStart ?? message.value.length
  const before = message.value.slice(0, caret)
  const after = message.value.slice(caret)
  message.value = before + text + after
  nextTick(() => {
    if (el) {
      const newPos = caret + text.length
      el.focus()
      el.setSelectionRange(newPos, newPos)
    }
  })
}

function makeUniquePlaceholder(): string {
  const base = `[image: ${t('chatInput.uploading')}]`
  const existing = new Set(pendingImages.value.map((p) => p.placeholder))
  if (!existing.has(base)) return base
  // Disambiguate with a numeric suffix
  let n = 2
  while (existing.has(`[image: ${t('chatInput.uploading')} ${n}]`)) n++
  return `[image: ${t('chatInput.uploading')} ${n}]`
}

async function uploadImage(file: File) {
  if (!ALLOWED_TYPES.includes(file.type)) return

  const tempId = crypto.randomUUID()
  const originalName = file.name || 'pasted-image.png'
  const placeholder = makeUniquePlaceholder()
  const pending: PendingImage = {
    tempId,
    originalName,
    placeholder,
    status: 'uploading',
  }
  pendingImages.value.push(pending)
  // Insert the readable placeholder at the caret position; it will be
  // replaced by the real path once upload completes.
  insertTextAtCaret(placeholder)

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
      // Replace the temporary placeholder with the real path-based one,
      // matching the tag shown in the badge above the textarea.
      const newPlaceholder = `[image: ${data.path}]`
      if (newPlaceholder !== entry.placeholder) {
        message.value = message.value.split(entry.placeholder).join(newPlaceholder)
        entry.placeholder = newPlaceholder
      }
    }
  } catch {
    const entry = pendingImages.value.find((p) => p.tempId === tempId)
    if (entry) entry.status = 'error'
  }
}

function deleteImageOnServer(workspaceId: string, uid: string) {
  fetch(`/api/workspaces/${workspaceId}/images/${uid}`, { method: 'DELETE' }).catch(() => {
    /* best-effort */
  })
}

/**
 * Remove a pending image. Synchronous local state mutations (list + textarea
 * placeholder) run first; the network DELETE is fired asynchronously after so
 * multiple concurrent calls never interleave with the local reactive updates.
 */
function removeImage(tempId: string) {
  const target = pendingImages.value.find((p) => p.tempId === tempId)
  if (!target) return
  pendingImages.value = pendingImages.value.filter((p) => p.tempId !== tempId)
  // Remove the placeholder from the textarea (no-op if already gone)
  {
    const escaped = target.placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    message.value = message.value.replace(new RegExp(`${escaped}\\s?`, 'g'), '')
  }
  // Fire the server DELETE last, best-effort and non-blocking
  if (target.uid) {
    deleteImageOnServer(props.workspaceId, target.uid)
  }
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

const currentSession = computed(() => store.sessions.find((s) => s.id === store.selectedSessionId) ?? null)

// Pre-fetch the skills catalogue so the dropdown opens instantly on the
// first `/`. Throttling lives inside the composable.
void fetchSkills()

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

// When queue is consumed by auto-send, clear the textarea.
// cancelQueue does NOT trigger this because it preserves the text.
let cancelledManually = false

function cancelQueue() {
  cancelledManually = true
  store.cancelQueuedMessage(props.workspaceId)
}

watch(isQueued, (queued, wasQueued) => {
  if (wasQueued && !queued && !cancelledManually) {
    message.value = ''
  }
  cancelledManually = false
})

watch(
  () => props.workspaceId,
  (wid) => {
    const queued = store.queuedMessages[wid]
    message.value = queued ? queued.content : ''
  },
)

// Watch the message text: re-detect slash fragments + reconcile the image
// placeholder list (so deleting "[image: …]" from the textarea also drops
// the upload reference). The slash detection itself lives in the composable.
watch(message, async () => {
  await nextTick()
  await detectSlashFragment()

  // Detect placeholders removed by the user and delete the corresponding image.
  // Snapshot tempIds first to avoid mutating the list while iterating.
  const removedTempIds: string[] = []
  for (const img of pendingImages.value) {
    if (!message.value.includes(img.placeholder)) {
      removedTempIds.push(img.tempId)
    }
  }
  for (const tempId of removedTempIds) {
    removeImage(tempId)
  }
})

function selectDropdownItem(item: SlashDropdownItem | undefined) {
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
    replaceFragmentWith(expanded)
    closeDropdown()
    return
  }

  // Skills Claude + Kōbō commands: insert `/name` (complete the fragment)
  const asCommand = `/${item.name}`
  if (item.type === 'kobo' && KOBO_COMMANDS[asCommand]) {
    // Kōbō commands auto-send — preserve the existing behavior
    message.value = asCommand
    closeDropdown()
    sendMessage()
    return
  }
  // Claude skills: just complete the fragment in the input, user hits Enter to send
  replaceFragmentWith(`${asCommand} `)
  closeDropdown()
}

// "Running" means iterations are actively spawning — auto_loop AND auto_loop_ready
// must both be set. During grooming (ready=0) the user must stay free to answer
// the agent's clarifying questions.
const isAutoLoopRunning = computed(() => {
  const id = props.workspaceId
  if (!id) return false
  const state = store.autoLoopStates[id]
  return state?.auto_loop === true && state?.auto_loop_ready === true
})

const isAwaitingUser = computed(() => store.selectedWorkspace?.status === 'awaiting-user')

const isDisabled = computed(() => {
  return !props.workspaceId || isAutoLoopRunning.value || isAwaitingUser.value
})

const stoppingAutoLoop = ref(false)
async function stopAutoLoopFromChat() {
  if (!props.workspaceId || stoppingAutoLoop.value) return
  stoppingAutoLoop.value = true
  try {
    await store.disableAutoLoop(props.workspaceId)
  } finally {
    stoppingAutoLoop.value = false
  }
}

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

  // Queue the message if the agent is busy
  if (isAgentBusy.value) {
    store.queueMessage(props.workspaceId, text, store.selectedSessionId ?? undefined)
    return
  }
  store.cancelQueuedMessage(props.workspaceId)

  // Placeholders already contain `[image: path]` once the upload is done,
  // so no replacement is needed. Append orphan images as a safety net.
  let composedText = text
  const orphanTags = pendingImages.value
    .filter((p) => p.status === 'ready' && p.path && !composedText.includes(`[image: ${p.path}]`))
    .map((p) => `[image: ${p.path}]`)
    .join(' ')
  if (orphanTags) {
    composedText = `${composedText} ${orphanTags}`.trim()
  }
  const sessionTag = store.selectedSessionId ?? undefined

  // Early guard: completed/error session without engineSessionId can't be resumed.
  if ((session?.status === 'completed' || session?.status === 'error') && !session.engineSessionId) {
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
    if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
      event.preventDefault()
      selectDropdownItem(flatDropdown.value[selectedSkillIndex.value])
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      closeDropdown()
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

// Position the slash-suggestions popup above the chat textarea, flush with
// the input edges. The popup's internal styling (sections + items) is owned
// by SlashSuggestionsPopup itself.
.chat-slash-popup {
  position: absolute;
  bottom: calc(100% + 4px);
  left: 8px;
  right: 48px;
  z-index: 9999;
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

.queue-banner {
  background-color: #2a2a1a;
  border-bottom: 1px solid #4a4a2a;
}

.autoloop-banner {
  background-color: #1e1e36;
  border-bottom: 1px solid rgba(108, 99, 255, 0.4);
  border-top: 1px solid rgba(108, 99, 255, 0.4);
}

.image-tag-close {
  color: #aa4444;
  opacity: 0.7;

  &:hover {
    opacity: 1;
  }
}
</style>
