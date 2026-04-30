<template>
  <div class="diff-viewer column full-height">
    <!-- Header — same style as .wp-header in WorkspacePage -->
    <div class="diff-header row items-center q-px-md q-py-sm no-wrap">
      <q-icon name="difference" size="18px" color="indigo-4" class="q-mr-xs" />
      <span class="text-body1 text-weight-medium text-grey-3">{{ $t('diff.title') }}</span>
      <q-badge
        :label="`${files.length}`"
        color="grey-8"
        text-color="grey-4"
        class="q-ml-sm"
        style="font-size: 10px;"
      />
      <span v-if="sourceBranch" class="text-caption text-grey-6 q-ml-md" style="font-size: 11px;">
        <template v-if="diffMode === 'branch'">
          <span class="text-grey-7">{{ sourceBranch }}</span>
          <q-icon name="arrow_forward" size="11px" color="grey-8" class="q-mx-xs" />
          <span class="text-green-4">{{ workingBranch }}</span>
        </template>
        <template v-else>
          <span class="text-grey-7">origin/{{ workingBranch }}</span>
          <q-icon name="arrow_forward" size="11px" color="grey-8" class="q-mx-xs" />
          <span class="text-green-4">HEAD</span>
        </template>
      </span>
      <span
        v-if="selectedFile"
        class="text-caption text-grey-5 q-ml-md ellipsis"
        style="font-size: 11px; font-family: 'Roboto Mono', monospace; max-width: 400px;"
      >
        {{ selectedFile }}
      </span>
      <q-space />
      <q-btn-toggle
        v-model="diffMode"
        dense
        no-caps
        size="sm"
        toggle-color="indigo-8"
        color="grey-9"
        text-color="grey-5"
        :options="[
          { label: $t('diff.scopeBranch'), value: 'branch' },
          { label: $t('diff.scopeUnpushed'), value: 'unpushed' },
        ]"
        class="q-mr-sm"
      />
      <q-btn-toggle
        v-model="reviewMode"
        dense
        no-caps
        size="sm"
        toggle-color="indigo-8"
        color="grey-9"
        text-color="grey-5"
        :options="[
          { label: $t('diff.modeInspect'), value: 'inspect' },
          { label: $t('diff.modeReview'), value: 'review' },
        ]"
        class="q-mr-sm"
      />
      <q-btn-toggle
        v-model="viewMode"
        dense
        no-caps
        size="sm"
        toggle-color="indigo-8"
        color="grey-9"
        text-color="grey-5"
        :options="[
          { label: $t('diff.side'), value: 'side' },
          { label: $t('diff.inline'), value: 'inline' },
        ]"
        class="q-mr-sm"
      />
      <q-btn
        :icon="hideUnchanged ? 'unfold_less' : 'unfold_more'"
        dense
        flat
        size="sm"
        :color="hideUnchanged ? 'indigo-4' : 'grey-5'"
        class="q-mr-sm"
        @click="hideUnchanged = !hideUnchanged"
      >
        <q-tooltip anchor="bottom middle" self="top middle" :delay="400">
          {{ hideUnchanged ? $t('diff.showUnchanged') : $t('diff.hideUnchanged') }}
        </q-tooltip>
      </q-btn>
      <q-btn
        v-if="diffMode === 'branch'"
        icon="visibility"
        dense
        flat
        size="sm"
        :color="includeUntracked ? 'indigo-4' : 'grey-5'"
        class="q-mr-sm"
        @click="includeUntracked = !includeUntracked"
      >
        <q-tooltip anchor="bottom middle" self="top middle" :delay="400">
          {{ includeUntracked ? $t('diff.hideUntracked') : $t('diff.showUntracked') }}
        </q-tooltip>
      </q-btn>
      <q-btn
        flat
        round
        dense
        icon="close"
        color="grey-5"
        size="sm"
        :disable="submittingReview"
        @click="emit('close')"
      >
        <q-tooltip>{{ $t('tooltip.closeDiffViewer') }}</q-tooltip>
      </q-btn>
    </div>

    <q-separator dark />

    <div class="row col no-wrap" style="min-height: 0;">
      <!-- Review mode: draft panel on the far left.
           Note: `reviewDraft.draft` is a Ref nested inside the returned object,
           so Vue does NOT auto-unwrap it in the template — we go through the
           `draftComments` / `draftGlobalMessage` computed wrappers below. -->
      <div
        v-if="reviewMode === 'review'"
        class="review-draft-panel-wrapper"
        :style="{ width: '300px', minWidth: '240px', flexShrink: 0, borderRight: '1px solid #2a2a4a' }"
      >
        <ReviewDraftPanel
          :comments="draftComments"
          :global-message="draftGlobalMessage"
          :submitting="submittingReview"
          @update-global="reviewDraft.setGlobalMessage"
          @jump-to-file="onJumpToFile"
          @jump-to-comment="onJumpToComment"
          @submit="onSubmitReview"
        />
      </div>

      <!-- File tree sidebar (resizable via the drag handle on its right edge) -->
      <div
        class="diff-file-list-wrapper"
        :style="{ width: `${fileListWidth}px`, minWidth: `${FILE_LIST_MIN}px` }"
      >
      <q-scroll-area class="diff-file-list q-pa-xs" style="width: 100%; height: 100%; border-right: 1px solid #2a2a4a;">
        <q-spinner-dots v-if="loading" size="24px" color="grey-6" class="q-ma-md" />
        <div v-else-if="files.length === 0" class="text-caption text-grey-8 q-pa-sm">{{ $t('diff.noChanges') }}</div>
        <q-tree
          v-else
          :nodes="tree"
          node-key="nodeKey"
          label-key="label"
          children-key="children"
          dark
          dense
          default-expand-all
          no-selection-unset
          :selected="selectedNodeKey"
          class="diff-tree"
          @update:selected="
            (key) => {
              if (typeof key !== 'string' || !key.startsWith('file:')) return
              selectedFile = key.slice('file:'.length)
            }
          "
        >
          <template #default-header="{ node }">
            <template v-if="node.isFolder">
              <q-icon name="folder" size="14px" color="indigo-4" class="q-mr-xs" />
              <span
                class="text-grey-4"
                style="font-family: 'Roboto Mono', monospace; font-size: 11px;"
              >{{ node.label }}</span>
              <q-badge
                :label="node.children ? countLeaves(node.children) : 0"
                color="grey-9"
                text-color="grey-5"
                class="q-ml-xs"
                style="font-size: 9px;"
              />
              <q-badge
                v-if="reviewMode === 'review' && commentCountForFolder(folderPathOf(node)) > 0"
                :label="String(commentCountForFolder(folderPathOf(node)))"
                color="grey-7"
                text-color="grey-3"
                class="q-ml-xs"
                style="font-size: 9px;"
              />
            </template>
            <template v-else>
              <q-icon
                name="description"
                size="14px"
                :style="{ color: statusColor(node.file.status) }"
                class="q-mr-xs"
              >
                <q-tooltip>{{ node.file.status }}</q-tooltip>
              </q-icon>
              <span
                class="text-grey-3 ellipsis"
                style="font-family: 'Roboto Mono', monospace; font-size: 11px;"
              >{{ node.label }}</span>
              <q-badge
                v-if="reviewMode === 'review' && (commentsByFile.get(node.file.path) ?? 0) > 0"
                :label="String(commentsByFile.get(node.file.path))"
                color="indigo-8"
                text-color="white"
                class="q-ml-xs"
                style="font-size: 9px;"
              />
              <q-menu touch-position context-menu>
                <q-list dense dark style="min-width: 220px;">
                  <q-item
                    clickable
                    v-close-popup
                    @click="confirmRollback(node.file.path, node.file.status)"
                  >
                    <q-item-section avatar>
                      <q-icon
                        :name="node.file.status === 'untracked' ? 'delete' : 'restore'"
                        size="16px"
                        :color="node.file.status === 'untracked' ? 'red-5' : 'orange-5'"
                      />
                    </q-item-section>
                    <q-item-section>
                      {{ node.file.status === 'untracked' ? $t('diff.deleteUntracked') : $t('diff.rollbackToRemote') }}
                    </q-item-section>
                  </q-item>
                </q-list>
              </q-menu>
            </template>
          </template>
        </q-tree>
      </q-scroll-area>
        <div class="diff-file-list-resize-handle" @mousedown="startFileListResize" />
      </div>

      <!-- Monaco diff editor -->
      <div class="col column" style="min-width: 0; position: relative;">
        <div v-if="loadingFile" class="col column items-center justify-center">
          <q-spinner-dots size="32px" color="indigo-4" />
        </div>
        <div
          v-else-if="!selectedFile"
          class="col column items-center justify-center text-grey-8 text-caption"
        >
          {{ $t('diff.selectFile') }}
        </div>
        <!-- Editor area + Review-mode overlays. The wrapper is `position:
             relative` so the overlays inside are positioned against this
             box, not the document. Each overlay's `top` is the pixel
             position of its line in the modified editor (synced via
             onDidScrollChange / onDidLayoutChange).  -->
        <div ref="editorWrapperRef" class="col" style="min-height: 0; position: relative; overflow: hidden;">
          <div ref="editorContainer" style="position: absolute; inset: 0;" />
          <div
            v-for="zone in mountedZones"
            :key="zone.zoneId"
            class="review-zone-overlay"
            :style="{ top: `${zone.topPx}px`, height: `${zone.heightPx}px` }"
          >
            <ReviewCommentBlock
              :comments="zone.comments"
              :start-in-add-mode="zone.transient"
              @add="(content) => onZoneAdd(selectedFile ?? '', zone.line, content)"
              @update="(id, content) => onZoneUpdate(selectedFile ?? '', zone.line, id, content)"
              @delete="(id) => onZoneDelete(selectedFile ?? '', zone.line, id)"
              @dismiss-empty="disposeZonesForLine(zone.line)"
            />
          </div>
        </div>

        <!-- Floating "Add to chat" button when text is selected -->
        <q-btn
          v-if="hasSelection"
          no-caps
          dense
          size="sm"
          color="primary"
          icon="chat"
          :label="$t('diff.addToChat')"
          class="send-to-chat-btn"
          @click="sendSelectionToChat"
        />
      </div>
    </div>

  </div>
</template>

<script setup lang="ts">
import { useQuasar } from 'quasar'
import { type ReviewComment, useReviewDraft } from 'src/composables/use-review-draft'
import { useWebSocketStore } from 'src/stores/websocket'
import { useWorkspaceStore } from 'src/stores/workspace'
import { buildPathTree, countLeaves } from 'src/utils/build-path-tree'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import ReviewCommentBlock from './ReviewCommentBlock.vue'
import ReviewDraftPanel from './ReviewDraftPanel.vue'

const props = defineProps<{
  workspaceId: string
  /** When true, force-open in Review mode regardless of the persisted preference. */
  initialReviewMode?: boolean
}>()

const emit = defineEmits<{
  close: []
  sendToChat: [text: string]
}>()

const { t } = useI18n()
const $q = useQuasar()

interface DiffFile {
  path: string
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked'
}

const files = ref<DiffFile[]>([])
const sourceBranch = ref('')
const workingBranch = ref('')
const selectedFile = ref<string | null>(null)
const loading = ref(false)
const loadingFile = ref(false)
const editorContainer = ref<HTMLElement | null>(null)
const viewMode = ref<'side' | 'inline'>('side')
// Compact mode: collapse unchanged regions in the Monaco diff editor so the
// reader only sees what actually differs. Enabled by default; the user
// preference is persisted across sessions and only OFF when explicitly
// turned off (stored as '0').
const HIDE_UNCHANGED_KEY = 'kobo:diff:hideUnchanged'
const hideUnchanged = ref(localStorage.getItem(HIDE_UNCHANGED_KEY) !== '0')

// Opt-in: include untracked files in the diff viewer. Default OFF — they
// would not ship in the next commit/PR, so showing them is misleading. The
// toggle only appears in `branch` mode (untracked is meaningless for the
// `unpushed` scope, which is committed-only).
const INCLUDE_UNTRACKED_KEY = 'kobo:diff:includeUntracked'
const includeUntracked = ref(localStorage.getItem(INCLUDE_UNTRACKED_KEY) === '1')

/**
 * Diff scope:
 *  - `branch`   → working branch vs sourceBranch (= what the PR will contain)
 *  - `unpushed` → committed-only changes vs origin/<workingBranch>
 *                 (= what the next `git push` will send)
 */
const diffMode = ref<'branch' | 'unpushed'>('branch')

// Diff layout mode:
//  - `inspect` (default) → tree left, diff right. Existing behaviour.
//  - `review`            → 3-column review experience with inline comments.
const DIFF_MODE_KEY = 'kobo:diff:mode'
const reviewMode = ref<'inspect' | 'review'>(
  props.initialReviewMode ? 'review' : localStorage.getItem(DIFF_MODE_KEY) === 'review' ? 'review' : 'inspect',
)
watch(reviewMode, (m) => {
  localStorage.setItem(DIFF_MODE_KEY, m)
  // Toggle review-mode bits WITHOUT rebuilding the editor — recreating it
  // mid-toggle races with Monaco's debounced events ("AbstractContextKey-
  // Service has been disposed"). We just turn the gutter handler + zones
  // on or off as needed.
  if (m === 'review') {
    setupReviewMode()
  } else {
    teardownReviewMode()
  }
})

function teardownReviewMode() {
  disposeAllZones()
  for (const d of reviewModeDisposables) d.dispose()
  reviewModeDisposables = []
  if (diffEditor) {
    diffEditor.getModifiedEditor().getDomNode()?.classList.remove('review-mode-active')
  }
}

function setupReviewMode() {
  if (!diffEditor) return
  setupGutterAddButton()
  if (selectedFile.value) {
    renderCommentZonesForFile(selectedFile.value)
  }
}

// Review draft state — comments accumulated locally, submitted as a chat
// message to the workspace agent.
const wsStore = useWebSocketStore()
const workspaceStore = useWorkspaceStore()
const reviewDraft = useReviewDraft(props.workspaceId, {
  sendChatMessage: async (workspaceId, content, sessionId) => {
    if (!wsStore.isConnected()) {
      throw new Error('WebSocket not connected — cannot send the review')
    }
    wsStore.sendChatMessage(workspaceId, content, sessionId)
  },
})

// Computed wrappers around `reviewDraft.draft` (a Ref) so the template can
// pass them as plain values to ReviewDraftPanel without seeing the Ref shape.
const draftComments = computed(() => reviewDraft.draft.value.comments)
const draftGlobalMessage = computed(() => reviewDraft.draft.value.globalMessage)

const submittingReview = ref(false)
async function onSubmitReview() {
  submittingReview.value = true
  try {
    const result = await reviewDraft.submit(workspaceStore.selectedSessionId ?? undefined)
    if (result.ok) {
      $q.notify({ type: 'positive', message: t('diff.reviewSubmitted'), position: 'top' })
      emit('close')
    } else {
      $q.notify({
        type: 'negative',
        message: t('diff.reviewSubmitFailed', { error: result.error ?? '' }),
        position: 'top',
      })
    }
  } finally {
    submittingReview.value = false
  }
}

// Per-file comment count (computed reactively from the draft state).
const commentsByFile = computed(() => {
  const m = new Map<string, number>()
  if (reviewMode.value !== 'review') return m
  for (const c of reviewDraft.draft.value.comments) {
    m.set(c.filePath, (m.get(c.filePath) ?? 0) + 1)
  }
  return m
})

function commentCountForFolder(folderPath: string): number {
  if (reviewMode.value !== 'review' || !folderPath) return 0
  let count = 0
  for (const c of reviewDraft.draft.value.comments) {
    if (c.filePath.startsWith(`${folderPath}/`)) count++
  }
  return count
}

// Folder nodes have nodeKey `dir:src/components`. Derive the relative folder
// path on the fly instead of teaching build-path-tree about review counts.
function folderPathOf(node: { nodeKey: string }): string {
  return node.nodeKey.startsWith('dir:') ? node.nodeKey.slice(4) : ''
}

function onJumpToFile(filePath: string) {
  selectedFile.value = filePath
}

async function waitForDiffLoad(timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (loadingFile.value) {
    if (Date.now() - start > timeoutMs) return
    await new Promise((r) => setTimeout(r, 30))
  }
}

async function onJumpToComment(filePath: string, line: number) {
  if (selectedFile.value !== filePath) {
    selectedFile.value = filePath
    await waitForDiffLoad()
  }
  diffEditor?.getModifiedEditor().revealLineInCenter(line)
}

// ── File tree drawer width (resizable) ────────────────────────────────────
const FILE_LIST_WIDTH_KEY = 'kobo:diffViewerFileListWidth'
const FILE_LIST_MIN = 180
const FILE_LIST_MAX = 600
const savedFileListWidth = parseInt(localStorage.getItem(FILE_LIST_WIDTH_KEY) ?? '280', 10)
const fileListWidth = ref(Math.min(FILE_LIST_MAX, Math.max(FILE_LIST_MIN, savedFileListWidth)))

function startFileListResize(event: MouseEvent) {
  event.preventDefault()
  const viewerEl = (event.target as HTMLElement).closest('.diff-viewer') as HTMLElement | null
  if (!viewerEl) return
  const viewerLeft = viewerEl.getBoundingClientRect().left

  const onMouseMove = (e: MouseEvent) => {
    fileListWidth.value = Math.min(FILE_LIST_MAX, Math.max(FILE_LIST_MIN, e.clientX - viewerLeft))
  }
  const onMouseUp = () => {
    localStorage.setItem(FILE_LIST_WIDTH_KEY, String(fileListWidth.value))
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

// Monaco instances (lazy loaded)
let monaco: typeof import('monaco-editor') | null = null
let diffEditor: import('monaco-editor').editor.IStandaloneDiffEditor | null = null
let selectionDisposables: Array<{ dispose(): void }> = []
// Disposables that belong to the Review mode setup (gutter onMouseDown,
// scroll/layout listeners). Tracked separately so we can tear them down
// when the user toggles back to Inspect, WITHOUT recreating the editor.
let reviewModeDisposables: Array<{ dispose(): void }> = []

// Review-mode view zones state.
// Monaco's view zones live inside an internal overlay (`.view-lines.monaco-
// -mouse-cursor-text`) that captures all mouse events for cursor positioning
// — even with z-index/pointer-events tweaks, it consistently swallowed
// clicks and prevented our textarea from getting focus.
// Workaround: register an EMPTY Monaco view zone (height-only placeholder
// that pushes the code below) and render the real UI as a normal Vue
// component absolutely-positioned over the editor, OUTSIDE Monaco's DOM.
// Sync the overlay's top to the line position on scroll + relayout.
interface MountedZone {
  zoneId: string
  placeholderNode: HTMLDivElement // empty, owned by Monaco — just reserves space
  line: number
  comments: ReviewComment[]
  transient: boolean
  topPx: number
  heightPx: number
}
const mountedZones = ref<MountedZone[]>([])
const editorWrapperRef = ref<HTMLElement | null>(null)

function refreshZonePositions() {
  if (!diffEditor) return
  const me = diffEditor.getModifiedEditor()
  for (const z of mountedZones.value) {
    // `getTopForLineNumber(N)` accounts for view zones inserted before N,
    // so for our placeholder inserted `afterLineNumber: zone.line` we want
    // the position of `zone.line + 1` (the line BELOW the zone) MINUS the
    // zone height, which gives us the top of the placeholder itself.
    z.topPx = me.getTopForLineNumber(z.line + 1) - me.getScrollTop() - z.heightPx
  }
}

function disposeAllZones() {
  if (!diffEditor) {
    mountedZones.value = []
    return
  }
  const modifiedEditor = diffEditor.getModifiedEditor()
  modifiedEditor.changeViewZones((accessor) => {
    for (const z of mountedZones.value) {
      try {
        accessor.removeZone(z.zoneId)
      } catch {
        /* editor may already be disposed */
      }
    }
  })
  mountedZones.value = []
}

function mountCommentZone(line: number, comments: ReviewComment[], transient: boolean) {
  if (!diffEditor) return
  const modifiedEditor = diffEditor.getModifiedEditor()
  const lineCount = modifiedEditor.getModel()?.getLineCount() ?? 0
  if (line < 1 || line > lineCount) return // stale, skip silently

  // Empty placeholder — Monaco only uses this to compute the view zone
  // height. The real content is rendered separately as a Vue overlay.
  const placeholderNode = document.createElement('div')
  placeholderNode.style.pointerEvents = 'none'

  const baseHeight = comments.length > 0 ? comments.length * 4 + 1 : 0
  const transientHeight = transient ? 6 : 0
  const heightInLines = Math.max(6, baseHeight + transientHeight)

  let zoneId = ''
  modifiedEditor.changeViewZones((accessor) => {
    zoneId = accessor.addZone({ afterLineNumber: line, heightInLines, domNode: placeholderNode })
  })

  // Approximate height in pixels for the overlay. Monaco's line height is
  // configured at editor creation (lineHeight: 18 — see createDiffEditor).
  const lineHeightPx = 18
  const heightPx = heightInLines * lineHeightPx
  // See refreshZonePositions() above — top = position of next line minus zone height.
  const topPx = modifiedEditor.getTopForLineNumber(line + 1) - modifiedEditor.getScrollTop() - heightPx

  mountedZones.value.push({ zoneId, placeholderNode, line, comments, transient, topPx, heightPx })
}

function disposeZonesForLine(line: number) {
  if (!diffEditor) return
  const modifiedEditor = diffEditor.getModifiedEditor()
  const matches = mountedZones.value.filter((z) => z.line === line)
  if (matches.length === 0) return
  modifiedEditor.changeViewZones((accessor) => {
    for (const z of matches) {
      try {
        accessor.removeZone(z.zoneId)
      } catch {
        /* swallow */
      }
    }
  })
  mountedZones.value = mountedZones.value.filter((z) => z.line !== line)
}

function rerenderZoneForLine(filePath: string, line: number) {
  disposeZonesForLine(line)
  const remaining = reviewDraft.draft.value.comments.filter((c) => c.filePath === filePath && c.line === line)
  if (remaining.length === 0) return // last comment deleted — leave the line bare
  remaining.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  mountCommentZone(line, remaining, false)
}

function renderCommentZonesForFile(filePath: string) {
  if (!diffEditor || reviewMode.value !== 'review') return
  const all = reviewDraft.draft.value.comments.filter((c) => c.filePath === filePath)
  const byLine = new Map<number, ReviewComment[]>()
  for (const c of all) {
    const list = byLine.get(c.line) ?? []
    list.push(c)
    byLine.set(c.line, list)
  }
  for (const list of byLine.values()) {
    list.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }
  for (const [line, comments] of byLine) {
    mountCommentZone(line, comments, false)
  }
}

// Handlers passed to ReviewCommentBlock from the Teleport in the template.
function onZoneAdd(filePath: string, line: number, content: string) {
  reviewDraft.addComment({ filePath, line, content })
  rerenderZoneForLine(filePath, line)
}
function onZoneUpdate(filePath: string, line: number, id: string, content: string) {
  reviewDraft.updateComment(id, content)
  rerenderZoneForLine(filePath, line)
}
function onZoneDelete(filePath: string, line: number, id: string) {
  reviewDraft.deleteComment(id)
  rerenderZoneForLine(filePath, line)
}

function setupGutterAddButton() {
  if (!diffEditor || reviewMode.value !== 'review' || !monaco) return
  const modifiedEditor = diffEditor.getModifiedEditor()
  // Review mode: clicking on a line number in the gutter starts a new
  // comment on that line. Simpler and more discoverable than a hover-only
  // floating "+" button (which got hidden by Monaco's internal overflow).
  // The cursor pointer is set via CSS on .monaco-editor .line-numbers
  // when the host has the `review-mode-active` class (added below).
  const editorDom = modifiedEditor.getDomNode()
  if (editorDom) editorDom.classList.add('review-mode-active')

  reviewModeDisposables.push(
    modifiedEditor.onMouseDown((e) => {
      const targetType = e.target.type
      const isLineNumberGutter = targetType === 3 // GUTTER_LINE_NUMBERS
      if (!isLineNumberGutter) return
      const line = e.target.position?.lineNumber ?? 0
      if (line < 1 || !selectedFile.value) return
      addCommentOnLine(selectedFile.value, line)
    }),
    // Keep overlay positions in sync with editor scroll + relayout.
    modifiedEditor.onDidScrollChange(() => refreshZonePositions()),
    modifiedEditor.onDidLayoutChange(() => refreshZonePositions()),
  )
}

function addCommentOnLine(filePath: string, line: number) {
  // If there's already a thread on this line, just dispose+rerender with a
  // transient extra block. Otherwise mount a fresh transient zone.
  disposeZonesForLine(line)
  const existing = reviewDraft.draft.value.comments
    .filter((c) => c.filePath === filePath && c.line === line)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  mountCommentZone(line, existing, true)
}

function disposeEditor() {
  // View zones must be disposed BEFORE the editor instance — disposeAllZones
  // calls into diffEditor.getModifiedEditor() which is invalid post-dispose.
  disposeAllZones()
  for (const d of reviewModeDisposables) d.dispose()
  reviewModeDisposables = []
  if (!diffEditor) return
  diffEditor.getModifiedEditor().getDomNode()?.classList.remove('review-mode-active')
  for (const d of selectionDisposables) d.dispose()
  selectionDisposables = []
  const model = diffEditor.getModel()
  diffEditor.dispose()
  diffEditor = null
  model?.original?.dispose()
  model?.modified?.dispose()
}

// ── File tree ────────────────────────────────────────────────────────────────

const tree = computed(() => buildPathTree(files.value))
const selectedNodeKey = computed(() => (selectedFile.value ? `file:${selectedFile.value}` : ''))

// ── Data loading ─────────────────────────────────────────────────────────────

async function loadFiles() {
  loading.value = true
  try {
    const params = new URLSearchParams({ mode: diffMode.value })
    if (diffMode.value === 'branch' && includeUntracked.value) params.set('includeUntracked', '1')
    const res = await fetch(`/api/workspaces/${props.workspaceId}/diff?${params}`, {
      cache: 'no-store',
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    files.value = data.files
    sourceBranch.value = data.sourceBranch ?? ''
    workingBranch.value = data.workingBranch ?? ''
  } catch (err) {
    console.error('Failed to load diff files:', err)
  } finally {
    loading.value = false
  }
}

async function loadFileDiff(filePath: string) {
  if (!editorContainer.value) return
  loadingFile.value = true

  try {
    if (!monaco) {
      // Configure Monaco workers per language for proper syntax support
      self.MonacoEnvironment = {
        getWorker(_workerId: string, label: string) {
          if (label === 'json') {
            return new Worker(new URL('monaco-editor/esm/vs/language/json/json.worker.js', import.meta.url), {
              type: 'module',
            })
          }
          if (label === 'css' || label === 'scss' || label === 'less') {
            return new Worker(new URL('monaco-editor/esm/vs/language/css/css.worker.js', import.meta.url), {
              type: 'module',
            })
          }
          if (label === 'html' || label === 'handlebars' || label === 'razor') {
            return new Worker(new URL('monaco-editor/esm/vs/language/html/html.worker.js', import.meta.url), {
              type: 'module',
            })
          }
          if (label === 'typescript' || label === 'javascript') {
            return new Worker(new URL('monaco-editor/esm/vs/language/typescript/ts.worker.js', import.meta.url), {
              type: 'module',
            })
          }
          return new Worker(new URL('monaco-editor/esm/vs/editor/editor.worker.js', import.meta.url), {
            type: 'module',
          })
        },
      }
      monaco = await import('monaco-editor')
      monaco.editor.defineTheme('kobo-dark', {
        base: 'vs-dark',
        inherit: true,
        rules: [],
        colors: {
          'editor.background': '#1a1a2e',
          'diffEditor.insertedTextBackground': '#22c55e20',
          'diffEditor.removedTextBackground': '#ef444420',
        },
      })
    }

    const res = await fetch(
      `/api/workspaces/${props.workspaceId}/diff-file?path=${encodeURIComponent(filePath)}&mode=${diffMode.value}`,
      { cache: 'no-store' },
    )
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()

    const ext = filePath.split('.').pop() ?? ''
    const langMap: Record<string, string> = {
      ts: 'typescript',
      tsx: 'typescript',
      js: 'javascript',
      jsx: 'javascript',
      vue: 'html',
      html: 'html',
      css: 'css',
      scss: 'scss',
      json: 'json',
      md: 'markdown',
      yaml: 'yaml',
      yml: 'yaml',
      sh: 'shell',
      sql: 'sql',
      py: 'python',
      rs: 'rust',
      go: 'go',
    }
    const language = langMap[ext] ?? 'plaintext'

    disposeEditor()

    const originalModel = monaco.editor.createModel(data.original ?? '', language)
    const modifiedModel = monaco.editor.createModel(data.modified ?? '', language)

    diffEditor = monaco.editor.createDiffEditor(editorContainer.value, {
      theme: 'kobo-dark',
      readOnly: true,
      renderSideBySide: viewMode.value === 'side',
      automaticLayout: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      fontSize: 12,
      lineHeight: 18,
      hideUnchangedRegions: {
        enabled: hideUnchanged.value,
        contextLineCount: 3,
        minimumLineCount: 3,
        revealLineCount: 20,
      },
    })

    diffEditor.setModel({ original: originalModel, modified: modifiedModel })
    setupSelectionTracking()
    if (reviewMode.value === 'review') {
      setupGutterAddButton()
      renderCommentZonesForFile(filePath)
    }
  } catch (err) {
    console.error('Failed to load file diff:', err)
  } finally {
    loadingFile.value = false
  }
}

// Right-click → rollback. Destructive: warns the user. The exact action
// depends on the file status (cascade in the backend resolves the right
// baseline); for untracked files the dialog uses delete-flavoured wording
// since the cascade ends with `rm <file>`.
function confirmRollback(filePath: string, fileStatus: DiffFile['status']) {
  const isUntracked = fileStatus === 'untracked'
  $q.dialog({
    title: isUntracked ? t('diff.deleteUntracked') : t('diff.rollbackToRemote'),
    message: isUntracked
      ? t('diff.deleteUntrackedConfirm', { path: filePath })
      : t('diff.rollbackConfirm', { path: filePath }),
    cancel: true,
    persistent: true,
    color: isUntracked ? 'red' : 'orange',
    ok: {
      label: isUntracked ? t('diff.deleteUntrackedConfirmOk') : t('diff.rollbackConfirmOk'),
      color: isUntracked ? 'red-7' : 'orange-7',
      flat: false,
      unelevated: true,
    },
  }).onOk(() => {
    void rollbackFile(filePath)
  })
}

async function rollbackFile(filePath: string) {
  try {
    const res = await fetch(`/api/workspaces/${props.workspaceId}/rollback-file`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: filePath }),
    })
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string }
      $q.notify({
        type: 'negative',
        message: body.error || t('diff.rollbackFailed'),
        position: 'top',
      })
      return
    }
    const body = (await res.json().catch(() => ({}))) as { target?: 'remote' | 'head' | 'deleted' }
    let message = t('diff.rollbackDoneRemote')
    if (body.target === 'head') message = t('diff.rollbackDoneHead')
    else if (body.target === 'deleted') message = t('diff.rollbackDoneDeleted')
    $q.notify({ type: 'positive', message, position: 'top' })
    await loadFiles()
    if (selectedFile.value === filePath) {
      // File brought back to its baseline. If it's still in the diff list
      // (e.g. the rollback only touched part of the changes), reload its
      // diff. Otherwise clear the selection — the watcher disposes Monaco.
      if (files.value.some((f) => f.path === filePath)) {
        await loadFileDiff(filePath)
      } else {
        selectedFile.value = null
      }
    }
  } catch (err) {
    console.error('rollbackFile failed:', err)
    $q.notify({ type: 'negative', message: t('diff.rollbackFailed'), position: 'top' })
  }
}

const hasSelection = ref(false)

function setupSelectionTracking() {
  if (!diffEditor) return

  // Dispose previous listeners before creating new ones
  for (const d of selectionDisposables) d.dispose()
  selectionDisposables = []

  const modifiedEditor = diffEditor.getModifiedEditor()
  const originalEditor = diffEditor.getOriginalEditor()

  for (const editor of [modifiedEditor, originalEditor]) {
    const disposable = editor.onDidChangeCursorSelection(() => {
      const sel = editor.getSelection()
      hasSelection.value = !!(sel && !sel.isEmpty())
    })
    selectionDisposables.push(disposable)
  }
}

function sendSelectionToChat() {
  if (!diffEditor || !selectedFile.value) return

  // Try modified editor first, then original
  for (const editor of [diffEditor.getModifiedEditor(), diffEditor.getOriginalEditor()]) {
    const sel = editor.getSelection()
    if (sel && !sel.isEmpty()) {
      const model = editor.getModel()
      if (!model) continue
      const text = model.getValueInRange(sel)
      const side = editor === diffEditor!.getModifiedEditor() ? 'modified' : 'original'
      const snippet = `\`\`\`\n// ${selectedFile.value} (${side}) L${sel.startLineNumber}-L${sel.endLineNumber}\n${text}\n\`\`\``
      emit('sendToChat', snippet)
      return
    }
  }
}

// ── Watchers ─────────────────────────────────────────────────────────────────

watch(selectedFile, (filePath) => {
  if (filePath) {
    loadFileDiff(filePath)
  } else {
    // Selection was cleared (e.g. after a successful rollback removed the
    // file from the diff). Tear down Monaco so the previous diff stops
    // showing in the empty state.
    disposeEditor()
  }
})

watch(viewMode, () => {
  if (diffEditor) {
    diffEditor.updateOptions({ renderSideBySide: viewMode.value === 'side' })
  }
})

watch(hideUnchanged, (enabled) => {
  localStorage.setItem(HIDE_UNCHANGED_KEY, enabled ? '1' : '0')
  if (diffEditor) {
    diffEditor.updateOptions({
      hideUnchangedRegions: {
        enabled,
        contextLineCount: 3,
        minimumLineCount: 3,
        revealLineCount: 20,
      },
    })
  }
})

// When the user toggles between Branch / Unpushed scopes, reload the list
// and the currently-opened file (if any). If the file is no longer in the
// new scope, clear the selection so the editor shows the empty state.
watch(diffMode, async () => {
  const previouslySelected = selectedFile.value
  await loadFiles()
  if (previouslySelected && files.value.some((f) => f.path === previouslySelected)) {
    // Same file still in scope → reload its diff against the new base ref.
    loadFileDiff(previouslySelected)
  } else {
    selectedFile.value = null
  }
})

watch(includeUntracked, async (enabled) => {
  localStorage.setItem(INCLUDE_UNTRACKED_KEY, enabled ? '1' : '0')
  await loadFiles()
  if (selectedFile.value && !files.value.some((f) => f.path === selectedFile.value)) {
    selectedFile.value = null
  }
})

// ── Helpers ──────────────────────────────────────────────────────────────────

function statusColor(status: DiffFile['status']): string {
  switch (status) {
    case 'added':
      return '#4ade80'
    case 'untracked':
      // Same green family as `added` but lighter, to hint that the file is
      // brand-new and not yet `git add`-ed (only visible when the user
      // toggled "show untracked files" ON).
      return '#86efac'
    case 'deleted':
      return '#f87171'
    case 'renamed':
      return '#60a5fa'
    default:
      return '#f59e0b'
  }
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

onMounted(loadFiles)

onUnmounted(() => {
  // Single source of truth — disposeEditor() handles selection disposables,
  // editor and (in Review mode) view zones / mounted Vue apps.
  reviewDraft.flush() // before disposeEditor in case the user closed mid-edit
  disposeEditor()
})
</script>

<style lang="scss" scoped>
// Match the main app color scheme from MainLayout / WorkspaceList
.diff-viewer {
  background-color: #1a1a2e;
}

// Same as .wp-header in WorkspacePage
.diff-header {
  min-height: 48px;
  background-color: #16162a;
  border-bottom: 1px solid #2a2a4a;
}

.diff-file-list-wrapper {
  position: relative;
  height: 100%;
  flex-shrink: 0;
}
.diff-file-list-resize-handle {
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
// Same as .left-sidebar in MainLayout
.diff-file-list {
  background-color: #16162a;
  border-color: #2a2a4a;
}

.diff-tree {
  :deep(.q-tree__node-header) {
    padding: 2px 4px;
    min-height: 22px;
    align-items: center;
  }
  :deep(.q-tree__node--selected) > .q-tree__node-header {
    background-color: #2a2a4a;
    outline: 1px solid rgba(108, 99, 255, 0.4);
    border-left: 2px solid #6c63ff;
  }
  :deep(.q-tree__node-header:hover) {
    background-color: rgba(255, 255, 255, 0.03);
  }
}

.send-to-chat-btn {
  position: absolute;
  bottom: 16px;
  right: 16px;
  z-index: 10;
  font-size: 11px;
  padding: 2px 10px;
}

/* Review mode: clicking a line number in the modified editor's gutter opens
   a new review comment on that line. The CSS just hints the affordance. */
:deep(.review-mode-active .line-numbers) {
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}
:deep(.review-mode-active .line-numbers:hover) {
  background: rgba(99, 102, 241, 0.25);
  color: #c7d2fe;
}
/* Review overlays are rendered OUTSIDE Monaco's DOM (in our editorWrapperRef
   container) and absolutely positioned to align with the corresponding
   line in the modified editor. Monaco only sees an empty placeholder, so
   none of its event handlers interfere. */
.review-zone-overlay {
  position: absolute;
  left: 60px; /* skip the gutter (line numbers + glyph margin); empirical */
  right: 16px;
  z-index: 50;
  pointer-events: auto;
  background: rgba(20, 20, 35, 0.95);
  backdrop-filter: blur(2px);
  padding: 4px;
  box-sizing: border-box;
  overflow: auto;
  border-left: 3px solid rgba(99, 102, 241, 0.6);
}
</style>
