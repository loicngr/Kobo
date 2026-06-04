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
        @click="handleRefreshAll"
      >
        <q-tooltip>{{ $t('tooltip.refreshGitStats') }}</q-tooltip>
      </q-btn>
    </div>

    <template v-if="workspace">
      <!-- Loader: full panel while the new workspace's stats are being fetched.
           Replaces every sub-card (Repository / Changes / Actions / PR) so the
           user doesn't see a half-empty panel during the switch. -->
      <div v-if="loadingStats && !gitStats" class="row items-center justify-center q-py-xl">
        <q-spinner size="32px" color="indigo-4" />
      </div>

      <template v-else>
      <!-- Repository sub-card -->
      <div class="git-subcard">
        <div class="git-subcard-title">{{ $t('git.section.repository') }}</div>

        <!-- Repo name -->
        <div class="row items-center q-mb-xs">
          <q-icon name="folder" size="14px" color="grey-6" class="q-mr-xs" />
          <span class="text-caption text-grey-3">{{ repoName }}</span>
        </div>

        <!-- Branch -->
        <div class="row items-center q-mb-xs">
          <span
            style="width: 8px; height: 8px; border-radius: 50%; background-color: #4ade80; display: inline-block;"
            class="q-mr-xs"
          />
          <span class="text-caption text-grey-4" style="font-family: 'Roboto Mono', monospace; font-size: 11px;">
            {{ workspace.workingBranch }}
          </span>
        </div>

        <!-- Source branch info — 1 line, no "from" prefix (section title is enough) -->
        <div class="text-caption text-grey-8" style="font-size: 11px;">
          {{ workspace.sourceBranch }}
          <template v-if="gitStats">
            <span v-if="gitStats.commitCount > 0" class="cursor-pointer arrow-clickable" style="color: #4ade80;" @click.stop="openDivergence('ahead')">
              · ↑{{ gitStats.commitCount }}
            </span>
            <span v-if="gitStats.behindCount > 0" class="cursor-pointer arrow-clickable" style="color: #f87171;" @click.stop="openDivergence('behind')">
              · ↓{{ gitStats.behindCount }}
            </span>
            <q-tooltip v-if="gitStats.commitCount > 0 || gitStats.behindCount > 0">
              {{ $t('git.aheadBehindTooltip', { ahead: gitStats.commitCount, behind: gitStats.behindCount, source: workspace.sourceBranch }) }}
            </q-tooltip>
            ·
            <span v-if="gitStats.unpushedCount === -1">{{ $t('git.localOnly') }}</span>
            <span v-else-if="gitStats.unpushedCount === 0" style="color: #4ade80;">{{ $t('git.pushed') }}</span>
            <span v-else style="color: #f59e0b;">{{ $t('git.unpushed', { count: gitStats.unpushedCount }) }}</span>
          </template>
        </div>
      </div>

      <!-- Changes sub-card -->
      <div v-if="gitStats" class="git-subcard">
        <div class="git-subcard-title">{{ $t('git.section.changes') }}</div>

        <div class="row items-center" style="font-size: 11px; gap: 14px; flex-wrap: wrap;">
          <!-- Commits (clickable to expand) -->
          <div
            v-if="gitStats.commitCount > 0"
            class="row items-center commit-toggle cursor-pointer"
            @click="toggleCommits"
          >
            <q-icon name="commit" size="14px" color="grey-6" class="q-mr-xs" />
            <span class="text-grey-4">{{ $t('git.commits', { count: gitStats.commitCount }, gitStats.commitCount) }}</span>
            <q-spinner v-if="loadingCommits" size="12px" color="indigo-4" class="q-ml-xs" />
            <q-icon v-else :name="showCommits ? 'expand_less' : 'expand_more'" size="14px" color="grey-6" class="q-ml-xs" />
          </div>
          <div v-else class="row items-center">
            <q-icon name="commit" size="14px" color="grey-6" class="q-mr-xs" />
            <span class="text-grey-4">{{ $t('git.commits', { count: 0 }, 0) }}</span>
          </div>

          <!-- Files -->
          <div v-if="gitStats.filesChanged > 0" class="row items-center">
            <q-icon name="insert_drive_file" size="14px" color="grey-6" class="q-mr-xs" />
            <span class="text-grey-4">{{ gitStats.filesChanged }}</span>
            <span v-if="gitStats.insertions > 0" class="q-ml-xs" style="color: #4ade80;">+{{ gitStats.insertions }}</span>
            <span v-if="gitStats.deletions > 0" class="q-ml-xs" style="color: #f87171;">-{{ gitStats.deletions }}</span>
          </div>

          <!-- Working tree (only if dirty) -->
          <div
            v-if="gitStats.workingTree && (gitStats.workingTree.staged > 0 || gitStats.workingTree.modified > 0 || gitStats.workingTree.untracked > 0)"
            class="row items-center"
          >
            <q-icon name="edit_note" size="14px" color="grey-6" class="q-mr-xs" />
            <span v-if="gitStats.workingTree.staged > 0" style="color: #4ade80;">{{ gitStats.workingTree.staged }}s</span>
            <span v-if="gitStats.workingTree.modified > 0" class="q-ml-xs" style="color: #f59e0b;">{{ gitStats.workingTree.modified }}m</span>
            <span v-if="gitStats.workingTree.untracked > 0" class="q-ml-xs text-grey-6">{{ gitStats.workingTree.untracked }}u</span>
            <q-tooltip>
              {{ $t('git.staged', { count: gitStats.workingTree.staged }) }} ·
              {{ $t('git.modified', { count: gitStats.workingTree.modified }) }} ·
              {{ $t('git.untracked', { count: gitStats.workingTree.untracked }) }}
            </q-tooltip>
          </div>
        </div>

        <!-- Commit list expand — kept inside the sub-card, below the stats row -->
        <div v-if="showCommits" class="commit-list q-mt-sm">
          <div v-if="commits.length > 0" class="row justify-end q-mb-xs">
            <q-btn
              flat
              dense
              no-caps
              size="sm"
              icon="difference"
              color="grey-5"
              :label="$t('git.compareCommits')"
              @click="showCompareDialog = true"
            />
          </div>
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
              <q-btn
                flat
                dense
                round
                size="xs"
                icon="difference"
                color="grey-6"
                class="commit-diff-btn q-ml-xs"
                @click.stop="openCommitDiff(`${commit.sha}^`, commit.sha)"
              >
                <q-tooltip anchor="top middle" self="bottom middle">{{ $t('git.commits.diffThisCommit') }}</q-tooltip>
              </q-btn>
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
      </div>

      <!-- Actions sub-card — placed BEFORE Pull request per UX request. -->
      <div v-if="workspace && gitStats" class="git-subcard">
        <div class="git-subcard-title">{{ $t('git.section.actions') }}</div>

        <!-- Primary action: View PR/MR (green) when PR open, else Create PR/MR (indigo).
             Hidden entirely when no supported forge is detected. -->
        <template v-if="forge.id !== 'none'">
          <q-btn
            v-if="gitStats?.prUrl && gitStats.prState === 'OPEN'"
            no-caps unelevated dense size="sm"
            color="green-7"
            icon="open_in_new"
            :label="$t('git.viewRequest', { request: forge.capabilities.requestTermShort })"
            class="full-width q-mb-xs"
            @click="viewPr"
          />
          <q-btn
            v-else
            no-caps unelevated dense size="sm"
            color="indigo-5"
            icon="open_in_new"
            :label="$t('git.createRequest', { request: forge.capabilities.requestTermShort })"
            class="full-width q-mb-xs"
            :loading="openingPr"
            :disable="!workspace || pushing || !canOpenPr || isArchived"
            @click="handleOpenPr"
          >
            <q-tooltip v-if="!canOpenPr && createPrDisabledReason">{{ createPrDisabledReason }}</q-tooltip>
          </q-btn>
        </template>

        <!-- Secondary row: Sync dropdown + Push + Diff Review + overflow.
             Each action lives in its own `col` so the four share space evenly
             without overlap; the overflow icon stays at natural width via `col-auto`. -->
        <div class="row no-wrap items-stretch q-gutter-xs">
          <div v-if="gitStats" class="col">
            <q-btn-dropdown
              split dense no-caps size="sm" outline color="grey-5"
              icon="sync"
              :label="$t('git.sync')"
              class="full-width git-btn"
              :loading="pulling || rebasing || merging"
              :disable="!workspace || pushing || isArchived"
              @click="gitStats.unpushedCount === -1 ? handleRebase() : handlePull()"
            >
              <q-list dark dense style="min-width: 140px;">
                <q-item
                  clickable v-close-popup
                  :disable="pulling || rebasing || merging || gitStats.unpushedCount === -1 || isArchived"
                  @click="handlePull"
                >
                  <q-item-section avatar style="min-width: 28px;">
                    <q-icon name="download" size="16px" color="grey-5" />
                  </q-item-section>
                  <q-item-section>{{ $t('git.pull') }}</q-item-section>
                  <q-tooltip v-if="gitStats.unpushedCount === -1">{{ $t('git.pullNoUpstream') }}</q-tooltip>
                </q-item>
                <q-item clickable v-close-popup :disable="pulling || rebasing || merging || isArchived" @click="handleRebase">
                  <q-item-section avatar style="min-width: 28px;">
                    <q-icon name="replay" size="16px" color="orange-4" />
                  </q-item-section>
                  <q-item-section>{{ $t('git.rebase') }}</q-item-section>
                </q-item>
                <q-item clickable v-close-popup :disable="pulling || rebasing || merging || isArchived" @click="handleMerge">
                  <q-item-section avatar style="min-width: 28px;">
                    <q-icon name="merge" size="16px" color="purple-4" />
                  </q-item-section>
                  <q-item-section>{{ $t('git.merge') }}</q-item-section>
                </q-item>
              </q-list>
            </q-btn-dropdown>
          </div>

          <div v-if="gitStats?.unpushedCount !== 0" class="col">
            <q-btn
              dense no-caps size="sm" outline color="orange-5"
              icon="upload"
              :label="$t('git.push')"
              class="full-width git-btn"
              :loading="pushing"
              :disable="!workspace || openingPr || pulling || rebasing || isArchived"
              @click="handlePush"
            >
              <q-tooltip anchor="bottom middle" self="top middle" :delay="400">{{ $t('git.push') }}</q-tooltip>
            </q-btn>
          </div>

          <div class="col">
            <q-btn
              dense no-caps size="sm" outline color="indigo-4"
              icon="rate_review"
              :label="$t('git.diffReview')"
              class="full-width git-btn"
              :disable="!workspace"
              @click="openDiff(true)"
            >
              <q-tooltip anchor="bottom middle" self="top middle" :delay="400">{{ $t('git.diffReviewTooltip') }}</q-tooltip>
            </q-btn>
          </div>

          <div v-if="hasOverflowActions" class="col-auto">
            <q-btn
              dense flat size="sm" color="grey-5"
              icon="more_horiz"
              class="git-btn"
            >
              <q-menu>
                <q-list dark dense style="min-width: 160px;">
                  <q-item
                    v-if="canRenameBranch"
                    clickable v-close-popup
                    :disable="renamingBranch || isArchived"
                    @click="openRenameBranchDialog"
                  >
                    <q-item-section avatar style="min-width: 28px;">
                      <q-icon name="edit" size="16px" color="grey-5" />
                    </q-item-section>
                    <q-item-section>{{ $t('git.renameBranch') }}</q-item-section>
                  </q-item>
                  <q-item
                    v-if="gitStats?.prUrl && gitStats.prState === 'OPEN'"
                    clickable v-close-popup
                    :disable="changingBase || isArchived"
                    @click="handleChangePrBase"
                  >
                    <q-item-section avatar style="min-width: 28px;">
                      <q-icon name="swap_horiz" size="16px" color="grey-5" />
                    </q-item-section>
                    <q-item-section>{{ $t('git.changeRequestBase', { request: forge.capabilities.requestTermShort }) }}</q-item-section>
                  </q-item>
                  <q-item
                    v-if="changeSourceBranchEnabled"
                    clickable v-close-popup
                    :disable="changingSource || isArchived"
                    @click="handleChangeSourceBranch"
                  >
                    <q-item-section avatar style="min-width: 28px;">
                      <q-icon name="alt_route" size="16px" color="grey-5" />
                    </q-item-section>
                    <q-item-section>{{ $t('git.changeSourceBranch') }}</q-item-section>
                  </q-item>
                </q-list>
              </q-menu>
              <q-tooltip>{{ $t('git.actions.more') }}</q-tooltip>
            </q-btn>
          </div>
        </div>
      </div>

      <!-- Pull request sub-card — placed AFTER Actions per UX request. -->
      <div v-if="prSnapshot && prSnapshot.state === 'OPEN'" class="git-subcard">
        <div class="git-subcard-title">{{ $t('git.section.pullRequest') }}</div>
        <PrPanel :snapshot="prSnapshot" />
      </div>
      </template>
    </template>

    <div v-else class="text-caption text-grey-8">
      {{ $t('common.selectWorkspace') }}
    </div>

    <!-- Push confirmation dialog with Force Push toggle (uses --force-with-lease) -->
    <q-dialog v-model="showPushDialog">
      <q-card dark style="min-width: 360px; max-width: 480px;">
        <q-card-section>
          <div class="text-subtitle1">{{ $t('git.pushConfirmTitle') }}</div>
          <div class="text-body2 text-grey-5 q-mt-sm">
            {{ $t('git.pushConfirmMessagePrefix') }}
            <code class="git-branch-code">{{ workspace?.workingBranch ?? '' }}</code>
            {{ $t('git.pushConfirmMessageSuffix') }}
          </div>
        </q-card-section>
        <q-card-section class="q-pt-none">
          <q-toggle
            v-model="pushForce"
            :label="$t('git.forcePushToggle')"
            color="orange-6"
            dense
          />
          <div class="text-caption text-grey-6 q-mt-xs" style="padding-left: 46px;">
            {{ $t('git.forcePushHint') }}
          </div>
        </q-card-section>
        <q-card-actions align="right">
          <q-btn flat :label="$t('common.cancel')" color="grey-5" v-close-popup />
          <q-btn
            flat
            :label="pushForce ? $t('git.forcePush') : $t('git.push')"
            :color="pushForce ? 'orange-4' : 'grey-5'"
            @click="confirmPush"
          />
        </q-card-actions>
      </q-card>
    </q-dialog>

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

    <!-- Dirty-worktree recovery dialog -->
    <q-dialog v-model="dirtyDialog" persistent>
      <q-card dark style="min-width: 420px; max-width: 600px;">
        <q-card-section>
          <div class="text-subtitle1 text-warning">
            <q-icon name="warning" class="q-mr-xs" />
            {{ dirtyOperation === 'merge' ? $t('git.dirtyTitleMerge') : $t('git.dirtyTitleRebase') }}
          </div>
          <div class="text-caption text-grey-6 q-mt-xs">
            {{ $t('git.dirtySubtitle', {
              modified: dirtyStatus?.modified ?? 0,
              staged: dirtyStatus?.staged ?? 0,
              untracked: dirtyStatus?.untracked ?? 0,
            }) }}
          </div>
        </q-card-section>
        <q-card-section v-if="dirtyCommitMode" class="q-pt-none">
          <q-input
            v-model="dirtyCommitMessage"
            dark
            dense
            autofocus
            :placeholder="$t('git.dirtyCommitPlaceholder')"
            :disable="dirtyBusy"
            @keyup.enter="dirtyCommit"
          />
        </q-card-section>
        <q-card-actions align="right">
          <q-btn
            flat
            no-caps
            :label="$t('common.cancel')"
            color="grey-5"
            :disable="dirtyBusy"
            @click="dirtyDialog = false"
          />
          <q-btn
            flat
            no-caps
            color="red-4"
            icon="delete_forever"
            :label="$t('git.dirtyDiscard')"
            :loading="dirtyBusy"
            :disable="dirtyBusy"
            @click="dirtyDiscard"
          />
          <template v-if="dirtyCommitMode">
            <q-btn
              unelevated
              no-caps
              color="grey-7"
              icon="check"
              :label="$t('git.dirtyCommitConfirm')"
              :loading="dirtyBusy"
              :disable="!dirtyCommitMessage.trim()"
              @click="dirtyCommit"
            />
          </template>
          <template v-else>
            <q-btn
              flat
              no-caps
              color="grey-5"
              icon="edit"
              :label="$t('git.dirtyCommit')"
              :disable="dirtyBusy"
              @click="dirtyCommitMode = true"
            />
            <q-btn
              unelevated
              no-caps
              color="primary"
              icon="inventory_2"
              :label="$t('git.dirtyStash')"
              :disable="dirtyBusy"
              @click="dirtyStash"
            />
          </template>
        </q-card-actions>
      </q-card>
    </q-dialog>

    <!-- Change-source-branch error with abort option. Opens when the server
         reports an `ongoingOperation` after a failed change (typically a
         custom script that crashed mid-cherry-pick). -->
    <q-dialog v-model="sourceChangeErrorDialog" persistent>
      <q-card dark style="min-width: 420px; max-width: 600px;">
        <q-card-section>
          <div class="text-subtitle1 text-negative">
            <q-icon name="error" class="q-mr-xs" />
            {{ $t('git.changeSourceBranchErrorTitle') }}
          </div>
          <div class="text-caption text-grey-6 q-mt-xs">
            {{ $t('git.changeSourceBranchErrorOngoing', { op: sourceChangeErrorOperation }) }}
          </div>
        </q-card-section>
        <q-card-section class="q-pt-none">
          <div class="text-body2 text-grey-3" style="white-space: pre-wrap; word-break: break-word;">
            {{ sourceChangeErrorMessage }}
          </div>
        </q-card-section>
        <q-card-actions align="right">
          <q-btn
            flat
            no-caps
            :label="$t('common.close')"
            color="grey-5"
            :disable="sourceChangeAborting"
            @click="sourceChangeErrorDialog = false"
          />
          <q-btn
            unelevated
            no-caps
            color="red-5"
            icon="undo"
            :label="$t('git.changeSourceBranchErrorAbort')"
            :loading="sourceChangeAborting"
            @click="abortSourceChange"
          />
        </q-card-actions>
      </q-card>
    </q-dialog>

    <!-- Diff viewer dialog (fullscreen). `diffInitialReview` selects which
         mode the viewer opens in — set to true by the "Diff v2" button. -->
    <q-dialog v-model="showDiff" maximized>
      <DiffViewer
        v-if="workspace"
        :workspace-id="workspace.id"
        :initial-review-mode="diffInitialReview"
        :compare-from="compareFrom"
        :compare-to="compareTo"
        @close="showDiff = false"
        @send-to-chat="onSendToChat"
      />
    </q-dialog>

    <CompareCommitsDialog
      v-if="workspace"
      v-model="showCompareDialog"
      :commits="commits"
      :source-branch="workspace.sourceBranch"
      @compare="onCompareConfirmed"
    />

    <BranchDivergenceDialog
      v-if="workspace && gitStats"
      v-model="divergenceDialogOpen"
      :workspace-id="workspace.id"
      :initial-tab="divergenceInitialTab"
      :ahead-count="gitStats.commitCount"
      :behind-count="gitStats.behindCount"
      :source-branch="workspace.sourceBranch"
      :working-branch="workspace.workingBranch"
      @append-sha="appendCommitToChat"
    />
  </div>
</template>

<script setup lang="ts">
import { useQuasar } from 'quasar'
import { defineAsyncComponent } from 'vue'
import { useI18n } from 'vue-i18n'

const DiffViewer = defineAsyncComponent(() => import('./DiffViewer.vue'))

import BranchDivergenceDialog from 'src/components/BranchDivergenceDialog.vue'
import PrPanel from 'src/components/PrPanel.vue'
import { useSettingsStore } from 'src/stores/settings'
import type { BranchCommit, ForgeInfo, GitStats, Workspace } from 'src/stores/workspace'
import { useWorkspaceStore, WorkspaceActionError } from 'src/stores/workspace'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import CompareCommitsDialog from './CompareCommitsDialog.vue'

const props = defineProps<{
  workspace: Workspace | null
}>()

const { t } = useI18n()
const $q = useQuasar()
const store = useWorkspaceStore()
const settingsStore = useSettingsStore()

const isArchived = computed<boolean>(() => Boolean(props.workspace?.archivedAt))

/** The change-source-branch action is hidden unless a script is configured
 *  (per-project override or global default). Empty script = feature off. */
const changeSourceBranchEnabled = computed<boolean>(() => {
  if (!props.workspace) return false
  const project = settingsStore.getProjectByPath(props.workspace.projectPath)
  const effective =
    (project?.changeSourceBranchScript ?? '').trim() || (settingsStore.global.changeSourceBranchScript ?? '').trim()
  return effective.length > 0
})

const pushing = ref(false)
const pulling = ref(false)
const rebasing = ref(false)
const merging = ref(false)
const openingPr = ref(false)
const changingBase = ref(false)
const showDiff = ref(false)
// Whether to open the DiffViewer directly in Review mode. Set by the "Diff v2"
// button; the regular "Diff" button keeps the user's persisted preference.
const diffInitialReview = ref(false)
const showCompareDialog = ref(false)
const compareFrom = ref<string | undefined>(undefined)
const compareTo = ref<string | undefined>(undefined)

function openDiff(asReview: boolean) {
  compareFrom.value = undefined
  compareTo.value = undefined
  diffInitialReview.value = asReview
  showDiff.value = true
}

/** Open the DiffViewer in read-only commits mode for an explicit ref range. */
function openCommitDiff(from: string, to: string) {
  compareFrom.value = from
  compareTo.value = to
  diffInitialReview.value = false
  showDiff.value = true
}

function onCompareConfirmed(payload: { from: string; to: string }) {
  openCommitDiff(payload.from, payload.to)
}
const renamingBranch = ref(false)

// Commit list expand state + cache per workspace
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

// Conflict state for the shared merge/rebase/cherry-pick resolution dialog
const conflictDialog = ref(false)
const conflictOperation = ref<'merge' | 'rebase' | 'cherry-pick' | null>(null)
const conflictFiles = ref<string[]>([])
const conflictAborting = ref(false)
const conflictResolving = ref(false)

// Dirty-worktree recovery dialog (rebase/merge refused by uncommitted changes)
const dirtyDialog = ref(false)
const dirtyOperation = ref<'rebase' | 'merge' | null>(null)
const dirtyStatus = ref<{ staged: number; modified: number; untracked: number } | null>(null)
const dirtyBusy = ref(false)
const dirtyCommitMode = ref(false)
const dirtyCommitMessage = ref('')

// Dialog opened when /change-source-branch fails with a partial git state
// (custom script crashed mid-cherry-pick / mid-rebase). The "Abort" button
// runs `/git/abort` to clean up and leaves the user back in a sane state.
const sourceChangeErrorDialog = ref(false)
const sourceChangeErrorMessage = ref('')
const sourceChangeErrorOperation = ref<'cherry-pick' | 'merge' | 'rebase' | null>(null)
const sourceChangeAborting = ref(false)

function openSourceChangeErrorDialog(msg: string, op: 'cherry-pick' | 'merge' | 'rebase') {
  sourceChangeErrorMessage.value = msg
  sourceChangeErrorOperation.value = op
  sourceChangeErrorDialog.value = true
}

async function abortSourceChange() {
  if (!props.workspace) return
  sourceChangeAborting.value = true
  try {
    const res = await fetch(`/api/workspaces/${props.workspace.id}/git/abort`, { method: 'POST' })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      throw new Error(data.error ?? 'Abort failed')
    }
    $q.notify({ type: 'positive', message: t('git.conflictAborted'), position: 'top' })
    sourceChangeErrorDialog.value = false
    loadGitStats()
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Abort failed'
    $q.notify({ type: 'negative', message: msg, position: 'top', timeout: 6000 })
  } finally {
    sourceChangeAborting.value = false
  }
}

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

const prSnapshot = computed(() => {
  const id = props.workspace?.id
  if (!id) return undefined
  return store.prSnapshots[id]
})

/** Fallback when the backend hasn't returned a forge block yet (old cached response). */
const FORGE_FALLBACK: ForgeInfo = {
  id: 'none',
  capabilities: { canCreatePr: false, canChangePrBase: false, requestTermShort: 'PR' },
  availability: { available: false },
}

/** Derived forge info — uses the backend response when available, falls back to none. */
const forge = computed<ForgeInfo>(() => gitStats.value?.forge ?? FORGE_FALLBACK)

/** CLI name used in tooltip messages ('gh' for GitHub, 'glab' for GitLab). */
const forgeCli = computed(() => (forge.value.id === 'gitlab' ? 'glab' : 'gh'))

// Gate the "Create PR" button: the branch must exist on the remote, otherwise
// `gh pr create` fails downstream. Once it's pushed, let the user open a PR
// even if the commit count is zero — the server will surface a clear error.
const canOpenPr = computed(() => {
  if (!gitStats.value) return false
  if (forge.value.id === 'none') return false
  if (!forge.value.availability.available) return false
  if (gitStats.value.unpushedCount === -1) return false
  return true
})

const createPrDisabledReason = computed(() => {
  if (!gitStats.value) return ''
  // Branch-not-pushed takes priority (most actionable for the user)
  if (gitStats.value.unpushedCount === -1) return t('git.createPrNoRemote')
  // Forge availability gates
  if (!forge.value.availability.available) {
    const reason = forge.value.availability.reason
    if (reason === 'cli_missing') {
      return t('git.forgeCliMissing', { cli: forgeCli.value, request: forge.value.capabilities.requestTermShort })
    }
    if (reason === 'not_authenticated') {
      return t('git.forgeNotAuthenticated', { cli: forgeCli.value })
    }
    // Generic fallback for unknown unavailability reasons
    return t('git.forgeCliMissing', { cli: forgeCli.value, request: forge.value.capabilities.requestTermShort })
  }
  return ''
})

// Overflow `⋯` surfaces rename + change-PR-base + change-source-branch;
// Push is a first-class secondary button.
const canRenameBranch = computed<boolean>(() => props.workspace?.worktreeOwned !== false)
const hasOverflowActions = computed(() => {
  if (!props.workspace) return false
  const hasChangePrBase = !!(gitStats.value?.prUrl && gitStats.value.prState === 'OPEN')
  return canRenameBranch.value || hasChangePrBase || changeSourceBranchEnabled.value
})

// Branch divergence dialog state
const divergenceDialogOpen = ref(false)
const divergenceInitialTab = ref<'ahead' | 'behind'>('ahead')

function openDivergence(tab: 'ahead' | 'behind') {
  divergenceInitialTab.value = tab
  divergenceDialogOpen.value = true
}

let inflightController: AbortController | null = null

async function loadGitStats(opts: { freshFetch?: boolean } = {}) {
  if (!props.workspace) {
    gitStats.value = null
    return
  }
  inflightController?.abort()
  const controller = new AbortController()
  inflightController = controller
  const wsIdAtStart = props.workspace.id
  loadingStats.value = true
  try {
    const stats = await store.fetchGitStats(wsIdAtStart, { freshFetch: opts.freshFetch, signal: controller.signal })
    if (controller.signal.aborted) return
    if (props.workspace?.id !== wsIdAtStart) return
    gitStats.value = stats
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') return
    gitStats.value = null
  } finally {
    if (inflightController === controller) inflightController = null
    loadingStats.value = false
  }
}

async function handleRefreshAll() {
  const id = props.workspace?.id
  if (!id) return
  await Promise.allSettled([loadGitStats({ freshFetch: true }), store.refreshPrSnapshot(id)])
}

// Refresh when agent runs git commands (debounced)
let gitRefreshTimeout: ReturnType<typeof setTimeout> | null = null

watch(
  () => props.workspace?.id,
  (newId, oldId) => {
    inflightController?.abort()
    if (gitRefreshTimeout) {
      clearTimeout(gitRefreshTimeout)
      gitRefreshTimeout = null
    }
    // Immediately clear the previous workspace's data so the panel shows a
    // loader instead of stale info while the new fetch is in flight.
    if (newId !== oldId) {
      gitStats.value = null
      commits.value = []
      showCommits.value = false
    }
    if (newId) {
      loadGitStats({ freshFetch: true })
    }
  },
  { immediate: true },
)

watch(
  () => store.gitRefreshTrigger,
  () => {
    if (gitRefreshTimeout) clearTimeout(gitRefreshTimeout)
    gitRefreshTimeout = setTimeout(() => loadGitStats(), 3000)
  },
)

// Sync the panel from the global gitStatsCache — kept ≤30s fresh by
// WorkspaceList's `fetchWorkspacesInfo` poll. Lets the open GitPanel reflect
// background watcher updates without its own self-poll. Guarded against an
// in-flight manual refresh so the freshFetch result wins when it lands.
watch(
  () => {
    const id = props.workspace?.id
    return id ? store.gitStatsCache[id] : null
  },
  (cached) => {
    if (!cached) return
    if (loadingStats.value) return
    gitStats.value = cached
  },
)

onBeforeUnmount(() => {
  if (gitRefreshTimeout) {
    clearTimeout(gitRefreshTimeout)
    gitRefreshTimeout = null
  }
  inflightController?.abort()
})

function openRenameBranchDialog() {
  const ws = props.workspace
  if (!ws) return
  $q.dialog({
    title: t('git.renameBranch'),
    message: t('git.renameBranchPrompt', { branch: ws.workingBranch }),
    prompt: { model: ws.workingBranch, type: 'text' },
    dark: true,
    cancel: { flat: true, label: t('common.cancel'), color: 'grey-5' },
    ok: { flat: true, label: t('git.renameBranch'), color: 'indigo-4' },
  }).onOk(async (newName: string) => {
    const trimmed = (newName ?? '').trim()
    if (!trimmed || trimmed === ws.workingBranch) return
    renamingBranch.value = true
    try {
      await store.renameWorkspaceBranch(ws.id, trimmed)
      $q.notify({ type: 'positive', message: t('git.renameBranchSuccess', { branch: trimmed }), position: 'top' })
      loadGitStats()
    } catch (e) {
      const msg =
        e instanceof WorkspaceActionError && e.code === 'branch_exists'
          ? t('git.renameBranchExists', { branch: trimmed })
          : e instanceof Error
            ? e.message
            : t('git.renameBranchFailed')
      $q.notify({ type: 'negative', message: msg, position: 'top', timeout: 6000 })
    } finally {
      renamingBranch.value = false
    }
  })
}

// HTML-escape a branch name before it lands in an `html: true` dialog message.
// Defensive: branch names come from user input (workspace creation form) and
// could in theory contain characters that would otherwise break layout or
// inject markup. Cheap to apply, impossible to regret.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

async function runRebase(opts?: { autostash?: boolean }) {
  if (!props.workspace) return
  rebasing.value = true
  try {
    const qs = opts?.autostash ? '?autostash=1' : ''
    const res = await fetch(`/api/workspaces/${props.workspace.id}/rebase${qs}`, { method: 'POST' })
    if (res.status === 409) {
      const data = await res.json()
      if (data.code === 'dirty_worktree') {
        openDirtyDialog('rebase', data.status)
        return
      }
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
}

function handleRebase() {
  if (!props.workspace) return
  $q.dialog({
    title: t('git.rebaseConfirmTitle'),
    message: t('git.rebaseConfirmMessage', {
      branch: `<code class="git-branch-code">${escapeHtml(props.workspace.sourceBranch)}</code>`,
    }),
    html: true,
    dark: true,
    cancel: { flat: true, label: t('common.cancel'), color: 'grey-5' },
    ok: { flat: true, label: t('git.rebase'), color: 'orange-4' },
  }).onOk(() => {
    void runRebase()
  })
}

async function runMerge(opts?: { autostash?: boolean }) {
  if (!props.workspace) return
  merging.value = true
  try {
    const qs = opts?.autostash ? '?autostash=1' : ''
    const res = await fetch(`/api/workspaces/${props.workspace.id}/merge${qs}`, { method: 'POST' })
    if (res.status === 409) {
      const data = await res.json()
      if (data.code === 'dirty_worktree') {
        openDirtyDialog('merge', data.status)
        return
      }
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
}

function handleMerge() {
  if (!props.workspace) return
  $q.dialog({
    title: t('git.mergeConfirmTitle'),
    message: t('git.mergeConfirmMessage', {
      branch: `<code class="git-branch-code">${escapeHtml(props.workspace.sourceBranch)}</code>`,
    }),
    html: true,
    dark: true,
    cancel: { flat: true, label: t('common.cancel'), color: 'grey-5' },
    ok: { flat: true, label: t('git.merge'), color: 'purple-4' },
  }).onOk(() => {
    void runMerge()
  })
}

function openConflictDialog(op: 'merge' | 'rebase' | 'cherry-pick', files: string[]) {
  conflictOperation.value = op
  conflictFiles.value = files
  conflictDialog.value = true
}

function openDirtyDialog(op: 'rebase' | 'merge', status: { staged: number; modified: number; untracked: number }) {
  dirtyOperation.value = op
  dirtyStatus.value = status
  dirtyCommitMode.value = false
  dirtyCommitMessage.value = ''
  dirtyBusy.value = false
  dirtyDialog.value = true
}

// Re-run the original operation after a recovery step succeeded.
function retryDirtyOperation(opts?: { autostash?: boolean }) {
  const op = dirtyOperation.value
  dirtyDialog.value = false
  if (op === 'rebase') void runRebase(opts)
  else if (op === 'merge') void runMerge(opts)
}

function dirtyStash() {
  retryDirtyOperation({ autostash: true })
}

async function dirtyCommit() {
  if (!props.workspace || !dirtyCommitMessage.value.trim()) return
  dirtyBusy.value = true
  try {
    const res = await fetch(`/api/workspaces/${props.workspace.id}/git/commit-all`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: dirtyCommitMessage.value.trim() }),
    })
    if (!res.ok) {
      const data = await res.json()
      throw new Error(data.error ?? t('git.commitFailed'))
    }
    retryDirtyOperation()
  } catch (e) {
    const msg = e instanceof Error ? e.message : t('git.commitFailed')
    $q.notify({ type: 'negative', message: msg, position: 'top', timeout: 6000 })
  } finally {
    dirtyBusy.value = false
  }
}

function dirtyDiscard() {
  if (!props.workspace) return
  $q.dialog({
    title: t('git.dirtyDiscardConfirmTitle'),
    message: t('git.dirtyDiscardConfirmMessage'),
    dark: true,
    cancel: { flat: true, label: t('common.cancel'), color: 'grey-5' },
    ok: { flat: true, label: t('git.dirtyDiscard'), color: 'red-4' },
  }).onOk(async () => {
    dirtyBusy.value = true
    try {
      const res = await fetch(`/api/workspaces/${props.workspace!.id}/git/discard`, { method: 'POST' })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error ?? t('git.discardFailed'))
      }
      retryDirtyOperation()
    } catch (e) {
      const msg = e instanceof Error ? e.message : t('git.discardFailed')
      $q.notify({ type: 'negative', message: msg, position: 'top', timeout: 6000 })
    } finally {
      dirtyBusy.value = false
    }
  })
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

// Push confirmation dialog state — custom inline dialog (instead of $q.dialog)
// so we can embed a Force Push toggle inside the body.
const showPushDialog = ref(false)
const pushForce = ref(false)

function handlePush() {
  if (!props.workspace) return
  pushForce.value = false // reset each time, never default to force
  showPushDialog.value = true
}

async function confirmPush() {
  if (!props.workspace) return
  const force = pushForce.value
  showPushDialog.value = false
  pushing.value = true
  try {
    await store.pushBranch(props.workspace.id, { force })
    $q.notify({
      type: 'positive',
      message: force ? t('git.branchForcePushed') : t('git.branchPushed'),
      position: 'top',
    })
    loadGitStats()
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Push failed'
    $q.notify({ type: 'negative', message: msg, position: 'top', timeout: 6000 })
  } finally {
    pushing.value = false
  }
}

function handlePull() {
  if (!props.workspace) return
  $q.dialog({
    title: t('git.pullConfirmTitle'),
    message: t('git.pullConfirmMessage', {
      branch: `<code class="git-branch-code">${escapeHtml(props.workspace.workingBranch)}</code>`,
    }),
    html: true,
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
    message: t('git.changePrBaseMessage', { request: forge.value.capabilities.requestTermShort }),
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
      $q.notify({
        type: 'positive',
        message: t('git.changePrBaseSuccess', { request: forge.value.capabilities.requestTermShort }),
        position: 'top',
      })
      loadGitStats()
    } catch (e) {
      const msg =
        e instanceof Error
          ? e.message
          : t('git.changePrBaseFailed', { request: forge.value.capabilities.requestTermShort })
      $q.notify({ type: 'negative', message: msg, position: 'top', timeout: 6000 })
    } finally {
      changingBase.value = false
    }
  })
}

const changingSource = ref(false)

function promptForcePush() {
  if (!props.workspace) return
  $q.dialog({
    title: t('git.changeSourceForcePushTitle'),
    message: t('git.changeSourceForcePushMessage'),
    dark: true,
    cancel: { flat: true, label: t('common.cancel'), color: 'grey-5' },
    ok: { flat: true, label: t('git.forcePush'), color: 'primary' },
  }).onOk(async () => {
    if (!props.workspace) return
    try {
      const res = await fetch(`/api/workspaces/${props.workspace.id}/force-push`, { method: 'POST' })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error ?? 'Failed')
      }
      $q.notify({ type: 'positive', message: t('git.changeSourceForcePushDone'), position: 'top' })
      loadGitStats()
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed'
      $q.notify({ type: 'negative', message: msg, position: 'top', timeout: 6000 })
    }
  })
}

async function handleChangeSourceBranch() {
  if (!props.workspace) return
  $q.dialog({
    title: t('git.changeSourceBranchTitle'),
    message: t('git.changeSourceBranchMessage'),
    prompt: { model: '', type: 'text' },
    dark: true,
    cancel: { flat: true, label: t('common.cancel'), color: 'grey-5' },
    ok: { flat: true, label: t('common.save'), color: 'primary' },
  }).onOk(async (newBase: string) => {
    if (!newBase.trim() || !props.workspace) return
    changingSource.value = true
    // Persistent spinner toast — the operation (full fetch + cherry-pick) can
    // take several seconds; dismissed in `finally` once it resolves.
    const dismissLoader = $q.notify({
      group: false,
      spinner: true,
      message: t('git.changeSourceBranchLoading'),
      position: 'top',
      timeout: 0,
    })
    try {
      const res = await fetch(`/api/workspaces/${props.workspace.id}/change-source-branch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newBase: newBase.trim() }),
      })
      const data = await res.json()
      if (!res.ok) {
        const msg =
          data.code === 'too_many_commits'
            ? t('git.changeSourceBranchTooMany', { n: data.commitCount ?? 0 })
            : data.code === 'dirty_worktree'
              ? t('git.changeSourceBranchDirty')
              : data.code === 'agent_running'
                ? t('git.changeSourceBranchAgentRunning')
                : (data.error ?? 'Failed')
        // The server attaches `ongoingOperation` (cherry-pick / merge / rebase)
        // when a partial git state was left behind (typically a custom script
        // that crashed mid-flight). Route to the abort-aware dialog so the
        // user can clean up in one click instead of dropping to a terminal.
        if (
          data.ongoingOperation === 'cherry-pick' ||
          data.ongoingOperation === 'merge' ||
          data.ongoingOperation === 'rebase'
        ) {
          openSourceChangeErrorDialog(msg, data.ongoingOperation)
        } else {
          $q.notify({ type: 'negative', message: msg, position: 'top', timeout: 6000 })
        }
        return
      }
      // The server updated source_branch for every ok status (done / aligned /
      // conflict). Mirror it into the store so the GitPanel header reflects the
      // new source branch immediately — without waiting for the pr-watcher poll.
      if (props.workspace) {
        store.updateWorkspaceFromEvent(props.workspace.id, { sourceBranch: newBase.trim() })
      }
      if (data.status === 'conflict') {
        openConflictDialog('cherry-pick', [])
      } else {
        const key = data.status === 'aligned' ? 'git.changeSourceBranchAligned' : 'git.changeSourceBranchDone'
        $q.notify({ type: 'positive', message: t(key, { branch: newBase.trim() }), position: 'top' })
        if (data.forcePushNeeded) promptForcePush()
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed'
      $q.notify({ type: 'negative', message: msg, position: 'top', timeout: 6000 })
    } finally {
      dismissLoader()
      changingSource.value = false
      loadGitStats()
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
      message: t('git.prCreated', { n: result.prNumber, request: forge.value.capabilities.requestTermShort }),
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

<style lang="scss" scoped>
.git-btn {
  font-size: 11px;
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
.arrow-clickable {
  transition: opacity 0.15s;
}
.arrow-clickable:hover {
  opacity: 0.75;
  text-decoration: underline;
}
.git-subcard {
  background: #1f2538;
  border-radius: 4px;
  padding: 8px 10px;
  margin-bottom: 8px;
}

.git-subcard-title {
  color: #6b7280;
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  margin-bottom: 6px;
}
</style>

<!-- Non-scoped: .git-branch-code is also rendered inside Quasar dialogs
     (message html:true) which teleport their DOM outside this component,
     so a scoped rule wouldn't reach them. -->
<style lang="scss">
.git-branch-code {
  font-family: 'Roboto Mono', monospace;
  font-size: 11px;
  padding: 1px 5px;
  border-radius: 3px;
  background-color: rgba(129, 140, 248, 0.14);
  color: #c7d2fe;
  // Long branch names (e.g. `feature/<TK-id>--<long-slug>`) used to force a
  // horizontal scrollbar inside the push/merge/rebase dialogs because of
  // `white-space: nowrap`. `overflow-wrap: anywhere` keeps short names on
  // a single line and only breaks when the container would otherwise overflow.
  overflow-wrap: anywhere;
}
</style>
