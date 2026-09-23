<template>
  <q-page class="split-page" :style-fn="workspacePageStyle">
    <header class="split-header" data-tour="split-controls">
      <q-btn flat dense no-caps :label="$t('layout.toggleWorkspaces')" @click="layout.toggleLeft()" />
      <strong>{{ $t('split.title') }}</strong>
      <q-space />
      <q-btn flat dense no-caps :label="$t('split.close')"
        @click="router.push({ name: 'workspace', params: { id: selected[active] || undefined } })" />
    </header>
    <q-splitter v-model="ratio" :limits="[25, 75]" :horizontal="$q.screen.lt.md" class="split-body"
      @update:model-value="saveRatio" >
      <template v-for="(slot, index) in slots" :key="slot" #[slot]>
        <section class="split-pane" :class="{ 'split-pane--active': active === index }">
          <div class="split-pane-header">
            <q-select :model-value="selected[index]" :options="options" emit-value map-options dense outlined
              :label="$t(index === 0 ? 'split.left' : 'split.right')" class="split-select"
              @update:model-value="(id: string) => selectPane(index, id)" />
            <span class="split-recipient" aria-live="polite">
              {{ $t('split.recipient', { name: paneName(index) }) }}
            </span>
          </div>
          <iframe v-if="sources[index]" :ref="(el) => setFrame(index, el)" :src="sources[index]"
            :title="$t('split.recipient', { name: paneName(index) })" class="split-frame"
            @load="syncPanes" />
          <div v-else class="split-empty">{{ $t('split.choose') }}</div>
        </section>
      </template>
    </q-splitter>
  </q-page>
</template>

<script setup lang="ts">
import { useTours } from 'src/composables/use-tours'
import { useLayoutStore } from 'src/stores/layout'
import { useWorkspaceStore } from 'src/stores/workspace'
import {
  embeddedWorkspaceUrl,
  normalizeSplitRatio,
  syncSplitLocation,
  type WorkspacePaneWindow,
} from 'src/utils/split-workspace'
import { registerUnsavedScope, unregisterUnsavedScope } from 'src/utils/unsaved-guard'
import { workspacePageStyle } from 'src/utils/workspace-page-layout'
import { type ComponentPublicInstance, computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'

const store = useWorkspaceStore()
const layout = useLayoutStore()
const route = useRoute()
const router = useRouter()
const { t } = useI18n()
const slots = ['before', 'after'] as const
const selected = ref(['', ''])
const sources = ref(['', ''])
const frames: (HTMLIFrameElement | null)[] = [null, null]
const active = ref(0)
let savedRatio: string | null = null
try {
  savedRatio = localStorage.getItem('kobo:splitRatio')
} catch {
  /* unavailable storage */
}
const ratio = ref(normalizeSplitRatio(savedRatio))
const options = computed(() =>
  [...store.workspaces, ...store.archivedWorkspaces].map((ws) => ({ label: ws.name, value: ws.id })),
)
function paneName(index: number) {
  return (
    options.value.find((option) => option.value === selected.value[index])?.label ||
    selected.value[index] ||
    t('split.choose')
  )
}
function setFrame(index: number, el: Element | ComponentPublicInstance | null) {
  frames[index] = el as HTMLIFrameElement | null
}
function bridge(index: number) {
  try {
    return (frames[index]?.contentWindow as WorkspacePaneWindow | null)?.koboPane
  } catch {
    return undefined
  }
}
async function selectPane(index: number, id: string) {
  active.value = index
  const pane = bridge(index)
  if (pane) {
    await pane.navigate(id)
    syncPanes()
  } else if (!sources.value[index]) {
    selected.value[index] = id
    sources.value[index] = embeddedWorkspaceUrl(id)
  }
}
function syncPanes() {
  for (const index of [0, 1]) {
    const pane = bridge(index)
    if (pane?.ready()) selected.value[index] = pane.workspaceId() ?? ''
    if (frames[index] && document.activeElement === frames[index]) active.value = index
  }
  // Do not erase a deep link while either application is still loading.
  if (route.name === 'split' && [0, 1].every((index) => !sources.value[index] || bridge(index)?.ready())) {
    void syncSplitLocation(router, { left: selected.value[0] || undefined, right: selected.value[1] || undefined })
  }
}
function saveRatio() {
  try {
    localStorage.setItem('kobo:splitRatio', String(ratio.value))
  } catch {
    /* unavailable storage */
  }
}
// Changes coming from the sidebar pass through the existing global dirty guard.
watch(
  () => [route.query.left, route.query.right],
  ([left, right]) => {
    for (const [index, id] of [left, right].entries()) {
      const next = typeof id === 'string' ? id : ''
      if (selected.value[index] === next) continue
      selected.value[index] = next
      sources.value[index] = selected.value[index] ? embeddedWorkspaceUrl(selected.value[index]!) : ''
    }
  },
  { immediate: true },
)
const { scheduleAutoRun } = useTours()
let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  registerUnsavedScope('split-panes', () => [0, 1].some((index) => bridge(index)?.hasUnsavedWork()))
  timer = setInterval(syncPanes, 500)
  scheduleAutoRun('split')
})
onUnmounted(() => {
  unregisterUnsavedScope('split-panes')
  clearInterval(timer)
})
</script>

<style scoped lang="scss">
.split-page { display: flex; flex-direction: column; overflow: hidden; }
.split-header, .split-pane-header { display: flex; align-items: center; gap: var(--kobo-space-sm); padding: var(--kobo-space-sm); border-bottom: 1px solid var(--kobo-border); }
.split-header { background: var(--kobo-surface); }
.split-body { flex: 1; min-height: 0; }
.split-pane { height: 100%; display: flex; flex-direction: column; min-width: 0; }
.split-pane-header { flex-wrap: wrap; border-top: var(--kobo-space-2xs) solid transparent; }
.split-pane--active .split-pane-header { border-top-color: var(--kobo-accent); }
.split-select { flex: 1; min-width: 0; }
.split-recipient { color: var(--kobo-text-3);  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
.split-frame { width: 100%; flex: 1; min-height: 0; border: 0; }
.split-empty { padding: var(--kobo-space-xl); color: var(--kobo-text-3); }
</style>
