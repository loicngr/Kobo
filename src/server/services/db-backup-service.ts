import fs from 'node:fs'
import path from 'node:path'
import type Database from 'better-sqlite3'

const BACKUP_PREFIX = 'kobo.db.backup-'
const DEFAULT_KEEP = 7
const DAILY_MS = 24 * 60 * 60 * 1000

let backupSequence = 0

/** Test-only: reset the in-process monotonic sequence to 0. */
export function _resetBackupSequenceForTests(): void {
  backupSequence = 0
}

/** Result of a daily backup attempt. */
export interface DbBackupResult {
  /** Absolute path of the newly created backup, or `null` if none was needed / the attempt failed. */
  created: string | null
  /** Absolute paths of backups rotated out. */
  deleted: string[]
}

interface BackupEntry {
  path: string
  mtimeMs: number
}

function listBackups(dir: string): BackupEntry[] {
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(BACKUP_PREFIX))
    .map((f) => {
      const full = path.join(dir, f)
      const stat = fs.statSync(full)
      return { path: full, mtimeMs: stat.mtimeMs }
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
}

/**
 * Create a WAL-safe snapshot of the Kōbō DB if no backup has been made in the
 * last 24h. Rotates old backups, keeping only the `keepCount` most recent.
 *
 * - Location: same directory as `dbPath`, named `kobo.db.backup-<ISO>-<seq>`
 *   (mirrors the settings.json backup convention).
 * - Uses better-sqlite3's online `.backup()` API, which is safe while the DB
 *   is open and under write load (WAL mode).
 * - Best-effort: never throws. On failure, logs to console.error and returns
 *   `{ created: null, deleted: [] }` so the boot path is never blocked.
 */
export async function createDailyDbBackupIfNeeded(
  db: Database.Database,
  dbPath: string,
  keepCount: number = DEFAULT_KEEP,
  nowMs: number = Date.now(),
): Promise<DbBackupResult> {
  const result: DbBackupResult = { created: null, deleted: [] }
  const dir = path.dirname(dbPath)

  try {
    const existing = listBackups(dir)
    const latestMtime = existing[0]?.mtimeMs ?? 0
    if (latestMtime && nowMs - latestMtime < DAILY_MS) {
      return result
    }

    const stamp = new Date(nowMs).toISOString().replace(/[:.]/g, '-')
    backupSequence += 1
    const backupPath = path.join(dir, `${BACKUP_PREFIX}${stamp}-${backupSequence}`)

    await db.backup(backupPath)
    result.created = backupPath

    const all = listBackups(dir)
    if (all.length > keepCount) {
      for (const entry of all.slice(keepCount)) {
        try {
          fs.unlinkSync(entry.path)
          result.deleted.push(entry.path)
        } catch (err) {
          console.error(`[kobo] Failed to delete old DB backup ${entry.path}:`, err)
        }
      }
    }
  } catch (err) {
    console.error('[kobo] DB daily backup failed:', err)
  }

  return result
}
