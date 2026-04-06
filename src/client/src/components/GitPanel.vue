<script setup lang="ts">
import { useQuasar } from 'quasar'
import type { GitStats, Workspace } from 'src/stores/workspace'
import { useWorkspaceStore, WorkspaceActionError } from 'src/stores/workspace'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps<{
  workspace: Workspace | null
}>()

const { t } = useI18n()
const $q = useQuasar()
const store = useWorkspaceStore()

const pushing = ref(false)
const openingPr = ref(false)
const gitStats = ref<GitStats | null>(null)
const loadingStats = ref(false)

const repoName = computed(() => {
  if (!props.workspace?.projectPath) return '-'
  const parts = props.workspace.projectPath.replace(/\\/g, '/').split('/')
  return parts[parts.length - 1] || parts[parts.length - 2] || '-'
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

async function handlePush() {
  if (!props.workspace) return
  pushing.value = true
  try {
    await store.pushBranch(props.workspace.id)
    $q.notify({ type: 'positive', message: t('git.pushSuccess'), position: 'top' })
    loadGitStats()
  } catch (e) {
    const error = e instanceof Error ? e.message : t('git.push')
    $q.notify({ type: 'negative', message: t('git.pushFailed', { error }), position: 'top', timeout: 6000 })
  } finally {
    pushing.value = false
  }
}

function viewPr() {
  if (gitStats.value?.prUrl) {
    window.open(gitStats.value.prUrl, '_blank')
  }
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
        message: t('git.pushFirstRemote', { label: t('git.push') }),
        position: 'top',
        timeout: 6000,
      })
      return
    }
    if (e instanceof WorkspaceActionError && e.code === 'unpushed_commits') {
      $q.notify({
        type: 'warning',
        message: t('git.pushFirstLocal', { label: t('git.push') }),
        position: 'top',
        timeout: 6000,
      })
      return
    }
    const error = e instanceof Error ? e.message : t('git.createPR')
    $q.notify({ type: 'negative', message: t('git.openPRFailed', { error }), position: 'top', timeout: 6000 })
  } finally {
    openingPr.value = false
  }
}
</script>

<template>
  <div class="git-panel q-pa-md">
    <div class="row items-center justify-between q-mb-sm">
      <div class="text-caption text-uppercase text-weight-bold text-grey-6" style="letter-spacing: 0.05em;">
        {{ t('git.title') }}
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
      />
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
        {{ t('git.from', { branch: workspace.sourceBranch }) }}
        <template v-if="gitStats">
          &middot;
          <span v-if="gitStats.unpushedCount === -1">{{ t('git.localOnly') }}</span>
          <span v-else-if="gitStats.unpushedCount === 0" style="color: #4ade80;">{{ t('git.pushed') }}</span>
          <span v-else style="color: #f59e0b;">{{ t('git.unpushed', { n: gitStats.unpushedCount }) }}</span>
        </template>
      </div>

      <!-- Git stats -->
      <template v-if="gitStats && (gitStats.commitCount > 0 || gitStats.filesChanged > 0)">
        <!-- Commit count -->
        <div class="row items-center q-mb-xs">
          <q-icon name="commit" size="14px" color="grey-6" class="q-mr-xs" />
          <span class="text-caption text-grey-4" style="font-size: 11px;">
            {{ gitStats.commitCount }} {{ t('git.commitWord', gitStats.commitCount) }}
          </span>
        </div>

        <!-- File changes -->
        <div class="row items-center q-mb-md">
          <q-icon name="insert_drive_file" size="14px" color="grey-6" class="q-mr-xs" />
          <span class="text-caption text-grey-4" style="font-size: 11px;">
            {{ gitStats.filesChanged }} {{ t('git.fileWord', gitStats.filesChanged) }}
          </span>
          <span v-if="gitStats.insertions > 0" class="text-caption q-ml-xs" style="font-size: 11px; color: #4ade80;">
            +{{ gitStats.insertions }}
          </span>
          <span v-if="gitStats.deletions > 0" class="text-caption q-ml-xs" style="font-size: 11px; color: #f87171;">
            -{{ gitStats.deletions }}
          </span>
        </div>
      </template>
      <div v-else class="q-mb-md" />

      <!-- Actions -->
      <div class="row q-gutter-xs">
        <q-btn
          v-if="gitStats?.prUrl"
          dense
          no-caps
          size="sm"
          outline
          color="green-4"
          :label="t('git.viewPR')"
          icon="open_in_new"
          class="git-btn"
          @click="viewPr"
        />
        <q-btn
          v-if="!gitStats?.prUrl || gitStats.prState === 'CLOSED' || gitStats.prState === 'MERGED'"
          dense
          no-caps
          size="sm"
          color="primary"
          :label="t('git.createPR')"
          class="git-btn"
          :loading="openingPr"
          :disable="!workspace || pushing"
          @click="handleOpenPr"
        />
        <q-btn
          v-if="!gitStats || gitStats.unpushedCount !== 0"
          dense
          no-caps
          size="sm"
          outline
          color="grey-5"
          :label="t('git.push')"
          class="git-btn"
          :loading="pushing"
          :disable="!workspace || openingPr"
          @click="handlePush"
        />
      </div>
    </template>

    <div v-else class="text-caption text-grey-8">
      {{ t('git.selectWorkspace') }}
    </div>
  </div>
</template>

<style lang="scss" scoped>
.git-btn {
  font-size: 11px;
  padding: 2px 10px;
}
</style>
