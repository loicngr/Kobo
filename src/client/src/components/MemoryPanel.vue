<script setup lang="ts">
import { QDialog } from 'quasar'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import type { MemoryEntry } from '../../../shared/memory'
import { useMemoryStore } from '../stores/memory'
import MemoryEntryEditor from './memory/MemoryEntryEditor.vue'
import MemoryEntryList from './memory/MemoryEntryList.vue'
import MemoryOperationsList from './memory/MemoryOperationsList.vue'
import MemoryProposalList from './memory/MemoryProposalList.vue'

const props = withDefaults(
  defineProps<{
    workspaceId: string
    sessionId?: string
    archived?: boolean
    purged?: boolean
  }>(),
  { sessionId: undefined, archived: false, purged: false },
)

const { t } = useI18n()
const memory = useMemoryStore()
const expanded = ref(false)
const dialogTarget = ref<HTMLElement | null>(null)
const error = ref('')
const editing = ref<MemoryEntry | null>(null)
const editorOpen = ref(false)
const editorConflict = ref(false)
const deleting = ref<MemoryEntry | null>(null)
const clearing = ref(false)
const clearPreview = ref<{ scopeId: string; revision: number; entries: number; proposals: number } | null>(null)
let clearRequest = 0
onUnmounted(() => {
  clearRequest++
})
const promotion = ref<MemoryEntry | null>(null)
const targetScopeId = ref('')
const busy = ref(false)
const busyProposalId = ref<string | null>(null)
const view = computed(() => memory.workspaceView(props.workspaceId, props.sessionId))
const scopes = computed(() => view.value?.scopes ?? [])
const entries = computed(() => view.value?.entries ?? [])
const proposals = computed(() => view.value?.proposals ?? [])
const workspaceScope = computed(() => scopes.value.find((scope) => scope.level === 'workspace'))
const operations = computed(() => memory.workspaceOperationsFor(props.workspaceId))
const operationCursor = computed(() => memory.workspaceOperationsCursor(props.workspaceId))

async function refresh(): Promise<void> {
  error.value = ''
  try {
    await Promise.all([
      memory.loadWorkspace(props.workspaceId, props.sessionId),
      memory.loadWorkspaceOperations(props.workspaceId),
    ])
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('memory.panel.loadFailed')
  }
}

onMounted(() => void refresh())
watch(
  () => [props.workspaceId, props.sessionId],
  () => {
    clearRequest++
    editing.value = null
    editorOpen.value = false
    editorConflict.value = false
    deleting.value = null
    clearing.value = false
    promotion.value = null
    clearPreview.value = null
    void refresh()
  },
  { flush: 'sync' },
)

function startCreate(): void {
  editing.value = null
  editorConflict.value = false
  editorOpen.value = true
}
function startEdit(entry: MemoryEntry): void {
  editing.value = entry
  editorConflict.value = false
  editorOpen.value = true
}
async function save(value: {
  scopeId: string
  key: string
  title: string
  body: string
  expectedRevision?: number
}): Promise<void> {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    if (editing.value) {
      const entry =
        value.expectedRevision === undefined ? editing.value : { ...editing.value, revision: value.expectedRevision }
      await memory.updateEntry(entry, { key: value.key, title: value.title, body: value.body })
    } else await memory.createEntry(value)
    editorOpen.value = false
    editing.value = null
    editorConflict.value = false
    await refresh()
  } catch (cause) {
    if (editing.value && errorStatus(cause) === 409) {
      try {
        await memory.loadWorkspace(props.workspaceId, props.sessionId)
        editing.value = view.value?.entries.find((entry) => entry.id === editing.value?.id) ?? null
        editorConflict.value = true
        error.value = ''
      } catch (refreshCause) {
        error.value = refreshCause instanceof Error ? refreshCause.message : t('memory.panel.loadFailed')
      }
    } else error.value = cause instanceof Error ? cause.message : t('memory.settings.saveFailed')
  } finally {
    busy.value = false
  }
}
async function confirmDelete(): Promise<void> {
  if (!deleting.value || busy.value) return
  busy.value = true
  try {
    await memory.deleteEntry(deleting.value)
    deleting.value = null
    await refresh()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('memory.settings.saveFailed')
  } finally {
    busy.value = false
  }
}
async function previewWorkspaceClear(): Promise<void> {
  if (!workspaceScope.value || busy.value) return
  const scopeId = workspaceScope.value.id
  const request = ++clearRequest
  try {
    const preview = await memory.previewClear(scopeId)
    if (request !== clearRequest || workspaceScope.value?.id !== scopeId) return
    clearPreview.value = { ...preview, scopeId }
    clearing.value = true
  } catch (cause) {
    if (request !== clearRequest) return
    error.value = cause instanceof Error ? cause.message : t('memory.settings.clearFailed')
  }
}
async function confirmClear(): Promise<void> {
  if (!workspaceScope.value || !clearPreview.value || busy.value) return
  const preview = clearPreview.value
  const request = clearRequest
  if (workspaceScope.value.id !== preview.scopeId) return
  busy.value = true
  try {
    await memory.clearScope(preview.scopeId, preview.revision)
    if (request !== clearRequest) return
    clearing.value = false
    clearPreview.value = null
    await refresh()
  } catch (cause) {
    if (request !== clearRequest) return
    error.value = cause instanceof Error ? cause.message : t('memory.settings.clearFailed')
  } finally {
    busy.value = false
  }
}
async function decide(id: string, action: 'approve' | 'reject'): Promise<void> {
  if (busyProposalId.value) return
  busyProposalId.value = id
  try {
    await memory.decideProposal(id, action)
    await refresh()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('memory.settings.saveFailed')
  } finally {
    busyProposalId.value = null
  }
}
async function promote(entry: MemoryEntry): Promise<void> {
  if (!targetScopeId.value || busy.value) return
  busy.value = true
  try {
    await memory.promoteEntry(entry, targetScopeId.value)
    promotion.value = null
    await refresh()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('memory.settings.saveFailed')
  } finally {
    busy.value = false
  }
}
function errorStatus(cause: unknown): number | undefined {
  return typeof cause === 'object' && cause !== null && 'status' in cause ? Number(cause.status) : undefined
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
  <QDialog v-model="expanded" :aria-label="t('memory.panel.title')">
    <div ref="dialogTarget" class="memory-dialog" data-testid="memory-dialog" />
  </QDialog>
  <Teleport :to="dialogTarget || 'body'" :disabled="!expanded || !dialogTarget">
  <section class="memory-panel q-pa-md" :class="{ 'memory-panel--expanded': expanded }" data-testid="memory-panel">
    <header class="memory-panel__header">
      <div>
        <h2 class="text-h6 q-my-sm">{{ t('memory.panel.title') }}</h2>
        <span v-if="archived || purged" class="text-caption">{{ archived ? t('memory.panel.archived') : '' }} {{ purged ? t('memory.panel.purged') : '' }}</span>
      </div>
      <button type="button" class="memory-panel__expand" :data-testid="expanded ? 'memory-collapse' : 'memory-expand'" :aria-label="t(expanded ? 'memory.panel.closeDialog' : 'memory.panel.openDialog')" :title="t(expanded ? 'memory.panel.closeDialog' : 'memory.panel.openDialog')" @click="expanded = !expanded">
        <svg aria-hidden="true" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
          <path v-if="expanded" d="m6 6 12 12M6 18 18 6" />
          <path v-else d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5M3 3l6 6m12-6-6 6M3 21l6-6m12 6-6-6" />
        </svg>
      </button>
    </header>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-if="memory.loadingWorkspaceKeys[JSON.stringify([workspaceId, sessionId ?? ''])]">{{ t('memory.panel.loading') }}</p>
    <template v-if="view">
      <section class="memory-section" aria-labelledby="memory-context-title">
        <div class="memory-section__heading"><span v-if="expanded" class="memory-section__number" aria-hidden="true">01</span><div><h3 id="memory-context-title">{{ t('memory.panel.contexts') }}</h3><p v-if="expanded" class="memory-section__description">{{ t('memory.panel.contextsHint') }}</p></div></div>
        <p v-if="view.contexts.length === 0">{{ t('memory.panel.noContext') }}</p>
        <div class="memory-context-grid">
        <article v-for="context in view.contexts" :key="context.id" class="memory-context q-pa-sm q-mb-sm">
          <h4>{{ t(`memory.engine.${context.engine}`) }} · {{ t(`memory.context.state.${context.state}`) }}</h4>
          <p>{{ t('memory.panel.contextStats', { tokens: context.estimatedTokens, cumulative: context.cumulativeEstimatedTokens, remaining: context.remainingEstimatedTokens, omitted: context.omittedCount }) }}</p>
          <p class="memory-context__meta">{{ context.sessionId }} · {{ context.createdAt }}</p>
          <ul v-if="context.entryStates.length">
            <li v-for="item in context.entryStates" :key="`${item.id}:${item.revision}`">
              <template v-if="item.state === 'current'">{{ item.title }} — {{ item.body }}<span v-if="item.bodyTruncated"> {{ t('memory.panel.truncated') }}</span></template>
              <template v-else>{{ item.state === 'changed' ? t('memory.panel.changed') : t('memory.panel.deleted') }} · {{ item.id }} ({{ item.revision }})</template>
            </li>
          </ul>
        </article>
        </div>
      </section>
      <section class="memory-section" aria-labelledby="memory-entries-title">
        <div class="memory-section__heading memory-section__heading--actions"><span v-if="expanded" class="memory-section__number" aria-hidden="true">02</span><div><h3 id="memory-entries-title">{{ t('memory.panel.entries') }}</h3><p v-if="expanded" class="memory-section__description">{{ t('memory.panel.entriesHint') }}</p></div><button type="button" class="memory-add" :disabled="busy" @click="startCreate">{{ t('memory.panel.add') }}</button></div>
        <MemoryEntryEditor v-if="editorOpen" :scope-id="editing?.scopeId ?? workspaceScope?.id ?? ''" :entry="editing" :saving="busy" :conflict="editorConflict" :error="error" @save="save" @reload="handleReload" @rebase="handleRebase" @cancel="editorOpen = false; editorConflict = false" />
        <MemoryEntryList :entries="entries" :disabled="busy" @edit="startEdit" @delete="deleting = $event" @promote="promotion = $event; targetScopeId = ''" />
        <button v-if="view.entriesNextCursor" type="button" :disabled="memory.loadingWorkspaceKeys[JSON.stringify([workspaceId, sessionId ?? ''])]" @click="memory.loadMoreWorkspaceEntries(workspaceId, sessionId).catch((cause: Error) => error = cause.message)">{{ t('memory.entry.loadMore') }}</button>
      </section>
      <section class="memory-section" aria-labelledby="memory-proposals-title"><div class="memory-section__heading"><span v-if="expanded" class="memory-section__number" aria-hidden="true">03</span><div><h3 id="memory-proposals-title">{{ t('memory.panel.proposals') }} <span class="memory-section__count">{{ proposals.length }}</span></h3><p v-if="expanded" class="memory-section__description">{{ t('memory.panel.proposalsHint') }}</p></div></div><MemoryProposalList :proposals="proposals" :busy-proposal-id="busyProposalId" @decision="decide" /></section>
      <section class="memory-section" aria-labelledby="memory-operations-title">
        <div class="memory-section__heading"><span v-if="expanded" class="memory-section__number" aria-hidden="true">04</span><div><h3 id="memory-operations-title">{{ t('memory.panel.operations') }}</h3><p v-if="expanded" class="memory-section__description">{{ t('memory.panel.operationsHint') }}</p></div></div>
        <MemoryOperationsList :operations="operations" :has-more="Boolean(operationCursor)" :loading="memory.loadingWorkspaceOperations[workspaceId]" @load-more="memory.loadWorkspaceOperations(workspaceId, true)" />
      </section>
      <footer class="column q-gutter-sm">
        <button data-testid="memory-clear-workspace" type="button" :disabled="!workspaceScope || busy" @click="previewWorkspaceClear">{{ t('memory.panel.clearWorkspace') }}</button>
      </footer>
    </template>
    <RouterLink class="memory-settings-link" data-tour="ws-memory-settings" data-testid="memory-settings-link" :to="{ name: 'settings', query: { tab: 'memory' } }">
      <span>{{ t('memory.panel.settingsLink') }}</span>
      <svg aria-hidden="true" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14m-6-6 6 6-6 6" /></svg>
    </RouterLink>
    <div v-if="deleting" role="dialog" aria-modal="true" :aria-label="t('memory.settings.deleteConfirmTitle')">
      <p>{{ t('memory.settings.deleteConfirm', { title: deleting.title, scope: t(`memory.scope.${scopes.find((scope) => scope.id === deleting?.scopeId)?.level ?? 'workspace'}`) }) }}</p>
      <button type="button" :disabled="busy" @click="confirmDelete">{{ t('memory.settings.deleteConfirmAction') }}</button><button type="button" :disabled="busy" @click="deleting = null">{{ t('memory.editor.cancel') }}</button>
    </div>
    <div v-if="clearing" role="dialog" aria-modal="true"><p>{{ t('memory.panel.clearConfirm', { entries: clearPreview?.entries ?? 0, proposals: clearPreview?.proposals ?? 0 }) }}</p><button type="button" :disabled="busy" @click="confirmClear">{{ t('memory.panel.confirmClear') }}</button><button type="button" :disabled="busy" @click="clearing = false">{{ t('memory.editor.cancel') }}</button></div>
    <div v-if="promotion" role="dialog" aria-modal="true"><label>{{ t('memory.panel.promoteTo') }}<select v-model="targetScopeId" :disabled="busy"><option value="">{{ t('memory.scope.choose') }}</option><option v-for="scope in scopes.filter((candidate) => candidate.id !== promotion?.scopeId)" :key="scope.id" :value="scope.id">{{ t(`memory.scope.${scope.level}`) }}</option></select></label><button type="button" :disabled="!targetScopeId || busy" @click="promote(promotion)">{{ t('memory.entry.promote') }}</button><button type="button" :disabled="busy" @click="promotion = null">{{ t('memory.editor.cancel') }}</button></div>
  </section>
  </Teleport>
</template>

<style scoped>
.memory-panel { display: grid; gap: var(--kobo-space-md); }
.memory-panel__header { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--kobo-space-sm); }
.memory-panel__expand { display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto; }
.memory-dialog { width: 900px; max-width: calc(100vw - 32px); max-height: 85vh; overflow-y: auto; background: var(--kobo-surface); color: var(--kobo-text); border: 1px solid var(--kobo-border-subtle); border-radius: var(--kobo-radius-md); }
.memory-panel h2, .memory-panel h3, .memory-panel h4 { margin: 0 0 var(--kobo-space-sm); }
.memory-panel h3 { font-size: 1rem; line-height: 1.5; font-weight: 600; }
.memory-panel h4 { font-size: 0.875rem; line-height: 1.5; font-weight: 600; }
.memory-panel :deep(button), .memory-panel select { min-height: 32px; padding: 4px var(--kobo-space-sm); color: var(--kobo-text); background: var(--kobo-surface); border: 1px solid var(--kobo-border-subtle); border-radius: var(--kobo-radius-sm); font: inherit; cursor: pointer; }
.memory-panel :deep(button:disabled) { opacity: 0.5; cursor: default; }
.memory-panel :deep(button:focus-visible), .memory-panel select:focus-visible { outline: 2px solid var(--kobo-accent); outline-offset: 2px; }
.memory-panel [role="dialog"] { padding: var(--kobo-space-md); border: 1px solid var(--kobo-border-subtle); border-radius: var(--kobo-radius-md); background: var(--kobo-surface); }
.memory-panel [role="dialog"] button { margin: var(--kobo-space-xs); }
.memory-panel select { max-width: 100%; }
.memory-settings-link, .memory-settings-link:visited { display: flex; align-items: center; justify-content: space-between; gap: var(--kobo-space-md); padding: var(--kobo-space-md); color: var(--kobo-text); background: var(--kobo-surface); border: 1px solid var(--kobo-border-subtle); border-radius: var(--kobo-radius-md); text-decoration: none; font-size: 0.875rem; line-height: 1.5; transition: border-color var(--kobo-duration-short), background var(--kobo-duration-short); }
.memory-settings-link svg { flex: 0 0 auto; color: var(--kobo-accent); }
.memory-settings-link:hover { border-color: var(--kobo-accent); background: var(--kobo-surface-2); }
.memory-settings-link:hover span { text-decoration: underline; text-underline-offset: 3px; }
.memory-settings-link:focus-visible { outline: 2px solid var(--kobo-accent); outline-offset: 3px; }
.memory-context { overflow-wrap: anywhere; border: 1px solid var(--kobo-border-subtle); border-radius: var(--kobo-radius-sm); }
.memory-context p { overflow-wrap: anywhere; }
.memory-section { min-width: 0; }
.memory-section__heading { display: flex; align-items: flex-start; gap: var(--kobo-space-md); margin-bottom: var(--kobo-space-lg); }
.memory-section__heading > div { flex: 1; min-width: 0; }
.memory-section__heading--actions { flex-wrap: wrap; align-items: center; }
.memory-section__heading h3 { margin: 0; text-wrap: balance; }
.memory-section__description { margin: var(--kobo-space-xs) 0 0; color: var(--kobo-text-2); font-size: 0.8125rem; line-height: 1.5; text-wrap: pretty; }
.memory-section__number { display: grid; place-items: center; flex: 0 0 32px; height: 32px; border-radius: var(--kobo-radius-sm); color: var(--kobo-accent); background: color-mix(in srgb, var(--kobo-accent) 12%, transparent); font-size: 0.75rem; font-weight: 700; font-variant-numeric: tabular-nums; }
.memory-section__count { display: inline-block; min-width: 24px; padding: 0 6px; margin-inline-start: 4px; border-radius: 12px; background: var(--kobo-surface-2); color: var(--kobo-text-2); font-size: 0.75rem; text-align: center; font-variant-numeric: tabular-nums; }
.memory-context__meta { color: var(--kobo-text-2); font-size: 0.75rem; }
.memory-panel--expanded { padding: 0 var(--kobo-space-2xl) var(--kobo-space-2xl); gap: var(--kobo-space-xl); background: var(--kobo-surface-2); }
.memory-panel--expanded .memory-panel__header { position: sticky; top: 0; z-index: 2; align-items: center; margin-inline: calc(-1 * var(--kobo-space-2xl)); padding: var(--kobo-space-lg) var(--kobo-space-2xl); background: var(--kobo-surface-2); border-bottom: 1px solid var(--kobo-border-subtle); }
.memory-panel--expanded .memory-panel__header h2 { margin: 0; font-size: 1.25rem; font-weight: 600; }
.memory-panel--expanded .memory-section { padding: var(--kobo-space-xl); background: var(--kobo-surface); border: 1px solid var(--kobo-border-subtle); border-radius: var(--kobo-radius-md); }
.memory-panel--expanded .memory-context-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--kobo-space-md); }
.memory-panel--expanded .memory-context { margin: 0; padding: var(--kobo-space-lg); background: var(--kobo-surface-2); font-variant-numeric: tabular-nums; }
.memory-panel--expanded .memory-context p:last-child { margin-bottom: 0; }
.memory-panel--expanded :deep(button) { min-height: 40px; }
.memory-panel--expanded .memory-add { border-color: var(--kobo-accent); color: var(--kobo-accent); }
.memory-panel--expanded :deep(.memory-operations-list ol) { padding: 0; gap: 0; }
.memory-panel--expanded :deep(.memory-operations-list li) { padding: var(--kobo-space-md) 0; border-bottom: 1px solid var(--kobo-border-subtle); }
.memory-panel--expanded :deep(.memory-operations-list li:last-child) { border-bottom: 0; }
.memory-panel--expanded :deep(.memory-operations-list time) { margin-inline-start: auto; font-size: 0.75rem; font-variant-numeric: tabular-nums; }
@media (max-width: 700px) {
  .memory-panel--expanded { padding-inline: var(--kobo-space-md); }
  .memory-panel--expanded .memory-panel__header { margin-inline: calc(-1 * var(--kobo-space-md)); padding-inline: var(--kobo-space-md); }
  .memory-panel--expanded .memory-context-grid { grid-template-columns: 1fr; }
  .memory-panel--expanded .memory-section { padding: var(--kobo-space-md); }
}
</style>
