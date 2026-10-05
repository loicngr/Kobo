<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { MemoryEntry, MemoryMode } from '../../../shared/memory'
import { useMemoryStore } from '../stores/memory'
import MemoryEntryEditor from './memory/MemoryEntryEditor.vue'
import MemoryEntryList from './memory/MemoryEntryList.vue'
import MemoryOperationsList from './memory/MemoryOperationsList.vue'
import MemoryProposalList from './memory/MemoryProposalList.vue'
import MemoryScopeSelect from './memory/MemoryScopeSelect.vue'

const props = defineProps<{ memoryMode: MemoryMode }>()
const emit = defineEmits<{ 'update:memoryMode': [mode: MemoryMode] }>()
const { t } = useI18n()
const memory = useMemoryStore()
const scopeId = ref('')
const editorOpen = ref(false)
const editing = ref<MemoryEntry | null>(null)
const deletingEntry = ref<MemoryEntry | null>(null)
const promotionEntry = ref<MemoryEntry | null>(null)
const targetScopeId = ref('')
const isSaving = ref(false)
const isDeleting = ref(false)
const isPromoting = ref(false)
const busyProposalId = ref<string | null>(null)
const editorConflict = ref(false)
const error = ref('')
const clearPreview = ref<{ scopeId: string; revision: number; entries: number; proposals: number } | null>(null)
let clearRequest = 0
onUnmounted(() => {
  clearRequest++
})
const clearError = ref('')
const scopes = computed(() => memory.scopesFor())
const hasMoreScopes = computed(() => memory.hasMoreScopes())
const loadingMoreScopes = computed(() => memory.loadingScopes.all ?? false)
const entries = computed(() => (scopeId.value ? memory.entriesFor(scopeId.value) : []))
const proposals = computed(() => (scopeId.value ? memory.proposalsFor(scopeId.value) : []))
const operations = computed(() => (scopeId.value ? memory.operationsFor(scopeId.value) : []))
const operationCursor = computed(() => (scopeId.value ? memory.operationsCursor(scopeId.value) : undefined))

onMounted(async () => {
  try {
    await memory.loadScopes()
    if (!scopeId.value)
      scopeId.value = scopes.value.find((scope) => scope.level === 'global')?.id ?? scopes.value[0]?.id ?? ''
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('memory.settings.loadFailed')
  }
})

watch(
  scopeId,
  async (id) => {
    clearRequest++
    clearPreview.value = null
    clearError.value = ''
    editorOpen.value = false
    editing.value = null
    editorConflict.value = false
    if (!id) return
    try {
      await Promise.all([memory.loadEntries(id), memory.loadProposals(id), memory.loadOperations(id)])
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : t('memory.settings.loadFailed')
    }
  },
  { flush: 'sync' },
)

function startCreate(): void {
  editing.value = null
  error.value = ''
  editorConflict.value = false
  editorOpen.value = true
}

function startEdit(entry: MemoryEntry): void {
  editing.value = entry
  error.value = ''
  editorConflict.value = false
  editorOpen.value = true
}

async function saveEntry(value: {
  scopeId: string
  key: string
  title: string
  body: string
  expectedRevision?: number
}): Promise<void> {
  isSaving.value = true
  error.value = ''
  try {
    if (editing.value) {
      const entry =
        value.expectedRevision === undefined ? editing.value : { ...editing.value, revision: value.expectedRevision }
      await memory.updateEntry(entry, { key: value.key, title: value.title, body: value.body })
    } else await memory.createEntry({ scopeId: value.scopeId, key: value.key, title: value.title, body: value.body })
    editorOpen.value = false
    editing.value = null
    editorConflict.value = false
    await Promise.all([
      memory.loadEntries(scopeId.value),
      memory.loadProposals(scopeId.value),
      memory.loadOperations(scopeId.value),
    ])
  } catch (cause) {
    if (editing.value && errorStatus(cause) === 409) {
      await memory.loadEntries(editing.value.scopeId)
      editing.value = memory.entriesFor(editing.value.scopeId).find((entry) => entry.id === editing.value?.id) ?? null
      editorConflict.value = true
      error.value = ''
      return
    }
    error.value = cause instanceof Error ? cause.message : t('memory.settings.saveFailed')
  } finally {
    isSaving.value = false
  }
}

function deleteEntry(entry: MemoryEntry): void {
  deletingEntry.value = entry
}

async function loadMoreScopes(): Promise<void> {
  try {
    await memory.loadMoreScopes()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('memory.settings.loadFailed')
  }
}

async function confirmDeleteEntry(): Promise<void> {
  const entry = deletingEntry.value
  if (!entry || isDeleting.value) return
  isDeleting.value = true
  try {
    await memory.deleteEntry(entry)
    deletingEntry.value = null
    await Promise.all([memory.loadEntries(scopeId.value), memory.loadOperations(scopeId.value)])
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('memory.settings.saveFailed')
  } finally {
    isDeleting.value = false
  }
}

function cancelDeleteEntry(): void {
  deletingEntry.value = null
}

function selectedScopeLabel(targetScopeId = scopeId.value): string {
  const scope = scopes.value.find((candidate) => candidate.id === targetScopeId)
  if (!scope) return ''
  const level = t(`memory.scope.${scope.level}`)
  if (scope.level === 'project') return `${level} · ${scope.projectPath ?? scope.id}`
  if (scope.level === 'workspace') return `${level} · ${scope.workspaceId ?? scope.id}`
  return level
}

function startPromotion(entry: MemoryEntry): void {
  promotionEntry.value = entry
  targetScopeId.value = ''
}

async function confirmPromotion(): Promise<void> {
  const entry = promotionEntry.value
  if (!entry || !targetScopeId.value || isPromoting.value) return
  isPromoting.value = true
  try {
    await memory.promoteEntry(entry, targetScopeId.value)
    promotionEntry.value = null
    targetScopeId.value = ''
    await Promise.all([memory.loadEntries(scopeId.value), memory.loadOperations(scopeId.value)])
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('memory.settings.saveFailed')
  } finally {
    isPromoting.value = false
  }
}

async function decideProposal(id: string, decision: 'approve' | 'reject'): Promise<void> {
  if (busyProposalId.value) return
  busyProposalId.value = id
  try {
    await memory.decideProposal(id, decision)
    await Promise.all([
      memory.loadEntries(scopeId.value),
      memory.loadProposals(scopeId.value),
      memory.loadOperations(scopeId.value),
    ])
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('memory.settings.saveFailed')
  } finally {
    busyProposalId.value = null
  }
}

async function previewClear(): Promise<void> {
  if (!scopeId.value) return
  const targetScopeId = scopeId.value
  const request = ++clearRequest
  clearError.value = ''
  try {
    const preview = await memory.previewClear(targetScopeId)
    if (request !== clearRequest || scopeId.value !== targetScopeId) return
    clearPreview.value = { ...preview, scopeId: targetScopeId }
  } catch (cause) {
    if (request !== clearRequest) return
    clearError.value = cause instanceof Error ? cause.message : t('memory.settings.clearFailed')
  }
}

function errorStatus(cause: unknown): number | undefined {
  return typeof cause === 'object' && cause !== null && 'status' in cause ? Number(cause.status) : undefined
}

async function confirmClear(): Promise<void> {
  if (!scopeId.value || !clearPreview.value || isDeleting.value) return
  const preview = clearPreview.value
  const request = clearRequest
  if (scopeId.value !== preview.scopeId) return
  isDeleting.value = true
  try {
    await memory.clearScope(preview.scopeId, preview.revision)
    if (request !== clearRequest) return
    clearPreview.value = null
    await Promise.all([
      memory.loadEntries(scopeId.value),
      memory.loadProposals(scopeId.value),
      memory.loadOperations(scopeId.value),
    ])
  } catch (cause) {
    if (request !== clearRequest) return
    clearError.value =
      errorStatus(cause) === 409
        ? t('memory.settings.clearConflict')
        : cause instanceof Error
          ? cause.message
          : t('memory.settings.clearFailed')
    if (errorStatus(cause) === 409) {
      try {
        const refreshed = await memory.previewClear(preview.scopeId)
        if (request === clearRequest) clearPreview.value = { ...refreshed, scopeId: preview.scopeId }
      } catch {
        if (request === clearRequest) clearPreview.value = null
      }
    }
  } finally {
    isDeleting.value = false
  }
}

function handleReload(): void {
  editorConflict.value = false
  error.value = ''
}

function handleRebase(): void {
  editorConflict.value = false
  error.value = ''
}
</script>

<template>
  <section class="memory-settings" data-tour="settings-card-memory" aria-labelledby="memory-settings-title">
    <header class="memory-settings__header">
      <h3 id="memory-settings-title">{{ t('memory.settings.title') }}</h3>
      <p>{{ t('memory.settings.intro') }}</p>
    </header>

    <fieldset class="memory-settings__modes" data-tour="settings-memory-modes">
      <legend>{{ t('memory.settings.mode') }}</legend>
      <label v-for="mode in (['manual', 'automatic', 'hybrid'] as const)" :key="mode">
        <input
          type="radio"
          name="memory-mode"
          :value="mode"
          :checked="props.memoryMode === mode"
          @change="emit('update:memoryMode', mode)"
        />
        <span>{{ t(`memory.settings.mode.${mode}`) }}</span>
        <small>{{ t(`memory.settings.modeHint.${mode}`) }}</small>
      </label>
      <p class="memory-settings__note">{{ t('memory.settings.saveNote') }}</p>
    </fieldset>

    <div class="memory-settings__divider" />
    <h4>{{ t('memory.settings.manageTitle') }}</h4>
    <p class="memory-settings__note">{{ t('memory.settings.independentNote') }}</p>
    <MemoryScopeSelect :scopes="scopes" :model-value="scopeId" @update:model-value="scopeId = $event" />

    <p v-if="error" role="alert">{{ error }}</p>
    <div v-if="scopeId" class="memory-settings__actions">
      <button type="button" data-testid="memory-add-entry" :disabled="isSaving || isDeleting || isPromoting" @click="startCreate">{{ t('memory.settings.add') }}</button>
      <button type="button" data-testid="memory-clear-preview" :disabled="isSaving || isDeleting || isPromoting" @click="previewClear">{{ t('memory.settings.clear') }}</button>
    </div>

    <button
      v-if="hasMoreScopes"
      type="button"
      data-testid="memory-load-more-scopes"
      :disabled="loadingMoreScopes"
      @click="loadMoreScopes"
    >{{ loadingMoreScopes ? t('memory.settings.loadingScopes') : t('memory.settings.loadMoreScopes') }}</button>

    <div v-if="clearPreview" class="memory-clear-confirm" role="dialog" aria-modal="true">
      <h4>{{ t('memory.settings.clearConfirmTitle') }}</h4>
      <p>{{ t('memory.settings.clearConfirm', { scope: t(`memory.scope.${scopes.find((scope) => scope.id === scopeId)?.level ?? 'global'}`), entries: clearPreview.entries, proposals: clearPreview.proposals }) }}</p>
      <p class="memory-settings__note">{{ t('memory.settings.clearWarning') }}</p>
      <p v-if="clearError" role="alert">{{ clearError }}</p>
      <button type="button" data-testid="memory-clear-confirm" :disabled="isDeleting" @click="confirmClear">{{ t('memory.settings.confirmClear') }}</button>
      <button type="button" data-testid="memory-clear-cancel" :disabled="isDeleting" @click="clearPreview = null; clearError = ''">{{ t('memory.settings.cancel') }}</button>
    </div>

    <div v-if="deletingEntry" class="memory-clear-confirm" role="dialog" aria-modal="true">
      <h4>{{ t('memory.settings.deleteConfirmTitle') }}</h4>
      <p>{{ t('memory.settings.deleteConfirm', { title: deletingEntry.title, scope: selectedScopeLabel(deletingEntry.scopeId) }) }}</p>
      <p class="memory-settings__note">{{ t('memory.settings.clearWarning') }}</p>
      <button type="button" data-testid="memory-delete-confirm" :disabled="isDeleting" @click="confirmDeleteEntry">{{ t('memory.settings.deleteConfirmAction') }}</button>
      <button type="button" data-testid="memory-delete-cancel" :disabled="isDeleting" @click="cancelDeleteEntry">{{ t('memory.settings.cancel') }}</button>
    </div>

    <div v-if="promotionEntry" class="memory-clear-confirm" role="dialog" aria-modal="true">
      <h4>{{ t('memory.panel.promoteTo') }}</h4>
      <label><span>{{ t('memory.scope.label') }}</span><select v-model="targetScopeId" :disabled="isPromoting"><option value="">{{ t('memory.scope.choose') }}</option><option v-for="scope in scopes.filter((candidate) => candidate.id !== promotionEntry?.scopeId)" :key="scope.id" :value="scope.id">{{ selectedScopeLabel(scope.id) }}</option></select></label>
      <button type="button" data-testid="memory-promote-confirm" :disabled="!targetScopeId || isPromoting" @click="confirmPromotion">{{ t('memory.entry.promote') }}</button>
      <button type="button" data-testid="memory-promote-cancel" :disabled="isPromoting" @click="promotionEntry = null; targetScopeId = ''">{{ t('memory.settings.cancel') }}</button>
    </div>

    <MemoryEntryEditor
      v-if="editorOpen && scopeId"
      :scope-id="scopeId"
      :entry="editing"
      :saving="isSaving"
      :error="error"
      :conflict="editorConflict"
      @save="saveEntry"
      @reload="handleReload"
      @rebase="handleRebase"
      @cancel="editorOpen = false; editorConflict = false"
    />
    <MemoryEntryList v-else :entries="entries" :disabled="isSaving || isDeleting || isPromoting" @edit="startEdit" @delete="deleteEntry" @promote="startPromotion" />
    <button v-if="memory.hasMoreEntries(scopeId)" type="button" :disabled="memory.loadingEntries[`${scopeId}\u0000`]" @click="memory.loadEntries(scopeId, '', true).catch((cause: Error) => error = cause.message)">{{ t('memory.entry.loadMore') }}</button>
    <MemoryProposalList :proposals="proposals" :busy-proposal-id="busyProposalId" @decision="decideProposal" />
    <MemoryOperationsList :operations="operations" :has-more="Boolean(operationCursor)" @load-more="memory.loadOperations(scopeId, true)" />
  </section>
</template>

<style scoped>
.memory-settings { display: grid; gap: var(--kobo-space-md); }
.memory-settings h3, .memory-settings h4, .memory-settings p { margin: 0; }
.memory-settings h3 { font-size: 1.125rem; line-height: 1.5; font-weight: 600; }
.memory-settings h4 { font-size: 1rem; line-height: 1.5; font-weight: 600; }
.memory-settings__header p, .memory-settings__note { color: var(--kobo-text-2); }
.memory-settings__modes { display: grid; gap: var(--kobo-space-sm); border: 0; padding: 0; }
.memory-settings__modes legend { margin-bottom: var(--kobo-space-sm); font-weight: 600; }
.memory-settings__modes label { display: grid; grid-template-columns: auto 1fr; gap: var(--kobo-space-xs) var(--kobo-space-sm); align-items: center; }
.memory-settings__modes small { grid-column: 2; color: var(--kobo-text-2); }
.memory-settings__modes input { accent-color: var(--kobo-accent); }
.memory-settings__divider { height: 1px; background: var(--kobo-border-subtle); margin-block: var(--kobo-space-sm); }
.memory-settings__actions, .memory-clear-confirm { display: flex; flex-wrap: wrap; gap: var(--kobo-space-sm); align-items: center; }
.memory-clear-confirm { display: grid; padding: var(--kobo-space-md); border-inline-start: 3px solid var(--kobo-danger); background: var(--kobo-surface-2); }
.memory-settings :deep(button) { min-height: 36px; padding: 4px var(--kobo-space-md); color: var(--kobo-text); background: var(--kobo-surface); border: 1px solid var(--kobo-border-subtle); border-radius: var(--kobo-radius-sm); font: inherit; cursor: pointer; }
.memory-settings :deep(button:disabled) { opacity: 0.5; cursor: default; }
.memory-settings :deep(button:focus-visible), input:focus-visible { outline: 2px solid var(--kobo-accent); outline-offset: 2px; }
</style>
