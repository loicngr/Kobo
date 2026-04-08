<script setup lang="ts">
import { useWebSocketStore } from 'src/stores/websocket'
import type { Task, Workspace } from 'src/stores/workspace'
import { useWorkspaceStore } from 'src/stores/workspace'
import { sendCheckProgress } from 'src/utils/kobo-commands'
import { computed, nextTick, ref } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps<{
  workspace: Workspace | null
  tasks: Task[]
}>()

const { t } = useI18n()
const store = useWorkspaceStore()
const wsStore = useWebSocketStore()
const refreshing = ref(false)

function askAgentProgress() {
  if (!props.workspace?.id) return
  sendCheckProgress(props.workspace.id, wsStore, store)
}

// Filter non-criterion tasks for NotionPanel
const displayTasks = computed(() => props.tasks.filter((t) => !t.isAcceptanceCriterion))

const doneTasks = computed(() => displayTasks.value.filter((t) => t.status === 'done').length)
const totalTasks = computed(() => displayTasks.value.length)
const progress = computed(() => (totalTasks.value > 0 ? doneTasks.value / totalTasks.value : 0))

// CRUD state
const adding = ref(false)
const newTitle = ref('')
const editingId = ref<string | null>(null)
const editTitle = ref('')
const editInputRefs = ref<Record<string, HTMLElement | null>>({})

function setEditRef(taskId: string, el: unknown) {
  if (el) {
    const nativeEl = (el as { $el?: HTMLElement }).$el ?? (el as HTMLElement)
    editInputRefs.value[taskId] = nativeEl
  } else {
    delete editInputRefs.value[taskId]
  }
}

async function refreshFromNotion() {
  if (!props.workspace?.id || !props.workspace.notionUrl) return
  refreshing.value = true
  try {
    const res = await fetch(`/api/workspaces/${props.workspace.id}/refresh-notion`, { method: 'POST' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    // Reload workspace details to get updated tasks
    store.fetchWorkspaceDetails(props.workspace.id)
  } catch (err) {
    console.error('Failed to refresh from Notion:', err)
  } finally {
    refreshing.value = false
  }
}

function startAdd() {
  adding.value = true
  newTitle.value = ''
  // autofocus prop on q-input handles focusing
}

async function addTask() {
  const title = newTitle.value.trim()
  if (!title || !props.workspace?.id) return
  try {
    await store.createTask(props.workspace.id, title, false)
    newTitle.value = ''
    adding.value = false
  } catch {
    /* error already logged */
  }
}

function cancelAdd() {
  newTitle.value = ''
  adding.value = false
}

function startEdit(task: Task) {
  editingId.value = task.id
  editTitle.value = task.title
  nextTick(() => {
    const el = editInputRefs.value[task.id]
    const input = el?.querySelector('input, textarea') as HTMLInputElement | null
    input?.focus()
    input?.select()
  })
}

async function saveEdit(task: Task) {
  // Idempotency guard — prevent double-save from Enter + blur
  if (editingId.value !== task.id) return

  const newT = editTitle.value.trim()
  const currentId = task.id
  editingId.value = null // clear immediately so a second call returns early

  if (!newT || newT === task.title) {
    return
  }
  if (!props.workspace?.id) return

  try {
    await store.updateTaskTitle(props.workspace.id, currentId, newT)
  } catch {
    /* error already logged */
  }
}

function cancelEdit() {
  editingId.value = null
  editTitle.value = ''
}

async function removeTask(task: Task) {
  if (!props.workspace?.id) return
  try {
    await store.deleteTask(props.workspace.id, task.id)
  } catch {
    /* error already logged */
  }
}

async function toggleTask(task: Task) {
  if (!props.workspace?.id) return
  const newStatus = task.status === 'done' ? 'pending' : 'done'
  try {
    const res = await fetch(`/api/workspaces/${task.workspaceId}/tasks/${task.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: newStatus }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    store.fetchWorkspaceDetails(props.workspace.id)
  } catch (err) {
    console.error('Failed to toggle task:', err)
  }
}

function statusIcon(status: string): string {
  switch (status) {
    case 'done':
      return 'check_circle'
    case 'in_progress':
      return 'timelapse'
    default:
      return 'radio_button_unchecked'
  }
}

function statusColor(status: string): string {
  switch (status) {
    case 'done':
      return '#4ade80'
    case 'in_progress':
      return '#f59e0b'
    default:
      return '#888'
  }
}
</script>

<template>
  <div class="notion-panel q-pa-md">
    <div class="row items-center q-mb-sm">
      <div class="text-caption text-uppercase text-weight-bold text-grey-6" style="letter-spacing: 0.05em;">
        {{ $t('notion.title') }}
      </div>
      <q-space />
      <q-btn
        v-if="workspace"
        flat
        dense
        round
        size="xs"
        icon="fact_check"
        color="grey-5"
        @click="askAgentProgress"
      >
        <q-tooltip>{{ $t('tasks.askProgress') }}</q-tooltip>
      </q-btn>
      <q-btn
        v-if="workspace"
        flat
        dense
        round
        size="xs"
        icon="add"
        color="indigo-4"
        @click="startAdd"
      >
        <q-tooltip>{{ $t('tooltip.addNotionTask') }}</q-tooltip>
      </q-btn>
    </div>

    <template v-if="workspace">
      <!-- Notion link -->
      <div v-if="workspace.notionUrl" class="q-mb-sm">
        <a
          :href="workspace.notionUrl"
          target="_blank"
          rel="noopener noreferrer"
          class="notion-link text-caption items-center text-blue-4"
        >
          <q-icon name="open_in_new" size="12px" class="q-mr-xs" />
          {{ $t('notion.openInNotion') }}
        </a>
      </div>
      <div v-else class="text-caption q-mb-sm text-grey-8">
        {{ $t('notion.noUrl') }}
      </div>

      <!-- Refresh button -->
      <q-btn
        v-if="workspace.notionUrl"
        flat
        dense
        no-caps
        size="xs"
        icon="refresh"
        :label="$t('common.refresh')"
        color="grey-6"
        class="q-mb-sm"
        :loading="refreshing"
        @click="refreshFromNotion"
      />

      <!-- Progress -->
      <div v-if="totalTasks > 0" class="q-mb-sm">
        <q-linear-progress
          :value="progress"
          color="primary"
          track-color="grey-9"
          class="q-mb-xs"
          style="height: 4px; border-radius: 2px;"
        />
        <div class="text-caption text-grey-7" style="font-size: 11px;">
          {{ $t('notion.subtasks', { done: doneTasks, total: totalTasks }) }}
        </div>
      </div>
      <div v-else-if="!adding" class="text-caption text-grey-8 q-mb-sm" style="font-size: 11px;">
        {{ $t('notion.noTasks') }}
      </div>

      <!-- Add task inline input -->
      <div v-if="adding" class="task-add-row row items-center q-mb-xs">
        <q-input
          v-model="newTitle"
          dark
          dense
          borderless
          autofocus
          :placeholder="$t('notion.newTask')"
          class="col task-input"
          input-class="task-input-inner"
          @keydown.enter.prevent="addTask"
          @keydown.esc.prevent="cancelAdd"
        />
      </div>

      <!-- Tasks list -->
      <div v-if="displayTasks.length > 0" class="tasks-list">
        <div
          v-for="task in displayTasks"
          :key="task.id"
          class="task-item row items-center q-py-xxs"
        >
          <q-icon
            :name="statusIcon(task.status)"
            size="14px"
            :style="{ color: statusColor(task.status) }"
            class="q-mr-xs cursor-pointer"
            @click="toggleTask(task)"
          />

          <template v-if="editingId === task.id">
            <q-input
              :ref="(el) => setEditRef(task.id, el)"
              v-model="editTitle"
              dark
              dense
              borderless
              class="col task-input"
              input-class="task-input-inner"
              @keydown.enter.prevent="saveEdit(task)"
              @keydown.esc.prevent="cancelEdit"
              @blur="saveEdit(task)"
            />
          </template>
          <template v-else>
            <span
              class="col task-title text-caption"
              :class="{ 'text-strike': task.status === 'done' }"
              :style="{ color: task.status === 'done' ? '#4ade80' : '#ccc' }"
              @dblclick="startEdit(task)"
            >
              {{ task.title }}
            </span>
            <q-btn
              flat
              dense
              round
              size="xs"
              icon="close"
              color="grey-6"
              class="task-delete-btn"
              @click="removeTask(task)"
            >
              <q-tooltip>{{ $t('tooltip.removeNotionTask') }}</q-tooltip>
            </q-btn>
          </template>
        </div>
      </div>
    </template>

    <div v-else class="text-caption text-grey-8">
      {{ $t('common.selectWorkspace') }}
    </div>
  </div>
</template>

<style lang="scss" scoped>
.notion-link {
  text-decoration: none;
  display: inline-flex;

  &:hover {
    text-decoration: underline;
  }
}

.task-item {
  padding: 2px 0;

  &:hover {
    background-color: rgba(255, 255, 255, 0.03);

    .task-delete-btn {
      opacity: 1;
    }
  }
}

.task-delete-btn {
  opacity: 0;
  transition: opacity 0.15s ease;
}

.task-title {
  line-height: 1.4;
  word-break: break-word;
  cursor: text;
}

.text-strike {
  text-decoration: line-through;
  opacity: 0.7;
}

.task-input {
  :deep(.q-field__control) {
    padding: 0;
    height: 22px;
    min-height: 22px;
  }

  :deep(input) {
    font-size: 12px;
    color: #e0e0e0;

    &::placeholder {
      color: #555;
    }
  }
}

.task-add-row {
  padding: 2px 0;
}
</style>
