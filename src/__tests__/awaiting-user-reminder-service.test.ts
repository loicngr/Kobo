import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../server/services/websocket-service.js', () => ({
  broadcastAll: vi.fn(),
}))

vi.mock('../server/db/index.js', () => ({
  getDb: vi.fn(() => ({
    prepare: () => ({ all: () => awaitingRows }),
  })),
}))

vi.mock('../server/services/settings-service.js', () => ({
  getGlobalSettings: vi.fn(() => ({ awaitingUserReminderMinutes: reminderMinutes })),
}))

import {
  _resetForTest,
  computeDueReminders,
  type ReminderState,
  runReminderTick,
} from '../server/services/awaiting-user-reminder-service.js'
import { getGlobalSettings } from '../server/services/settings-service.js'
import { broadcastAll } from '../server/services/websocket-service.js'

let awaitingRows: Array<{ id: string; name: string }>
let reminderMinutes: number

beforeEach(() => {
  vi.clearAllMocks()
  _resetForTest()
  awaitingRows = []
  reminderMinutes = 10
})

const MINUTE = 60_000

describe('computeDueReminders', () => {
  it('starts the clock on first sight without reminding immediately', () => {
    const state = new Map<string, ReminderState>()

    const due = computeDueReminders({
      awaiting: [{ id: 'ws-1', name: 'demo' }],
      now: 1_000,
      intervalMs: 10 * MINUTE,
      state,
    })

    expect(due).toEqual([])
    expect(state.get('ws-1')).toEqual({ firstSeenAt: 1_000, lastRemindedAt: null, remindersSent: 0 })
  })

  it('reminds once the interval has elapsed', () => {
    const state = new Map<string, ReminderState>([['ws-1', { firstSeenAt: 0, lastRemindedAt: null, remindersSent: 0 }]])

    const due = computeDueReminders({
      awaiting: [{ id: 'ws-1', name: 'demo' }],
      now: 10 * MINUTE,
      intervalMs: 10 * MINUTE,
      state,
    })

    expect(due).toEqual([{ id: 'ws-1', name: 'demo', waitingMs: 10 * MINUTE, reminderNumber: 1 }])
  })

  it('does not remind twice for the same interval', () => {
    const state = new Map<string, ReminderState>([
      ['ws-1', { firstSeenAt: 0, lastRemindedAt: 10 * MINUTE, remindersSent: 1 }],
    ])

    const due = computeDueReminders({
      awaiting: [{ id: 'ws-1', name: 'demo' }],
      now: 12 * MINUTE,
      intervalMs: 10 * MINUTE,
      state,
    })

    expect(due).toEqual([])
  })

  it('reminds again at each further interval, so a missed one is not the last', () => {
    const state = new Map<string, ReminderState>([
      ['ws-1', { firstSeenAt: 0, lastRemindedAt: 10 * MINUTE, remindersSent: 1 }],
    ])

    const due = computeDueReminders({
      awaiting: [{ id: 'ws-1', name: 'demo' }],
      now: 20 * MINUTE,
      intervalMs: 10 * MINUTE,
      state,
    })

    expect(due[0]?.reminderNumber).toBe(2)
  })

  it('sends one reminder, not three, after a long gap between ticks', () => {
    // The server was asleep. Waking up owing three reminders and firing them
    // all at once would be three notifications for one unanswered question.
    const state = new Map<string, ReminderState>([['ws-1', { firstSeenAt: 0, lastRemindedAt: null, remindersSent: 0 }]])

    const due = computeDueReminders({
      awaiting: [{ id: 'ws-1', name: 'demo' }],
      now: 35 * MINUTE,
      intervalMs: 10 * MINUTE,
      state,
    })

    expect(due).toHaveLength(1)
    // The number counts reminders actually sent, not intervals elapsed.
    expect(due[0]?.reminderNumber).toBe(1)
    expect(due[0]?.waitingMs).toBe(35 * MINUTE)
    expect(state.get('ws-1')?.remindersSent).toBe(1)
  })

  it('does not remind one tick early', () => {
    const state = new Map<string, ReminderState>([['ws-1', { firstSeenAt: 0, lastRemindedAt: null, remindersSent: 0 }]])

    const due = computeDueReminders({
      awaiting: [{ id: 'ws-1', name: 'demo' }],
      now: 10 * MINUTE - 1,
      intervalMs: 10 * MINUTE,
      state,
    })

    expect(due).toEqual([])
  })

  it('measures from the last reminder, so changing the interval mid-wait takes effect at once', () => {
    // Three reminders at a 10 min interval, then the user sets 60 min. The
    // next reminder is due 60 min after the LAST one — not at some multiple
    // of the new interval counted from the very first sighting, which would
    // either fire immediately or go quiet for hours.
    const state = new Map<string, ReminderState>([
      ['ws-1', { firstSeenAt: 0, lastRemindedAt: 30 * MINUTE, remindersSent: 3 }],
    ])

    expect(
      computeDueReminders({
        awaiting: [{ id: 'ws-1', name: 'demo' }],
        now: 60 * MINUTE,
        intervalMs: 60 * MINUTE,
        state,
      }),
    ).toEqual([])
    expect(
      computeDueReminders({
        awaiting: [{ id: 'ws-1', name: 'demo' }],
        now: 90 * MINUTE,
        intervalMs: 60 * MINUTE,
        state,
      }),
    ).toMatchObject([{ reminderNumber: 4 }])
  })

  it('forgets a workspace that is no longer waiting, so answering resets the clock', () => {
    const state = new Map<string, ReminderState>([
      ['ws-1', { firstSeenAt: 0, lastRemindedAt: 20 * MINUTE, remindersSent: 2 }],
    ])

    computeDueReminders({ awaiting: [], now: 30 * MINUTE, intervalMs: 10 * MINUTE, state })

    expect(state.has('ws-1')).toBe(false)
  })

  it.each([0, -5])('is disabled by a zero or negative interval (%i), and drops its state with it', (intervalMs) => {
    const state = new Map<string, ReminderState>([['ws-1', { firstSeenAt: 0, lastRemindedAt: null, remindersSent: 0 }]])

    const due = computeDueReminders({
      awaiting: [{ id: 'ws-1', name: 'demo' }],
      now: 99 * MINUTE,
      intervalMs,
      state,
    })

    expect(due).toEqual([])
    expect(state.size).toBe(0)
  })
})

describe('runReminderTick', () => {
  it('broadcasts to every client, not only the ones watching that workspace', () => {
    awaitingRows = [{ id: 'ws-1', name: 'demo' }]

    runReminderTick(0)
    runReminderTick(10 * MINUTE)

    expect(broadcastAll).toHaveBeenCalledTimes(1)
    expect(broadcastAll).toHaveBeenCalledWith(
      'workspace:awaiting-reminder',
      expect.objectContaining({ workspaceId: 'ws-1', workspaceName: 'demo', waitingMinutes: 10, reminderNumber: 1 }),
    )
  })

  it('broadcasts nothing while the feature is off', () => {
    reminderMinutes = 0
    awaitingRows = [{ id: 'ws-1', name: 'demo' }]

    runReminderTick(0)
    runReminderTick(60 * MINUTE)

    expect(broadcastAll).not.toHaveBeenCalled()
  })

  it('survives a settings read failure and keeps working on the next tick', () => {
    awaitingRows = [{ id: 'ws-1', name: 'demo' }]
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    runReminderTick(0)
    vi.mocked(getGlobalSettings).mockImplementationOnce(() => {
      throw new Error('settings.json is unreadable')
    })

    expect(() => runReminderTick(5 * MINUTE)).not.toThrow()
    runReminderTick(10 * MINUTE)

    expect(broadcastAll).toHaveBeenCalledTimes(1)
    errorSpy.mockRestore()
  })

  it('caps a hand-edited delay at one day, like the API does', () => {
    reminderMinutes = 5000
    awaitingRows = [{ id: 'ws-1', name: 'demo' }]

    runReminderTick(0)
    runReminderTick(1440 * MINUTE)

    expect(broadcastAll).toHaveBeenCalledTimes(1)
  })

  it('starts the loop once and stops it cleanly', async () => {
    const { startAwaitingUserReminder, stopAwaitingUserReminder } = await import(
      '../server/services/awaiting-user-reminder-service.js'
    )
    vi.useFakeTimers()
    try {
      reminderMinutes = 1
      awaitingRows = [{ id: 'ws-1', name: 'demo' }]
      startAwaitingUserReminder()
      startAwaitingUserReminder()
      vi.advanceTimersByTime(60_000 * 2 + 10)
      expect(broadcastAll).toHaveBeenCalledTimes(1)
      stopAwaitingUserReminder()
      vi.advanceTimersByTime(60_000 * 5)
      expect(broadcastAll).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
