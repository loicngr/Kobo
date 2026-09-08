import { type Config, type Driver, type DriveStep, driver } from 'driver.js'
import 'driver.js/dist/driver.css'
import { anchorSelector, waitForVisible } from 'src/tours/dom'
import { findTour, TOURS } from 'src/tours/registry'
import type { RunOptions, TourDefinition, TourId, TourStatus, TourStep } from 'src/tours/types'
import { getCurrentInstance, nextTick, onBeforeUnmount, reactive, readonly } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'

export const SEEN_STORAGE_KEY = 'kobo:tours'
/** Delay before a page auto-runs its tour, so its anchors are rendered first. */
export const AUTO_RUN_DELAY_MS = 400
/** A single retry for an auto-run refused because a dialog was open (a save prompt, a picker...). */
export const DIALOG_RETRY_DELAY_MS = 1500
const LEGACY_FLAG = 'kobo:onboarding-done'

type SeenMap = Partial<Record<TourId, string[]>>

function readSeen(): SeenMap {
  try {
    const raw = localStorage.getItem(SEEN_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const out: SeenMap = {}
    for (const [id, ids] of Object.entries(parsed)) {
      if (Array.isArray(ids)) out[id as TourId] = ids.filter((x): x is string => typeof x === 'string')
    }
    return out
  } catch {
    return {}
  }
}

/** Module-level so the layout, the pages and the Help menu share one state and one driver. */
const seen = reactive<SeenMap>(readSeen())
let driverObj: Driver | undefined
/** Number of `runTour` calls in flight (from their synchronous start until their driver exists), so a racing auto-run bails. */
let starting = 0
/** Auto-runs refused because a tour was running; drained one at a time, in registry order, as tours complete. */
const pendingAutoRuns = new Set<TourId>()
/** True while a previous driver is being destroyed on purpose, so that tour's `onDestroyed` stays inert. */
let replacing = false

/** Reload the in-memory state from storage and drop the driver. Test-only. */
export function _resetToursStateForTests(): void {
  for (const key of Object.keys(seen) as TourId[]) delete seen[key]
  Object.assign(seen, readSeen())
  discardDriver()
  starting = 0
  pendingAutoRuns.clear()
  replacing = false
}

/** Destroy the current driver without running its tour's completion logic. */
function discardDriver(): void {
  replacing = true
  try {
    driverObj?.destroy()
  } finally {
    replacing = false
    driverObj = undefined
  }
}

function persist(): void {
  try {
    localStorage.setItem(SEEN_STORAGE_KEY, JSON.stringify(seen))
  } catch {
    // Storage may be unavailable (private mode); the tours simply replay next time.
  }
}

/** Steps whose gate depends on application state, not on the rendered page. */
function stateGatedSteps(tour: TourDefinition): TourStep[] {
  return tour.steps.filter((s) => s.gate !== 'dom')
}

/** Steps a run can show at most: DOM-gated ones are left out since they depend on the page. */
export function countRunnableSteps(tour: TourDefinition): number {
  return stateGatedSteps(tour).length
}

/** Steps that apply right now: gated ones dropped, seen ones dropped when asked. */
function applicableSteps(tour: TourDefinition, onlyUnseen: boolean): TourStep[] {
  const seenIds = new Set(seen[tour.id] ?? [])
  return tour.steps.filter((s) => (s.when?.() ?? true) && (!onlyUnseen || !seenIds.has(s.id)))
}

/** The first pending auto-run in registry order, removed from the queue. */
function takePendingAutoRun(): TourId | undefined {
  const next = TOURS.find((t) => pendingAutoRuns.has(t.id))
  if (next) pendingAutoRuns.delete(next.id)
  return next?.id
}

export function useTours() {
  const { t } = useI18n()
  const router = useRouter()
  // Captured once: a later watcher callback has no current instance, yet its timer must die with the host.
  const instance = getCurrentInstance()
  /** The single pending auto-run timer of this composable; re-arming replaces it. */
  let autoRunTimer: ReturnType<typeof setTimeout> | undefined
  if (instance) onBeforeUnmount(() => clearTimeout(autoRunTimer), instance)

  function markSeen(id: TourId, stepIds: string[]): void {
    // Merge with storage first: another tab may have marked steps since this one loaded.
    const stored = readSeen()
    for (const [tourId, ids] of Object.entries(stored) as [TourId, string[]][]) {
      seen[tourId] = [...new Set([...(seen[tourId] ?? []), ...ids])]
    }
    seen[id] = [...new Set([...(seen[id] ?? []), ...stepIds])]
    persist()
  }

  function status(id: TourId): TourStatus {
    const tour = findTour(id)
    if (!tour) return 'unseen'
    const seenIds = new Set(seen[id] ?? [])
    // DOM gates depend on the page the user is on; only state gates are deterministic here.
    const gated = stateGatedSteps(tour).filter((s) => s.when?.() ?? true)
    const count = gated.filter((s) => seenIds.has(s.id)).length
    // Every step gated out means nothing is left to run: report it as seen.
    if (count === gated.length) return 'seen'
    return count === 0 ? 'unseen' : 'partial'
  }

  function isRunning(): boolean {
    return driverObj?.isActive() ?? false
  }

  /** The pre-tours boolean flag: a user who had it has seen the home tour, nothing else. */
  function migrateLegacyFlag(): void {
    try {
      if (localStorage.getItem(LEGACY_FLAG) !== '1') return
      const home = findTour('home')
      if (home)
        markSeen(
          'home',
          home.steps.map((s) => s.id),
        )
      localStorage.removeItem(LEGACY_FLAG)
    } catch {
      // Unreadable storage: nothing to migrate.
    }
  }

  /** Run `step`'s preparation, then report whether its anchor is on screen. */
  async function prepareStep(step: TourStep): Promise<boolean> {
    await step.beforeShow?.()
    if (await waitForVisible(anchorSelector(step.anchor))) return true
    console.warn(`[tours] anchor not visible, skipping: ${step.anchor}`)
    return false
  }

  /**
   * Driver steps for `steps`, with `finished` reporting whether a forward move ran out of
   * visible anchors (the tour then ends as completed rather than abandoned).
   */
  function buildDriveSteps(steps: TourStep[], finished: { value: boolean }): DriveStep[] {
    let busy = false
    // Prepare the step at `from`, skipping in `direction` past invisible anchors; a second click while in flight is ignored.
    const moveTo = async (from: number, direction: 1 | -1, drv: Driver): Promise<void> => {
      if (busy) return
      busy = true
      try {
        for (let index = from; index >= 0 && index < steps.length; index += direction) {
          const step = steps[index]
          if (step && (await prepareStep(step))) {
            drv.moveTo(index)
            return
          }
        }
        // Nothing left forward: the tour is over. Nothing left backward: stay put.
        if (direction === 1) {
          finished.value = true
          drv.destroy()
        }
      } finally {
        busy = false
      }
    }
    return steps.map((step, index) => ({
      element: anchorSelector(step.anchor),
      popover: {
        title: t(`${step.i18nKey}.title`),
        description: t(`${step.i18nKey}.description`),
        onPrevClick: (_el, _step, opts) => moveTo(index - 1, -1, opts.driver),
        ...(index < steps.length - 1 ? { onNextClick: (_el, _step, opts) => moveTo(index + 1, 1, opts.driver) } : {}),
      },
    }))
  }

  /** Start `id` from scratch, navigating to its page first. Never rejects: failures are logged. */
  async function runTour(id: TourId, options: RunOptions = {}): Promise<void> {
    const tour = findTour(id)
    if (!tour) return
    starting++
    try {
      // Another tour owns the screen: drop it before leaving its page.
      discardDriver()
      if (router.currentRoute.value.name !== tour.route) {
        const failure = await router.push({ name: tour.route })
        // A guard refused or redirected the navigation: the tour's anchors are not on screen.
        if (failure || router.currentRoute.value.name !== tour.route) return
      }
      // Let the page render and prepare its first step (its anchor may live in a closed drawer)
      // before reading the gates, so DOM gates see the rendered page.
      await nextTick()
      const first = tour.steps[0]
      const firstVisible = first ? await prepareStep(first) : false
      const steps = applicableSteps(tour, options.onlyUnseen ?? false)
      // Drop leading steps whose anchor never shows up; the first one was already prepared above.
      while (steps[0] && !(steps[0] === first ? firstVisible : await prepareStep(steps[0]))) steps.shift()
      if (steps.length === 0) return
      driverObj = driver(buildConfig(tour, steps))
      driverObj.drive()
    } catch (err) {
      console.error('[tours]', err)
    } finally {
      starting--
      // Ended without a driver (nothing to show, navigation refused...): `onDestroyed` will never
      // drain the auto-runs this run held back, so hand the next one over here.
      if (starting === 0 && !driverObj) {
        const next = takePendingAutoRun()
        if (next) scheduleAutoRun(next)
      }
    }
  }

  function buildConfig(tour: TourDefinition, steps: TourStep[]): Config {
    const finished = { value: false }
    return {
      showProgress: true,
      progressText: '{{current}} / {{total}}',
      overlayColor: '#000000',
      popoverClass: 'kobo-onboarding-popover',
      nextBtnText: t('tours.next'),
      prevBtnText: t('tours.prev'),
      doneBtnText: t('tours.done'),
      steps: buildDriveSteps(steps, finished),
      // Marked seen when shown, not when the tour ends: leaving mid-way only replays the rest.
      // driver.js passes no element for its dummy target, which is nothing the user has seen.
      onHighlighted: (el, _step, opts) => {
        if (!el) return
        const shown = steps[opts.state.activeIndex ?? 0]
        if (shown) markSeen(tour.id, [shown.id])
      },
      // Native confirm on purpose: driver.js renders above every Quasar layer.
      onDestroyStarted: (_el, _step, opts) => {
        if (!opts.driver.hasNextStep() || window.confirm(t('tours.exitConfirm'))) {
          opts.driver.destroy()
        }
      },
      // driver.js resets its state before this hook but hands over a snapshot,
      // which is the only way left to tell "closed on the last step" from "abandoned".
      onDestroyed: (_el, _step, opts) => {
        // Replaced by another tour: neither done nor abandoned, another tour owns the screen.
        if (replacing) return
        if (!finished.value && opts.state.activeIndex !== steps.length - 1) {
          // Abandoned (the user declined a tour): it never auto-runs again, only a replay
          // from the Help menu shows it, and the queued auto-runs are not piled on top.
          markSeen(
            tour.id,
            tour.steps.map((s) => s.id),
          )
          pendingAutoRuns.clear()
          return
        }
        tour.onDone?.(router)
        const next = takePendingAutoRun()
        if (next) scheduleAutoRun(next)
      },
    }
  }

  /**
   * First-visit auto-run: unseen steps only. It never navigates (the user may have left
   * the tour's page by the time a delayed call fires; only `runTour` may navigate), never
   * stacks over a running tour (queued and drained when that tour completes) and never opens
   * over a dialog (one retry after `DIALOG_RETRY_DELAY_MS`). Never rejects: failures are logged.
   */
  async function autoRun(id: TourId, retryOnDialog = true): Promise<void> {
    if (starting > 0 || isRunning()) {
      pendingAutoRuns.add(id)
      return
    }
    if (document.querySelector('.q-dialog')) {
      console.debug(`[tours] auto-run deferred, dialog open: ${id}`)
      if (retryOnDialog) setTimeout(() => void autoRun(id, false), DIALOG_RETRY_DELAY_MS)
      return
    }
    const tour = findTour(id)
    if (!tour || router.currentRoute.value.name !== tour.route) return
    try {
      await runTour(id, { onlyUnseen: true })
    } catch (err) {
      console.error('[tours]', err)
    }
  }

  /**
   * Arm a delayed `autoRun`, replacing any timer this composable already armed. When
   * `useTours()` was called from a component, the timer is cleared on that component's
   * unmount - even when armed later from a watcher callback - and an arm requested after
   * the unmount is ignored, so a tour never starts on a page the user has already left.
   */
  function scheduleAutoRun(id: TourId, delayMs = AUTO_RUN_DELAY_MS): void {
    if (instance?.isUnmounted) return
    clearTimeout(autoRunTimer)
    autoRunTimer = setTimeout(() => void autoRun(id), delayMs)
  }

  async function resetAll(): Promise<void> {
    for (const key of Object.keys(seen) as TourId[]) delete seen[key]
    try {
      localStorage.removeItem(SEEN_STORAGE_KEY)
    } catch {
      // Storage may be unavailable; the in-memory state is cleared anyway.
    }
    await runTour('home')
  }

  return {
    tours: TOURS,
    seen: readonly(seen),
    status,
    markSeen,
    runTour,
    autoRun,
    scheduleAutoRun,
    resetAll,
    isRunning,
    migrateLegacyFlag,
  }
}
