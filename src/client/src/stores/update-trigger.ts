import { defineStore } from 'pinia'
import { useUpdateStore } from 'src/stores/update'
import { apiFetch } from 'src/utils/api'
import { computed, ref } from 'vue'
import {
  UPDATE_TRIGGER_TERMINAL,
  type UpdateTriggerErrorCode,
  type UpdateTriggerPhase,
  type UpdateTriggerReason,
  type UpdateTriggerState,
} from '../../../shared/update-trigger'

const REQUEST_KEY = 'kobo:update-request'
const POLL_MS = 5000
const POLL_IDLE_MS = 30_000
/** After the last sighting of our update, how long an unknown request may be a restart in progress. */
const RESTART_GRACE_MS = 5 * 60_000
/** The server drops a pending request after 180 s: past this, a pending request is someone else's. */
const PENDING_MINE_MS = 190_000
/** An unbroken run of failing status requests this old means the update can no longer be followed. */
const FAILURE_LIMIT_MS = 10 * 60_000
const ENDPOINT = '/api/maintenance/update-trigger'

export type UpdateTriggerStep =
  | 'idle'
  | 'waiting'
  | 'building'
  | 'stopping-agents'
  | 'restarting'
  | 'reconnecting'
  | 'done'
  | 'not-started'
  | 'lost'
  | 'other'
  | 'result'

/** A new server phase or reason fails type-checking here until it has a message. */
const PHASE_STEP = {
  accepted: 'waiting',
  building: 'building',
  'stopping-agents': 'stopping-agents',
  restarting: 'restarting',
  complete: 'result',
  'up-to-date': 'result',
  refused: 'result',
  aborted: 'result',
  'recovery-required': 'result',
} as const satisfies Record<UpdateTriggerPhase, UpdateTriggerStep>

const STEP_KEY = {
  waiting: 'updateTrigger.step.waiting',
  building: 'updateTrigger.step.building',
  'stopping-agents': 'updateTrigger.step.stoppingAgents',
  restarting: 'updateTrigger.step.restarting',
  reconnecting: 'updateTrigger.step.reconnecting',
  lost: 'updateTrigger.result.lost',
  other: 'updateTrigger.otherInProgress',
  'not-started': 'updateTrigger.result.notStarted',
} as const satisfies Partial<Record<UpdateTriggerStep, string>>

const RESULT_KEY = {
  complete: 'updateTrigger.result.completeNoVersion',
  'up-to-date': 'updateTrigger.result.upToDate',
  aborted: 'updateTrigger.result.aborted',
  'recovery-required': 'updateTrigger.result.recoveryRequired',
} as const satisfies Partial<Record<UpdateTriggerPhase, string>>

export const REASON_KEY = {
  busy: 'updateTrigger.reason.busy',
  'already-running': 'updateTrigger.reason.alreadyRunning',
  'interrupted-update': 'updateTrigger.reason.interruptedUpdate',
  'legacy-runtime': 'updateTrigger.reason.legacyRuntime',
  unknown: 'updateTrigger.reason.unknown',
} as const satisfies Record<UpdateTriggerReason, string>

/** Text of a refused request; a new server code fails type-checking here until it has one. */
export const ERROR_KEY = {
  busy: REASON_KEY.busy,
  pending: REASON_KEY['already-running'],
  'in-progress': REASON_KEY['already-running'],
  unavailable: 'updateTrigger.error.unavailable',
  'not-allowed': 'updateTrigger.error.notAllowed',
} as const satisfies Record<UpdateTriggerErrorCode, string>

interface Stored {
  id: string
  /** Running version at the click, null when it was unknown. */
  version: string | null
  /** Last time this request was seen in progress, or answers resumed after failed requests (epoch ms). */
  seenAt: number | null
  /** When the current unbroken run of failed status requests began (epoch ms). */
  failingSince: number | null
  /** When the server accepted the click (epoch ms); null in values stored before it existed: long ago. */
  clickedAt: number | null
}

function load(): Stored | null {
  try {
    const raw = sessionStorage.getItem(REQUEST_KEY)
    const value = raw ? (JSON.parse(raw) as Partial<Stored>) : null
    if (!value || typeof value.id !== 'string') return null
    return {
      id: value.id,
      version: typeof value.version === 'string' ? value.version : null,
      seenAt: typeof value.seenAt === 'number' ? value.seenAt : null,
      failingSince: typeof value.failingSince === 'number' ? value.failingSince : null,
      clickedAt: typeof value.clickedAt === 'number' ? value.clickedAt : null,
    }
  } catch {
    return null
  }
}

function save(value: Stored | null): void {
  try {
    if (value) sessionStorage.setItem(REQUEST_KEY, JSON.stringify(value))
    else sessionStorage.removeItem(REQUEST_KEY)
  } catch {
    /* Storage can be blocked: the page keeps working for this tab's lifetime. */
  }
}

/** The update request of this browser tab, and what the host-side updater reports about it. */
export const useUpdateTriggerStore = defineStore('update-trigger', () => {
  const update = useUpdateStore()
  const initial = load()
  const state = ref<UpdateTriggerState | null>(null)
  const requestId = ref<string | null>(initial?.id ?? null)
  const startVersion = ref<string | null>(initial?.version ?? null)
  const seenAt = ref<number | null>(initial?.seenAt ?? null)
  const failingSince = ref<number | null>(initial?.failingSince ?? null)
  const clickedAt = ref<number | null>(initial?.clickedAt ?? null)
  /** True while the last refresh failed (network error, 5xx, 401 after the restart). */
  const failing = ref(false)
  /** Clock for the restart grace period; moved by every refresh so computeds stay reactive. */
  const nowMs = ref(Date.now())
  let latestCall = 0
  let inFlight = 0
  let polling = false
  let generation = 0
  let timer: ReturnType<typeof setTimeout> | null = null

  function persist(): void {
    save(
      requestId.value
        ? {
            id: requestId.value,
            version: startVersion.value,
            seenAt: seenAt.value,
            failingSince: failingSince.value,
            clickedAt: clickedAt.value,
          }
        : null,
    )
  }

  function markSeen(): void {
    seenAt.value = Date.now()
    persist()
  }

  const ownStatus = computed(() => (state.value?.status?.id === requestId.value ? state.value.status : null))

  const versionChanged = computed(
    () => !!startVersion.value && !!update.currentVersion && update.currentVersion !== startVersion.value,
  )

  const graceOver = (since: number) => nowMs.value - since >= RESTART_GRACE_MS

  /** What the server reports about our request, ignoring whether the last refresh failed. */
  const baseStep = computed<UpdateTriggerStep>(() => {
    const server = state.value
    const status = ownStatus.value
    if (!server) return 'waiting'
    // Past the server's expiry a pending request is another tab's: ours is then unknown to the server.
    if (server.pending && nowMs.value - (clickedAt.value ?? 0) < PENDING_MINE_MS) return 'waiting'
    // The server only reports `inProgress` with a status: in progress and not ours is another update.
    if (server.inProgress && server.status?.id !== requestId.value) return 'other'
    // A non-terminal status is never success, whatever the version: the updater may still fail.
    if (status) return server.inProgress ? PHASE_STEP[status.phase] : 'lost'
    // The server knows nothing about the request: a restart may have dropped it, and the final
    // report may still be adopted. A changed version is announced once that report had time to come,
    // counted from the last sighting, or from the click for a request never seen in progress.
    if (!versionChanged.value) {
      if (seenAt.value === null) return 'not-started'
      return graceOver(seenAt.value) ? 'lost' : 'reconnecting'
    }
    return graceOver(seenAt.value ?? clickedAt.value ?? 0) ? 'done' : 'reconnecting'
  })

  const step = computed<UpdateTriggerStep>(() => {
    const server = state.value
    // Another tab or operator: something is pending or running that this tab did not request.
    if (!requestId.value) return server && (server.pending || server.inProgress) ? 'other' : 'idle'
    const status = ownStatus.value
    if (status && UPDATE_TRIGGER_TERMINAL.includes(status.phase)) {
      // A new version may run after a failed update (recovery needed): only `complete` is success.
      return status.phase === 'complete' && versionChanged.value ? 'done' : 'result'
    }
    const base = baseStep.value
    if (!failing.value) return base
    // Failing requests: an outcome already shown stays; otherwise reconnecting for at most 10 minutes.
    if (base === 'lost' || base === 'not-started' || base === 'done') return base
    return failingSince.value !== null && nowMs.value - failingSince.value > FAILURE_LIMIT_MS ? 'lost' : 'reconnecting'
  })

  const finished = computed(() => ['done', 'not-started', 'lost', 'result'].includes(step.value))

  /** i18n key and params of the line describing the current step, or null when idle. */
  const message = computed<{ key: string; params?: Record<string, string> } | null>(() => {
    const current = step.value
    if (current === 'idle') return null
    if (current === 'done')
      return { key: 'updateTrigger.result.complete', params: { version: update.currentVersion ?? '' } }
    if (current === 'result') {
      const status = ownStatus.value
      if (!status) return null
      if (status.phase === 'refused') return { key: REASON_KEY[status.reason ?? 'unknown'] }
      return { key: RESULT_KEY[status.phase as keyof typeof RESULT_KEY] }
    }
    return { key: STEP_KEY[current] }
  })

  /** Our status is terminal, or the server no longer knows our request: the version decides the step. */
  function versionDecides(next: UpdateTriggerState): boolean {
    if (!requestId.value) return false
    if (next.status?.id === requestId.value) return UPDATE_TRIGGER_TERMINAL.includes(next.status.phase)
    const pendingMine = next.pending && Date.now() - (clickedAt.value ?? 0) < PENDING_MINE_MS
    return !next.inProgress && !pendingMine
  }

  async function refresh(): Promise<void> {
    const call = ++latestCall
    inFlight++
    try {
      const next = await apiFetch<UpdateTriggerState>(ENDPOINT)
      if (call !== latestCall) return
      // The running version only changes once the new process is up: it must be known before
      // a `complete` status is shown, or the page would name the old version.
      if (versionDecides(next)) await update.refreshSnapshot()
      if (call !== latestCall) return
      state.value = next
      failing.value = false
      nowMs.value = Date.now()
      if (failingSince.value !== null) {
        failingSince.value = null
        // A drop may outlast the grace: the final report gets the whole grace again from here.
        if (seenAt.value !== null) seenAt.value = nowMs.value
        persist()
      }
      if (requestId.value && next.inProgress && next.status?.id === requestId.value) markSeen()
    } catch {
      if (call !== latestCall) return
      failing.value = true
      nowMs.value = Date.now()
      if (requestId.value && failingSince.value === null) {
        failingSince.value = nowMs.value
        persist()
      }
    } finally {
      inFlight--
    }
  }

  async function start(input: { skipBackup: boolean; stopAgents: boolean }): Promise<void> {
    const { id } = await apiFetch<{ id: string }>(ENDPOINT, { method: 'POST', body: input })
    requestId.value = id
    startVersion.value = null
    seenAt.value = null
    failingSince.value = null
    failing.value = false
    // Until the refresh answers, the request is known to be waiting: the pre-click state says nothing,
    // so an answer to a status request sent before the click is discarded.
    latestCall++
    state.value = {
      available: true,
      runningAgents: 0,
      busy: false,
      allowSkipBackup: false,
      allowStopAgents: false,
      ...state.value,
      pending: true,
      inProgress: false,
      status: null,
    }
    nowMs.value = Date.now()
    // Taken after the POST answered: the server's 180 s expiry cannot end after our window.
    clickedAt.value = nowMs.value
    persist()
    // A stale tab's snapshot may predate an earlier update: capture the version running now.
    await update.refreshSnapshot()
    if (requestId.value !== id) return
    startVersion.value = update.currentVersion
    persist()
    await refresh()
  }

  function dismiss(): void {
    requestId.value = null
    startVersion.value = null
    seenAt.value = null
    failingSince.value = null
    clickedAt.value = null
    persist()
  }

  const onVisible = () => {
    if (!document.hidden) void refresh()
  }

  function nextDelay(): number {
    return state.value?.available === false && !requestId.value ? POLL_IDLE_MS : POLL_MS
  }

  async function tick(chain: number): Promise<void> {
    // A refresh still in flight is not superseded: that tick is skipped.
    if (!document.hidden && inFlight === 0) await refresh()
    // A stop then start during the await began a newer chain: this one ends.
    if (polling && chain === generation) timer = setTimeout(() => void tick(chain), nextDelay())
  }

  function startPolling(): void {
    if (polling) return
    polling = true
    generation++
    document.addEventListener('visibilitychange', onVisible)
    void tick(generation)
  }

  function stopPolling(): void {
    polling = false
    generation++
    if (timer) clearTimeout(timer)
    timer = null
    document.removeEventListener('visibilitychange', onVisible)
  }

  return { state, requestId, step, finished, message, failing, refresh, start, dismiss, startPolling, stopPolling }
})
