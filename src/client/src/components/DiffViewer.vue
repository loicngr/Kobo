<script setup lang="ts">
import { buildPathTree, countLeaves } from 'src/utils/build-path-tree'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps<{
  workspaceId: string
}>()

const emit = defineEmits<{
  close: []
  sendToChat: [text: string]
}>()

const { t } = useI18n()

interface DiffFile {
  path: string
  status: 'added' | 'modified' | 'deleted' | 'renamed'
}

const files = ref<DiffFile[]>([])
const sourceBranch = ref('')
const workingBranch = ref('')
const selectedFile = ref<string | null>(null)
const loading = ref(false)
const loadingFile = ref(false)
const editorContainer = ref<HTMLElement | null>(null)
const viewMode = ref<'side' | 'inline'>('side')

// Monaco instances (lazy loaded)
let monaco: typeof import('monaco-editor') | null = null
let diffEditor: import('monaco-editor').editor.IStandaloneDiffEditor | null = null
let selectionDisposables: Array<{ dispose(): void }> = []

// ── File tree ────────────────────────────────────────────────────────────────

const tree = computed(() => buildPathTree(files.value))
const selectedNodeKey = computed(() => (selectedFile.value ? `file:${selectedFile.value}` : ''))

// ── Data loading ─────────────────────────────────────────────────────────────

async function loadFiles() {
  loading.value = true
  try {
    const res = await fetch(`/api/workspaces/${props.workspaceId}/diff`)
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

    const res = await fetch(`/api/workspaces/${props.workspaceId}/diff-file?path=${encodeURIComponent(filePath)}`)
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

    if (diffEditor) {
      for (const d of selectionDisposables) d.dispose()
      selectionDisposables = []
      const model = diffEditor.getModel()
      diffEditor.dispose()
      diffEditor = null
      model?.original?.dispose()
      model?.modified?.dispose()
    }

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
    })

    diffEditor.setModel({ original: originalModel, modified: modifiedModel })
    setupSelectionTracking()
  } catch (err) {
    console.error('Failed to load file diff:', err)
  } finally {
    loadingFile.value = false
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
  if (filePath) loadFileDiff(filePath)
})

watch(viewMode, () => {
  if (diffEditor) {
    diffEditor.updateOptions({ renderSideBySide: viewMode.value === 'side' })
  }
})

// ── Helpers ──────────────────────────────────────────────────────────────────

function statusColor(status: DiffFile['status']): string {
  switch (status) {
    case 'added':
      return '#4ade80'
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
  for (const d of selectionDisposables) d.dispose()
  selectionDisposables = []
  if (diffEditor) {
    const model = diffEditor.getModel()
    diffEditor.dispose()
    diffEditor = null
    model?.original?.dispose()
    model?.modified?.dispose()
  }
})
</script>

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
        <span class="text-grey-7">{{ sourceBranch }}</span>
        <q-icon name="arrow_forward" size="11px" color="grey-8" class="q-mx-xs" />
        <span class="text-green-4">{{ workingBranch }}</span>
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
      <q-btn flat round dense icon="close" color="grey-5" size="sm" @click="emit('close')">
        <q-tooltip>{{ $t('tooltip.closeDiffViewer') }}</q-tooltip>
      </q-btn>
    </div>

    <q-separator dark />

    <div class="row col no-wrap" style="min-height: 0;">
      <!-- File tree sidebar -->
      <q-scroll-area class="diff-file-list q-pa-xs" style="width: 280px; min-width: 200px; height: 100%; border-right: 1px solid #2a2a4a;">
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
            </template>
          </template>
        </q-tree>
      </q-scroll-area>

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
        <div ref="editorContainer" class="col" style="min-height: 0;" />

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
</style>
