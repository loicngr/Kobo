<script setup lang="ts">
import { useWebSocketStore } from 'src/stores/websocket'
import { useWorkspaceStore } from 'src/stores/workspace'
import { KOBO_COMMANDS } from 'src/utils/kobo-commands'
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps<{
  workspaceId: string
}>()

const { t } = useI18n()
const store = useWorkspaceStore()
const wsStore = useWebSocketStore()
const message = ref('')

// Skills autocomplete
const skills = ref<string[]>([])
const showSkills = ref(false)
const skillFilter = ref('')
const selectedSkillIndex = ref(0)

const filteredSkills = computed(() => {
  if (!skillFilter.value) return skills.value
  const q = skillFilter.value.toLowerCase()
  return skills.value.filter((s) => s.toLowerCase().includes(q))
})

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

// Watch for / prefix to trigger autocomplete
watch(message, async (val) => {
  if (val.startsWith('/')) {
    await fetchSkills()
    skillFilter.value = val.substring(1)
    showSkills.value = true
    selectedSkillIndex.value = 0
  } else {
    showSkills.value = false
  }
})

function selectSkill(skill: string) {
  const asCommand = `/${skill}`
  if (KOBO_COMMANDS[asCommand]) {
    message.value = asCommand
    showSkills.value = false
    sendMessage()
    return
  }
  message.value = `${asCommand} `
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

function sendMessage() {
  const text = message.value.trim()
  if ((!text && pendingImages.value.length === 0) || isDisabled.value || hasUploading.value) return

  // Intercept Kobo built-in commands
  const koboCmd = KOBO_COMMANDS[text]
  if (koboCmd) {
    wsStore.sendChatMessage(props.workspaceId, koboCmd.prompt)
    store.markRead(props.workspaceId)
    store.addActivityItem(props.workspaceId, {
      id: `user-${Date.now()}`,
      type: 'text',
      content: koboCmd.prompt,
      timestamp: new Date().toISOString(),
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

  wsStore.sendChatMessage(props.workspaceId, composedText)
  store.markRead(props.workspaceId)

  store.addActivityItem(props.workspaceId, {
    id: `user-${Date.now()}`,
    type: 'text',
    content: composedText,
    timestamp: new Date().toISOString(),
    meta: { sender: 'user', pending: true },
  })

  pushToHistory(text)
  resetHistoryNav()
  message.value = ''
  pendingImages.value = []
}

function onKeydown(event: KeyboardEvent) {
  if (showSkills.value && filteredSkills.value.length > 0) {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      selectedSkillIndex.value = Math.min(selectedSkillIndex.value + 1, filteredSkills.value.length - 1)
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      selectedSkillIndex.value = Math.max(selectedSkillIndex.value - 1, 0)
      return
    }
    if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
      event.preventDefault()
      selectSkill(filteredSkills.value[selectedSkillIndex.value])
      return
    }
    if (event.key === 'Escape') {
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

    <!-- Skills autocomplete popup -->
    <div v-if="showSkills && filteredSkills.length > 0" class="skills-popup rounded-borders">
      <div class="skills-header text-caption text-weight-bold text-grey-6 q-px-sm q-py-xs">
        {{ $t('chatInput.skills') }}
      </div>
      <div
        v-for="(skill, idx) in filteredSkills.slice(0, 12)"
        :key="skill"
        class="skill-item row items-center q-px-sm q-py-xs cursor-pointer"
        :class="{ 'skill-item--active': idx === selectedSkillIndex }"
        @click="selectSkill(skill)"
        @mouseenter="selectedSkillIndex = idx"
      >
        <q-icon name="bolt" size="12px" color="indigo-4" class="q-mr-xs" />
        <span class="text-caption">{{ skill }}</span>
        <span v-if="koboDescription(skill)" class="text-caption text-grey-7 q-ml-xs">— {{ koboDescription(skill) }}</span>
      </div>
    </div>

    <div class="row items-end q-gutter-sm">
      <q-input
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

.skills-header {
  border-bottom: 1px solid #2a2a4a;
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
