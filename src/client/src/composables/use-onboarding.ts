import { type DriveStep, driver } from 'driver.js'
import 'driver.js/dist/driver.css'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'

const ONBOARDING_FLAG = 'kobo:onboarding-done'

/** Whether the first-run onboarding tour has already been shown. */
export function isOnboardingDone(): boolean {
  return localStorage.getItem(ONBOARDING_FLAG) === '1'
}

/** Persist that the onboarding tour has been shown. */
export function markOnboardingDone(): void {
  localStorage.setItem(ONBOARDING_FLAG, '1')
}

/**
 * Settings sections walked through by the tour, in nav order. Each value is a
 * `SettingsPage` tab id; the tour switches to it via the `settings-nav-<id>`
 * entry and highlights the section's `settings-card-<id>` anchor.
 */
const SETTINGS_SECTIONS = [
  'general',
  'agents',
  'skills',
  'prompts',
  'scripts',
  'notion',
  'voice',
  'notifications',
  'worktrees',
  'projects',
  'templates',
  'export',
] as const

/** Resolve once `selector` is in the DOM AND has a layout box, or after `timeout`. */
function waitForVisible(selector: string, timeout = 2000): Promise<void> {
  return new Promise((resolve) => {
    const start = Date.now()
    const tick = () => {
      const el = document.querySelector<HTMLElement>(selector)
      const visible = !!el && (el.offsetWidth > 0 || el.offsetHeight > 0)
      if (visible || Date.now() - start > timeout) resolve()
      else requestAnimationFrame(tick)
    }
    tick()
  })
}

/**
 * Onboarding tour: a driver.js walkthrough that starts on the home screen
 * sidebar, then crosses into the Settings page and highlights each section's
 * key card — engine/model, voice, scripts, projects, export… Auto-runs once on
 * first visit, and can be replayed from Settings.
 */
export function useOnboarding() {
  const { t } = useI18n()
  const router = useRouter()

  let driverObj: ReturnType<typeof driver> | undefined

  /** Switch SettingsPage to `section` and wait until its card is on screen. */
  async function gotoSection(section: string): Promise<void> {
    document.querySelector<HTMLElement>(`[data-tour="settings-nav-${section}"]`)?.click()
    await waitForVisible(`[data-tour="settings-card-${section}"]`)
  }

  function buildSteps(): DriveStep[] {
    const popover = (key: string) => ({
      title: t(`onboarding.${key}.title`),
      description: t(`onboarding.${key}.description`),
    })

    // Home-screen sidebar steps. The last one (`settings`) bridges into the
    // Settings page when the user clicks "Next".
    const homeSteps: DriveStep[] = [
      { element: '[data-tour="workspace-list"]', popover: popover('list') },
      { element: '[data-tour="create-workspace"]', popover: popover('create') },
      { element: '[data-tour="search"]', popover: popover('search') },
      { element: '[data-tour="health"]', popover: popover('health') },
      {
        element: '[data-tour="settings"]',
        popover: {
          ...popover('settings'),
          onNextClick: async () => {
            await router.push('/settings')
            await gotoSection('general')
            driverObj?.moveNext()
          },
        },
      },
    ]

    // Settings-page steps. Each highlights its section's key card; the active
    // tab is switched (and the card awaited) in the neighbouring step's click
    // handler, so the highlight always lands on a visible element.
    const settingsSteps: DriveStep[] = SETTINGS_SECTIONS.map((section, index) => {
      const prev = SETTINGS_SECTIONS[index - 1]
      const next = SETTINGS_SECTIONS[index + 1]
      return {
        element: `[data-tour="settings-card-${section}"]`,
        popover: {
          ...popover(`settings-${section}`),
          onPrevClick: async () => {
            if (prev) {
              await gotoSection(prev)
            } else {
              // First settings step — step back out to the home tour.
              await router.push('/')
              await waitForVisible('[data-tour="workspace-list"]')
            }
            driverObj?.movePrevious()
          },
          // The last step's button is "Done", so it needs no next handler.
          ...(next
            ? {
                onNextClick: async () => {
                  await gotoSection(next)
                  driverObj?.moveNext()
                },
              }
            : {}),
        },
      }
    })

    return [...homeSteps, ...settingsSteps]
  }

  /** Build and run the tour now. */
  async function startTour(): Promise<void> {
    // Replays can be triggered from the Settings page — rewind home first so
    // the home-screen steps have their anchors.
    if (router.currentRoute.value.path !== '/') {
      await router.push('/')
      await waitForVisible('[data-tour="workspace-list"]')
    }
    driverObj = driver({
      showProgress: true,
      progressText: '{{current}} / {{total}}',
      overlayColor: '#000000',
      popoverClass: 'kobo-onboarding-popover',
      nextBtnText: t('onboarding.next'),
      prevBtnText: t('onboarding.prev'),
      doneBtnText: t('onboarding.done'),
      // Confirm before quitting mid-tour (close button, overlay click, Esc).
      // The "Done" button on the last step closes without a prompt. A native
      // confirm is used on purpose: driver.js renders above every app layer
      // (z-index 1e9), so a Quasar dialog would be hidden behind the overlay.
      onDestroyStarted: () => {
        if (!driverObj?.hasNextStep() || window.confirm(t('onboarding.exitConfirm'))) {
          driverObj?.destroy()
        }
      },
      steps: buildSteps(),
    })
    driverObj.drive()
  }

  /**
   * Run the tour once, on the very first visit. Marks the flag immediately so a
   * reload mid-tour doesn't replay it. A short delay lets the sidebar render.
   */
  function maybeStartOnFirstVisit(): void {
    if (isOnboardingDone()) return
    markOnboardingDone()
    setTimeout(() => void startTour(), 500)
  }

  return { startTour, maybeStartOnFirstVisit }
}
