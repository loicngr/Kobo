import { mount } from '@vue/test-utils'
import type { Config, Driver, DriverHook, DriveStep } from 'driver.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { type ComponentInternalInstance, defineComponent, getCurrentInstance, h } from 'vue'
import type { TourDefinition, TourId } from '../tours/types'

const driverInstance = {
  drive: vi.fn(),
  moveNext: vi.fn(),
  movePrevious: vi.fn(),
  moveTo: vi.fn(),
  hasNextStep: vi.fn(() => true),
  destroy: vi.fn(),
  isActive: vi.fn(() => false),
}
const driverFactory = vi.fn((_config: unknown) => driverInstance)
vi.mock('driver.js', () => ({ driver: (config: unknown) => driverFactory(config) }))
vi.mock('driver.js/dist/driver.css', () => ({}))

const push = vi.fn(async (): Promise<unknown> => undefined)
const currentRoute = { value: { name: 'workspace' as string, path: '/' } }
vi.mock('vue-router', () => ({ useRouter: () => ({ push, currentRoute }) }))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (k: string) => k }) }))
// No anchor has a layout box under happy-dom: report every anchor visible so no test burns the 2 s timeout.
vi.mock('../tours/dom', async (orig) => ({
  ...(await orig<typeof import('../tours/dom')>()),
  waitForVisible: vi.fn(async () => true),
}))

// Hoisted: the registry mock factory below reads them eagerly.
const gateC = vi.hoisted(() => ({ value: false }))
const beforeShowA = vi.hoisted(() => vi.fn(async () => {}))
const beforeShowB = vi.hoisted(() => vi.fn(async () => {}))
const TEST_TOURS = vi.hoisted<TourDefinition[]>(() => [
  {
    id: 'home',
    route: 'workspace',
    i18nKey: 'tours.home',
    onDone: (router) => void router.push({ name: 'create' }),
    steps: [
      { id: 'a', anchor: 'a', i18nKey: 'tours.home.a', beforeShow: () => beforeShowA() },
      { id: 'b', anchor: 'b', i18nKey: 'tours.home.b', beforeShow: () => beforeShowB() },
      { id: 'c', anchor: 'c', i18nKey: 'tours.home.c', when: () => gateC.value },
    ],
  },
  {
    id: 'create',
    route: 'workspace',
    i18nKey: 'tours.create',
    steps: [
      { id: 'c1', anchor: 'c1', i18nKey: 'tours.create.c1' },
      // A DOM gate: whether the anchor exists depends on the page, not on the seen state.
      { id: 'c2', anchor: 'c2', i18nKey: 'tours.create.c2', gate: 'dom', when: () => false },
    ],
  },
  {
    id: 'settings',
    route: 'settings',
    i18nKey: 'tours.settings',
    steps: [{ id: 's1', anchor: 's1', i18nKey: 'tours.settings.s1' }],
  },
  {
    id: 'health',
    route: 'workspace',
    i18nKey: 'tours.health',
    steps: [{ id: 'h1', anchor: 'h1', i18nKey: 'tours.health.h1', when: () => false }],
  },
])
vi.mock('../tours/registry', () => ({
  TOURS: TEST_TOURS,
  findTour: (id: string) => TEST_TOURS.find((t) => t.id === id),
}))

import {
  _resetToursStateForTests,
  AUTO_RUN_DELAY_MS,
  countRunnableSteps,
  DIALOG_RETRY_DELAY_MS,
  SEEN_STORAGE_KEY,
  useTours,
} from '../composables/use-tours'
import { waitForVisible } from '../tours/dom'

type HookOpts = Parameters<DriverHook>[2]

/** What driver.js hands to every hook; `driver` defaults to the shared mock. */
function hookOpts(overrides: { activeIndex?: number; driver?: unknown } = {}): HookOpts {
  return {
    config: {},
    state: { activeIndex: overrides.activeIndex },
    driver: (overrides.driver ?? driverInstance) as Driver,
    index: overrides.activeIndex,
  }
}

const noStep = {} as DriveStep

/** driver.js snapshots the state before resetting it, so the hook still sees the last active index. */
function destroyAt(activeIndex: number): void {
  lastConfig().onDestroyed?.(undefined, noStep, hookOpts({ activeIndex }))
}

/** A promise the test resolves by hand, to observe what happens before and after. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {}
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

function lastConfig(): Config {
  return driverFactory.mock.calls.at(-1)?.[0] as Config
}

function stepElements(config: Config): unknown[] {
  return (config.steps ?? []).map((s) => s.element)
}

beforeEach(() => {
  localStorage.clear()
  // Drops the previous test's driver first, so its destroy() call is not counted below.
  _resetToursStateForTests()
  vi.clearAllMocks()
  vi.mocked(waitForVisible).mockImplementation(async () => true)
  driverInstance.isActive.mockReturnValue(false)
  driverInstance.hasNextStep.mockReturnValue(true)
  currentRoute.value = { name: 'workspace', path: '/' }
  gateC.value = false
  document.body.innerHTML = ''
})

describe('useTours seen state', () => {
  it('reports unseen, partial and seen from the stored step ids', () => {
    const tours = useTours()
    expect(tours.status('home')).toBe('unseen')
    tours.markSeen('home', ['a'])
    expect(tours.status('home')).toBe('partial')
    tours.markSeen('home', ['b'])
    expect(tours.status('home')).toBe('seen')
    expect(JSON.parse(localStorage.getItem(SEEN_STORAGE_KEY) ?? '{}')).toEqual({ home: ['a', 'b'] })
  })

  it('migrates the legacy onboarding flag into a fully seen home tour, then removes it', () => {
    localStorage.setItem('kobo:onboarding-done', '1')
    const tours = useTours()
    tours.migrateLegacyFlag()
    expect(tours.status('home')).toBe('seen')
    expect(tours.status('settings')).toBe('unseen')
    expect(localStorage.getItem('kobo:onboarding-done')).toBeNull()
  })

  it('leaves everything untouched when there is no legacy flag', () => {
    const tours = useTours()
    tours.migrateLegacyFlag()
    expect(tours.status('home')).toBe('unseen')
    expect(localStorage.getItem(SEEN_STORAGE_KEY)).toBeNull()
  })

  it('reports seen when every step is gated out, since nothing is left to run', () => {
    const tours = useTours()
    expect(tours.status('health')).toBe('seen')
  })

  it('ignores DOM-gated steps in status, so the Help menu does not depend on the current page', () => {
    const tours = useTours()
    expect(tours.status('create')).toBe('unseen')
    tours.markSeen('create', ['c1'])
    expect(tours.status('create')).toBe('seen')
  })

  it('counts runnable steps without the DOM-gated ones', () => {
    expect(countRunnableSteps(TEST_TOURS[1] as TourDefinition)).toBe(1)
    expect(countRunnableSteps(TEST_TOURS[0] as TourDefinition)).toBe(3)
  })

  it('merges with what another tab stored before writing', () => {
    const tours = useTours()
    // Another tab marked the settings tour seen after this tab loaded its state.
    localStorage.setItem(SEEN_STORAGE_KEY, JSON.stringify({ settings: ['s1'] }))
    tours.markSeen('home', ['a'])
    expect(JSON.parse(localStorage.getItem(SEEN_STORAGE_KEY) ?? '{}')).toEqual({ settings: ['s1'], home: ['a'] })
    expect(tours.status('settings')).toBe('seen')
  })

  it('keeps marking steps seen in memory when storage rejects writes', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    try {
      const tours = useTours()
      expect(() => tours.markSeen('home', ['a'])).not.toThrow()
      expect(tours.status('home')).toBe('partial')
    } finally {
      setItem.mockRestore()
    }
  })

  it('survives a corrupted store', () => {
    localStorage.setItem(SEEN_STORAGE_KEY, '{not json')
    const tours = useTours()
    expect(tours.status('home')).toBe('unseen')
  })
})

describe('runTour', () => {
  it('builds driver steps from the definition, dropping gated steps', async () => {
    const tours = useTours()
    await tours.runTour('home')
    const config = lastConfig()
    expect(stepElements(config)).toEqual(['[data-tour="a"]', '[data-tour="b"]'])
    expect(config.steps?.[0]?.popover?.title).toBe('tours.home.a.title')
    expect(driverInstance.drive).toHaveBeenCalledTimes(1)
  })

  it('does nothing for an unknown tour id', async () => {
    const tours = useTours()
    await expect(tours.runTour('nope' as TourId)).resolves.toBeUndefined()
    expect(driverFactory).not.toHaveBeenCalled()
    expect(push).not.toHaveBeenCalled()
  })

  it('keeps only unseen steps with onlyUnseen and does nothing when none remain', async () => {
    const tours = useTours()
    tours.markSeen('home', ['a'])
    await tours.runTour('home', { onlyUnseen: true })
    expect(stepElements(lastConfig())).toEqual(['[data-tour="b"]'])

    driverFactory.mockClear()
    tours.markSeen('home', ['b'])
    await tours.runTour('home', { onlyUnseen: true })
    expect(driverFactory).not.toHaveBeenCalled()
  })

  it('marks a step seen when it is highlighted', async () => {
    const tours = useTours()
    await tours.runTour('home')
    lastConfig().onHighlighted?.(document.body, noStep, hookOpts({ activeIndex: 1 }))
    expect(tours.status('home')).toBe('partial')
    expect(JSON.parse(localStorage.getItem(SEEN_STORAGE_KEY) ?? '{}')).toEqual({ home: ['b'] })
  })

  it('does not mark a step seen when driver.js highlights its dummy element', async () => {
    const tours = useTours()
    await tours.runTour('home')
    lastConfig().onHighlighted?.(undefined, noStep, hookOpts({ activeIndex: 1 }))
    expect(tours.status('home')).toBe('unseen')
  })

  it('navigates to the tour route first when elsewhere', async () => {
    currentRoute.value = { name: 'settings', path: '/settings' }
    const tours = useTours()
    await tours.runTour('home')
    expect(push).toHaveBeenCalledWith({ name: 'workspace' })
  })

  it('gives up without a driver when a guard refuses the navigation', async () => {
    currentRoute.value = { name: 'settings', path: '/settings' }
    push.mockImplementationOnce(async () => ({ type: 8, from: {}, to: {} }))
    const tours = useTours()
    await tours.runTour('home')
    expect(driverFactory).not.toHaveBeenCalled()
  })

  it('gives up without a driver when a guard redirected elsewhere', async () => {
    currentRoute.value = { name: 'settings', path: '/settings' }
    const tours = useTours()
    await tours.runTour('home') // push resolves but the route did not change
    expect(driverFactory).not.toHaveBeenCalled()
  })

  it('destroys the running driver before navigating away', async () => {
    const tours = useTours()
    await tours.runTour('home')
    currentRoute.value = { name: 'workspace', path: '/' }
    push.mockImplementationOnce(async () => {
      expect(driverInstance.destroy).toHaveBeenCalledTimes(1)
      currentRoute.value = { name: 'settings', path: '/settings' }
    })
    await tours.runTour('settings')
    expect(push).toHaveBeenCalledWith({ name: 'settings' })
    expect(driverFactory).toHaveBeenCalledTimes(2)
  })

  it('drops a leading step whose anchor never shows up and starts on the next one', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      vi.mocked(waitForVisible).mockImplementation(async (selector) => selector !== '[data-tour="a"]')
      const tours = useTours()
      await tours.runTour('home')
      expect(stepElements(lastConfig())).toEqual(['[data-tour="b"]'])
      expect(warn).toHaveBeenCalledWith('[tours] anchor not visible, skipping: a')
    } finally {
      warn.mockRestore()
    }
  })

  it('never rejects: a failing step preparation is logged instead', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      beforeShowB.mockImplementationOnce(async () => {
        throw new Error('boom')
      })
      const tours = useTours()
      tours.markSeen('home', ['a'])
      await expect(tours.runTour('home', { onlyUnseen: true })).resolves.toBeUndefined()
      expect(error).toHaveBeenCalledWith('[tours]', expect.any(Error))
      expect(driverFactory).not.toHaveBeenCalled()
    } finally {
      error.mockRestore()
    }
  })

  it('prepares the first step before waiting for its anchor, so a closed drawer gets opened first', async () => {
    const order: string[] = []
    beforeShowA.mockImplementationOnce(async () => {
      order.push('beforeShow')
    })
    vi.mocked(waitForVisible).mockImplementation(async (selector) => {
      order.push(selector)
      return true
    })
    const tours = useTours()
    await tours.runTour('home')
    expect(order.slice(0, 2)).toEqual(['beforeShow', '[data-tour="a"]'])
    expect(driverFactory).toHaveBeenCalledTimes(1)
  })

  it('keeps the start lock until every in-flight run has finished', async () => {
    currentRoute.value = { name: 'settings', path: '/settings' }
    const navigation = deferred()
    push.mockImplementationOnce(async () => {
      await navigation.promise
      currentRoute.value = { name: 'workspace', path: '/' }
    })
    const tours = useTours()
    const home = tours.runTour('home') // waits on the navigation
    await tours.runTour('settings') // completes first
    expect(driverFactory).toHaveBeenCalledTimes(1)
    await tours.autoRun('settings') // still locked by the home run: queued, not started
    expect(driverFactory).toHaveBeenCalledTimes(1)
    navigation.resolve()
    await home
    expect(driverFactory).toHaveBeenCalledTimes(2)
  })
})

describe('runTour hooks', () => {
  it('evaluates step gates after navigating, so they see the target page', async () => {
    currentRoute.value = { name: 'settings', path: '/settings' }
    push.mockImplementationOnce(async () => {
      currentRoute.value = { name: 'workspace', path: '/' }
      gateC.value = true
    })
    const tours = useTours()
    await tours.runTour('home')
    expect(stepElements(lastConfig())).toEqual(['[data-tour="a"]', '[data-tour="b"]', '[data-tour="c"]'])
  })

  it('evaluates step gates once the first anchor is rendered, so DOM gates see the page', async () => {
    vi.mocked(waitForVisible).mockImplementationOnce(async () => {
      gateC.value = true
      return true
    })
    const tours = useTours()
    await tours.runTour('home')
    expect(stepElements(lastConfig())).toEqual(['[data-tour="a"]', '[data-tour="b"]', '[data-tour="c"]'])
  })

  it('awaits the next step preparation and its anchor before moving', async () => {
    const gate = deferred()
    beforeShowB.mockImplementationOnce(() => gate.promise)
    const tours = useTours()
    await tours.runTour('home')
    vi.mocked(waitForVisible).mockClear()
    const next = lastConfig().steps?.[0]?.popover?.onNextClick
    const pending = next?.(undefined, noStep, hookOpts({ activeIndex: 0 }))
    await Promise.resolve()
    expect(beforeShowB).toHaveBeenCalledTimes(1)
    expect(driverInstance.moveTo).not.toHaveBeenCalled()
    gate.resolve()
    await pending
    expect(waitForVisible).toHaveBeenCalledWith('[data-tour="b"]')
    expect(driverInstance.moveTo).toHaveBeenCalledWith(1)
  })

  it('awaits the previous step anchor before moving back', async () => {
    const tours = useTours()
    await tours.runTour('home')
    vi.mocked(waitForVisible).mockClear()
    await lastConfig().steps?.[1]?.popover?.onPrevClick?.(undefined, noStep, hookOpts({ activeIndex: 1 }))
    expect(waitForVisible).toHaveBeenCalledWith('[data-tour="a"]')
    expect(driverInstance.moveTo).toHaveBeenCalledWith(0)
  })

  it('skips a step whose anchor is not visible and moves to the following one', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      gateC.value = true
      const tours = useTours()
      await tours.runTour('home') // a, b, c
      vi.mocked(waitForVisible).mockImplementation(async (selector) => selector !== '[data-tour="b"]')
      await lastConfig().steps?.[0]?.popover?.onNextClick?.(undefined, noStep, hookOpts({ activeIndex: 0 }))
      expect(warn).toHaveBeenCalledWith('[tours] anchor not visible, skipping: b')
      expect(driverInstance.moveTo).toHaveBeenCalledWith(2)
    } finally {
      warn.mockRestore()
    }
  })

  it('ends the tour when no following step has a visible anchor', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const tours = useTours()
      await tours.runTour('home') // a, b
      vi.mocked(waitForVisible).mockImplementation(async () => false)
      await lastConfig().steps?.[0]?.popover?.onNextClick?.(undefined, noStep, hookOpts({ activeIndex: 0 }))
      expect(driverInstance.moveTo).not.toHaveBeenCalled()
      expect(driverInstance.destroy).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })

  it('moves the driver handed to the hook, never the one a later tour created', async () => {
    const gate = deferred()
    beforeShowB.mockImplementationOnce(() => gate.promise)
    const tours = useTours()
    await tours.runTour('home')
    const oldDriver = { ...driverInstance, moveTo: vi.fn(), destroy: vi.fn() }
    const pending = lastConfig().steps?.[0]?.popover?.onNextClick?.(
      undefined,
      noStep,
      hookOpts({ activeIndex: 0, driver: oldDriver }),
    )
    currentRoute.value = { name: 'settings', path: '/settings' }
    await tours.runTour('settings')
    gate.resolve()
    await pending
    expect(oldDriver.moveTo).toHaveBeenCalledWith(1)
    expect(driverInstance.moveTo).not.toHaveBeenCalled()
  })

  it('asks before quitting mid-way and quits freely on the last step', async () => {
    // happy-dom ships no window.confirm: stub it rather than spy on it.
    const confirm = vi.fn(() => false)
    vi.stubGlobal('confirm', confirm)
    try {
      const tours = useTours()
      await tours.runTour('home')
      const onDestroyStarted = lastConfig().onDestroyStarted
      const hookDriver = { ...driverInstance, hasNextStep: vi.fn(() => true), destroy: vi.fn() }
      const opts = hookOpts({ activeIndex: 0, driver: hookDriver })

      confirm.mockReturnValue(false)
      onDestroyStarted?.(undefined, noStep, opts)
      expect(hookDriver.destroy).not.toHaveBeenCalled()

      confirm.mockReturnValue(true)
      onDestroyStarted?.(undefined, noStep, opts)
      expect(hookDriver.destroy).toHaveBeenCalledTimes(1)

      confirm.mockClear()
      hookDriver.hasNextStep.mockReturnValue(false)
      onDestroyStarted?.(undefined, noStep, opts)
      expect(confirm).not.toHaveBeenCalled()
      expect(hookDriver.destroy).toHaveBeenCalledTimes(2)
      // The hook works on the driver it was given, not on the module-level one.
      expect(driverInstance.destroy).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('runs the onDone hook when destroyed on the last step, not when abandoned mid-way', async () => {
    const tours = useTours()
    await tours.runTour('home') // steps a and b (c is gated out)
    destroyAt(0)
    expect(push).not.toHaveBeenCalled()
    destroyAt(1)
    expect(push).toHaveBeenCalledWith({ name: 'create' })
  })

  it('marks every step seen when the tour is abandoned, so it never auto-runs again', async () => {
    const tours = useTours()
    await tours.runTour('home')
    destroyAt(0)
    expect(tours.status('home')).toBe('seen')
    expect(JSON.parse(localStorage.getItem(SEEN_STORAGE_KEY) ?? '{}')).toEqual({ home: ['a', 'b', 'c'] })
    driverFactory.mockClear()
    await tours.autoRun('home')
    expect(driverFactory).not.toHaveBeenCalled()
  })

  it('marks only the shown steps seen on completion', async () => {
    const tours = useTours()
    await tours.runTour('home')
    lastConfig().onHighlighted?.(document.body, noStep, hookOpts({ activeIndex: 0 }))
    destroyAt(1)
    expect(JSON.parse(localStorage.getItem(SEEN_STORAGE_KEY) ?? '{}')).toEqual({ home: ['a'] })
    expect(tours.status('home')).toBe('partial')
  })

  it('does not mark a replaced tour seen', async () => {
    const tours = useTours()
    await tours.runTour('home')
    const homeConfig = lastConfig()
    driverInstance.destroy.mockImplementationOnce(() => {
      homeConfig.onDestroyed?.(undefined, noStep, hookOpts({ activeIndex: 0 }))
    })
    push.mockImplementationOnce(async () => {
      currentRoute.value = { name: 'settings', path: '/settings' }
    })
    await tours.runTour('settings')
    expect(tours.status('home')).toBe('unseen')
  })

  it('does not run the replaced tour onDone when another tour takes over', async () => {
    const tours = useTours()
    await tours.runTour('home')
    const homeConfig = lastConfig()
    // driver.js fires the old tour's onDestroyed from the destroy() the new run issues.
    driverInstance.destroy.mockImplementationOnce(() => {
      homeConfig.onDestroyed?.(undefined, noStep, hookOpts({ activeIndex: 1 }))
    })
    push.mockImplementationOnce(async () => {
      currentRoute.value = { name: 'settings', path: '/settings' }
    })
    await tours.runTour('settings')
    expect(push).toHaveBeenCalledTimes(1)
    expect(push).toHaveBeenCalledWith({ name: 'settings' })
  })

  it('does not run onDone when the test reset drops the driver', async () => {
    const tours = useTours()
    await tours.runTour('home')
    const homeConfig = lastConfig()
    driverInstance.destroy.mockImplementationOnce(() => {
      homeConfig.onDestroyed?.(undefined, noStep, hookOpts({ activeIndex: 1 }))
    })
    _resetToursStateForTests()
    expect(push).not.toHaveBeenCalled()
  })

  it('destroys the previous driver when a second tour starts', async () => {
    const tours = useTours()
    await tours.runTour('home')
    expect(driverInstance.destroy).not.toHaveBeenCalled()
    push.mockImplementationOnce(async () => {
      currentRoute.value = { name: 'settings', path: '/settings' }
    })
    await tours.runTour('settings')
    expect(driverInstance.destroy).toHaveBeenCalledTimes(1)
    expect(driverFactory).toHaveBeenCalledTimes(2)
  })
})

describe('autoRun', () => {
  it('runs the unseen steps', async () => {
    const tours = useTours()
    currentRoute.value = { name: 'settings', path: '/settings' }
    await tours.autoRun('settings')
    expect(driverInstance.drive).toHaveBeenCalledTimes(1)
  })

  it('starts a single tour when two auto-runs on the current page race in the same tick', async () => {
    const tours = useTours()
    await Promise.all([tours.autoRun('home'), tours.autoRun('create')])
    expect(driverFactory).toHaveBeenCalledTimes(1)
    expect(driverInstance.drive).toHaveBeenCalledTimes(1)
  })

  it('refuses to stack over a running tour or an open dialog', async () => {
    const tours = useTours()
    currentRoute.value = { name: 'settings', path: '/settings' }
    driverInstance.isActive.mockReturnValue(true)
    await tours.runTour('settings') // creates a driver so isActive() is consulted
    driverInstance.drive.mockClear()
    await tours.autoRun('settings')
    expect(driverInstance.drive).not.toHaveBeenCalled()

    driverInstance.isActive.mockReturnValue(false)
    document.body.innerHTML = '<div class="q-dialog"></div>'
    await tours.autoRun('settings')
    expect(driverInstance.drive).not.toHaveBeenCalled()
  })

  it('never navigates: bails when the user is not on the tour route', async () => {
    const tours = useTours()
    currentRoute.value = { name: 'settings', path: '/settings' }
    await tours.autoRun('home')
    expect(push).not.toHaveBeenCalled()
    expect(driverInstance.drive).not.toHaveBeenCalled()
  })

  it('never rejects: a failing run is logged instead', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      beforeShowB.mockImplementationOnce(async () => {
        throw new Error('boom')
      })
      const tours = useTours()
      tours.markSeen('home', ['a'])
      await expect(tours.autoRun('home')).resolves.toBeUndefined()
      expect(error).toHaveBeenCalledWith('[tours]', expect.any(Error))
    } finally {
      error.mockRestore()
    }
  })
})

describe('autoRun retries', () => {
  it('queues an auto-run refused by a running tour and drains it when that tour ends', async () => {
    vi.useFakeTimers()
    try {
      const tours = useTours()
      driverInstance.isActive.mockReturnValue(true)
      await tours.runTour('home')
      currentRoute.value = { name: 'settings', path: '/settings' }
      await tours.autoRun('settings')
      expect(driverFactory).toHaveBeenCalledTimes(1)

      driverInstance.isActive.mockReturnValue(false)
      destroyAt(1) // completed: the queued auto-run drains
      await vi.advanceTimersByTimeAsync(AUTO_RUN_DELAY_MS)
      expect(driverFactory).toHaveBeenCalledTimes(2)
      expect(lastConfig().steps?.[0]?.element).toBe('[data-tour="s1"]')
    } finally {
      vi.useRealTimers()
    }
  })

  it('drains several queued auto-runs one at a time, in registry order', async () => {
    vi.useFakeTimers()
    try {
      const tours = useTours()
      driverInstance.isActive.mockReturnValue(true)
      await tours.runTour('home')
      // Armed out of registry order; the last armed one is not the one that should start.
      await Promise.all([tours.autoRun('settings'), tours.autoRun('create'), tours.autoRun('health')])
      expect(driverFactory).toHaveBeenCalledTimes(1)

      driverInstance.isActive.mockReturnValue(false)
      destroyAt(1)
      await vi.advanceTimersByTimeAsync(AUTO_RUN_DELAY_MS)
      expect(driverFactory).toHaveBeenCalledTimes(2)
      expect(lastConfig().steps?.[0]?.element).toBe('[data-tour="c1"]')

      // The others wait for this one to complete: nothing else starts meanwhile.
      await vi.advanceTimersByTimeAsync(AUTO_RUN_DELAY_MS * 2)
      expect(driverFactory).toHaveBeenCalledTimes(2)
      currentRoute.value = { name: 'settings', path: '/settings' }
      destroyAt(0) // create completed (its only runnable step)
      await vi.advanceTimersByTimeAsync(AUTO_RUN_DELAY_MS)
      expect(driverFactory).toHaveBeenCalledTimes(3)
      expect(lastConfig().steps?.[0]?.element).toBe('[data-tour="s1"]')
    } finally {
      vi.useRealTimers()
    }
  })

  it('drains the queue when the run that blocked it ends without a driver', async () => {
    vi.useFakeTimers()
    try {
      const tours = useTours()
      driverInstance.isActive.mockReturnValue(true)
      await tours.runTour('home')
      await tours.autoRun('create') // queued behind the running home tour
      expect(driverFactory).toHaveBeenCalledTimes(1)

      driverInstance.isActive.mockReturnValue(false)
      tours.markSeen('home', ['a', 'b'])
      await tours.runTour('home', { onlyUnseen: true }) // nothing left to show: no driver
      expect(driverFactory).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(AUTO_RUN_DELAY_MS)
      expect(driverFactory).toHaveBeenCalledTimes(2)
      expect(lastConfig().steps?.[0]?.element).toBe('[data-tour="c1"]')
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops the queued auto-runs when the running tour is abandoned', async () => {
    vi.useFakeTimers()
    try {
      const tours = useTours()
      driverInstance.isActive.mockReturnValue(true)
      await tours.runTour('home')
      currentRoute.value = { name: 'settings', path: '/settings' }
      await tours.autoRun('settings')

      driverInstance.isActive.mockReturnValue(false)
      destroyAt(0)
      await vi.advanceTimersByTimeAsync(AUTO_RUN_DELAY_MS * 2)
      expect(driverFactory).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('retries once when a dialog is open, logging the deferral, and gives up after that', async () => {
    vi.useFakeTimers()
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {})
    try {
      const tours = useTours()
      document.body.innerHTML = '<div class="q-dialog"></div>'
      await tours.autoRun('home')
      expect(driverInstance.drive).not.toHaveBeenCalled()
      expect(debug).toHaveBeenCalledWith('[tours] auto-run deferred, dialog open: home')
      document.body.innerHTML = ''
      await vi.advanceTimersByTimeAsync(DIALOG_RETRY_DELAY_MS)
      expect(driverInstance.drive).toHaveBeenCalledTimes(1)

      _resetToursStateForTests()
      driverInstance.drive.mockClear()
      document.body.innerHTML = '<div class="q-dialog"></div>'
      await tours.autoRun('home')
      await vi.advanceTimersByTimeAsync(DIALOG_RETRY_DELAY_MS)
      document.body.innerHTML = ''
      await vi.advanceTimersByTimeAsync(DIALOG_RETRY_DELAY_MS * 2)
      expect(driverInstance.drive).not.toHaveBeenCalled()
    } finally {
      debug.mockRestore()
      vi.useRealTimers()
    }
  })
})

describe('scheduleAutoRun', () => {
  it('arms a timer and auto-runs after the delay', async () => {
    vi.useFakeTimers()
    try {
      const tours = useTours()
      tours.scheduleAutoRun('home')
      expect(driverInstance.drive).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(AUTO_RUN_DELAY_MS)
      expect(driverInstance.drive).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not throw outside a component and honours a custom delay', async () => {
    vi.useFakeTimers()
    try {
      const tours = useTours()
      expect(() => tours.scheduleAutoRun('home', 50)).not.toThrow()
      await vi.advanceTimersByTimeAsync(49)
      expect(driverInstance.drive).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(driverInstance.drive).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a single timer per composable: re-arming replaces the pending one', async () => {
    vi.useFakeTimers()
    try {
      const tours = useTours()
      tours.scheduleAutoRun('home', 100)
      tours.scheduleAutoRun('home', 100)
      await vi.advanceTimersByTimeAsync(300)
      expect(driverFactory).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('registers one unmount hook per composable, however often it is armed', () => {
    let instance: ComponentInternalInstance | null = null
    const Host = defineComponent({
      setup() {
        instance = getCurrentInstance()
        const tours = useTours()
        tours.scheduleAutoRun('home', 100)
        tours.scheduleAutoRun('home', 100)
        return () => h('div')
      },
    })
    const wrapper = mount(Host)
    // Vue keeps beforeUnmount hooks in the internal `bum` array.
    const hooks = (instance as unknown as { bum?: unknown[] } | null)?.bum
    expect(hooks).toHaveLength(1)
    wrapper.unmount()
  })

  it('clears the timer when the calling component unmounts, even when armed after setup', async () => {
    vi.useFakeTimers()
    try {
      const Host = defineComponent({
        setup() {
          const tours = useTours()
          tours.scheduleAutoRun('home', 100)
          // Mimics a watcher firing after mount (workspace selected, PR turned OPEN).
          setTimeout(() => tours.scheduleAutoRun('home', 100), 10)
          return () => h('div')
        },
      })
      const wrapper = mount(Host)
      await vi.advanceTimersByTimeAsync(50)
      wrapper.unmount()
      await vi.advanceTimersByTimeAsync(200)
      expect(driverInstance.drive).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores an arm requested after the calling component unmounted', async () => {
    vi.useFakeTimers()
    try {
      let arm: (() => void) | undefined
      const Host = defineComponent({
        setup() {
          const tours = useTours()
          arm = () => tours.scheduleAutoRun('home', 100)
          return () => h('div')
        },
      })
      const wrapper = mount(Host)
      wrapper.unmount()
      arm?.()
      await vi.advanceTimersByTimeAsync(200)
      expect(driverInstance.drive).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('resetAll', () => {
  it('clears every tour and replays home', async () => {
    const tours = useTours()
    tours.markSeen('settings', ['s1'])
    await tours.resetAll()
    expect(localStorage.getItem(SEEN_STORAGE_KEY)).toBeNull()
    expect(tours.status('settings')).toBe('unseen')
    expect(driverInstance.drive).toHaveBeenCalledTimes(1)
  })
})
