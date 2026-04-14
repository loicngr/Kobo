<script setup lang="ts">
import { useQuasar } from 'quasar'
import { defineAsyncComponent } from 'vue'
import { useI18n } from 'vue-i18n'

const DiffViewer = defineAsyncComponent(() => import('./DiffViewer.vue'))

import type { GitStats, Workspace } from 'src/stores/workspace'
import { useWorkspaceStore, WorkspaceActionError } from 'src/stores/workspace'
import { computed, onUnmounted, ref, watch } from 'vue'

const props = defineProps<{
  workspace: Workspace | null
}>()

const { t } = useI18n()
const $q = useQuasar()
const store = useWorkspaceStore()

const pushing = ref(false)
const pulling = ref(false)
const rebasing = ref(false)
const openingPr = ref(false)
const changingBase = ref(false)
const showDiff = ref(false)

function onSendToChat(text: string) {
  store.chatDraft = text
  showDiff.value = false
}
const gitStats = ref<GitStats | null>(null)
const loadingStats = ref(false)

const repoName = computed(() => {
  if (!props.workspace?.projectPath) return '-'
  const parts = props.workspace.projectPath.replace(/\\/g, '/').split('/')
  return parts[parts.length - 1] || parts[parts.length - 2] || '-'
})

// Gate the "Create PR" button: the branch must exist on the remote, otherwise
// `gh pr create` fails downstream. Once it's pushed, let the user open a PR
// even if the commit count is zero — the server will surface a clear error.
const canOpenPr = computed(() => {
  if (!gitStats.value) return false
  if (gitStats.value.unpushedCount === -1) return false
  return true
})

const createPrDisabledReason = computed(() => {
  if (!gitStats.value) return ''
  if (gitStats.value.unpushedCount === -1) return t('git.createPrNoRemote')
  return ''
})

async function loadGitStats() {
  if (!props.workspace) {
    gitStats.value = null
    return
  }
  loadingStats.value = true
  try {
    gitStats.value = await store.fetchGitStats(props.workspace.id)
  } catch {
    gitStats.value = null
  } finally {
    loadingStats.value = false
  }
}

watch(
  () => props.workspace?.id,
  () => loadGitStats(),
  { immediate: true },
)

// Refresh when agent runs git commands (debounced)
let gitRefreshTimeout: ReturnType<typeof setTimeout> | null = null
watch(
  () => store.gitRefreshTrigger,
  () => {
    if (gitRefreshTimeout) clearTimeout(gitRefreshTimeout)
    gitRefreshTimeout = setTimeout(() => loadGitStats(), 3000)
  },
)

onUnmounted(() => {
  if (gitRefreshTimeout) clearTimeout(gitRefreshTimeout)
})

function handleRebase() {
  if (!props.workspace) return
  $q.dialog({
    title: t('git.rebaseConfirmTitle'),
    message: t('git.rebaseConfirmMessage', { branch: props.workspace.sourceBranch }),
    dark: true,
    cancel: { flat: true, label: t('common.cancel'), color: 'grey-5' },
    ok: { flat: true, label: t('git.rebase'), color: 'orange-4' },
  }).onOk(async () => {
    rebasing.value = true
    try {
      const res = await fetch(`/api/workspaces/${props.workspace!.id}/rebase`, { method: 'POST' })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error ?? 'Rebase failed')
      }
      $q.notify({ type: 'positive', message: t('git.rebaseSuccess'), position: 'top' })
      loadGitStats()
    } catch (e) {
      const msg = e instanceof Error ? e.message : t('git.rebaseFailed')
      $q.notify({ type: 'negative', message: msg, position: 'top', timeout: 6000 })
    } finally {
      rebasing.value = false
    }
  })
}

function handlePush() {
  if (!props.workspace) return
  $q.dialog({
    title: t('git.pushConfirmTitle'),
    message: t('git.pushConfirmMessage', { branch: props.workspace.workingBranch }),
    dark: true,
    cancel: { flat: true, label: t('common.cancel'), color: 'grey-5' },
    ok: { flat: true, label: t('git.push'), color: 'grey-5' },
  }).onOk(async () => {
    pushing.value = true
    try {
      await store.pushBranch(props.workspace!.id)
      $q.notify({ type: 'positive', message: t('git.branchPushed'), position: 'top' })
      loadGitStats()
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Push failed'
      $q.notify({ type: 'negative', message: msg, position: 'top', timeout: 6000 })
    } finally {
      pushing.value = false
    }
  })
}

function handlePull() {
  if (!props.workspace) return
  $q.dialog({
    title: t('git.pullConfirmTitle'),
    message: t('git.pullConfirmMessage', { branch: props.workspace.workingBranch }),
    dark: true,
    cancel: { flat: true, label: t('common.cancel'), color: 'grey-5' },
    ok: { flat: true, label: t('git.pull'), color: 'grey-5' },
  }).onOk(async () => {
    pulling.value = true
    try {
      await store.pullBranch(props.workspace!.id)
      $q.notify({ type: 'positive', message: t('git.branchPulled'), position: 'top' })
      loadGitStats()
    } catch (e) {
      console.error('[GitPanel] pullBranch failed:', e)
      const msg = e instanceof Error ? e.message : t('git.pullFailed')
      $q.notify({ type: 'negative', message: msg, position: 'top', timeout: 6000 })
    } finally {
      pulling.value = false
    }
  })
}

function viewPr() {
  if (gitStats.value?.prUrl) {
    window.open(gitStats.value.prUrl, '_blank')
  }
}

function handleChangePrBase() {
  if (!props.workspace) return
  $q.dialog({
    title: t('git.changePrBaseTitle'),
    message: t('git.changePrBaseMessage'),
    prompt: {
      model: props.workspace.sourceBranch,
      type: 'text',
    },
    dark: true,
    cancel: { flat: true, label: t('common.cancel'), color: 'grey-5' },
    ok: { flat: true, label: t('common.save'), color: 'primary' },
  }).onOk(async (newBase: string) => {
    if (!newBase.trim() || !props.workspace) return
    changingBase.value = true
    try {
      const res = await fetch(`/api/workspaces/${props.workspace.id}/change-pr-base`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base: newBase.trim() }),
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error ?? 'Failed')
      }
      $q.notify({ type: 'positive', message: t('git.changePrBaseSuccess'), position: 'top' })
      loadGitStats()
    } catch (e) {
      const msg = e instanceof Error ? e.message : t('git.changePrBaseFailed')
      $q.notify({ type: 'negative', message: msg, position: 'top', timeout: 6000 })
    } finally {
      changingBase.value = false
    }
  })
}

async function handleOpenPr() {
  if (!props.workspace) return
  openingPr.value = true
  try {
    const result = await store.openPullRequest(props.workspace.id)
    $q.notify({
      type: 'positive',
      message: t('git.prCreated', { n: result.prNumber }),
      caption: result.prUrl,
      position: 'top',
      timeout: 5000,
    })
    loadGitStats()
  } catch (e) {
    if (e instanceof WorkspaceActionError && e.code === 'branch_not_pushed') {
      $q.notify({
        type: 'warning',
        message: t('git.pushFirst'),
        position: 'top',
        timeout: 6000,
      })
      return
    }
    if (e instanceof WorkspaceActionError && e.code === 'unpushed_commits') {
      $q.notify({
        type: 'warning',
        message: t('git.unpushedCommits'),
        position: 'top',
        timeout: 6000,
      })
      return
    }
    const msg = e instanceof Error ? e.message : 'Open PR failed'
    $q.notify({ type: 'negative', message: msg, position: 'top', timeout: 6000 })
  } finally {
    openingPr.value = false
  }
}
</script>

<template>
  <div class="git-panel q-pa-md">
    <div class="row items-center justify-between q-mb-sm">
      <div class="text-caption text-uppercase text-weight-bold text-grey-6" style="letter-spacing: 0.05em;">
        {{ $t('git.title') }}
      </div>
      <q-btn
        v-if="workspace"
        flat
        round
        dense
        size="xs"
        icon="refresh"
        color="grey-6"
        :loading="loadingStats"
        @click="loadGitStats"
      >
        <q-tooltip>{{ $t('tooltip.refreshGitStats') }}</q-tooltip>
      </q-btn>
    </div>

    <template v-if="workspace">
      <!-- Repo name -->
      <div class="row items-center q-mb-sm">
        <q-icon name="folder" size="14px" color="grey-6" class="q-mr-xs" />
        <span class="text-caption text-grey-3">{{ repoName }}</span>
      </div>

      <!-- Branch -->
      <div class="row items-center q-mb-sm">
        <span
          style="width: 8px; height: 8px; border-radius: 50%; background-color: #4ade80; display: inline-block;"
          class="q-mr-xs"
        />
        <span class="text-caption text-grey-4" style="font-family: 'Roboto Mono', monospace; font-size: 11px;">
          {{ workspace.workingBranch }}
        </span>
      </div>

      <!-- Source branch info -->
      <div class="text-caption q-mb-sm text-grey-8" style="font-size: 11px;">
        {{ $t('git.from') }} {{ workspace.sourceBranch }}
        <template v-if="gitStats">
          &middot;
          <span v-if="gitStats.unpushedCount === -1">{{ $t('git.localOnly') }}</span>
          <span v-else-if="gitStats.unpushedCount === 0" style="color: #4ade80;">{{ $t('git.pushed') }}</span>
          <span v-else style="color: #f59e0b;">{{ $t('git.unpushed', { count: gitStats.unpushedCount }) }}</span>
        </template>
      </div>

      <!-- Git stats -->
      <template v-if="gitStats">
        <!-- Commit count -->
        <div class="row items-center q-mb-xs">
          <q-icon name="commit" size="14px" color="grey-6" class="q-mr-xs" />
          <span class="text-caption text-grey-4" style="font-size: 11px;">
            {{ $t('git.commits', { count: gitStats.commitCount }, gitStats.commitCount) }}
          </span>
        </div>

        <!-- File changes -->
        <div v-if="gitStats.filesChanged > 0" class="row items-center q-mb-md">
          <q-icon name="insert_drive_file" size="14px" color="grey-6" class="q-mr-xs" />
          <span class="text-caption text-grey-4" style="font-size: 11px;">
            {{ $t('git.files', { count: gitStats.filesChanged }, gitStats.filesChanged) }}
          </span>
          <span v-if="gitStats.insertions > 0" class="text-caption q-ml-xs" style="font-size: 11px; color: #4ade80;">
            +{{ gitStats.insertions }}
          </span>
          <span v-if="gitStats.deletions > 0" class="text-caption q-ml-xs" style="font-size: 11px; color: #f87171;">
            -{{ gitStats.deletions }}
          </span>
        </div>
        <div v-else class="q-mb-xs" />

        <!-- Working tree -->
        <div
          v-if="gitStats.workingTree && (gitStats.workingTree.staged > 0 || gitStats.workingTree.modified > 0 || gitStats.workingTree.untracked > 0)"
          class="row items-center q-gutter-xs q-mb-md"
          style="font-size: 11px;"
        >
          <q-icon name="edit_note" size="14px" color="grey-6" />
          <span v-if="gitStats.workingTree.staged > 0" class="text-caption" style="color: #4ade80;">
            {{ $t('git.staged', { count: gitStats.workingTree.staged }) }}
          </span>
          <span v-if="gitStats.workingTree.modified > 0" class="text-caption" style="color: #f59e0b;">
            {{ $t('git.modified', { count: gitStats.workingTree.modified }) }}
          </span>
          <span v-if="gitStats.workingTree.untracked > 0" class="text-caption text-grey-6">
            {{ $t('git.untracked', { count: gitStats.workingTree.untracked }) }}
          </span>
        </div>
        <div v-else class="q-mb-md" />
      </template>

      <!-- Actions -->
      <div class="row q-gutter-xs">
        <q-btn
          v-if="gitStats?.prUrl"
          dense
          no-caps
          size="sm"
          outline
          color="green-4"
          :label="$t('git.viewPr')"
          icon="open_in_new"
          class="git-btn"
          @click="viewPr"
        />
        <q-btn
          v-if="gitStats?.prUrl && gitStats.prState === 'OPEN'"
          dense
          no-caps
          size="sm"
          outline
          color="grey-5"
          icon="swap_horiz"
          :loading="changingBase"
          class="git-btn"
          @click="handleChangePrBase"
        >
          <q-tooltip>{{ $t('git.changePrBase') }}</q-tooltip>
        </q-btn>
        <q-btn
          v-if="!gitStats?.prUrl || gitStats.prState === 'CLOSED' || gitStats.prState === 'MERGED'"
          dense
          no-caps
          size="sm"
          color="primary"
          :label="$t('git.createPr')"
          class="git-btn"
          :loading="openingPr"
          :disable="!workspace || pushing || !canOpenPr"
          @click="handleOpenPr"
        >
          <q-tooltip v-if="!canOpenPr && createPrDisabledReason">{{ createPrDisabledReason }}</q-tooltip>
        </q-btn>
        <q-btn
          v-if="!gitStats || gitStats.unpushedCount !== 0"
          dense
          no-caps
          size="sm"
          outline
          color="grey-5"
          :label="$t('git.push')"
          class="git-btn"
          :loading="pushing"
          :disable="!workspace || openingPr || pulling || rebasing"
          @click="handlePush"
        />
        <q-btn
          v-if="gitStats && gitStats.unpushedCount !== -1"
          dense
          no-caps
          size="sm"
          outline
          color="grey-5"
          icon="download"
          :label="$t('git.pull')"
          class="git-btn"
          :loading="pulling"
          :disable="!workspace || pushing || rebasing"
          @click="handlePull"
        />
        <q-btn
          dense
          no-caps
          size="sm"
          outline
          color="orange-4"
          :label="$t('git.rebase')"
          class="git-btn"
          :loading="rebasing"
          :disable="!workspace || pushing || pulling"
          @click="handleRebase"
        />
        <q-btn
          dense
          no-caps
          size="sm"
          outline
          color="indigo-4"
          :label="$t('git.diff')"
          icon="difference"
          class="git-btn"
          :disable="!workspace"
          @click="showDiff = true"
        />
      </div>
    </template>

    <div v-else class="text-caption text-grey-8">
      {{ $t('common.selectWorkspace') }}
    </div>

    <!-- Diff viewer dialog (fullscreen) -->
    <q-dialog v-model="showDiff" maximized>
      <DiffViewer
        v-if="workspace"
        :workspace-id="workspace.id"
        @close="showDiff = false"
        @send-to-chat="onSendToChat"
      />
    </q-dialog>
  </div>
</template>

<style lang="scss" scoped>
.git-btn {
  font-size: 11px;
  padding: 2px 10px;
}
</style>
