import type Database from 'better-sqlite3'

export interface EngineReliabilityRow {
  engine: string
  model: string
  /** Sessions that have ended. A running one has no outcome yet. */
  total: number
  completed: number
  error: number
  killed: number
  watchdog: number
  /** Sessions that ended before `end_reason` was recorded (migration 39). */
  unknown: number
  /** Share of ended sessions that finished on their own, 0..1. */
  completedRatio: number
  /** Median wall-clock duration in ms, or null when nothing is measurable. */
  medianDurationMs: number | null
}

interface SessionRow {
  engine: string | null
  model: string | null
  end_reason: string | null
  started_at: string
  ended_at: string | null
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid]
}

/**
 * Outcome of every ended session, grouped by engine and model.
 *
 * You pick a model when creating a workspace with nothing to go on. This says
 * how each one actually behaved on *your* code: how often it finished by
 * itself, how often the watchdog had to end it, how long it typically ran.
 *
 * Median rather than mean: one session left open overnight would drag an
 * average far from anything representative.
 */
export function computeEngineReliability(db: Database.Database): EngineReliabilityRow[] {
  const rows = db
    .prepare(
      `SELECT engine, model, end_reason, started_at, ended_at
         FROM agent_sessions
        WHERE ended_at IS NOT NULL`,
    )
    .all() as SessionRow[]

  const groups = new Map<string, { row: EngineReliabilityRow; durations: number[] }>()
  for (const session of rows) {
    const engine = session.engine ?? 'unknown'
    const model = session.model ?? 'unknown'
    const key = `${engine}\u0000${model}`
    let group = groups.get(key)
    if (!group) {
      group = {
        row: {
          engine,
          model,
          total: 0,
          completed: 0,
          error: 0,
          killed: 0,
          watchdog: 0,
          unknown: 0,
          completedRatio: 0,
          medianDurationMs: null,
        },
        durations: [],
      }
      groups.set(key, group)
    }

    group.row.total += 1
    switch (session.end_reason) {
      case 'completed':
        group.row.completed += 1
        break
      case 'error':
        group.row.error += 1
        break
      case 'killed':
        group.row.killed += 1
        break
      case 'watchdog':
        group.row.watchdog += 1
        break
      default:
        // Predates migration 39, or an unrecognised value: counted, never guessed.
        group.row.unknown += 1
    }

    const started = Date.parse(session.started_at)
    const ended = session.ended_at ? Date.parse(session.ended_at) : Number.NaN
    if (!Number.isNaN(started) && !Number.isNaN(ended) && ended >= started) {
      group.durations.push(ended - started)
    }
  }

  return (
    [...groups.values()]
      .map(({ row, durations }) => ({
        ...row,
        completedRatio: row.total > 0 ? row.completed / row.total : 0,
        medianDurationMs: median(durations),
      }))
      // Ties broken by name: SQLite's read order is rowid order, which is not a
      // guarantee, and a table that reorders itself between refreshes is noise.
      .sort((a, b) => b.total - a.total || a.engine.localeCompare(b.engine) || a.model.localeCompare(b.model))
  )
}
