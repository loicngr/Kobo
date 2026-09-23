<template>
  <div class="agent-todos-panel q-pa-md">
    <div class="row items-center q-mb-sm">
      <div class="text-caption text-uppercase text-weight-bold text-kobo-3" style="letter-spacing: 0.05em;">
        {{ $t('agentTodos.title') }}
      </div>
    </div>

    <div v-if="store.currentAgentTodos.length > 0" class="todos-list">
      <!-- id/taskNumber are stable across reorders (Task-tool origin); content is the
           best fallback for legacy TodoWrite snapshots that lack them; idx is the last resort -->
      <div
        v-for="(todo, idx) in store.currentAgentTodos"
        :key="todo.id ?? todo.taskNumber ?? todo.content ?? idx"
        class="todo-item row items-start q-py-xxs"
      >
        <q-icon
          :name="statusIcon(todo.status)"
          size="14px"
          :style="{ color: statusColor(todo.status) }"
          class="q-mr-xs q-mt-xxs"
        />
        <span
          class="col todo-title text-caption"
          :class="{ 'text-strike': todo.status === 'completed' }"
          :style="{ color: todo.status === 'completed' ? 'var(--kobo-success)' : 'var(--kobo-text-2)' }"
        >
          {{ todo.content }}
        </span>
      </div>
    </div>

    <div v-else class="text-caption text-kobo-3" style="font-size: 11px;">
      {{ $t('agentTodos.empty') }}
    </div>
  </div>
</template>

<script setup lang="ts">
import { useWorkspaceStore } from 'src/stores/workspace'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
const store = useWorkspaceStore()

function statusIcon(status: string): string {
  switch (status) {
    case 'completed':
      return 'check_circle'
    case 'in_progress':
      return 'timelapse'
    default:
      return 'radio_button_unchecked'
  }
}

function statusColor(status: string): string {
  switch (status) {
    case 'completed':
      return 'var(--kobo-success)'
    case 'in_progress':
      return 'var(--kobo-warning)'
    default:
      return 'var(--kobo-text-3)'
  }
}
</script>

<style lang="scss" scoped>
.todo-item {
  padding: 2px 0;
}

.todo-title {
  line-height: 1.4;
  word-break: break-word;
}

.text-strike {
  text-decoration: line-through;
  opacity: 0.7;
}
</style>
