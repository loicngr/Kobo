<template>
  <div class="workspace-preview col column no-wrap">
    <div ref="body" class="preview-body col row no-wrap" :class="{ 'is-resizing': resizing }">
      <q-resize-observer @resize="({ width }) => bodyWidth = width" />
      <div v-show="mode !== 'preview'" class="preview-chat column no-wrap"
        :style="{ flex: split ? `0 0 ${displayPercent}%` : '1 1 0%' }"><slot /></div>
      <div v-if="split" class="preview-separator" role="separator" tabindex="0" aria-orientation="vertical"
        :aria-label="t('preview.resize')" :aria-valuenow="Math.round(displayPercent)" :aria-valuemin="Math.round(minPercent)" :aria-valuemax="Math.round(maxPercent)"
        @pointerdown="startResize" @dblclick="setPercent(45)"
        @keydown.left.prevent="setPercent(displayPercent - 2)" @keydown.right.prevent="setPercent(displayPercent + 2)"
        @keydown.home.prevent="setPercent(45)" />
      <section v-if="opened" v-show="mode !== 'chat'" class="preview-pane col column no-wrap" :aria-label="t('preview.title')">
        <div class="preview-toolbar row items-center no-wrap">
          <span class="text-weight-medium">{{ t('preview.title') }}</span>
          <span class="preview-status ellipsis" role="status">{{ statusText }}</span>
          <q-space />
          <q-btn flat round icon="refresh" :loading="loading" :aria-label="t('preview.reload')" @click="load" />
          <q-btn v-if="url" flat round icon="open_in_new" :href="publicUrl" target="_blank" rel="noopener noreferrer"
            :aria-label="t('preview.external')" />
          <q-btn flat round icon="close" :aria-label="t('preview.close')" @click="close" />
        </div>
        <div v-if="loading" class="preview-state col" role="status"><q-spinner color="primary" />{{ t('common.loading') }}</div>
        <div v-else-if="error || !url" class="preview-state col" :role="error ? 'alert' : 'status'">
          <span>{{ error || t('preview.stopped') }}</span>
          <q-btn v-if="canStart" no-caps color="primary" :label="t('common.start')" :loading="starting" @click="start" />
          <q-btn v-else flat no-caps :label="t('common.retry')" @click="load" />
        </div>
        <iframe v-else :key="url" :src="url" :title="t('preview.title')" class="preview-frame col"
          referrerpolicy="no-referrer" sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads allow-modals" />
        <div v-if="url && !loading" class="preview-hint">{{ t('preview.frameHint') }}</div>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useQuasar } from 'quasar'
import { usePointerResize } from 'src/composables/use-pointer-resize'
import { useDevServerStore } from 'src/stores/dev-server'
import { useLayoutStore } from 'src/stores/layout'
import { useWorkspaceStore } from 'src/stores/workspace'
import { apiFetch } from 'src/utils/api'
import { createLatestRequest, isAbortError } from 'src/utils/latest-request'
import { previewBrowserUrl, readPreviewPercent } from 'src/utils/preview'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { isNavigationFailure, NavigationFailureType, useRoute, useRouter } from 'vue-router'

const props = defineProps<{ workspaceId: string }>()
const { t } = useI18n()
const $q = useQuasar()
const layout = useLayoutStore()
const dev = useDevServerStore()
const workspaces = useWorkspaceStore()
const route = useRoute()
const router = useRouter()
type Mode = 'chat' | 'split' | 'preview'
const mode = ref<Mode>('chat')
const opened = ref(false)
const bodyWidth = ref(0)
const small = computed(() => $q.screen.lt.md || (bodyWidth.value > 0 && bodyWidth.value < 640))
const split = computed(() => mode.value === 'split' && !small.value)
const options = computed<{ label: string; value: Mode; icon: string }[]>(() => [
  { label: t('preview.chat'), value: 'chat', icon: 'chat_bubble_outline' },
  ...(!small.value ? [{ label: t('preview.split'), value: 'split' as const, icon: 'vertical_split' }] : []),
  { label: t('preview.title'), value: 'preview', icon: 'preview' },
])
let previousDrawers: { left: boolean; right: boolean; leftWidth: number; rightWidth: number } | undefined
const body = ref<HTMLElement>()
const resizing = ref(false)
const resize = usePointerResize()
const widthKey = computed(() => `kobo:preview:width:${layout.rightDrawerOpen ? 'drawer' : 'plain'}`)
const percent = ref(45)
const minPercent = computed(() => (bodyWidth.value ? Math.max(20, (280 / bodyWidth.value) * 100) : 20))
const maxPercent = computed(() =>
  bodyWidth.value ? Math.min(80, ((bodyWidth.value - 288) / bodyWidth.value) * 100) : 80,
)
const displayPercent = computed(() => Math.min(maxPercent.value, Math.max(minPercent.value, percent.value)))
watch(
  widthKey,
  () => {
    percent.value = readPreviewPercent(localStorage.getItem(widthKey.value))
  },
  { immediate: true },
)
function setPercent(value: number) {
  percent.value = Math.min(maxPercent.value, Math.max(minPercent.value, value))
  localStorage.setItem(widthKey.value, String(percent.value))
}
function startResize(event: PointerEvent) {
  const bounds = body.value?.getBoundingClientRect()
  if (!bounds?.width) return
  resize(event, {
    cursor: 'col-resize',
    move: (next) => {
      resizing.value = true
      setPercent(((next.clientX - bounds.left) / bounds.width) * 100)
    },
    end: () => {
      resizing.value = false
    },
  })
}
async function setMode(value: Mode, syncRoute = true) {
  if (syncRoute) {
    const failure = await router.replace(modeLocation(value))
    if (!failure || isNavigationFailure(failure, NavigationFailureType.duplicated)) void setMode(value, false)
    return
  }
  if (value !== 'chat' && !opened.value) {
    previousDrawers = {
      left: layout.leftDrawerOpen,
      right: layout.rightDrawerOpen,
      leftWidth: layout.leftDrawerWidth,
      rightWidth: layout.rightDrawerWidth,
    }
    opened.value = true
    void load()
  }
  mode.value = small.value && value === 'split' ? 'preview' : value
}
function modeLocation(value: Mode) {
  const query = { ...route.query }
  delete query.preview
  if (value === 'split') query.preview = 'split'
  return {
    path: `/workspace/${encodeURIComponent(props.workspaceId)}${value === 'chat' ? '' : '/preview'}`,
    query,
    hash: route.hash,
  }
}

defineExpose({ mode, options, setMode })

async function close() {
  const failure = await router.replace(modeLocation('chat'))
  if (failure && !isNavigationFailure(failure, NavigationFailureType.duplicated)) return
  request.abort()
  url.value = ''
  opened.value = false
  loading.value = false
  if (previousDrawers) {
    layout.setLeft(previousDrawers.left)
    layout.setRight(previousDrawers.right)
    layout.leftDrawerWidth = previousDrawers.leftWidth
    layout.rightDrawerWidth = previousDrawers.rightWidth
    localStorage.setItem('at-left-drawer-width', String(previousDrawers.leftWidth))
    localStorage.setItem('kobo:rightDrawerWidth', String(previousDrawers.rightWidth))
    previousDrawers = undefined
  }
  setMode('chat', false)
}
const status = computed(() => dev.getStatus(props.workspaceId))
const statusText = computed(() =>
  status.value
    ? t(`devServer.${status.value.status === 'not_configured' ? 'notConfigured' : status.value.status}`)
    : '',
)
const workspace = computed(() => workspaces.workspaces.find((w) => w.id === props.workspaceId))
const canStart = computed(
  () => status.value?.status === 'stopped' && !workspace.value?.archivedAt && !workspace.value?.worktreePurgedAt,
)
const url = ref('')
const publicUrl = ref('')
const loading = ref(false)
const starting = ref(false)
const error = ref('')
const request = createLatestRequest()
async function load() {
  const signal = request.begin()
  loading.value = true
  error.value = ''
  url.value = ''
  try {
    await dev.fetchStatus(props.workspaceId)
    if (!request.isCurrent(signal)) return
    if (status.value?.status !== 'running') return
    const data = await apiFetch<{ url: string; publicUrl: string; remote: boolean }>(
      `/api/dev-server/${encodeURIComponent(props.workspaceId)}/preview`,
      { method: 'POST', signal },
    )
    if (!request.isCurrent(signal) || status.value?.status !== 'running') return
    url.value = previewBrowserUrl(data.url, window.location.href, data.remote)
    publicUrl.value = previewBrowserUrl(data.publicUrl, window.location.href, data.remote)
  } catch (err) {
    if (request.isCurrent(signal) && !isAbortError(err))
      error.value = t('preview.failed', { message: err instanceof Error ? err.message : String(err) })
  } finally {
    if (request.isCurrent(signal)) loading.value = false
  }
}
async function start() {
  starting.value = true
  try {
    await dev.startDevServer(props.workspaceId)
    await load()
  } catch (err) {
    error.value = t('preview.failed', { message: String(err) })
  } finally {
    starting.value = false
  }
}
watch(
  () => status.value?.status,
  (next, previous) => {
    if (!opened.value) return
    if (previous === 'running' && next !== 'running') {
      request.abort()
      loading.value = false
      url.value = ''
      void close()
      return
    }
    if (next !== 'running') {
      request.abort()
      loading.value = false
      url.value = ''
    } else if (previous !== 'running' && !loading.value) void load()
  },
)
watch(small, (value) => {
  if (value && mode.value === 'split') mode.value = 'preview'
})
watch(
  () => [route.path, route.query.preview],
  () => {
    setMode(route.path.endsWith('/preview') ? (route.query.preview === 'split' ? 'split' : 'preview') : 'chat', false)
  },
  { immediate: true },
)
const poll = setInterval(() => {
  if (opened.value) void dev.fetchStatus(props.workspaceId)
}, 10000)
onBeforeUnmount(() => {
  request.abort()
  clearInterval(poll)
})
</script>

<style scoped lang="scss">
.workspace-preview, .preview-body, .preview-chat, .preview-pane { min-width: 0; min-height: 0; overflow: hidden; }
.preview-toolbar { flex-shrink: 0; min-height: 44px; gap: var(--kobo-space-sm); padding: var(--kobo-space-xs) var(--kobo-space-sm); border-bottom: 1px solid var(--kobo-border-subtle); background: var(--kobo-bg-deep); }
.preview-toolbar :deep(.q-btn) { min-height: 36px; }
.preview-pane { background: var(--kobo-bg); }
.preview-status { min-width: 0; font-size: 12px; color: var(--kobo-text-3); }
.preview-toolbar > span:first-child { flex-shrink: 0; }
.preview-frame { border: 0; width: 100%; min-height: 0; background: white; }
.preview-separator { width: 8px; flex: 0 0 8px; cursor: col-resize; touch-action: none; border-inline: 1px solid var(--kobo-border-subtle); background: var(--kobo-bg-deep); }
.preview-separator:hover, .preview-separator:focus-visible { background: var(--kobo-accent); outline: none; }
.is-resizing .preview-frame { pointer-events: none; }
.preview-state { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: var(--kobo-space-lg); padding: var(--kobo-space-xl); text-align: center; overflow-wrap: anywhere; }
.preview-hint { padding: var(--kobo-space-xs) var(--kobo-space-sm); color: var(--kobo-text-3); font-size: 12px; }
@media (max-width: 1023px) { .preview-toolbar :deep(.q-btn) { min-width: 44px; min-height: 44px; } .preview-status { display: none; } }
</style>
