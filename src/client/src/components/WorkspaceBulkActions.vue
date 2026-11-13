<template>
  <div v-if="workspaces.length || busy" class="q-pa-sm column q-gutter-xs" role="region" :aria-label="t('bulk.actions')">
    <div class="row items-center">
      <span class="col text-caption" aria-live="polite">{{ busy ? progress : t('bulk.selected', { count: workspaces.length }) }}</span>
      <q-btn flat round dense size="sm" icon="close" :disable="busy" :aria-label="t('bulk.clear')" @click="emit('clear')" />
    </div>
    <q-btn outline dense no-caps color="kobo-2" :label="t('bulk.actions')" :loading="busy" :disable="busy || !workspaces.length">
      <q-menu>
        <q-list dense>
          <q-item v-for="action in actions" :key="action.id" clickable v-close-popup @click="choose(action.id)">
            <q-item-section avatar><q-icon :name="action.icon" :color="action.id === 'delete' ? 'negative' : undefined" /></q-item-section>
            <q-item-section>{{ t(action.label) }}</q-item-section>
          </q-item>
        </q-list>
      </q-menu>
    </q-btn>
    <StartReviewDialog
      v-model="reviewOpen"
      :loading="busy"
      :workspace="reviewTargets[0] ?? null"
      :parallel="reviewParallel"
      :can-return-to-session="false"
      @submit="startReviews"
    >
      <template #context>
        <div class="text-caption text-kobo-3 q-mt-sm">{{ t('bulk.selected', { count: reviewTargets.length }) }}</div>
        <ul class="q-pl-md q-my-xs" style="max-height: 120px; overflow: auto;">
          <li v-for="workspace in reviewTargets" :key="workspace.id">{{ workspace.name }}</li>
        </ul>
      </template>
    </StartReviewDialog>
  </div>
</template>

<script setup lang="ts">
import { useQuasar } from 'quasar'
import StartReviewDialog from 'src/components/StartReviewDialog.vue'
import { useParallelReviewStore } from 'src/stores/parallel-review'
import { useWebSocketStore } from 'src/stores/websocket'
import { useWorkspaceStore, type Workspace } from 'src/stores/workspace'
import { apiFetchOk } from 'src/utils/api'
import { exportWorkspaceEvents } from 'src/utils/export-workspace-events'
import { isBusyStatus } from 'src/utils/workspace-status'
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import type { StartReviewRequest } from '../../../shared/review'

const props = defineProps<{ workspaces: Workspace[] }>()
const emit = defineEmits<{ clear: []; completed: [ids: string[]] }>()
const { t } = useI18n()
const $q = useQuasar()
const store = useWorkspaceStore()
const websocket = useWebSocketStore()
const router = useRouter()
const busy = ref(false)
const progress = ref('')
const reviewOpen = ref(false)
const reviewTargets = ref<Workspace[]>([])
const parallelReviews = useParallelReviewStore()
const reviewParallel = computed(() =>
  reviewTargets.value.some(
    (ws) =>
      !!store.activeAgentSessionIds[ws.id] ||
      !!store.agentLiveness[ws.id] ||
      isBusyStatus(store.workspaces.find((item) => item.id === ws.id)?.status),
  ),
)
async function startReviews(payload: StartReviewRequest) {
  if (busy.value || !reviewOpen.value) return
  try {
    await run('review', reviewTargets.value, { ...payload })
  } finally {
    reviewOpen.value = false
  }
}
const actions = [
  { id: 'archive', label: 'common.archive', icon: 'archive' },
  { id: 'purge', label: 'contextMenu.purgeWorktree', icon: 'cleaning_services' },
  { id: 'delete', label: 'common.delete', icon: 'delete' },
  { id: 'export', label: 'contextMenu.exportEvents', icon: 'download' },
  { id: 'setup', label: 'tools.runSetupScript', icon: 'restart_alt' },
  { id: 'fetch', label: 'bulk.fetch', icon: 'sync' },
  { id: 'pull', label: 'bulk.pull', icon: 'download' },
  { id: 'merge', label: 'bulk.merge', icon: 'merge' },
  { id: 'rebase', label: 'bulk.rebase', icon: 'rebase_edit' },
  { id: 'review', label: 'review.title', icon: 'rate_review' },
] as const
type Action = (typeof actions)[number]['id']

function choose(action: Action) {
  if (busy.value) return
  const targets = props.workspaces.map((ws) => ({ ...ws }))
  if (!targets.length) return
  if (action === 'review') {
    reviewTargets.value = targets
    reviewOpen.value = true
    return
  }
  if (['delete', 'purge', 'setup', 'merge', 'rebase'].includes(action)) {
    const branches = targets.map((ws) => ws.workingBranch).join('\n')
    $q.dialog({
      title: t(actions.find((item) => item.id === action)!.label),
      message: [
        t(action === 'delete' ? 'bulk.deleteWarning' : 'bulk.confirm'),
        action === 'purge'
          ? t('contextMenu.purgeWorktreeDialogMessage', { name: targets.map((ws) => ws.name).join(', ') })
          : '',
        action === 'setup' ? t('tools.runSetupScriptConfirm') : '',
        ...targets.map((ws) => `${ws.name} — ${ws.workingBranch} ← ${ws.sourceBranch}`),
        action === 'delete' ? `\n${branches}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
      style: { whiteSpace: 'pre-line' },
      dark: true,
      persistent: true,
      cancel: true,
      ...(action === 'delete'
        ? {
            prompt: {
              model: '',
              type: 'textarea',
              label: t('bulk.branches'),
              isValid: (value: string) => value.trim() === branches,
            },
          }
        : {}),
    }).onOk(() => void run(action, targets))
  } else void run(action, targets)
}

async function run(action: Action, targets: Workspace[], review?: StartReviewRequest) {
  if (busy.value) return
  busy.value = true
  const completed: string[] = []
  const errors: string[] = []
  const warnings: string[] = []
  try {
    for (const [index, ws] of targets.entries()) {
      progress.value = `${index + 1}/${targets.length} · ${ws.name}`
      try {
        const current = [...store.workspaces, ...store.archived].find((item) => item.id === ws.id)
        if (!current || current.workingBranch !== ws.workingBranch || current.sourceBranch !== ws.sourceBranch)
          throw new Error(t('bulk.changed'))
        if (action === 'archive') await store.archiveWorkspace(ws.id)
        else if (action === 'delete') {
          const result = await store.deleteWorkspace(ws.id, {
            confirmationBranch: ws.workingBranch,
            expectedArchivedAt: ws.archivedAt ?? null,
            expectedSprintId: ws.sprintId ?? null,
          })
          warnings.push(...result.warnings.map((message) => `${ws.name}: ${message}`))
          websocket.unsubscribe(ws.id)
        } else if (action === 'purge') {
          const result = await store.purgeWorktree(ws.id)
          if (!result.ok) throw new Error(result.error)
          warnings.push(...result.warnings.map((message) => `${ws.name}: ${message}`))
        } else if (action === 'export') await exportWorkspaceEvents(ws)
        else if (action === 'review') {
          await apiFetchOk(`/api/workspaces/${ws.id}/start-review`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(review),
          })
          void parallelReviews.fetchStatus(ws.id).catch(() => undefined)
        } else {
          if (action === 'setup' && isBusyStatus(current.status)) throw new Error(t('tools.runSetupScriptBusy'))
          await apiFetchOk(`/api/workspaces/${ws.id}/${action === 'setup' ? 'run-setup-script' : action}`, {
            method: 'POST',
          })
          if (action !== 'setup') void store.fetchGitStats(ws.id).catch(() => undefined)
        }
        completed.push(ws.id)
      } catch (error) {
        errors.push(`${ws.name}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    emit('completed', completed)
    if (
      ['archive', 'delete', 'purge'].includes(action) &&
      !store.selectedWorkspaceId &&
      router.currentRoute.value.name === 'workspace'
    ) {
      await router.push({ name: 'workspace', query: router.currentRoute.value.query })
    }
    $q.notify({
      type: errors.length ? 'warning' : 'positive',
      message: t('bulk.result', { done: completed.length, total: targets.length }),
      position: 'top',
    })
    if (errors.length || warnings.length)
      $q.dialog({
        title: t('bulk.result', { done: completed.length, total: targets.length }),
        message: [...errors, ...warnings].join('\n'),
        style: { whiteSpace: 'pre-line' },
        dark: true,
      })
  } finally {
    busy.value = false
  }
}
</script>
