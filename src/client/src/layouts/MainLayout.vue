<template>
  <q-layout view="lHh LpR lFf">
    <q-drawer
      v-model="leftDrawerOpen"
      :width="leftDrawerWidth"
      :breakpoint="0"
      persistent
      bordered
      class="bg-dark"
    >
      <WorkspaceList />
      <div class="resize-handle" @mousedown="startResize" />
    </q-drawer>

    <q-drawer
      :model-value="showRightDrawer"
      side="right"
      :width="rightDrawerWidth"
      :breakpoint="0"
      persistent
      bordered
      class="bg-dark"
    >
      <div class="resize-handle resize-handle--right" @mousedown="startRightResize" />
      <div class="column no-wrap" style="position: absolute; inset: 0; overflow: hidden;">
        <!-- Upper zone -->
        <div :style="{ flex: `${topPercent} 1 0%` }" class="column no-wrap" style="overflow: hidden;">
          <q-tabs
            :model-value="rightTab"
            dense
            dark
            active-color="indigo-4"
            indicator-color="indigo-4"
            narrow-indicator
            @update:model-value="setRightTab"
          >
            <q-tab name="git" icon="commit" />
            <q-tab name="tasks" icon="checklist" />
            <q-tab name="subagents" icon="smart_toy" />
            <q-tab name="documents" icon="description" />
          </q-tabs>

          <q-separator dark />

          <div class="col" style="overflow: auto;">
            <q-tab-panels v-model="rightTab" animated keep-alive>
              <q-tab-panel name="git" class="q-pa-none">
                <GitPanel :workspace="store.selectedWorkspace" />
              </q-tab-panel>

              <q-tab-panel name="tasks" class="q-pa-none">
                <TasksPanel :workspace="store.selectedWorkspace" :tasks="store.tasks" />
                <q-separator dark />
                <AcceptancePanel :tasks="store.acceptanceCriteria" />
                <q-separator dark />
                <AgentTodosPanel />
              </q-tab-panel>

              <q-tab-panel name="subagents" class="q-pa-none">
                <SubagentsPanel />
              </q-tab-panel>

              <q-tab-panel name="documents" class="q-pa-none">
                <DocumentsPanel :workspace="store.selectedWorkspace" />
              </q-tab-panel>
            </q-tab-panels>
          </div>
        </div>

        <!-- Drag handle -->
        <div class="vertical-resize-handle" @mousedown="startVerticalResize" />

        <!-- Lower zone -->
        <div :style="{ flex: `${100 - topPercent} 1 0%` }" class="column no-wrap" style="overflow: hidden;">
          <q-tabs
            v-model="bottomTab"
            dense
            dark
            active-color="indigo-4"
            indicator-color="indigo-4"
            narrow-indicator
          >
            <q-tab name="tools" icon="build" />
            <q-tab name="terminal" icon="terminal" />
          </q-tabs>

          <q-separator dark />

          <q-tab-panels v-model="bottomTab" animated keep-alive class="col" style="overflow: hidden;">
            <q-tab-panel name="tools" class="q-pa-none" style="overflow: auto;">
              <ToolsPanel :workspace="store.selectedWorkspace" />
            </q-tab-panel>

            <q-tab-panel name="terminal" class="q-pa-none" style="height: 100%;">
              <TerminalPanel />
            </q-tab-panel>
          </q-tab-panels>
        </div>
      </div>
    </q-drawer>

    <q-page-container class="bg-dark">
      <router-view />
    </q-page-container>
  </q-layout>
</template>

<script setup lang="ts">
import AcceptancePanel from 'src/components/AcceptancePanel.vue'
import AgentTodosPanel from 'src/components/AgentTodosPanel.vue'
import DocumentsPanel from 'src/components/DocumentsPanel.vue'
import GitPanel from 'src/components/GitPanel.vue'
import SubagentsPanel from 'src/components/SubagentsPanel.vue'
import TasksPanel from 'src/components/TasksPanel.vue'
import TerminalPanel from 'src/components/TerminalPanel.vue'
import ToolsPanel from 'src/components/ToolsPanel.vue'
import WorkspaceList from 'src/components/WorkspaceList.vue'
import { useDocumentsStore } from 'src/stores/documents'
import { useWorkspaceStore } from 'src/stores/workspace'
import { computed, provide, ref, watch } from 'vue'
import { useRoute } from 'vue-router'

const DRAWER_TAB_KEY = 'kobo:rightTab'
const VALID_RIGHT_TABS = ['git', 'tasks', 'subagents', 'documents'] as const
const storedRightTab = localStorage.getItem(DRAWER_TAB_KEY)
const rightTab = ref(
  storedRightTab && (VALID_RIGHT_TABS as readonly string[]).includes(storedRightTab) ? storedRightTab : 'git',
)

function setRightTab(val: string) {
  rightTab.value = val
  localStorage.setItem(DRAWER_TAB_KEY, val)
}

// External deep-link: when the documents store signals a request to open
// (e.g. user clicked a plan path inside a chat message), switch to the
// Documents tab so the opened file is visible.
const documentsStore = useDocumentsStore()
watch(
  () => documentsStore.requestOpen,
  () => setRightTab('documents'),
)

// Keep the documents list populated for the selected workspace regardless
// of whether the user has opened the Documents tab yet — otherwise the
// in-chat clickable-path detection has no catalogue to match against.

const leftDrawerOpen = ref(true)
const rightDrawerOpen = ref(true)

const DRAWER_WIDTH_KEY = 'at-left-drawer-width'
const savedWidth = parseInt(localStorage.getItem(DRAWER_WIDTH_KEY) ?? '260', 10)
const leftDrawerWidth = ref(Math.min(500, Math.max(140, savedWidth)))
const isResizing = ref(false)

const RIGHT_DRAWER_WIDTH_KEY = 'kobo:rightDrawerWidth'
const RIGHT_DRAWER_MIN = 240
const RIGHT_DRAWER_MAX = 800
const savedRightWidth = parseInt(localStorage.getItem(RIGHT_DRAWER_WIDTH_KEY) ?? '300', 10)
const rightDrawerWidth = ref(Math.min(RIGHT_DRAWER_MAX, Math.max(RIGHT_DRAWER_MIN, savedRightWidth)))
const isResizingRight = ref(false)

function startResize(event: MouseEvent) {
  event.preventDefault()
  isResizing.value = true

  const onMouseMove = (e: MouseEvent) => {
    const newWidth = Math.min(500, Math.max(140, e.clientX))
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

function startRightResize(event: MouseEvent) {
  event.preventDefault()
  isResizingRight.value = true

  const onMouseMove = (e: MouseEvent) => {
    const newWidth = Math.min(RIGHT_DRAWER_MAX, Math.max(RIGHT_DRAWER_MIN, window.innerWidth - e.clientX))
    rightDrawerWidth.value = newWidth
  }

  const onMouseUp = () => {
    isResizingRight.value = false
    localStorage.setItem(RIGHT_DRAWER_WIDTH_KEY, String(rightDrawerWidth.value))
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

const route = useRoute()
const store = useWorkspaceStore()

watch(
  () => store.selectedWorkspaceId,
  (wsId) => {
    if (wsId) void documentsStore.fetchDocuments(wsId)
  },
  { immediate: true },
)

// Clear the workspace selection when the user navigates to a non-workspace
// page (create, settings, search, health). The sidebar highlight stops
// pointing to a workspace the user is no longer working on.
watch(
  () => route.name,
  (name) => {
    if (name !== 'workspace' && store.selectedWorkspaceId) {
      store.selectedWorkspaceId = null
      store.selectedSessionId = null
    }
  },
  { immediate: true },
)

const showRightDrawer = computed(() => route.name === 'workspace')

provide('openDrawerTab', (tab: string) => {
  rightDrawerOpen.value = true
  setRightTab(tab)
})

const SPLIT_KEY = 'kobo:rightDrawerSplit'
const savedSplit = parseInt(localStorage.getItem(SPLIT_KEY) ?? '60', 10)
const topPercent = ref(Math.min(80, Math.max(20, savedSplit)))
const isResizingVertical = ref(false)

const bottomTab = ref('tools')

function startVerticalResize(event: MouseEvent) {
  event.preventDefault()
  isResizingVertical.value = true

  const drawer = (event.target as HTMLElement).closest('.q-drawer') as HTMLElement | null
  if (!drawer) return

  const onMouseMove = (e: MouseEvent) => {
    const rect = drawer.getBoundingClientRect()
    const y = e.clientY - rect.top
    const percent = Math.round((y / rect.height) * 100)
    topPercent.value = Math.min(80, Math.max(20, percent))
  }

  const onMouseUp = () => {
    isResizingVertical.value = false
    localStorage.setItem(SPLIT_KEY, String(topPercent.value))
    document.removeEventListener('mousemove', onMouseMove)
    document.removeEventListener('mouseup', onMouseUp)
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
  }

  document.body.style.cursor = 'row-resize'
  document.body.style.userSelect = 'none'
  document.addEventListener('mousemove', onMouseMove)
  document.addEventListener('mouseup', onMouseUp)
}
</script>

<style lang="scss" scoped>
.bg-dark {
  background-color: #16162a !important;
  border-color: #2a2a4a !important;
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

  &--right {
    right: auto;
    left: -2px;
  }
}

.vertical-resize-handle {
  height: 4px;
  cursor: row-resize;
  background-color: #2a2a4a;
  transition: background-color 0.15s;

  &:hover,
  &:active {
    background-color: rgba(108, 99, 255, 0.5);
  }
}
</style>
