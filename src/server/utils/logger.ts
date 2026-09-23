import fs from 'node:fs'
import path from 'node:path'
import { getKoboHome } from './paths.js'

/**
 * Minimal structured logger — deliberately dependency-free.
 *
 * Kōbō ships twelve production dependencies, all structural. A logging library
 * would be the thirteenth for a single-user local tool whose entire need is
 * "one JSON line per event, in a file that does not grow forever, readable
 * from the Health page". That fits in this module, so it lives here.
 *
 * In production every console line goes to the stdout of a process started in
 * a terminal: close the terminal, lose the diagnosis. This writes to disk AND
 * mirrors to the console, so nothing regresses while call sites migrate.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LogEntry {
  ts: string
  level: LogLevel
  scope: string
  message: string
  meta?: unknown
}

const MAX_FILE_BYTES = 5 * 1024 * 1024
const KEPT_ROTATIONS = 3
const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

let cachedDir: string | null = null

/** Test hook: drop the cached directory so a new KOBO_HOME takes effect. */
export function _resetLoggerForTest(): void {
  cachedDir = null
}

function logDir(): string {
  if (cachedDir === null) cachedDir = path.join(getKoboHome(), 'logs')
  return cachedDir
}

export function getLogFilePath(): string {
  return path.join(logDir(), 'kobo.log')
}

function rotateIfNeeded(file: string): void {
  let size = 0
  try {
    size = fs.statSync(file).size
  } catch {
    return // no file yet — nothing to rotate
  }
  if (size < MAX_FILE_BYTES) return

  try {
    fs.rmSync(`${file}.${KEPT_ROTATIONS}`, { force: true })
    for (let i = KEPT_ROTATIONS - 1; i >= 1; i--) {
      if (fs.existsSync(`${file}.${i}`)) fs.renameSync(`${file}.${i}`, `${file}.${i + 1}`)
    }
    fs.renameSync(file, `${file}.1`)
  } catch (err) {
    console.error('[logger] rotation failed:', err)
  }
}

function mirrorToConsole(entry: LogEntry): void {
  const line = `[${entry.scope}] ${entry.message}`
  if (entry.level === 'error') console.error(line, entry.meta ?? '')
  else if (entry.level === 'warn') console.warn(line, entry.meta ?? '')
  else console.log(line, entry.meta ?? '')
}

export function log(level: LogLevel, scope: string, message: string, meta?: unknown): void {
  const entry: LogEntry = { ts: new Date().toISOString(), level, scope, message }
  if (meta !== undefined) entry.meta = meta
  mirrorToConsole(entry)

  // A logging failure must NEVER take down the operation it was logging.
  try {
    const dir = logDir()
    fs.mkdirSync(dir, { recursive: true })
    const file = getLogFilePath()
    rotateIfNeeded(file)
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf-8')
  } catch {
    // Console already has the line; nothing more to do.
  }
}

export function logInfo(scope: string, message: string, meta?: unknown): void {
  log('info', scope, message, meta)
}

export function logWarn(scope: string, message: string, meta?: unknown): void {
  log('warn', scope, message, meta)
}

export function logError(scope: string, message: string, meta?: unknown): void {
  log('error', scope, message, meta)
}

/**
 * Most recent entries first, bounded. Reads only the current file — the
 * rotated ones stay on disk for a human with `grep`, which is the right tool
 * for anything this route cannot answer.
 */
export function readRecentLogs(options: { limit?: number; level?: LogLevel } = {}): LogEntry[] {
  const limit = Math.min(Math.max(options.limit ?? 200, 1), 2000)
  const minLevel = options.level ? LEVEL_ORDER[options.level] : 0

  let raw: string
  try {
    raw = fs.readFileSync(getLogFilePath(), 'utf-8')
  } catch {
    return []
  }

  const out: LogEntry[] = []
  const lines = raw.split('\n')
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    const line = lines[i].trim()
    if (line.length === 0) continue
    try {
      const entry = JSON.parse(line) as LogEntry
      if (LEVEL_ORDER[entry.level] >= minLevel) out.push(entry)
    } catch {
      // A truncated last line (process killed mid-append) is skipped, not fatal.
    }
  }
  return out
}
