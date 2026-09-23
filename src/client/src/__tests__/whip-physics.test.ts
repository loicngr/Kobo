import { describe, expect, it } from 'vitest'
import { createWhip, dropWhip, stepWhip, WHIP_CONFIG } from '../utils/whip-physics'

const bounds = { width: 1200, height: 800 }

describe('whip physics', () => {
  it('creates a tapered rope rooted at the pointer', () => {
    const state = createWhip({ x: 200, y: 300 }, 1_000)
    expect(state.points).toHaveLength(WHIP_CONFIG.segments)
    expect(state.points[0]).toMatchObject({ x: 200, y: 300, previousX: 200, previousY: 300 })
    const first = Math.hypot(state.points[1]!.x - state.points[0]!.x, state.points[1]!.y - state.points[0]!.y)
    const lastIndex = state.points.length - 1
    const last = Math.hypot(
      state.points[lastIndex]!.x - state.points[lastIndex - 1]!.x,
      state.points[lastIndex]!.y - state.points[lastIndex - 1]!.y,
    )
    expect(first).toBeGreaterThan(last)
  })

  it('pins the handle and constrains adjacent points', () => {
    const state = createWhip({ x: 100, y: 100 }, 1_000)
    stepWhip(state, { pointer: { x: 350, y: 220 }, bounds, now: 1_016 })
    expect(state.points[0]).toMatchObject({ x: 350, y: 220 })
    for (let index = 0; index < state.points.length - 1; index += 1) {
      const a = state.points[index]!
      const b = state.points[index + 1]!
      expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeLessThanOrEqual(
        WHIP_CONFIG.segmentLength * WHIP_CONFIG.maxStretchRatio + 0.01,
      )
    }
  })

  it('applies spawn grace and cooldown to crack detection', () => {
    const state = createWhip({ x: 100, y: 100 }, 1_000)
    const tip = state.points.at(-1)!
    tip.previousX = tip.x - WHIP_CONFIG.crackSpeed - 10
    expect(stepWhip(state, { pointer: { x: 100, y: 100 }, bounds, now: 1_200 }).cracked).toBe(false)
    tip.previousX = tip.x - WHIP_CONFIG.crackSpeed - 10
    expect(stepWhip(state, { pointer: { x: 100, y: 100 }, bounds, now: 1_400 }).cracked).toBe(true)
    tip.previousX = tip.x - WHIP_CONFIG.crackSpeed - 10
    expect(stepWhip(state, { pointer: { x: 100, y: 100 }, bounds, now: 1_500 }).cracked).toBe(false)
    tip.previousX = tip.x - WHIP_CONFIG.crackSpeed - 10
    expect(stepWhip(state, { pointer: { x: 100, y: 100 }, bounds, now: 1_700 }).cracked).toBe(true)
  })

  it('lets a dropped whip fall completely offscreen', () => {
    const state = createWhip({ x: 100, y: 790 }, 1_000)
    dropWhip(state)
    let offscreen = false
    for (let frame = 0; frame < 240 && !offscreen; frame += 1) {
      offscreen = stepWhip(state, {
        pointer: { x: 100, y: 790 },
        bounds,
        now: 1_000 + frame * 16,
      }).offscreen
    }
    expect(offscreen).toBe(true)
  })

  it('produces comparable motion at 60 Hz and 120 Hz', () => {
    function simulate(frameMs: number) {
      const state = createWhip({ x: 100, y: 200 }, 0)
      let now = 0
      while (now < 1_000) {
        now = Math.min(1_000, now + frameMs)
        stepWhip(state, {
          pointer: { x: 100 + now * 0.4, y: 200 },
          bounds,
          now,
        })
      }
      return state.points.at(-1)!
    }

    const sixtyHz = simulate(1_000 / 60)
    const oneTwentyHz = simulate(1_000 / 120)

    expect(Math.abs(oneTwentyHz.x - sixtyHz.x)).toBeLessThan(1)
    expect(Math.abs(oneTwentyHz.y - sixtyHz.y)).toBeLessThan(1)
  })
})
