<script setup lang="ts">
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import { useQuasar } from 'quasar'
import { type DocumentFile, useDocumentsStore } from 'src/stores/documents'
import type { Workspace } from 'src/stores/workspace'
import { buildPathTree } from 'src/utils/build-path-tree'
import { computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps<{
  workspace: Workspace | null
}>()

const { t } = useI18n()
const $q = useQuasar()
const store = useDocumentsStore()

const documents = computed<DocumentFile[]>(() => (props.workspace ? store.documentsFor(props.workspace.id) : []))
const tree = computed(() => buildPathTree(documents.value))
const selectedPath = computed(() => store.selected?.path ?? null)

const renderedMarkdown = computed(() => {
  if (!store.selected) return ''
  const html = marked.parse(store.selected.content, { async: false, breaks: true, gfm: true }) as string
  return DOMPurify.sanitize(html)
})

async function refresh() {
  if (!props.workspace) return
  await store.fetchDocuments(props.workspace.id)
}

async function handleNodeClick(node: { nodeKey?: string; file?: DocumentFile }) {
  if (!props.workspace || !node.file) return
  try {
    await store.openDocument(props.workspace.id, node.file)
  } catch {
    $q.notify({ type: 'negative', message: t('documents.loadFailed'), position: 'top' })
  }
}

function closeDocument() {
  store.closeDocument()
}

// Re-fetch whenever the workspace changes.
watch(
  () => props.workspace?.id,
  (id) => {
    store.closeDocument()
    if (id) void store.fetchDocuments(id)
  },
  { immediate: true },
)
</script>

<template>
  <div class="documents-panel q-pa-md">
    <!-- Header -->
    <div class="row items-center justify-between q-mb-sm">
      <div class="text-caption text-uppercase text-weight-bold text-grey-6" style="letter-spacing: 0.05em;">
        {{ $t('documents.title') }}
      </div>
      <q-btn
        v-if="!store.selected"
        flat
        round
        dense
        size="xs"
        icon="refresh"
        color="grey-6"
        :loading="store.loadingList"
        @click="refresh"
      >
        <q-tooltip>{{ $t('documents.refresh') }}</q-tooltip>
      </q-btn>
      <q-btn
        v-else
        flat
        dense
        no-caps
        size="sm"
        icon="arrow_back"
        :label="$t('documents.back')"
        color="grey-5"
        @click="closeDocument"
      />
    </div>

    <!-- Tree view -->
    <template v-if="!store.selected">
      <div v-if="!workspace" class="text-caption text-grey-8">
        {{ $t('common.selectWorkspace') }}
      </div>

      <div v-else-if="store.loadingList" class="text-center q-py-lg">
        <q-spinner size="24px" color="grey-6" />
      </div>

      <div v-else-if="documents.length === 0" class="text-caption text-grey-8 text-center q-py-lg">
        {{ $t('documents.empty') }}
      </div>

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
        :selected="selectedPath ? `file:${selectedPath}` : ''"
        class="documents-tree"
        @update:selected="
          (key) => {
            if (typeof key !== 'string' || !key.startsWith('file:')) return
            const node = documents.find((d) => `file:${d.path}` === key)
            if (node) void handleNodeClick({ file: node })
          }
        "
      >
        <template #default-header="{ node }">
          <q-icon
            :name="node.isFolder ? 'folder' : 'description'"
            :color="node.isFolder ? 'indigo-4' : 'grey-5'"
            size="14px"
            class="q-mr-xs"
          />
          <span
            :class="node.isFolder ? 'text-grey-4' : 'text-grey-3'"
            style="font-family: 'Roboto Mono', monospace; font-size: 11px;"
          >{{ node.label }}</span>
        </template>
      </q-tree>
    </template>

    <!-- Detail view -->
    <template v-else>
      <div v-if="store.loadingContent" class="text-center q-py-lg">
        <q-spinner size="24px" color="grey-6" />
      </div>
      <div v-else class="document-content" v-html="renderedMarkdown" />
    </template>
  </div>
</template>

<style lang="scss" scoped>
.documents-tree {
  :deep(.q-tree__node--selected) > .q-tree__node-header {
    background: rgba(121, 134, 203, 0.15);
  }
  :deep(.q-tree__node-header) {
    padding: 2px 4px;
  }
}
.document-content {
  font-size: 12px;
  color: #d0d0d0;
  line-height: 1.6;
  overflow-wrap: break-word;

  :deep(h1) { font-size: 16px; color: #e0e0e0; margin: 16px 0 8px; }
  :deep(h2) { font-size: 14px; color: #e0e0e0; margin: 14px 0 6px; }
  :deep(h3) { font-size: 13px; color: #e0e0e0; margin: 12px 0 4px; }
  :deep(code) {
    background: #1a1a2e;
    padding: 1px 4px;
    border-radius: 3px;
    font-family: 'Roboto Mono', monospace;
    font-size: 11px;
  }
  :deep(pre) {
    background: #1a1a2e;
    padding: 8px 12px;
    border-radius: 6px;
    overflow-x: auto;
    font-size: 11px;
  }
  :deep(pre code) {
    background: none;
    padding: 0;
  }
  :deep(ul), :deep(ol) {
    padding-left: 20px;
  }
  :deep(li) {
    margin-bottom: 2px;
  }
  :deep(input[type="checkbox"]) {
    margin-right: 6px;
    pointer-events: none;
  }
  :deep(table) {
    border-collapse: collapse;
    width: 100%;
    font-size: 11px;
    margin: 8px 0;
  }
  :deep(th), :deep(td) {
    border: 1px solid #2a2a4a;
    padding: 4px 8px;
    text-align: left;
  }
  :deep(th) {
    background: #1a1a2e;
    color: #e0e0e0;
  }
  :deep(blockquote) {
    border-left: 3px solid #4a4a6a;
    margin: 8px 0;
    padding: 4px 12px;
    color: #a0a0b0;
  }
  :deep(a) {
    color: #818cf8;
  }
  :deep(hr) {
    border: none;
    border-top: 1px solid #2a2a4a;
    margin: 12px 0;
  }
}
</style>
