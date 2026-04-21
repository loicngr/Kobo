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
const merging = ref(false)
const openingPr = ref(false)
const changingBase = ref(false)
const showDiff = ref(false)

// Commit list expand state + cache per workspace
interface BranchCommit {
  sha: string
  shortSha: string
  subject: string
  author: string
  date: string
  isPushed: boolean
}
const showCommits = ref(false)
const loadingCommits = ref(false)
const commits = ref<BranchCommit[]>([])

async function fetchCommits() {
  if (!props.workspace) return
  loadingCommits.value = true
  try {
    const res = await fetch(`/api/workspaces/${props.workspace.id}/commits?limit=50`, {
      cache: 'no-store',
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const body = (await res.json()) as { commits: BranchCommit[] }
    commits.value = body.commits
  } catch (err) {
    console.error('[GitPanel] fetchCommits failed:', err)
    commits.value = []
  } finally {
    loadingCommits.value = false
  }
}

async function toggleCommits() {
  showCommits.value = !showCommits.value
  if (!showCommits.value) return
  // Flip the loader on synchronously — fetchCommits() is async, so without
  // this the header loader + expanded list would both flicker the empty
  // state for one tick before the network round-trip sets loadingCommits.
  loadingCommits.value = true
  // Fetch on every expand (cheap, git state may have changed since last time).
  await fetchCommits()
}

function appendCommitToChat(sha: string) {
  // Reuse the existing `chatDraft` mechanism — ChatInput.vue watches it and
  // appends to the textarea (preserving existing content). Reset happens there.
  store.chatDraft = sha
}

function formatCommitDate(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

// Conflict state for the shared merge/rebase resolution dialog
const conflictDialog = ref(false)
const conflictOperation = ref<'merge' | 'rebase' | null>(null)
const conflictFiles = ref<string[]>([])
const conflictAborting = ref(false)
const conflictResolving = ref(false)

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
      if (res.status === 409) {
        const data = await res.json()
        openConflictDialog('rebase', Array.isArray(data.files) ? data.files : [])
        return
      }
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

function handleMerge() {
  if (!props.workspace) return
  $q.dialog({
    title: t('git.mergeConfirmTitle'),
    message: t('git.mergeConfirmMessage', { branch: props.workspace.sourceBranch }),
    dark: true,
    cancel: { flat: true, label: t('common.cancel'), color: 'grey-5' },
    ok: { flat: true, label: t('git.merge'), color: 'purple-4' },
  }).onOk(async () => {
    merging.value = true
    try {
      const res = await fetch(`/api/workspaces/${props.workspace!.id}/merge`, { method: 'POST' })
      if (res.status === 409) {
        const data = await res.json()
        openConflictDialog('merge', Array.isArray(data.files) ? data.files : [])
        return
      }
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error ?? 'Merge failed')
      }
      $q.notify({ type: 'positive', message: t('git.mergeSuccess'), position: 'top' })
      loadGitStats()
    } catch (e) {
      const msg = e instanceof Error ? e.message : t('git.mergeFailed')
      $q.notify({ type: 'negative', message: msg, position: 'top', timeout: 6000 })
    } finally {
      merging.value = false
    }
  })
}

function openConflictDialog(op: 'merge' | 'rebase', files: string[]) {
  conflictOperation.value = op
  conflictFiles.value = files
  conflictDialog.value = true
}

async function abortGitOperation() {
  if (!props.workspace) return
  conflictAborting.value = true
  try {
    const res = await fetch(`/api/workspaces/${props.workspace.id}/git/abort`, { method: 'POST' })
    if (!res.ok) {
      const data = await res.json()
      throw new Error(data.error ?? 'Abort failed')
    }
    $q.notify({ type: 'positive', message: t('git.conflictAborted'), position: 'top' })
    conflictDialog.value = false
    loadGitStats()
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Abort failed'
    $q.notify({ type: 'negative', message: msg, position: 'top', timeout: 6000 })
  } finally {
    conflictAborting.value = false
  }
}

async function resolveWithAgent() {
  if (!props.workspace || !conflictOperation.value) return
  conflictResolving.value = true
  try {
    const res = await fetch(`/api/workspaces/${props.workspace.id}/git/resolve-with-agent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operation: conflictOperation.value, files: conflictFiles.value }),
    })
    if (!res.ok) {
      const data = await res.json()
      throw new Error(data.error ?? 'Handoff failed')
    }
    $q.notify({ type: 'positive', message: t('git.conflictHandoffSuccess'), position: 'top' })
    conflictDialog.value = false
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Handoff failed'
    $q.notify({ type: 'negative', message: msg, position: 'top', timeout: 6000 })
  } finally {
    conflictResolving.value = false
  }
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
  <div class="git-panel q-px-sm q-py-md">
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
        <!-- Commit count (clickable to expand the commit list) -->
        <div
          v-if="gitStats.commitCount > 0"
          class="row items-center q-mb-xs commit-toggle cursor-pointer"
          @click="toggleCommits"
        >
          <q-icon name="commit" size="14px" color="grey-6" class="q-mr-xs" />
          <span class="text-caption text-grey-4" style="font-size: 11px;">
            {{ $t('git.commits', { count: gitStats.commitCount }, gitStats.commitCount) }}
          </span>
          <q-spinner
            v-if="loadingCommits"
            size="12px"
            color="indigo-4"
            class="q-ml-xs"
          />
          <q-icon
            v-else
            :name="showCommits ? 'expand_less' : 'expand_more'"
            size="14px"
            color="grey-6"
            class="q-ml-xs"
          />
        </div>
        <div v-else class="row items-center q-mb-xs">
          <q-icon name="commit" size="14px" color="grey-6" class="q-mr-xs" />
          <span class="text-caption text-grey-4" style="font-size: 11px;">
            {{ $t('git.commits', { count: 0 }, 0) }}
          </span>
        </div>

        <!-- Commit list (click row → append SHA to chat draft, hover → full SHA tooltip) -->
        <div v-if="showCommits" class="commit-list q-mb-sm">
          <div v-if="loadingCommits" class="text-caption text-grey-6 q-pa-xs">
            <q-spinner size="xs" class="q-mr-xs" />{{ $t('git.commits.loading') }}
          </div>
          <div v-else-if="commits.length === 0" class="text-caption text-grey-7 q-pa-xs">
            {{ $t('git.commits.empty') }}
          </div>
          <template v-else>
            <div
              v-for="commit in commits"
              :key="commit.sha"
              class="commit-item row no-wrap items-center cursor-pointer"
              @click="appendCommitToChat(commit.sha)"
            >
              <q-icon
                :name="commit.isPushed ? 'cloud_done' : 'cloud_upload'"
                size="12px"
                :color="commit.isPushed ? 'grey-6' : 'orange-5'"
                class="q-mr-xs commit-item-icon"
              />
              <span class="commit-sha text-grey-5">{{ commit.shortSha }}</span>
              <span class="commit-subject text-grey-4 ellipsis q-ml-sm">{{ commit.subject }}</span>
              <q-tooltip anchor="top middle" self="bottom middle" class="commit-tooltip">
                <div class="text-caption">
                  <div><code>{{ commit.sha }}</code></div>
                  <div class="text-grey-5 q-mt-xs">{{ commit.author }} · {{ formatCommitDate(commit.date) }}</div>
                  <div class="text-grey-6 q-mt-xs" style="font-style: italic;">
                    {{ commit.isPushed ? $t('git.commits.pushed') : $t('git.commits.unpushed') }}
                    · {{ $t('git.commits.clickToAppend') }}
                  </div>
                </div>
              </q-tooltip>
            </div>
          </template>
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

      <!-- Actions — single row, uniform outlined look. PR button shares the
           same size/shape but keeps its indigo accent as the primary CTA. -->
      <div class="row items-center q-gutter-xs">
        <q-btn-dropdown
          v-if="gitStats && gitStats.unpushedCount !== -1"
          split
          dense
          no-caps
          size="sm"
          outline
          color="grey-5"
          icon="sync"
          :label="$t('git.sync')"
          class="git-btn git-sync-btn"
          :loading="pulling || rebasing || merging"
          :disable="!workspace || pushing"
          @click="handlePull"
        >
          <q-list dark dense style="min-width: 140px;">
            <q-item clickable v-close-popup :disable="pulling || rebasing || merging" @click="handlePull">
              <q-item-section avatar style="min-width: 28px;">
                <q-icon name="download" size="16px" color="grey-5" />
              </q-item-section>
              <q-item-section>{{ $t('git.pull') }}</q-item-section>
            </q-item>
            <q-item clickable v-close-popup :disable="pulling || rebasing || merging" @click="handleRebase">
              <q-item-section avatar style="min-width: 28px;">
                <q-icon name="replay" size="16px" color="orange-4" />
              </q-item-section>
              <q-item-section>{{ $t('git.rebase') }}</q-item-section>
            </q-item>
            <q-item clickable v-close-popup :disable="pulling || rebasing || merging" @click="handleMerge">
              <q-item-section avatar style="min-width: 28px;">
                <q-icon name="merge" size="16px" color="purple-4" />
              </q-item-section>
              <q-item-section>{{ $t('git.merge') }}</q-item-section>
            </q-item>
          </q-list>
        </q-btn-dropdown>
        <q-btn
          v-if="!gitStats || gitStats.unpushedCount !== 0"
          dense
          no-caps
          size="sm"
          outline
          color="grey-5"
          icon="upload"
          :label="$t('git.push')"
          class="git-btn"
          :loading="pushing"
          :disable="!workspace || openingPr || pulling || rebasing"
          @click="handlePush"
        />
        <q-btn
          dense
          no-caps
          size="sm"
          outline
          color="grey-5"
          icon="difference"
          :label="$t('git.diff')"
          class="git-btn"
          :disable="!workspace"
          @click="showDiff = true"
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
          v-if="gitStats?.prUrl"
          dense
          no-caps
          size="sm"
          outline
          color="green-4"
          icon="open_in_new"
          :label="$t('git.viewPr')"
          class="git-btn"
          @click="viewPr"
        />
        <q-btn
          v-if="!gitStats?.prUrl || gitStats.prState === 'CLOSED' || gitStats.prState === 'MERGED'"
          dense
          no-caps
          size="sm"
          outline
          color="indigo-4"
          icon="open_in_new"
          :label="$t('git.createPr')"
          class="git-btn"
          :loading="openingPr"
          :disable="!workspace || pushing || !canOpenPr"
          @click="handleOpenPr"
        >
          <q-tooltip v-if="!canOpenPr && createPrDisabledReason">{{ createPrDisabledReason }}</q-tooltip>
        </q-btn>
      </div>
    </template>

    <div v-else class="text-caption text-grey-8">
      {{ $t('common.selectWorkspace') }}
    </div>

    <!-- Merge / rebase conflict resolution dialog -->
    <q-dialog v-model="conflictDialog" persistent>
      <q-card dark style="min-width: 420px; max-width: 600px;">
        <q-card-section>
          <div class="text-subtitle1 text-warning">
            <q-icon name="warning" class="q-mr-xs" />
            {{ conflictOperation === 'merge' ? $t('git.conflictTitleMerge') : $t('git.conflictTitleRebase') }}
          </div>
          <div class="text-caption text-grey-6 q-mt-xs">
            {{ $t('git.conflictSubtitle', { count: conflictFiles.length }) }}
          </div>
        </q-card-section>
        <q-card-section v-if="conflictFiles.length > 0" class="q-pt-none">
          <q-list dense dark>
            <q-item v-for="f in conflictFiles" :key="f">
              <q-item-section side><q-icon name="insert_drive_file" size="xs" /></q-item-section>
              <q-item-section>
                <div class="text-caption text-mono">{{ f }}</div>
              </q-item-section>
            </q-item>
          </q-list>
        </q-card-section>
        <q-card-actions align="right">
          <q-btn
            flat
            no-caps
            :label="$t('common.cancel')"
            color="grey-5"
            :disable="conflictAborting || conflictResolving"
            @click="conflictDialog = false"
          />
          <q-btn
            flat
            no-caps
            color="red-4"
            icon="undo"
            :label="$t('git.conflictAbort')"
            :loading="conflictAborting"
            :disable="conflictResolving"
            @click="abortGitOperation"
          />
          <q-btn
            unelevated
            no-caps
            color="primary"
            icon="smart_toy"
            :label="$t('git.conflictResolveWithAgent')"
            :loading="conflictResolving"
            :disable="conflictAborting"
            @click="resolveWithAgent"
          />
        </q-card-actions>
      </q-card>
    </q-dialog>

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
  padding: 2px 8px;
}
// Split button — the outer dropdown wraps two child buttons. `.git-btn`
// padding on the outer edge would double-pad on the right, so we move the
// horizontal padding from the outer shell to each inner half. Result: the
// dropdown ends flush with the chevron, identical right-edge rhythm to
// the siblings (so `q-gutter-xs` between Sync and Diff equals the gap
// between Diff and Create PR).
.git-sync-btn {
  padding: 2px 0;
}
.git-sync-btn :deep(.q-btn__content) {
  padding: 0 8px;
}
.git-sync-btn :deep(.q-btn-dropdown__arrow-container) {
  padding: 0 4px;
  border-left: 1px solid rgba(255, 255, 255, 0.12);
}
.git-sync-btn :deep(.q-btn-dropdown--split) {
  gap: 0;
}
// Commit list — compact rows, clickable, hoverable.
.commit-toggle:hover {
  background-color: rgba(255, 255, 255, 0.03);
  border-radius: 3px;
}
.commit-list {
  max-height: 260px;
  overflow-y: auto;
  border-left: 2px solid rgba(255, 255, 255, 0.04);
  margin-left: 7px; // align with the commit icon above
  padding-left: 6px;
}
.commit-item {
  padding: 3px 4px;
  font-size: 11px;
  line-height: 1.3;
  border-radius: 3px;
  transition: background-color 0.1s;
}
.commit-item:hover {
  background-color: rgba(129, 140, 248, 0.08);
}
.commit-item-icon {
  flex-shrink: 0;
}
.commit-sha {
  font-family: 'Roboto Mono', monospace;
  font-size: 10.5px;
  flex-shrink: 0;
}
.commit-subject {
  font-size: 11px;
  min-width: 0;
}
</style>
