import { describe, expect, it } from 'vitest'
import { ciDurationMs, ciSpanMs, formatCiDuration, isCiRunning } from '../utils/ci-duration'

const START = '2026-11-18T10:00:00Z'
const at = (seconds: number) => new Date(Date.parse(START) + seconds * 1000).toISOString()
const now = (seconds: number) => Date.parse(START) + seconds * 1000

const t = (key: string, named: Record<string, unknown>) => {
  const { s, m, h } = named as Record<string, number | string>
  if (key === 'ciDuration.seconds') return `${s} s`
  if (key === 'ciDuration.minutes') return `${m} min ${s} s`
  return `${h} h ${m} min`
}

describe('formatCiDuration', () => {
  it.each([
    [45_000, '45 s'],
    [185_000, '3 min 05 s'],
    [3_725_000, '1 h 02 min'],
    [0, '0 s'],
  ])('formats %d ms as %s', (ms, expected) => {
    expect(formatCiDuration(ms, t)).toBe(expected)
  })
})

describe('ciDurationMs / isCiRunning', () => {
  it('returns end minus start for a finished item whatever its status', () => {
    const item = { status: 'weird', startedAt: START, completedAt: at(45) }
    expect(ciDurationMs(item, now(999))).toBe(45_000)
    expect(isCiRunning(item)).toBe(false)
  })
  it('returns now minus start for a running item', () => {
    const item = { status: 'in_progress', startedAt: START, completedAt: null }
    expect(isCiRunning(item)).toBe(true)
    expect(ciDurationMs(item, now(10))).toBe(10_000)
  })
  it('never returns a negative time when the start is in the future', () => {
    expect(ciDurationMs({ status: 'IN_PROGRESS', startedAt: at(60) }, now(0))).toBe(0)
    expect(ciDurationMs({ status: 'x', startedAt: at(60), completedAt: at(10) }, now(0))).toBe(0)
  })
  it('shows nothing for completed without an end date', () => {
    const item = { status: 'completed', startedAt: START, completedAt: null }
    expect(ciDurationMs(item, now(10))).toBeNull()
    expect(isCiRunning(item)).toBe(false)
    expect(isCiRunning({ status: 'COMPLETED', startedAt: START })).toBe(false)
  })
  it.each(['queued', 'PENDING', 'waiting', 'requested'])('shows nothing for a waiting status %s', (status) => {
    const item = { status, startedAt: START, completedAt: null }
    expect(ciDurationMs(item, now(10))).toBeNull()
    expect(isCiRunning(item)).toBe(false)
  })
  it('treats an unknown status with a start date and no end as running', () => {
    const item = { status: 'something_new', startedAt: START }
    expect(isCiRunning(item)).toBe(true)
    expect(ciDurationMs(item, now(5))).toBe(5_000)
  })
  it('shows nothing without a start date or with unparseable dates', () => {
    expect(ciDurationMs({ status: 'in_progress' }, now(1))).toBeNull()
    expect(ciDurationMs({ status: 'in_progress', startedAt: null }, now(1))).toBeNull()
    expect(ciDurationMs({ status: 'in_progress', startedAt: 'nope' }, now(1))).toBeNull()
    expect(ciDurationMs({ status: 'completed', startedAt: START, completedAt: 'nope' }, now(1))).toBeNull()
    expect(isCiRunning({ status: 'in_progress', startedAt: 'nope' })).toBe(false)
  })
})

describe('ciSpanMs', () => {
  it('spans earliest start to latest end for finished overlapping items', () => {
    const items = [
      { status: 'completed', startedAt: at(10), completedAt: at(70) },
      { status: 'completed', startedAt: at(0), completedAt: at(30) },
    ]
    expect(ciSpanMs(items, now(1000))).toBe(70_000)
  })
  it('extends to now while one item is running', () => {
    const items = [
      { status: 'completed', startedAt: at(0), completedAt: at(30) },
      { status: 'in_progress', startedAt: at(20), completedAt: null },
    ]
    expect(ciSpanMs(items, now(100))).toBe(100_000)
  })
  it('returns null when nothing has started', () => {
    expect(ciSpanMs([{ status: 'queued' }, { status: 'completed', startedAt: null }], now(5))).toBeNull()
    expect(ciSpanMs([], now(5))).toBeNull()
  })
  it('ignores items that show nothing and never goes negative', () => {
    expect(ciSpanMs([{ status: 'completed', startedAt: START, completedAt: null }], now(5))).toBeNull()
    expect(ciSpanMs([{ status: 'in_progress', startedAt: at(60) }], now(0))).toBe(0)
  })
})

describe('bad input never throws', () => {
  const bad = [
    { startedAt: START },
    { status: null, startedAt: START },
    { status: 42, startedAt: START },
    { status: 'in_progress', startedAt: 123, completedAt: {} },
    { status: 'completed', startedAt: START, completedAt: 123 },
  ] as unknown as Parameters<typeof isCiRunning>[0][]
  it('shows nothing or treats it as running without throwing', () => {
    for (const item of bad) {
      expect(() => isCiRunning(item)).not.toThrow()
      expect(() => ciDurationMs(item, now(5))).not.toThrow()
    }
    expect(ciDurationMs(bad[3] as never, now(5))).toBeNull()
    expect(ciDurationMs(bad[4] as never, now(5))).toBeNull()
  })
  it('a status-less item with a start date is not running', () => {
    expect(isCiRunning(bad[0] as never)).toBe(false)
    expect(isCiRunning(bad[1] as never)).toBe(false)
    expect(ciDurationMs(bad[0] as never, now(5))).toBeNull()
  })
  it('ciSpanMs skips null entries and bad items', () => {
    const list = [null, undefined, ...bad, { status: 'completed', startedAt: at(0), completedAt: at(30) }] as never
    expect(ciSpanMs(list, now(100))).toBe(30_000)
  })
})
