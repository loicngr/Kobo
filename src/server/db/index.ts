import Database from 'better-sqlite3'
import { ensureKoboHome, getDbPath } from '../utils/paths.js'

let instance: Database.Database | null = null

export function getDb(dbPath?: string): Database.Database {
  if (instance) return instance

  let resolvedPath = dbPath
  if (!resolvedPath) {
    ensureKoboHome()
    resolvedPath = getDbPath()
  }

  instance = new Database(resolvedPath)

  instance.pragma('journal_mode=WAL')
  instance.pragma('busy_timeout=5000')
  instance.pragma('foreign_keys=ON')

  return instance
}

export function closeDb(): void {
  if (instance) {
    instance.close()
    instance = null
  }
}
