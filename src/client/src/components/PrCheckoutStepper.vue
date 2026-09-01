<template>
  <q-dialog :model-value="modelValue" persistent @update:model-value="onDialogUpdate">
    <q-card dark style="min-width: 560px; max-width: 720px; width: 100%;">
      <q-card-section>
        <div class="text-subtitle1 text-kobo-1">{{ $t('prCheckout.title') }}</div>
      </q-card-section>

      <q-separator dark />

      <!-- No steps at all: nothing to ask, apply immediately. -->
      <q-card-section v-if="loading || (report && steps.length === 0)" class="row justify-center q-pa-xl">
        <q-spinner color="primary" size="var(--kobo-space-2xl)" />
      </q-card-section>

      <!-- Blocked: only Cancel (+ Retry for index-lock). -->
      <template v-else-if="report && steps.length > 0 && steps[0].id === 'blocked'">
        <q-card-section class="column q-gutter-y-sm">
          <div class="text-body2 text-kobo-1">{{ $t(blockedReasonKey) }}</div>
        </q-card-section>
        <q-separator dark />
        <q-card-actions align="right" class="q-pa-md">
          <q-btn v-if="hasIndexLockBlocker" flat no-caps :label="$t('prCheckout.retry')" color="kobo-2" :loading="loading" @click="retryDiagnose" />
          <q-btn flat no-caps :label="$t('prCheckout.cancel')" color="kobo-2" @click="close" />
        </q-card-actions>
      </template>

      <!-- Interactive stepper. -->
      <template v-else-if="report && steps.length > 0">
        <q-card-section v-if="staleNotice" class="q-pb-none">
          <div class="text-caption text-warning">{{ $t('prCheckout.staleReloaded') }}</div>
        </q-card-section>

        <q-card-section v-if="applyError" class="q-pb-none">
          <div class="text-caption text-negative">{{ applyError }}</div>
        </q-card-section>

        <q-card-section>
          <q-stepper v-model="currentStepIndex" flat dark animated header-nav color="primary" class="bg-transparent">
            <q-step
              v-for="(step, idx) in steps"
              :key="step.id"
              :name="idx"
              :title="$t(step.titleKey)"
              :done="idx < currentStepIndex"
            >
              <!-- workspace -->
              <template v-if="step.id === 'workspace'">
                <div class="text-caption text-kobo-3 q-mb-sm">{{ $t('prCheckout.workspace.activeHint') }}</div>
                <q-option-group
                  v-if="report.workspace.state === 'active'"
                  v-model="decisions.existingWorkspace"
                  dark
                  color="primary"
                  :options="[
                    { label: $t('prCheckout.workspace.open'), value: 'open' },
                    { label: $t('prCheckout.workspace.continue'), value: 'continue' },
                  ]"
                />
                <q-option-group
                  v-else-if="report.workspace.state === 'archived'"
                  v-model="decisions.archivedWorkspace"
                  dark
                  color="primary"
                  :options="[
                    { label: $t('prCheckout.workspace.unarchive'), value: 'unarchive' },
                    { label: $t('prCheckout.workspace.continue'), value: 'continue' },
                  ]"
                />
                <q-option-group
                  v-else-if="report.workspace.state === 'purged'"
                  v-model="decisions.purgedWorktree"
                  dark
                  color="primary"
                  :options="[{ label: $t('prCheckout.workspace.restore'), value: 'restore' }]"
                />
              </template>

              <!-- worktree -->
              <template v-else-if="step.id === 'worktree'">
                <div class="text-caption text-kobo-3 q-mb-sm">{{ $t('prCheckout.worktree.orphanHint', { path: orphanWorktreePath }) }}</div>
                <q-option-group
                  v-model="decisions.orphanWorktree"
                  dark
                  color="primary"
                  :options="[
                    { label: $t('prCheckout.worktree.attach'), value: 'attach' },
                    { label: $t('prCheckout.worktree.createElsewhere'), value: 'create-elsewhere' },
                  ]"
                />
              </template>

              <!-- path -->
              <template v-else-if="step.id === 'path'">
                <q-input
                  v-model="pathCollisionInput"
                  dark
                  dense
                  outlined
                  :label="$t('prCheckout.step.path')"
                  :error="needsPathInput"
                  :error-message="$t('prCheckout.path.required')"
                  @update:model-value="onPathCollisionInput"
                />
              </template>

              <!-- operation -->
              <template v-else-if="step.id === 'operation'">
                <div class="text-caption text-kobo-3 q-mb-sm">{{ $t('prCheckout.operation.hint') }}</div>
                <q-option-group
                  v-model="decisions.ongoingOperation"
                  dark
                  color="primary"
                  :options="[
                    { label: $t('prCheckout.operation.abort'), value: 'abort' },
                    { label: $t('prCheckout.operation.cancel'), value: 'cancel' },
                  ]"
                />
              </template>

              <!-- changes -->
              <template v-else-if="step.id === 'changes'">
                <div class="text-caption text-kobo-3 q-mb-sm">{{ $t('prCheckout.changes.hint') }}</div>
                <q-option-group
                  v-model="decisions.localChanges"
                  dark
                  color="primary"
                  :options="[
                    { label: $t('prCheckout.changes.stash'), value: 'stash' },
                    { label: $t('prCheckout.changes.commit'), value: 'commit' },
                    { label: $t('prCheckout.changes.discard'), value: 'discard' },
                    { label: $t('prCheckout.changes.keep'), value: 'keep' },
                  ]"
                />
              </template>

              <!-- divergence -->
              <template v-else-if="step.id === 'divergence'">
                <div class="text-caption text-kobo-3 q-mb-sm">{{ $t(divergenceHintKey) }}</div>
                <q-option-group
                  v-model="decisions.divergence"
                  dark
                  color="primary"
                  :options="divergenceOptions"
                />
              </template>
            </q-step>
          </q-stepper>
        </q-card-section>
      </template>

      <q-separator dark />

      <q-card-actions v-if="report && steps.length > 0 && steps[0].id !== 'blocked'" align="right" class="q-pa-md">
        <q-btn flat no-caps :label="$t('prCheckout.cancel')" color="kobo-2" :disable="applying" @click="close" />
        <q-btn
          unelevated
          no-caps
          :label="$t('prCheckout.apply')"
          color="primary"
          :loading="applying"
          :disable="needsPathInput"
          @click="apply"
        />
      </q-card-actions>
    </q-card>
  </q-dialog>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  type CheckoutStep,
  defaultDecisions,
  deriveSteps,
  type PrCheckoutDecisions,
  type PrCheckoutReport,
} from '../utils/pr-checkout-steps'
import type { PullRequestSummary } from './PrPickerDialog.vue'

const props = defineProps<{
  modelValue: boolean
  projectPath: string
  pr: PullRequestSummary
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  resolved: [result: { worktreePath: string; workingBranch: string; sourceBranch: string; applied: unknown[] }]
  openWorkspace: [workspaceId: string]
}>()

const { t } = useI18n()

const loading = ref(false)
const applying = ref(false)
const applyError = ref<string | null>(null)
const staleNotice = ref(false)

const report = ref<PrCheckoutReport | null>(null)
// Named distinctly from the `pr` prop: this holds the PR as re-confirmed by
// the diagnosis response, which can differ subtly from the prop if the
// picker's cached summary was stale.
const diagnosedPr = ref<PullRequestSummary | null>(null)
const fingerprint = ref<string>('')
const steps = ref<CheckoutStep[]>([])
const decisions = reactive<PrCheckoutDecisions>({})
const currentStepIndex = ref(0)
const pathCollisionInput = ref('')

// Bounds the 409-triggered re-diagnose loop in apply(): if the server keeps
// returning a stale-fingerprint 409 on every retry (e.g. a repository state
// that never stabilizes between calls), we must stop instead of cycling
// apply() -> 409 -> runDiagnose() -> empty steps -> apply() forever. 3 gives
// the legitimate "state changed once or twice while the user was deciding"
// case room to settle before giving up.
const staleRetryCount = ref(0)
const MAX_STALE_RETRIES = 3

function resetState() {
  loading.value = false
  applying.value = false
  applyError.value = null
  staleNotice.value = false
  report.value = null
  diagnosedPr.value = null
  fingerprint.value = ''
  steps.value = []
  currentStepIndex.value = 0
  pathCollisionInput.value = ''
  staleRetryCount.value = 0
  for (const key of Object.keys(decisions) as Array<keyof PrCheckoutDecisions>) {
    delete decisions[key]
  }
}

function applyReport(nextReport: PrCheckoutReport, nextPr: PullRequestSummary | null, nextFingerprint: string) {
  report.value = nextReport
  if (nextPr) diagnosedPr.value = nextPr
  fingerprint.value = nextFingerprint
  steps.value = deriveSteps(nextReport)
  const nextDecisions = defaultDecisions(nextReport)
  for (const key of Object.keys(decisions) as Array<keyof PrCheckoutDecisions>) {
    delete decisions[key]
  }
  Object.assign(decisions, nextDecisions)
  pathCollisionInput.value = ''
  currentStepIndex.value = 0
}

// Diagnose is read-only, so it's safe to cancel outright when the dialog
// closes mid-load. `/resolve` (in `apply()` below) is deliberately NOT made
// abortable the same way: it mutates the repository (creates a worktree,
// realigns a branch), and aborting the client-side fetch would not stop the
// server from finishing that work — it would just make the client blind to
// the outcome, potentially leaving a worktree behind with no dialog left to
// show it. The dialog is `persistent` (no ESC/backdrop close) and its own
// Cancel button is unreachable while `applying` is true, so this scenario
// cannot actually occur through this component's own UI today; the asymmetry
// here is deliberate, not an oversight.
let diagnoseController: AbortController | null = null

async function runDiagnose() {
  diagnoseController?.abort()
  const controller = new AbortController()
  diagnoseController = controller

  loading.value = true
  applyError.value = null
  try {
    const res = await fetch('/api/pull-requests/diagnose', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectPath: props.projectPath, prNumber: props.pr.number }),
      signal: controller.signal,
    })
    const data = (await res.json()) as { report: PrCheckoutReport; pr: PullRequestSummary | null; fingerprint: string }
    applyReport(data.report, data.pr, data.fingerprint)
    if (steps.value.length === 0) {
      // Nothing to ask: apply immediately.
      void apply()
    }
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return
    applyError.value = err instanceof Error ? err.message : t('prCheckout.diagnoseFailed')
  } finally {
    if (diagnoseController === controller) loading.value = false
  }
}

// User-initiated retry from the index-lock blocked screen: a fresh, explicit
// action gets a fresh 409-retry budget.
async function retryDiagnose() {
  staleRetryCount.value = 0
  await runDiagnose()
}

const hasIndexLockBlocker = computed(() => report.value?.blockers.some((b) => b.kind === 'index-lock') ?? false)

const orphanWorktreePath = computed(() => {
  const worktree = report.value?.worktree
  return worktree && worktree.state !== 'none' ? worktree.path : ''
})

// An empty path-collision input silently deletes `decisions.pathCollision`
// (see `onPathCollisionInput`), which makes the server fall back to the exact
// same already-occupied default path — guaranteed to fail again. Block Apply
// until the user has actually typed something for this step.
const needsPathInput = computed(() => steps.value.some((s) => s.id === 'path') && !decisions.pathCollision)

const BLOCKER_KEY_BY_KIND: Record<string, string> = {
  'forge-unavailable': 'prCheckout.blocked.forgeUnavailable',
  'fork-pr': 'prCheckout.blocked.forkPr',
  'head-branch-deleted': 'prCheckout.blocked.headBranchDeleted',
  'index-lock': 'prCheckout.blocked.indexLock',
  'path-occupied': 'prCheckout.blocked.pathOccupied',
  'worktree-other-branch': 'prCheckout.blocked.worktreeOtherBranch',
  'no-common-ancestor': 'prCheckout.blocked.noCommonAncestor',
}

const blockedReasonKey = computed(() => {
  const blockers = report.value?.blockers ?? []
  const first = blockers[0]
  if (!first) return 'prCheckout.step.blocked'
  return BLOCKER_KEY_BY_KIND[first.kind] ?? 'prCheckout.step.blocked'
})

const divergenceHintKey = computed(() => {
  switch (report.value?.branch.state) {
    case 'behind':
      return 'prCheckout.divergence.behindHint'
    case 'ahead':
      return 'prCheckout.divergence.aheadHint'
    case 'diverged':
      return 'prCheckout.divergence.divergedHint'
    default:
      return 'prCheckout.step.divergence'
  }
})

const divergenceOptions = computed(() => {
  const state = report.value?.branch.state
  if (state === 'behind') {
    return [
      { label: t('prCheckout.divergence.fastForward'), value: 'fast-forward' },
      { label: t('prCheckout.divergence.keep'), value: 'keep' },
    ]
  }
  if (state === 'diverged') {
    return [
      { label: t('prCheckout.divergence.rebase'), value: 'rebase' },
      { label: t('prCheckout.divergence.resetHard'), value: 'reset-hard' },
      { label: t('prCheckout.divergence.keep'), value: 'keep' },
    ]
  }
  // 'ahead' (or fallback): only keeping makes sense — there is nothing upstream
  // to fast-forward or rebase onto.
  return [{ label: t('prCheckout.divergence.keep'), value: 'keep' }]
})

function onPathCollisionInput(value: string | number | null) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text) {
    decisions.pathCollision = { worktreePath: text }
  } else {
    delete decisions.pathCollision
  }
}

function close() {
  emit('update:modelValue', false)
}

function onDialogUpdate(value: boolean) {
  emit('update:modelValue', value)
}

async function apply() {
  applyError.value = null

  const currentReport = report.value
  if (!currentReport) return

  // Short-circuit 1: open an already-active workspace, no /resolve call.
  if (decisions.existingWorkspace === 'open' && currentReport.workspace.state === 'active') {
    emit('openWorkspace', currentReport.workspace.id)
    close()
    return
  }

  // Short-circuit 2: unarchive is the caller's job — just signal which workspace.
  if (decisions.archivedWorkspace === 'unarchive' && currentReport.workspace.state === 'archived') {
    emit('openWorkspace', currentReport.workspace.id)
    close()
    return
  }

  // Short-circuit 3: cancel the ongoing operation flow entirely, nothing to apply.
  if (decisions.ongoingOperation === 'cancel') {
    close()
    return
  }

  // Short-circuit 4: restoring a purged workspace has no manual endpoint today
  // — the only existing mechanism is the pr-watcher's automatic 30s poll (see
  // AGENTS.md "Worktree purge" / "Auto-restore on manual recreation"). Calling
  // /resolve here would silently create a SECOND, unrelated worktree/workspace
  // for the same branch instead of restoring the original one — worse than
  // doing nothing, so this stops here with a clear explanation rather than
  // falling through to the generic resolve path.
  if (decisions.purgedWorktree === 'restore' && currentReport.workspace.state === 'purged') {
    applyError.value = t('prCheckout.workspace.restoreNotAvailable')
    return
  }

  applying.value = true
  try {
    const res = await fetch('/api/pull-requests/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectPath: props.projectPath,
        prNumber: props.pr.number,
        headBranch: diagnosedPr.value?.headBranch ?? props.pr.headBranch,
        baseBranch: diagnosedPr.value?.baseBranch ?? props.pr.baseBranch,
        decisions,
        fingerprint: fingerprint.value,
      }),
    })
    const data = await res.json().catch(() => null)

    if (res.status === 409) {
      // The repository state kept changing under us. Bound the retry loop:
      // runDiagnose() auto-calls apply() again when the fresh report has zero
      // steps, so an uninterrupted string of 409s would otherwise cycle
      // apply() -> 409 -> runDiagnose() -> apply() -> ... forever.
      staleRetryCount.value += 1
      if (staleRetryCount.value > MAX_STALE_RETRIES) {
        applyError.value = t('prCheckout.staleRetriesExhausted')
        return
      }

      // The 409 body carries a fresh `report` but no fingerprint (only `/diagnose`
      // computes and returns one) — re-run diagnose to get a matching report +
      // fingerprint pair from the server rather than fabricating one client-side.
      staleNotice.value = true
      await runDiagnose()
      return
    }

    if (!res.ok) {
      applyError.value = (data as { error?: string } | null)?.error ?? `HTTP ${res.status}`
      return
    }

    staleNotice.value = false
    emit('resolved', data as { worktreePath: string; workingBranch: string; sourceBranch: string; applied: unknown[] })
    close()
  } catch (err) {
    applyError.value = err instanceof Error ? err.message : t('prCheckout.resolveFailed')
  } finally {
    applying.value = false
  }
}

watch(
  () => props.modelValue,
  (open) => {
    if (open) {
      resetState()
      void runDiagnose()
    } else {
      diagnoseController?.abort()
    }
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  diagnoseController?.abort()
})
</script>
