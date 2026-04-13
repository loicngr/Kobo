<script setup lang="ts">
import AcceptancePanel from 'src/components/AcceptancePanel.vue'
import AgentTodosPanel from 'src/components/AgentTodosPanel.vue'
import DevServerPanel from 'src/components/DevServerPanel.vue'
import GitPanel from 'src/components/GitPanel.vue'
import NotionPanel from 'src/components/NotionPanel.vue'
import PlansPanel from 'src/components/PlansPanel.vue'
import StatsPanel from 'src/components/StatsPanel.vue'
import SubagentsPanel from 'src/components/SubagentsPanel.vue'
import TerminalPanel from 'src/components/TerminalPanel.vue'
import ToolsPanel from 'src/components/ToolsPanel.vue'
import WorkspaceList from 'src/components/WorkspaceList.vue'
import { useWorkspaceStore } from 'src/stores/workspace'
import { computed, provide, ref } from 'vue'
import { useRoute } from 'vue-router'

const DRAWER_TAB_KEY = 'kobo:rightTab'
const rightTab = ref(localStorage.getItem(DRAWER_TAB_KEY) ?? 'git')

function setRightTab(val: string) {
  rightTab.value = val
  localStorage.setItem(DRAWER_TAB_KEY, val)
}

const leftDrawerOpen = ref(true)
const rightDrawerOpen = ref(true)

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

const route = useRoute()
const store = useWorkspaceStore()

const showRightDrawer = computed(() => route.name === 'workspace')

provide('openDrawerTab', (tab: string) => {
  rightDrawerOpen.value = true
  setRightTab(tab)
})

const SPLIT_KEY = 'kobo:rightDrawerSplit'
const savedSplit = parseInt(localStorage.getItem(SPLIT_KEY) ?? '60', 10)
const topPercent = ref(Math.min(80, Math.max(20, savedSplit)))
const isResizingVertical = ref(false)

const bottomTab = ref('terminal')

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
      :width="300"
      :breakpoint="0"
      persistent
      bordered
      class="bg-dark"
    >
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
            <q-tab name="server" icon="dns" />
            <q-tab name="tasks" icon="checklist" />
            <q-tab name="subagents" icon="smart_toy" />
            <q-tab name="stats" icon="bar_chart" />
            <q-tab name="plans" icon="description" />
          </q-tabs>

          <q-separator dark />

          <div class="col" style="overflow: auto;">
            <q-tab-panels v-model="rightTab" animated keep-alive>
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

              <q-tab-panel name="stats" class="q-pa-none">
                <StatsPanel :workspace="store.selectedWorkspace" />
              </q-tab-panel>

              <q-tab-panel name="plans" class="q-pa-none">
                <PlansPanel :workspace="store.selectedWorkspace" />
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
            <q-tab name="terminal" icon="terminal" />
            <q-tab name="tools" icon="build" />
          </q-tabs>

          <q-separator dark />

          <q-tab-panels v-model="bottomTab" animated keep-alive class="col" style="overflow: hidden;">
            <q-tab-panel name="terminal" class="q-pa-none" style="height: 100%;">
              <TerminalPanel />
            </q-tab-panel>

            <q-tab-panel name="tools" class="q-pa-none" style="overflow: auto;">
              <ToolsPanel :workspace="store.selectedWorkspace" />
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
