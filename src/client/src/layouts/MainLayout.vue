<script setup lang="ts">
import AcceptancePanel from 'src/components/AcceptancePanel.vue'
import AgentTodosPanel from 'src/components/AgentTodosPanel.vue'
import DevServerPanel from 'src/components/DevServerPanel.vue'
import GitPanel from 'src/components/GitPanel.vue'
import NotionPanel from 'src/components/NotionPanel.vue'
import SubagentsPanel from 'src/components/SubagentsPanel.vue'
import WorkspaceList from 'src/components/WorkspaceList.vue'
import { useWorkspaceStore } from 'src/stores/workspace'
import { ref } from 'vue'

const rightTab = ref('git')

const leftDrawerOpen = ref(true)
const rightDrawerOpen = ref(true)

// Resizable left drawer — persist width in localStorage
const DRAWER_WIDTH_KEY = 'at-left-drawer-width'
const savedWidth = parseInt(localStorage.getItem(DRAWER_WIDTH_KEY) ?? '260', 10)
const leftDrawerWidth = ref(Math.min(500, Math.max(200, savedWidth)))
const isResizing = ref(false)

function startResize(event: MouseEvent) {
  event.preventDefault()
  isResizing.value = true

  const onMouseMove = (e: MouseEvent) => {
    const newWidth = Math.min(500, Math.max(200, e.clientX))
    leftDrawerWidth.value = newWidth
  }

  const onMouseUp = () => {
    isResizing.value = false
    localStorage.setItem(DRAWER_WIDTH_KEY, String(leftDrawerWidth.value))
    document.removeEventListener('mousemove', onMouseMove)
    document.removeEventListener('mouseup', onMouseUp)
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
  }

  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'
  document.addEventListener('mousemove', onMouseMove)
  document.addEventListener('mouseup', onMouseUp)
}

const store = useWorkspaceStore()
</script>

<template>
  <q-layout view="lHh LpR lFf">
    <!-- Left Sidebar — Workspace List (260px) -->
    <q-drawer
      v-model="leftDrawerOpen"
      :width="leftDrawerWidth"
      :breakpoint="0"
      persistent
      bordered
      class="left-sidebar"
    >
      <WorkspaceList />
      <!-- Resize handle -->
      <div
        class="resize-handle"
        @mousedown="startResize"
      />
    </q-drawer>

    <!-- Right Sidebar — Tabbed Context Panel (300px) -->
    <q-drawer
      v-model="rightDrawerOpen"
      side="right"
      :width="300"
      :breakpoint="0"
      persistent
      bordered
      class="right-sidebar"
    >
      <div class="drawer-content column full-height">
        <q-tabs
          v-model="rightTab"
          dense
          dark
          active-color="indigo-4"
          indicator-color="indigo-4"
          narrow-indicator
          align="justify"
          class="right-tabs"
        >
          <q-tab name="git" icon="commit" />
          <q-tab name="server" icon="dns" />
          <q-tab name="tasks" icon="checklist" />
          <q-tab name="subagents" icon="smart_toy" />
        </q-tabs>

        <q-separator dark />

        <q-tab-panels v-model="rightTab" animated class="col right-tab-panels">
          <q-tab-panel name="git" class="q-pa-none">
            <GitPanel :workspace="store.selectedWorkspace" />
          </q-tab-panel>

          <q-tab-panel name="server" class="q-pa-none">
            <DevServerPanel :workspace="store.selectedWorkspace" />
          </q-tab-panel>

          <q-tab-panel name="tasks" class="q-pa-none">
            <NotionPanel :workspace="store.selectedWorkspace" :tasks="store.tasks" />
            <q-separator dark />
            <AcceptancePanel :tasks="store.acceptanceCriteria" />
            <q-separator dark />
            <AgentTodosPanel />
          </q-tab-panel>

          <q-tab-panel name="subagents" class="q-pa-none">
            <SubagentsPanel />
          </q-tab-panel>
        </q-tab-panels>
      </div>
    </q-drawer>

    <!-- Main Content Area -->
    <q-page-container class="main-content">
      <router-view />
    </q-page-container>
  </q-layout>
</template>

<style lang="scss" scoped>
.left-sidebar,
.right-sidebar {
  background-color: #16162a !important;
  border-color: #2a2a4a !important;
  overflow-x: hidden !important;
}

:deep(.q-drawer__content) {
  overflow-x: hidden !important;
}

.drawer-content {
  overflow-y: auto;
}

.drawer-header {
  min-height: 48px;
}

.letter-spacing-wide {
  letter-spacing: 0.05em;
}

.right-tabs {
  flex-shrink: 0;
  background-color: #16162a;
}

.right-tab-panels {
  background: transparent !important;
  overflow-y: auto;
}

:deep(.q-tab-panel) {
  padding: 0;
}

.main-content {
  background-color: #1a1a2e;
}

.resize-handle {
  position: absolute;
  top: 0;
  right: -2px;
  width: 4px;
  height: 100%;
  cursor: col-resize;
  z-index: 10;
  transition: background-color 0.15s;

  &:hover,
  &:active {
    background-color: rgba(108, 99, 255, 0.5);
  }
}
</style>
