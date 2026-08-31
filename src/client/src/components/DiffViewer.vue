<template>
  <div class="diff-viewer column full-height">
    <!-- Header — same style as .wp-header in WorkspacePage -->
    <div class="diff-header row items-center q-px-md q-py-sm no-wrap">
      <!-- Tout le contenu variable défile horizontalement ; les deux boutons
           de droite restent épinglés. Sans cela, sous ~900 px le bouton de
           fermeture sortait du cadre et il ne restait qu'Échap. -->
      <div class="diff-header__scroll row items-center no-wrap">
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
      <!-- Rendu dès qu'il y a des modifications, même quand `canEdit` est
           faux : le faire disparaître du DOM piégeait le tampon sans un mot.
           Désactivé plutôt qu'absent, avec la raison en infobulle. -->
      <q-btn
        v-if="dirty"
        dense
        flat
        size="sm"
        no-caps
        icon="save"
        :label="$t('diffViewer.save')"
        color="indigo-4"
        :loading="savingFile"
        :disable="!canEdit"
        class="q-ml-sm"
        @click="onSaveClicked"
      >
        <q-tooltip v-if="!canEdit">{{ $t('diffViewer.saveBlocked') }}</q-tooltip>
      </q-btn>
      <q-badge
        v-if="dirty && !canEdit"
        color="orange-9"
        text-color="white"
        class="q-ml-sm"
        style="font-size: 10px;"
        :label="$t('diffViewer.unsavedBanner')"
      />
      <q-space />
      <q-chip
        v-if="isCommitsMode"
        dense
        square
        color="grey-9"
        text-color="grey-4"
        icon="difference"
        class="q-mr-sm"
      >
        {{ compareLabel }} · {{ $t('diff.commitsReadOnly') }}
      </q-chip>
      <q-btn-toggle
        v-else
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
      </div>

      <q-btn
        icon="account_tree"
        dense
        flat
        size="sm"
        :color="fileTreeOpen ? 'indigo-4' : 'grey-5'"
        class="q-ml-sm q-mr-sm diff-header__pinned"
        @click="fileTreeOpen = !fileTreeOpen"
      >
        <q-tooltip anchor="bottom middle" self="top middle" :delay="400">
          {{ fileTreeOpen ? $t('diffViewer.fileTreeHide') : $t('diffViewer.fileTreeShow') }}
        </q-tooltip>
      </q-btn>
      <q-btn
        icon="checklist"
        dense
        flat
        size="sm"
        :color="criteriaRailOpen ? 'indigo-4' : 'grey-5'"
        class="q-mr-sm diff-header__pinned"
        @click="criteriaRailOpen = !criteriaRailOpen"
      >
        <q-tooltip anchor="bottom middle" self="top middle" :delay="400">
          {{ criteriaRailOpen ? $t('diffViewer.criteriaRailHide') : $t('diffViewer.criteriaRailShow') }}
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
        class="diff-header__pinned"
        @click="requestClose"
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
      <!-- Sous 1024 px, le panneau de brouillon céderait toute sa largeur à
           l'éditeur : on le rend proportionnel plutôt que fixe. -->
      <div
        v-if="reviewDraftPanelOpen"
        class="review-draft-panel-wrapper"
        :style="
          isDrawerCollapsed
            ? { width: '45%', minWidth: '0', flexShrink: 1, borderRight: '1px solid var(--kobo-border-subtle)' }
            : { width: '300px', minWidth: '240px', flexShrink: 0, borderRight: '1px solid var(--kobo-border-subtle)' }
        "
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
        v-if="fileTreeOpen"
        class="diff-file-list-wrapper"
        :style="
          isDrawerCollapsed
            ? { width: '55%', minWidth: '0' }
            : { width: `${fileListWidth}px`, minWidth: `${FILE_LIST_MIN}px` }
        "
      >
      <q-input
        v-if="!loading && files.length > 0"
        v-model="fileFilter"
        dense
        dark
        outlined
        clearable
        :debounce="150"
        :placeholder="$t('diff.searchFiles')"
        class="diff-file-search q-ma-xs"
      >
        <template #prepend>
          <q-icon name="search" size="16px" />
        </template>
      </q-input>
      <q-scroll-area class="diff-file-list q-pa-xs" style="width: 100%; border-right: 1px solid #2a2a4a;">
        <q-spinner-dots v-if="loading" size="24px" color="grey-6" class="q-ma-md" />
        <template v-else>
        <!-- A file list that is empty because the request failed is NOT a
             branch without changes. The banner sits above whatever was
             already listed, so a failed refresh never wipes valid data. -->
        <div v-if="fileListError" class="text-caption q-pa-sm">
          <div class="row items-center q-gutter-xs">
            <q-icon name="error" size="16px" color="negative" />
            <span class="text-negative">{{ $t('diff.fileListLoadFailed') }}</span>
          </div>
          <div class="text-grey-6 q-mt-xs">{{ fileListError }}</div>
          <div class="text-grey-7 q-mt-xs">{{ $t('diff.fileListLoadFailedHint') }}</div>
          <q-btn
            dense
            flat
            no-caps
            class="q-mt-xs"
            icon="refresh"
            :label="$t('common.retry')"
            @click="retryFileList"
          />
        </div>
        <div v-if="files.length === 0 && !fileListError" class="text-caption text-grey-8 q-pa-sm">
          {{ $t('diff.noChanges') }}
        </div>
        <div v-else-if="noFilterMatch" class="text-caption text-grey-8 q-pa-sm">{{ $t('diff.noFileMatch') }}</div>
        <q-tree
          v-else
          :nodes="tree"
          node-key="nodeKey"
          label-key="label"
          children-key="children"
          dark
          dense
          v-model:expanded="expandedNodes"
          no-selection-unset
          :selected="selectedNodeKey"
          :filter="fileFilter"
          :filter-method="filterTreeNode"
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
              <span v-if="dirty && node.file.path === selectedFile" class="dirty-dot">●</span>
              <q-badge
                v-if="reviewMode === 'review' && (commentsByFile.get(node.file.path) ?? 0) > 0"
                :label="String(commentsByFile.get(node.file.path))"
                color="indigo-8"
                text-color="white"
                class="q-ml-xs"
                style="font-size: 9px;"
              />
              <!-- Rollback mutates the live worktree against the working branch.
                   It must never be reachable in read-only commits mode (the
                   displayed A↔B history has no relation to what would be rolled
                   back) — gate it on canEdit, same guard as inline editing. -->
              <q-menu v-if="canEdit" touch-position context-menu>
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
        </template>
      </q-scroll-area>
        <div class="diff-file-list-resize-handle" @mousedown="startFileListResize" />
      </div>

      <!-- Monaco diff editor -->
      <div class="col column" style="min-width: 0; position: relative;">
        <div v-if="loadingFile" class="col column items-center justify-center">
          <q-spinner-dots size="32px" color="indigo-4" />
        </div>
        <!-- Explicit failure state — the editor was already disposed above, so
             there is nothing stale left behind under the new file's name.
             Same shape as the sidebar, the settings page and the git stats
             card: icon, title, server message, hint, inline retry. This is
             the ONLY report for this failure; the toast that used to double
             it (in a second, unrelated convention) is gone. -->
        <div
          v-else-if="fileLoadError"
          class="col column items-center justify-center text-caption q-gutter-xs q-pa-lg text-center"
        >
          <q-icon name="error" size="24px" color="negative" />
          <div class="text-negative">{{ $t('diff.fileLoadFailed') }}</div>
          <div class="text-grey-6">{{ fileLoadError }}</div>
          <div class="text-grey-7">{{ $t('diff.fileLoadFailedHint') }}</div>
          <q-btn dense flat no-caps icon="refresh" :label="$t('common.retry')" @click="retryFileDiff" />
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

      <!-- Rail « Revue » — le contexte de relecture, DANS le diff. -->
      <div v-if="criteriaRailOpen" class="diff-criteria-rail column no-wrap">
        <div class="diff-criteria-rail__title">{{ $t('diffViewer.criteriaRail') }}</div>
        <q-separator dark />
        <div class="col" style="overflow-y: auto; min-height: 0;">
          <AcceptancePanel :tasks="railCriteria" />
          <q-separator dark />
          <TasksPanel :workspace="railWorkspace" :tasks="railTasks" />
        </div>
      </div>
    </div>

    <!-- Conflit de sauvegarde : trois issues, dont une qui débloque
         réellement le fichier. Persistant : Échap ne doit pas refermer un
         dialogue dont chaque option a une conséquence. -->
    <q-dialog v-model="conflictDialogOpen" persistent>
      <q-card dark style="min-width: 420px; max-width: 560px;">
        <q-card-section>
          <div class="text-subtitle1">{{ $t('diffViewer.conflict.title') }}</div>
          <div class="text-body2 text-grey-5 q-mt-sm">{{ $t('diffViewer.conflict.message') }}</div>
        </q-card-section>
        <q-card-section class="q-pt-none">
          <div class="text-caption text-grey-6">{{ $t('diffViewer.conflict.keepHint') }}</div>
          <div class="text-caption text-grey-6 q-mt-xs">{{ $t('diffViewer.conflict.overwriteHint') }}</div>
        </q-card-section>
        <q-card-actions align="right">
          <q-btn
            flat
            no-caps
            :label="$t('diffViewer.conflict.reload')"
            color="grey-5"
            :disable="overwriting"
            @click="conflictReload"
          />
          <q-btn
            flat
            no-caps
            :label="$t('diffViewer.conflict.keep')"
            color="indigo-4"
            :disable="overwriting"
            @click="conflictKeepMine"
          />
          <q-btn
            unelevated
            no-caps
            :label="$t('diffViewer.conflict.overwrite')"
            color="orange-7"
            :loading="overwriting"
            @click="conflictOverwrite"
          />
        </q-card-actions>
      </q-card>
    </q-dialog>

    <!-- Fermeture gardée : la garde « modifications non enregistrées »
         n'existait que sur le CHANGEMENT DE FICHIER. Échap ou un clic sur le
         fond détruisaient le tampon sans un mot. -->
    <q-dialog v-model="closeConfirmOpen" persistent>
      <q-card dark style="min-width: 420px; max-width: 560px;">
        <q-card-section>
          <div class="text-subtitle1">{{ $t('diffViewer.closeConfirm.title') }}</div>
          <div class="text-body2 text-grey-5 q-mt-sm">{{ $t('diffViewer.closeConfirm.message') }}</div>
        </q-card-section>
        <q-card-actions align="right">
          <q-btn flat no-caps :label="$t('common.cancel')" color="grey-5" :disable="savingFile" v-close-popup />
          <q-btn
            flat
            no-caps
            :label="$t('diffViewer.closeConfirm.discard')"
            color="red-4"
            :disable="savingFile"
            @click="closeDiscarding"
          />
          <q-btn
            unelevated
            no-caps
            :label="$t('diffViewer.closeConfirm.saveAndClose')"
            color="indigo-6"
            :loading="savingFile"
            @click="closeSaving"
          />
        </q-card-actions>
      </q-card>
    </q-dialog>
  </div>
</template>

<script setup lang="ts">
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker'
import { useQuasar } from 'quasar'
import { useIsMobile } from 'src/composables/use-is-mobile'
import { type ReviewComment, useReviewDraft } from 'src/composables/use-review-draft'
import { useWebSocketStore } from 'src/stores/websocket'
import { useWorkspaceStore } from 'src/stores/workspace'
import { ApiError, apiFetch } from 'src/utils/api'
import { buildPathTree, collectFolderKeys, countLeaves, type PathTreeNode } from 'src/utils/build-path-tree'
import { createLatestRequest, isAbortError } from 'src/utils/latest-request'
import { monacoLanguageForPath } from 'src/utils/monaco-language'
import { takePendingDiffOpen } from 'src/utils/pending-diff-open'
import { coalesceFrames } from 'src/utils/raf-coalesce'
import { countCommentsByPath } from 'src/utils/review-comment-counts'
import { registerUnsavedScope, unregisterUnsavedScope } from 'src/utils/unsaved-guard'
import { isBusyStatus } from 'src/utils/workspace-status'
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import AcceptancePanel from './AcceptancePanel.vue'
import ReviewCommentBlock from './ReviewCommentBlock.vue'
import ReviewDraftPanel from './ReviewDraftPanel.vue'
import TasksPanel from './TasksPanel.vue'

const props = defineProps<{
  workspaceId: string
  /** When true, force-open in Review mode regardless of the persisted preference. */
  initialReviewMode?: boolean
  /** Commits mode: when both are set, diff `compareFrom..compareTo` read-only. */
  compareFrom?: string
  compareTo?: string
}>()

const emit = defineEmits<{
  close: []
  sendToChat: [text: string]
}>()

const { t } = useI18n()
const $q = useQuasar()

const isCommitsMode = computed(() => !!props.compareFrom && !!props.compareTo)
const compareLabel = computed(() =>
  isCommitsMode.value ? `${(props.compareFrom ?? '').slice(0, 7)} ↔ ${(props.compareTo ?? '').slice(0, 7)}` : '',
)

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
const fileLoadError = ref<string | null>(null)
/** Failure of the file-list request itself, told apart from "no changes". */
const fileListError = ref<string | null>(null)
// Two independent single-flight guards: selecting a file must not cancel the
// file-list refresh, and vice-versa.
const filesRequest = createLatestRequest()
const fileDiffRequest = createLatestRequest()
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
    // Réaffirmation manuelle : rebasculer en mode review réaffiche le panneau
    // de brouillon même s'il avait été replié pour laisser la place à l'arbre
    // de fichiers / au rail de critères sur petit écran (bug 1 du correctif
    // task-7). On ne le referme jamais automatiquement en dehors de ce geste
    // explicite de l'utilisateur.
    reviewDraftHidden.value = false
    // Troisième sens de l'exclusion mutuelle (bug 2 du correctif task-7) :
    // sous le seuil responsive, le panneau de brouillon qui réapparaît ne doit
    // pas coexister avec l'arbre de fichiers ni le rail de critères, sous
    // peine d'écraser l'éditeur à 0px. On les referme au même titre que
    // l'ouverture de l'un ou l'autre le fait déjà pour les deux autres
    // colonnes. Ne touche à rien en desktop.
    if (isDrawerCollapsed.value) {
      fileTreeOpen.value = false
      criteriaRailOpen.value = false
    }
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

// Per-file AND per-folder comment counts, computed once per draft change
// instead of re-scanning the comment list for every folder node, twice per
// render, on every scroll frame.
const commentCounts = computed(() =>
  countCommentsByPath(reviewMode.value === 'review' ? reviewDraft.draft.value.comments : []),
)

const commentsByFile = computed(() => commentCounts.value.byFile)

function commentCountForFolder(folderPath: string): number {
  if (!folderPath) return 0
  return commentCounts.value.byFolder.get(folderPath) ?? 0
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

/**
 * Every boolean provider flag of the four worker-backed language services.
 * `dataProviders` (html) is deliberately absent: it is not a boolean.
 * Unspecified fields become undefined — falsy — so a single object safely
 * covers services whose ModeConfiguration shapes differ.
 */
const NO_LANGUAGE_PROVIDERS = {
  codeActions: false,
  colors: false,
  completionItems: false,
  definitions: false,
  diagnostics: false,
  documentFormattingEdits: false,
  documentHighlights: false,
  documentRangeFormattingEdits: false,
  documentSymbols: false,
  foldingRanges: false,
  hovers: false,
  inlayHints: false,
  links: false,
  onTypeFormattingEdits: false,
  references: false,
  rename: false,
  selectionRanges: false,
  signatureHelp: false,
  tokens: false,
} as const

/**
 * `import('monaco-editor')` resolves to esm/vs/index.js, which registers four
 * worker-backed language services (typescript, css, html, json). Each hooks
 * `languages.onLanguage(<id>)` and, when a model of that language is created,
 * registers providers that ask MonacoEnvironment.getWorker for their OWN
 * worker. We ship only the base worker — 274 kB instead of ~12 MB — so every
 * provider must be off, otherwise the base worker would be handed a protocol
 * it does not implement.
 *
 * A diff viewer needs none of them: it renders a diff and allows a plain edit
 * saved through POST /save-file. Syntax colouring comes from
 * languages/definitions/* (Monarch, main thread) and is unaffected.
 *
 * Note the accessors: in the ESM build these services are TOP-LEVEL exports
 * (`monaco.typescript`, `monaco.css`, …), not `monaco.languages.*` as in the
 * global build's monaco.d.ts.
 */
function disableWorkerBackedLanguageServices(m: typeof import('monaco-editor')): void {
  const noDiagnostics = {
    noSemanticValidation: true,
    noSyntaxValidation: true,
    noSuggestionDiagnostics: true,
  }
  m.typescript.typescriptDefaults.setDiagnosticsOptions(noDiagnostics)
  m.typescript.javascriptDefaults.setDiagnosticsOptions(noDiagnostics)
  m.typescript.typescriptDefaults.setEagerModelSync(false)
  m.typescript.javascriptDefaults.setEagerModelSync(false)
  m.typescript.typescriptDefaults.setModeConfiguration(NO_LANGUAGE_PROVIDERS)
  m.typescript.javascriptDefaults.setModeConfiguration(NO_LANGUAGE_PROVIDERS)
  m.css.cssDefaults.setModeConfiguration(NO_LANGUAGE_PROVIDERS)
  m.css.scssDefaults.setModeConfiguration(NO_LANGUAGE_PROVIDERS)
  m.css.lessDefaults.setModeConfiguration(NO_LANGUAGE_PROVIDERS)
  m.json.jsonDefaults.setModeConfiguration(NO_LANGUAGE_PROVIDERS)
  m.html.htmlDefaults.setModeConfiguration(NO_LANGUAGE_PROVIDERS)
  m.html.handlebarDefaults.setModeConfiguration(NO_LANGUAGE_PROVIDERS)
  m.html.razorDefaults.setModeConfiguration(NO_LANGUAGE_PROVIDERS)
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
  const scrollTop = me.getScrollTop()
  for (const z of mountedZones.value) {
    // `getTopForLineNumber(N)` accounts for view zones inserted before N,
    // so for our placeholder inserted `afterLineNumber: zone.line` we want
    // the position of `zone.line + 1` (the line BELOW the zone) MINUS the
    // zone height, which gives us the top of the placeholder itself.
    const top = me.getTopForLineNumber(z.line + 1) - scrollTop - z.heightPx
    // Skip the write when nothing moved: mutating a deeply reactive object
    // triggers a full re-render even when the value is identical.
    if (z.topPx !== top) z.topPx = top
  }
}

// One position pass per animation frame, not one per scroll event.
const zonePositionRefresh = coalesceFrames(refreshZonePositions)

function disposeAllZones() {
  zonePositionRefresh.cancel()
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
    // Keep overlay positions in sync with editor scroll + relayout, at most
    // once per animation frame.
    modifiedEditor.onDidScrollChange(() => zonePositionRefresh.request()),
    modifiedEditor.onDidLayoutChange(() => zonePositionRefresh.request()),
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

// ── Inline editing ───────────────────────────────────────────────────────────
const baseSha = ref<string>('')
const baseContent = ref<string>('')
const dirty = ref<boolean>(false)
const savingFile = ref<boolean>(false)
let modifiedModelDispose: (() => void) | null = null

const canEdit = computed<boolean>(() => {
  if (isCommitsMode.value) return false
  if (reviewMode.value !== 'inspect') return false
  const ws = workspaceStore.workspaces.find((w) => w.id === props.workspaceId)
  if (!ws) return false
  if (ws.archivedAt) return false
  if (isBusyStatus(ws.status)) return false
  const currentFile = selectedFile.value
  const fileMeta = currentFile ? files.value.find((f) => f.path === currentFile) : null
  if (fileMeta?.status === 'deleted') return false
  return true
})

// Sync Monaco read-only with canEdit. Lives at setup-time, not per-load.
watch(canEdit, (allowed) => {
  diffEditor?.updateOptions({ readOnly: !allowed })
})

function disposeEditor() {
  modifiedModelDispose?.()
  modifiedModelDispose = null
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

// ── Rail « Revue » ───────────────────────────────────────────────────────────
// Le diff est une modale PLEIN ÉCRAN : il fallait donc le fermer pour relire
// les critères d'acceptation, qui vivent dans le tiroir droit de MainLayout —
// exactement au moment où on en a le plus besoin. Plutôt que de sortir le diff
// de sa modale (remaniement de mise en page, hors périmètre), on lui fait
// emporter le contexte : `AcceptancePanel` et `TasksPanel` sont déjà autonomes
// et lisent le store, ils se réutilisent tels quels.
const CRITERIA_RAIL_KEY = 'kobo:diff:criteriaRail'
const criteriaRailOpen = ref<boolean>(
  localStorage.getItem(CRITERIA_RAIL_KEY) === null
    ? window.innerWidth >= 1280
    : localStorage.getItem(CRITERIA_RAIL_KEY) === '1',
)
watch(criteriaRailOpen, (open) => localStorage.setItem(CRITERIA_RAIL_KEY, open ? '1' : '0'))

/** Le visualiseur est toujours monté pour le workspace sélectionné. */
const railWorkspace = computed(() => workspaceStore.workspaces.find((w) => w.id === props.workspaceId) ?? null)
const railTasks = computed(() => workspaceStore.tasks.filter((task) => !task.isAcceptanceCriterion))
const railCriteria = computed(() => workspaceStore.acceptanceCriteria)

// ── Repli des colonnes en petite largeur ─────────────────────────────────────
const { isDrawerCollapsed } = useIsMobile()

// L'arbre de fichiers occupe au minimum 180 px et n'était pas rétractable :
// avec le panneau de brouillon (240 px) et le rail (240 px), l'éditeur
// recevait une largeur NULLE sous 900 px.
const FILE_TREE_KEY = 'kobo:diff:fileTree'
const fileTreeOpen = ref<boolean>(
  localStorage.getItem(FILE_TREE_KEY) === null ? window.innerWidth >= 900 : localStorage.getItem(FILE_TREE_KEY) === '1',
)
watch(fileTreeOpen, (open) => localStorage.setItem(FILE_TREE_KEY, open ? '1' : '0'))

// En mode Review, un TROISIÈME panneau concurrence l'arbre de fichiers et le
// rail de critères pour la largeur disponible : le panneau de brouillon de
// revue (`review-draft-panel-wrapper`). Il n'a pas de bouton dédié — sa
// visibilité découle normalement de `reviewMode === 'review'` — donc on le
// masque via ce flag plutôt qu'en le fermant réellement, pour pouvoir le
// réafficher sans perdre l'état de la revue. Non persisté : chaque montage du
// visualiseur repart visible.
const reviewDraftHidden = ref<boolean>(false)
const reviewDraftPanelOpen = computed(
  () => reviewMode.value === 'review' && !(isDrawerCollapsed.value && reviewDraftHidden.value),
)

// Sous 1024 px, l'écran ne peut porter qu'UNE colonne latérale à la fois.
// Ouvrir l'une referme les deux autres (l'autre colonne ET le panneau de
// brouillon de revue s'il est affiché) plutôt que d'écraser l'éditeur.
watch(criteriaRailOpen, (open) => {
  if (open && isDrawerCollapsed.value) {
    fileTreeOpen.value = false
    reviewDraftHidden.value = true
  }
})
watch(fileTreeOpen, (open) => {
  if (open && isDrawerCollapsed.value) {
    criteriaRailOpen.value = false
    reviewDraftHidden.value = true
  }
})

// Un état ouvert (arbre et/ou rail) peut avoir été persisté en localStorage
// depuis un usage en grand écran. Si la fenêtre est ensuite redimensionnée
// vers une largeur étroite SANS rechargement de page, les watchers ci-dessus
// ne se déclenchent pas (ils portent sur les refs elles-mêmes, pas sur le
// passage sous le seuil responsive) : on referme donc explicitement toutes
// les colonnes concurrentes dès que `isDrawerCollapsed` bascule à `true`. On
// ne referme rien quand il repasse à `false` — on laisse l'utilisateur
// rouvrir manuellement ce qu'il veut en grand écran.
watch(isDrawerCollapsed, (collapsed) => {
  if (!collapsed) return
  fileTreeOpen.value = false
  criteriaRailOpen.value = false
  reviewDraftHidden.value = true
})

// ── File tree ────────────────────────────────────────────────────────────────

const tree = computed(() => buildPathTree(files.value))
const selectedNodeKey = computed(() => (selectedFile.value ? `file:${selectedFile.value}` : ''))

/** Above this many files, expanding the whole tree costs more than it helps. */
const AUTO_EXPAND_FILE_LIMIT = 200

const expandedNodes = ref<string[]>([])

// Recompute the initial expansion whenever the file list changes: everything
// open on a small diff, first level only on a large one. The user's manual
// expansions afterwards are preserved by v-model.
watch(
  tree,
  (nodes) => {
    expandedNodes.value =
      files.value.length <= AUTO_EXPAND_FILE_LIMIT ? collectFolderKeys(nodes) : collectFolderKeys(nodes, 1)
  },
  { immediate: true },
)

// ── File tree search ─────────────────────────────────────────────────────────

const fileFilter = ref('')

/** q-tree filter-method: keep a file node when its full path matches (case-insensitive).
 *  Folders return false — q-tree keeps them automatically when a descendant matches. */
function filterTreeNode(node: PathTreeNode<DiffFile>, filter: string): boolean {
  if (!node.file) return false
  return node.file.path.toLowerCase().includes(filter.toLowerCase())
}

/** True when a filter is typed but no file path matches it. */
const noFilterMatch = computed(() => {
  const q = fileFilter.value.trim().toLowerCase()
  if (q === '') return false
  return !files.value.some((f) => f.path.toLowerCase().includes(q))
})

// ── Data loading ─────────────────────────────────────────────────────────────

async function loadFiles() {
  loading.value = true
  try {
    const params = isCommitsMode.value
      ? new URLSearchParams({ mode: 'commits', from: props.compareFrom!, to: props.compareTo! })
      : new URLSearchParams({ mode: diffMode.value })
    if (!isCommitsMode.value && diffMode.value === 'branch' && includeUntracked.value) {
      params.set('includeUntracked', '1')
    }
    const signal = filesRequest.begin()
    const data = await apiFetch<{ files: DiffFile[]; sourceBranch?: string; workingBranch?: string }>(
      `/api/workspaces/${props.workspaceId}/diff?${params}`,
      { cache: 'no-store', signal },
    )
    // A response that is no longer the current one must never touch the view:
    // the fetch may have resolved just before a newer call aborted it.
    if (!filesRequest.isCurrent(signal)) return
    files.value = data.files
    sourceBranch.value = data.sourceBranch ?? ''
    workingBranch.value = data.workingBranch ?? ''
    fileListError.value = null
  } catch (err) {
    // A cancelled request is the expected outcome of a fast second call, not
    // a failure worth logging or surfacing in the file-list error state.
    if (isAbortError(err)) return
    // This used to be a bare `console.error`, in the very component whose job
    // is to show failures: the tree simply stayed empty and the user read it
    // as "no changes". Record the failure; never clear `files`.
    fileListError.value = err instanceof Error ? err.message : String(err)
    console.error('Failed to load diff files:', err)
  } finally {
    loading.value = false
  }
}

/** Retry button of the file-list failure state. */
function retryFileList(): void {
  void loadFiles()
}

async function loadFileDiff(filePath: string) {
  if (!editorContainer.value) return
  loadingFile.value = true

  try {
    // Dispose FIRST. Disposing after the request left the PREVIOUS file's
    // content on screen under the NEW file's name whenever the request failed
    // — the user then reviewed a diff that was not the one they believed.
    disposeEditor()
    fileLoadError.value = null

    if (!monaco) {
      // The base worker computes the diff, resolves links and does basic
      // tokenisation — everything this viewer actually needs. The four
      // language-service workers (TypeScript 6.6 MB, its secondary API 3.5 MB,
      // CSS 1.1 MB, HTML 704 kB, JSON 401 kB) served diagnostics and
      // IntelliSense that this read-mostly view never surfaced, yet Vite
      // emitted their bundles unconditionally.
      self.MonacoEnvironment = { getWorker: () => new EditorWorker() }
      monaco = await import('monaco-editor')
      disableWorkerBackedLanguageServices(monaco)
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

    const fileQuery = isCommitsMode.value
      ? `path=${encodeURIComponent(filePath)}&mode=commits&from=${encodeURIComponent(props.compareFrom!)}&to=${encodeURIComponent(props.compareTo!)}`
      : `path=${encodeURIComponent(filePath)}&mode=${diffMode.value}`
    const signal = fileDiffRequest.begin()
    const data = await apiFetch<{ original?: string; modified?: string; modifiedSha?: string }>(
      `/api/workspaces/${props.workspaceId}/diff-file?${fileQuery}`,
      { cache: 'no-store', signal },
    )
    // Bail out BEFORE building the new editor: a superseded response must
    // leave the view — and the baseSha/baseContent snapshot that the save
    // path relies on — exactly as the newest request left it.
    if (!fileDiffRequest.isCurrent(signal)) return

    const language = monacoLanguageForPath(filePath)

    const originalModel = monaco.editor.createModel(data.original ?? '', language)
    const modifiedModel = monaco.editor.createModel(data.modified ?? '', language)

    diffEditor = monaco.editor.createDiffEditor(editorContainer.value, {
      theme: 'kobo-dark',
      readOnly: !canEdit.value,
      originalEditable: false,
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

    diffEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      if (canEdit.value && dirty.value && !savingFile.value) onSaveClicked()
    })

    diffEditor.setModel({ original: originalModel, modified: modifiedModel })

    // Snapshot for dirty + 412 conflict guard
    baseSha.value = data.modifiedSha ?? ''
    baseContent.value = data.modified ?? ''
    dirty.value = false

    // Preserve EOL: if the loaded content uses CRLF, configure the model so
    // edits round-trip without LF normalisation.
    if (monaco && (data.modified ?? '').includes('\r\n')) {
      modifiedModel.setEOL(monaco.editor.EndOfLineSequence.CRLF)
    }

    modifiedModelDispose?.()
    const changeSub = modifiedModel.onDidChangeContent(() => {
      dirty.value = modifiedModel.getValue() !== baseContent.value
    })
    modifiedModelDispose = () => changeSub.dispose()

    setupSelectionTracking()
    if (reviewMode.value === 'review') {
      setupGutterAddButton()
      renderCommentZonesForFile(filePath)
    }
  } catch (err) {
    // A cancelled request is the expected outcome of a fast second click, not
    // a failure worth surfacing in the inline error state.
    if (isAbortError(err)) return
    const message = err instanceof Error ? err.message : String(err)
    fileLoadError.value = message
    console.error('Failed to load file diff:', err)
  } finally {
    loadingFile.value = false
  }
}

/** Retry button of the inline failure state — re-runs the load for the file
 *  the user is looking at. */
function retryFileDiff(): void {
  if (selectedFile.value) void loadFileDiff(selectedFile.value)
}

async function saveCurrentFile(): Promise<
  { ok: true } | { ok: false; status: number; currentSha?: string; message?: string }
> {
  // Belt-and-braces: commits mode is a read-only historical diff (canEdit is
  // false, so this is already unreachable from the UI). Guard the save path
  // itself so a future regression can never write a historical commit's
  // content back into the worktree via the branch/unpushed save endpoint.
  if (isCommitsMode.value) return { ok: false, status: 0 }
  if (!diffEditor) return { ok: false, status: 0 }
  const modifiedModel = diffEditor.getModel()?.modified
  if (!modifiedModel || !selectedFile.value) return { ok: false, status: 0 }
  const content = modifiedModel.getValue()
  const wsId = props.workspaceId
  const filePath = selectedFile.value
  const sha = baseSha.value
  savingFile.value = true
  try {
    await apiFetch(`/api/workspaces/${wsId}/save-file`, {
      method: 'POST',
      body: { path: filePath, content, baseSha: sha },
    })
    // Refetch the diff so baseSha + baseContent reflect the new on-disk truth.
    // A failed refresh does not undo the save: report the save as done and let
    // the stale sha surface as a 412 on the next attempt.
    try {
      const data = await apiFetch<{ modified?: string; modifiedSha?: string }>(
        `/api/workspaces/${wsId}/diff-file?path=${encodeURIComponent(filePath)}&mode=${diffMode.value}`,
        { cache: 'no-store' },
      )
      baseSha.value = data.modifiedSha ?? ''
      baseContent.value = data.modified ?? ''
      dirty.value = modifiedModel.getValue() !== baseContent.value
    } catch (err) {
      console.error('[DiffViewer] post-save refresh failed:', err)
    }
    $q.notify({ type: 'positive', message: t('diffViewer.savedAt'), position: 'top', timeout: 1200 })
    return { ok: true }
  } catch (err) {
    console.error('[DiffViewer] save failed:', err)
    if (err instanceof ApiError) {
      if (err.status === 412) {
        let currentSha: string | undefined
        try {
          currentSha = (JSON.parse(err.body) as { currentSha?: string }).currentSha
        } catch {
          // The 412 body is expected to carry the on-disk sha; without it the
          // conflict dialog still works, it just cannot pre-fill anything.
        }
        return { ok: false, status: 412, currentSha }
      }
      return { ok: false, status: err.status, message: err.message }
    }
    return { ok: false, status: 0, message: err instanceof Error ? err.message : undefined }
  } finally {
    savingFile.value = false
  }
}

// Trois issues, pas deux. `$q.dialog` n'en offre que deux (ok / cancel), et
// c'est précisément pour cela que « écraser quand même » n'existait pas et que
// « garder les miennes » ne faisait rien : on passe donc à un dialogue rendu
// dans le gabarit.
const conflictDialogOpen = ref(false)
const conflictCurrentSha = ref('')
const overwriting = ref(false)

async function onSaveClicked(): Promise<void> {
  const result = await saveCurrentFile()
  if (result.ok) return
  if (result.status === 412) {
    conflictCurrentSha.value = result.currentSha ?? ''
    conflictDialogOpen.value = true
    return
  }
  $q.notify({
    type: 'negative',
    message:
      result.status === 409
        ? t('diffViewer.agentRunning')
        : result.message
          ? t('diffViewer.saveFailedDetail', { error: result.message })
          : t('diffViewer.saveFailed'),
    position: 'top',
  })
}

/** Jeter mes modifications et repartir du contenu réel du disque. */
async function conflictReload(): Promise<void> {
  conflictDialogOpen.value = false
  if (selectedFile.value) await loadFileDiff(selectedFile.value)
}

/**
 * Garder mes modifications dans l'éditeur ET adopter la signature renvoyée par
 * le serveur. Sans cette adoption, `baseSha` restait périmé et TOUTE
 * sauvegarde ultérieure échouait à l'infini sur le même 412.
 */
function conflictKeepMine(): void {
  if (conflictCurrentSha.value) baseSha.value = conflictCurrentSha.value
  conflictDialogOpen.value = false
}

/** Adopter la signature du serveur puis ré-enregistrer immédiatement. */
async function conflictOverwrite(): Promise<void> {
  if (!conflictCurrentSha.value) {
    conflictDialogOpen.value = false
    return
  }
  baseSha.value = conflictCurrentSha.value
  overwriting.value = true
  try {
    const result = await saveCurrentFile()
    if (result.ok) {
      conflictDialogOpen.value = false
      return
    }
    if (result.status === 412) {
      // Le fichier a encore changé entre-temps : on garde le dialogue ouvert
      // avec la signature fraîche plutôt que de renvoyer l'utilisateur au
      // point de départ.
      conflictCurrentSha.value = result.currentSha ?? ''
      return
    }
    conflictDialogOpen.value = false
    $q.notify({
      type: 'negative',
      message:
        result.status === 409
          ? t('diffViewer.agentRunning')
          : result.message
            ? t('diffViewer.saveFailedDetail', { error: result.message })
            : t('diffViewer.saveFailed'),
      position: 'top',
    })
  } finally {
    overwriting.value = false
  }
}

// ── Fermeture gardée ─────────────────────────────────────────────────────────
const closeConfirmOpen = ref(false)

/**
 * Point de sortie UNIQUE du visualiseur. Le bouton de fermeture et la touche
 * Échap passent tous les deux par ici : c'est la seule façon de garantir
 * qu'aucun tampon non enregistré ne parte en silence.
 */
function requestClose(): void {
  if (!dirty.value) {
    emit('close')
    return
  }
  closeConfirmOpen.value = true
}

/**
 * Exposed so hosts (GitPanel) that need to close the viewer from outside —
 * e.g. after "Add to chat" — go through the same guard as the close button
 * and Escape, instead of tearing down the dialog directly and silently
 * dropping unsaved edits.
 */
defineExpose({ requestClose })

function closeDiscarding(): void {
  closeConfirmOpen.value = false
  dirty.value = false
  emit('close')
}

async function closeSaving(): Promise<void> {
  const result = await saveCurrentFile()
  if (result.ok) {
    closeConfirmOpen.value = false
    emit('close')
    return
  }
  closeConfirmOpen.value = false
  if (result.status === 412) {
    conflictCurrentSha.value = result.currentSha ?? ''
    conflictDialogOpen.value = true
    return
  }
  $q.notify({
    type: 'negative',
    message:
      result.status === 409
        ? t('diffViewer.agentRunning')
        : result.message
          ? t('diffViewer.saveFailedDetail', { error: result.message })
          : t('diffViewer.saveFailed'),
    position: 'top',
  })
}

/**
 * Échap. Le dialogue hôte est passé `persistent` (GitPanel), donc Quasar ne
 * ferme plus rien tout seul : c'est ce gestionnaire qui rend la commodité
 * d'Échap, en la faisant passer par la garde.
 */
function onDiffKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return
  // Un dialogue enfant est ouvert : c'est à lui de traiter la touche.
  if (conflictDialogOpen.value || closeConfirmOpen.value) return
  event.preventDefault()
  requestClose()
}

onMounted(() => window.addEventListener('keydown', onDiffKeydown))
onUnmounted(() => window.removeEventListener('keydown', onDiffKeydown))

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
    const body = await apiFetch<{ target?: 'remote' | 'head' | 'deleted' } | undefined>(
      `/api/workspaces/${props.workspaceId}/rollback-file`,
      { method: 'POST', body: { path: filePath } },
    )
    let message = t('diff.rollbackDoneRemote')
    if (body?.target === 'head') message = t('diff.rollbackDoneHead')
    else if (body?.target === 'deleted') message = t('diff.rollbackDoneDeleted')
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
    // The server names the reason (dirty index, missing baseline, agent
    // running). Showing it beats a flat "Rollback failed".
    const detail = err instanceof ApiError ? err.message : null
    $q.notify({
      type: 'negative',
      message: detail ? t('diff.rollbackFailedDetail', { error: detail }) : t('diff.rollbackFailed'),
      position: 'top',
    })
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

// Guards against the `selectedFile.value = previousPath` revert below
// re-triggering this same watcher: without it, clicking Cancel on the
// unsaved-changes dialog reopens the same dialog forever, since `dirty`
// is still true when the watcher re-fires on the reverted assignment.
//
// This single boolean assumes only one watcher invocation is ever in
// flight at a time. That holds today because the `$q.dialog({ persistent:
// true })` backdrop blocks every other UI path from mutating
// `selectedFile` while a dialog is pending — there's no way to trigger a
// second, overlapping watcher run. If a future change ever lets
// `selectedFile` change from a non-modal-gated source while a dialog is
// open, this guard would need to become an identity check (compare
// against the specific reverted path) or a counter instead of a bare
// boolean.
let revertingSelection = false

watch(selectedFile, async (filePath, previousPath) => {
  if (revertingSelection) {
    revertingSelection = false
    return
  }

  if (dirty.value && previousPath) {
    const proceed = await new Promise<'save' | 'cancel'>((resolve) => {
      $q.dialog({
        title: t('diffViewer.unsavedChanges.title'),
        message: t('diffViewer.unsavedChanges.message'),
        dark: true,
        persistent: true,
        ok: { flat: true, label: t('diffViewer.unsavedChanges.save'), color: 'indigo-4' },
        cancel: { flat: true, label: t('diffViewer.unsavedChanges.cancel'), color: 'grey-5' },
      })
        .onOk(() => resolve('save'))
        .onCancel(() => resolve('cancel'))
    })
    if (proceed === 'save') {
      const result = await saveCurrentFile()
      if (!result.ok) {
        revertingSelection = true
        selectedFile.value = previousPath
        if (result.status === 412) {
          conflictCurrentSha.value = result.currentSha ?? ''
          conflictDialogOpen.value = true
        } else {
          $q.notify({ type: 'negative', message: t('diffViewer.saveFailed'), position: 'top' })
        }
        return
      }
    } else if (proceed === 'cancel') {
      revertingSelection = true
      selectedFile.value = previousPath
      return
    }
  }

  if (filePath) {
    // The DiffViewer can receive a target file while its dialog is still
    // being mounted. Wait for the teleported dialog DOM before loading Monaco
    // so loadFileDiff does not bail out on a missing editor container.
    await nextTick()
    if (selectedFile.value === filePath) await loadFileDiff(filePath)
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

function selectRequestedFile(path: string) {
  // A tool card may refer to a file that no longer belongs to the current
  // diff scope. Do not replace the current selection in that case.
  if (!files.value.some((file) => file.path === path)) return
  selectedFile.value = path
  // The watcher performs the actual load after the next DOM tick.
}

function onOpenDiff(event: Event) {
  const detail = (event as CustomEvent<{ workspaceId?: string; path?: string }>).detail
  if (detail?.workspaceId !== props.workspaceId || !detail.path) return
  void selectRequestedFile(detail.path)
}

onMounted(() => {
  window.addEventListener('kobo:select-diff', onOpenDiff)
  void loadFiles().then(() => {
    const path = takePendingDiffOpen(props.workspaceId)
    if (path) void selectRequestedFile(path)
  })
  registerUnsavedScope('diff:file', () => dirty.value)
})

onUnmounted(() => {
  window.removeEventListener('kobo:select-diff', onOpenDiff)
  // Single source of truth — disposeEditor() handles selection disposables,
  // editor and (in Review mode) view zones / mounted Vue apps.
  reviewDraft.flush() // before disposeEditor in case the user closed mid-edit
  disposeEditor()
  filesRequest.abort()
  fileDiffRequest.abort()
  unregisterUnsavedScope('diff:file')
})
</script>

<style lang="scss" scoped>
// Match the main app color scheme from MainLayout / WorkspaceList
.diff-viewer {
  background-color: #1a1a2e;
}

/* L'en-tête ne passe pas à la ligne (les contrôles perdraient leur
   alignement) : il défile. Les deux boutons de droite restent atteignables
   quelle que soit la largeur — sans quoi la seule sortie était Échap. */
.diff-header__scroll {
  flex: 1 1 auto;
  min-width: 0;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: thin;
}

.diff-header__scroll::-webkit-scrollbar {
  height: 4px;
}

.diff-header__scroll::-webkit-scrollbar-thumb {
  background-color: var(--kobo-border);
  border-radius: var(--kobo-radius-sm);
}

.diff-header__pinned {
  flex: 0 0 auto;
}

/* Rail de revue : même largeur que le panneau de brouillon de revue, pour que
   l'oeil retrouve la même colonne des deux côtés. Jetons de design
   exclusivement — aucune valeur en dur (cf. DESIGN.md). */
.diff-criteria-rail {
  width: 300px;
  min-width: 240px;
  flex-shrink: 0;
  border-left: 1px solid var(--kobo-border-subtle);
  background-color: var(--kobo-bg-deep);
  overflow: hidden;
}

.diff-criteria-rail__title {
  font-family: var(--kobo-font-sans);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--kobo-text-3);
  padding: var(--kobo-space-md) var(--kobo-space-lg);
}

// Same as .wp-header in WorkspacePage
.diff-header {
  min-height: 48px;
  background-color: #16162a;
  border-bottom: 1px solid #2a2a4a;
  // `.diff-header` est un item flex de la colonne `.diff-viewer` : sans
  // width: 100% + min-width: 0, son contenu (largement plus large que
  // l'écran sous ~550 px) le fait déborder de la page entière au lieu de
  // laisser `.diff-header__scroll` défiler EN INTERNE. C'est ce qui causait
  // le bouton de fermeture hors cadre.
  width: 100%;
  min-width: 0;
}

.diff-file-list-wrapper {
  position: relative;
  height: 100%;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
}
.diff-file-search {
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
  flex: 1;
  min-height: 0;
}

.diff-tree {
  :deep(.q-tree__node-header) {
    padding: 2px 4px;
    min-height: 22px;
    align-items: center;
  }
  // Quasar applies `q-tree__node--selected` directly ON the `q-tree__node-header`
  // element (NOT on a parent wrapper) — see node_modules/quasar/src/components/
  // tree/QTree.js:593. So the selector is the two classes combined on the same
  // element, not a descendant relationship.
  // `!important` keeps the selected style winning against Quasar's `q-hoverable`
  // pseudo-class hover background.
  :deep(.q-tree__node-header.q-tree__node--selected) {
    background-color: rgba(108, 99, 255, 0.18) !important;
    border-left: 2px solid #6c63ff !important;
  }
  // Hover style applied only on non-selected rows so the selected background
  // stays clean while the cursor browses other files.
  :deep(.q-tree__node-header:not(.q-tree__node--selected):hover) {
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

.dirty-dot {
  color: var(--kobo-accent, #6c63ff);
  margin-left: 4px;
  font-size: 10px;
}
</style>
