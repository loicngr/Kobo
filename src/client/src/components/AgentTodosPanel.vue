<script setup lang="ts">
import { useWorkspaceStore } from 'src/stores/workspace'

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
      return '#4ade80'
    case 'in_progress':
      return '#f59e0b'
    default:
      return '#888'
  }
}
</script>

<template>
  <div class="agent-todos-panel q-pa-md">
    <div class="row items-center q-mb-sm">
      <div class="text-caption text-uppercase text-weight-bold text-grey-6" style="letter-spacing: 0.05em;">
        Agent Todos
      </div>
    </div>

    <div v-if="store.currentAgentTodos.length > 0" class="todos-list">
      <div
        v-for="(todo, idx) in store.currentAgentTodos"
        :key="idx"
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
          :style="{ color: todo.status === 'completed' ? '#4ade80' : '#ccc' }"
        >
          {{ todo.content }}
        </span>
      </div>
    </div>

    <div v-else class="text-caption text-grey-8" style="font-size: 11px;">
      No agent todos
    </div>
  </div>
</template>

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
