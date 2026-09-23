import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { ensureKoboHome, getDbPath } from '../utils/paths.js'

let instance: Database.Database | null = null

/**
 * Return the singleton SQLite database connection, creating it on first call.
 * Configures WAL mode, busy timeout, and foreign keys.
 *
 * Safety guard: when running under vitest, refuse to open any DB located
 * under the user's real home directory. If the caller didn't pass a
 * custom path AND KOBO_HOME wasn't pinned to a temp dir, the vitest
 * global setup is misconfigured — better to fail loudly than to silently
 * mutate production data.
 */
export function getDb(dbPath?: string): Database.Database {
  if (instance) return instance

  let resolvedPath = dbPath
  if (!resolvedPath) {
    ensureKoboHome()
    resolvedPath = getDbPath()
  }

  if (process.env.VITEST) {
    const home = os.homedir()
    const resolved = path.resolve(resolvedPath)
    if (resolved.startsWith(home) && !resolved.startsWith(path.resolve(os.tmpdir()))) {
      throw new Error(
        `[kobo-db] Refusing to open production DB under a user home directory while VITEST is active: ${resolved}. ` +
          `This is a safety guard against tests leaking into the developer's ~/.config/kobo/. ` +
          `Ensure vitest.setup.ts sets KOBO_HOME to a tmp directory, or pass an explicit dbPath to getDb().`,
      )
    }
  }

  instance = new Database(resolvedPath)

  instance.pragma('journal_mode=WAL')
  instance.pragma('busy_timeout=5000')
  instance.pragma('foreign_keys=ON')

  return instance
}

/** Close the singleton database connection and release resources. */
export function closeDb(): void {
  if (instance) {
    instance.close()
    instance = null
  }
}
