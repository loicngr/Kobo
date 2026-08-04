export interface WhipPoint {
  x: number
  y: number
  previousX: number
  previousY: number
}

export interface WhipState {
  points: WhipPoint[]
  dropping: boolean
  spawnedAt: number
  lastCrackAt: number
}

export interface WhipBounds {
  width: number
  height: number
}

export interface WhipInput {
  pointer: { x: number; y: number }
  bounds: WhipBounds
  now: number
}

export interface WhipConfig {
  segments: number
  segmentLength: number
  taper: number
  gravity: number
  dropGravity: number
  damping: number
  constraintIterations: number
  maxStretchRatio: number
  crackSpeed: number
  crackCooldownMs: number
  spawnGraceMs: number
}

export const WHIP_CONFIG: Readonly<WhipConfig> = {
  segments: 28,
  segmentLength: 25,
  taper: 0.6,
  gravity: 1.2,
  dropGravity: 0.95,
  damping: 0.96,
  constraintIterations: 20,
  maxStretchRatio: 1.2,
  crackSpeed: 340,
  crackCooldownMs: 250,
  spawnGraceMs: 350,
}

function segmentLengthAt(index: number, config: Readonly<WhipConfig>): number {
  const denominator = Math.max(1, config.segments - 2)
  const progress = Math.min(1, index / denominator)
  return config.segmentLength * (1 - progress * (1 - config.taper))
}

export function createWhip(
  pointer: { x: number; y: number },
  now: number,
  config: Readonly<WhipConfig> = WHIP_CONFIG,
): WhipState {
  const points: WhipPoint[] = [
    { x: pointer.x, y: pointer.y, previousX: pointer.x, previousY: pointer.y },
  ]

  for (let index = 1; index < config.segments; index += 1) {
    const previous = points[index - 1]!
    const progress = index / Math.max(1, config.segments - 1)
    const angle = -1.1 + progress * 1.15
    const length = segmentLengthAt(index - 1, config)
    const x = previous.x + Math.cos(angle) * length
    const y = previous.y + Math.sin(angle) * length
    points.push({ x, y, previousX: x, previousY: y })
  }

  return { points, dropping: false, spawnedAt: now, lastCrackAt: Number.NEGATIVE_INFINITY }
}

export function dropWhip(state: WhipState): void {
  state.dropping = true
}

function capStretch(state: WhipState, config: Readonly<WhipConfig>): void {
  for (let index = 0; index < state.points.length - 1; index += 1) {
    const start = state.points[index]!
    const end = state.points[index + 1]!
    const dx = end.x - start.x
    const dy = end.y - start.y
    const distance = Math.hypot(dx, dy) || 0.0001
    const maximum = segmentLengthAt(index, config) * config.maxStretchRatio
    if (distance <= maximum) continue
    const ratio = maximum / distance
    end.x = start.x + dx * ratio
    end.y = start.y + dy * ratio
  }
}

function constrainDistances(state: WhipState, config: Readonly<WhipConfig>): void {
  for (let iteration = 0; iteration < config.constraintIterations; iteration += 1) {
    for (let index = 0; index < state.points.length - 1; index += 1) {
      const start = state.points[index]!
      const end = state.points[index + 1]!
      const dx = end.x - start.x
      const dy = end.y - start.y
      const distance = Math.hypot(dx, dy) || 0.0001
      const difference = (distance - segmentLengthAt(index, config)) / distance
      const offsetX = dx * difference * 0.5
      const offsetY = dy * difference * 0.5

      if (index === 0 && !state.dropping) {
        end.x -= offsetX * 2
        end.y -= offsetY * 2
      } else {
        start.x += offsetX
        start.y += offsetY
        end.x -= offsetX
        end.y -= offsetY
      }
    }
    capStretch(state, config)
  }
}

function containLiveWhip(state: WhipState, bounds: WhipBounds): void {
  if (state.dropping) return
  for (let index = 1; index < state.points.length; index += 1) {
    const point = state.points[index]!
    point.x = Math.max(0, Math.min(bounds.width, point.x))
    point.y = Math.max(0, Math.min(bounds.height, point.y))
  }
}

export function stepWhip(
  state: WhipState,
  input: WhipInput,
  config: Readonly<WhipConfig> = WHIP_CONFIG,
): { cracked: boolean; offscreen: boolean } {
  const tip = state.points.at(-1)
  const tipSpeed = tip ? Math.hypot(tip.x - tip.previousX, tip.y - tip.previousY) : 0
  const graceElapsed = input.now - state.spawnedAt >= config.spawnGraceMs
  const cooldownElapsed = input.now - state.lastCrackAt >= config.crackCooldownMs
  const cracked = !state.dropping && graceElapsed && cooldownElapsed && tipSpeed > config.crackSpeed
  if (cracked) state.lastCrackAt = input.now

  const startIndex = state.dropping ? 0 : 1
  const gravity = state.dropping ? config.dropGravity : config.gravity
  for (let index = startIndex; index < state.points.length; index += 1) {
    const point = state.points[index]!
    const velocityX = (point.x - point.previousX) * config.damping
    const velocityY = (point.y - point.previousY) * config.damping
    point.previousX = point.x
    point.previousY = point.y
    point.x += velocityX
    point.y += velocityY + gravity
  }

  if (!state.dropping) {
    const handle = state.points[0]
    if (handle) {
      handle.x = input.pointer.x
      handle.y = input.pointer.y
      handle.previousX = input.pointer.x
      handle.previousY = input.pointer.y
    }
  }

  capStretch(state, config)
  containLiveWhip(state, input.bounds)
  constrainDistances(state, config)
  containLiveWhip(state, input.bounds)

  return {
    cracked,
    offscreen: state.dropping && state.points.every((point) => point.y > input.bounds.height + 60),
  }
}
