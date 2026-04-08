<script setup lang="ts">
import type { Task } from 'src/stores/workspace'
import { useWorkspaceStore } from 'src/stores/workspace'
import { nextTick, ref } from 'vue'
import { useI18n } from 'vue-i18n'

defineProps<{
  tasks: Task[]
}>()

const { t } = useI18n()
const store = useWorkspaceStore()

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

async function toggleTask(task: Task) {
  const newStatus = task.status === 'done' ? 'pending' : 'done'
  try {
    const res = await fetch(`/api/workspaces/${task.workspaceId}/tasks/${task.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: newStatus }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    // Refresh tasks
    if (store.selectedWorkspaceId) {
      store.fetchWorkspaceDetails(store.selectedWorkspaceId)
    }
  } catch (err) {
    console.error('Failed to update task:', err)
  }
}

function startAdd() {
  adding.value = true
  newTitle.value = ''
  // autofocus prop on q-input handles focusing
}

async function addCriterion() {
  const title = newTitle.value.trim()
  const wid = store.selectedWorkspace?.id
  if (!title || !wid) return
  try {
    await store.createTask(wid, title, true)
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
  const wid = store.selectedWorkspace?.id
  if (!wid) return

  try {
    await store.updateTaskTitle(wid, currentId, newT)
  } catch {
    /* error already logged */
  }
}

function cancelEdit() {
  editingId.value = null
  editTitle.value = ''
}

async function removeCriterion(task: Task) {
  const wid = store.selectedWorkspace?.id
  if (!wid) return
  try {
    await store.deleteTask(wid, task.id)
  } catch {
    /* error already logged */
  }
}
</script>

<template>
  <div class="acceptance-panel q-pa-md">
    <div class="row items-center q-mb-sm">
      <div class="text-caption text-uppercase text-weight-bold text-grey-6" style="letter-spacing: 0.05em;">
        {{ $t('acceptance.title') }}
      </div>
      <q-space />
      <q-btn
        v-if="store.selectedWorkspace"
        flat
        dense
        round
        size="xs"
        icon="add"
        color="indigo-4"
        @click="startAdd"
      >
        <q-tooltip>{{ $t('tooltip.addCriterion') }}</q-tooltip>
      </q-btn>
    </div>

    <!-- Add criterion inline input -->
    <div v-if="adding" class="criterion-add-row row items-center q-mb-xs">
      <q-input
        v-model="newTitle"
        dark
        dense
        borderless
        autofocus
        :placeholder="$t('acceptance.newCriterion')"
        class="col criterion-input"
        input-class="criterion-input-inner"
        @keydown.enter.prevent="addCriterion"
        @keydown.esc.prevent="cancelAdd"
      />
    </div>

    <div v-if="tasks.length > 0" class="acceptance-list">
      <div
        v-for="task in tasks"
        :key="task.id"
        class="acceptance-item row items-center q-mb-xxs"
      >
        <q-icon
          :name="statusIcon(task.status)"
          size="16px"
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
            class="col criterion-input"
            input-class="criterion-input-inner"
            @keydown.enter.prevent="saveEdit(task)"
            @keydown.esc.prevent="cancelEdit"
            @blur="saveEdit(task)"
          />
        </template>
        <template v-else>
          <span
            class="col acceptance-title text-caption"
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
            class="criterion-delete-btn"
            @click="removeCriterion(task)"
          >
            <q-tooltip>{{ $t('tooltip.removeCriterion') }}</q-tooltip>
          </q-btn>
        </template>
      </div>
    </div>

    <div v-else-if="!adding" class="text-caption text-grey-8" style="font-size: 11px;">
      {{ $t('acceptance.empty') }}
    </div>
  </div>
</template>

<style lang="scss" scoped>
.acceptance-item {
  padding: 2px 0;

  &:hover {
    background-color: rgba(255, 255, 255, 0.03);

    .criterion-delete-btn {
      opacity: 1;
    }
  }
}

.criterion-delete-btn {
  opacity: 0;
  transition: opacity 0.15s ease;
}

.acceptance-title {
  line-height: 1.4;
  word-break: break-word;
  cursor: text;
}

.text-strike {
  text-decoration: line-through;
  opacity: 0.7;
}

.criterion-input {
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

.criterion-add-row {
  padding: 2px 0;
}
</style>
