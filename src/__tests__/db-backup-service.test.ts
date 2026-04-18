import fs, { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os, { tmpdir } from 'node:os'
import path, { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { _resetBackupSequenceForTests, createDailyDbBackupIfNeeded } from '../server/services/db-backup-service.js'

const DAILY_MS = 24 * 60 * 60 * 1000

let tmpDir: string
let dbPath: string
let db: Database.Database

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'at-db-backup-'))
  dbPath = path.join(tmpDir, 'kobo.db')
  db = new Database(dbPath)
  db.exec('CREATE TABLE t (id INTEGER); INSERT INTO t VALUES (1);')
  _resetBackupSequenceForTests()
})

afterEach(() => {
  try {
    db.close()
  } catch {
    // ignore
  }
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

function listBackupFiles(): string[] {
  return fs.readdirSync(tmpDir).filter((f) => f.startsWith('kobo.db.backup-'))
}

describe('createDailyDbBackupIfNeeded', () => {
  it('creates a backup when no prior backup exists', async () => {
    const result = await createDailyDbBackupIfNeeded(db, dbPath)
    expect(result.created).not.toBeNull()
    expect(fs.existsSync(result.created as string)).toBe(true)
    expect(listBackupFiles()).toHaveLength(1)
  })

  it('writes a filename matching kobo.db.backup-<ISO>-<seq>', async () => {
    const result = await createDailyDbBackupIfNeeded(db, dbPath)
    const basename = path.basename(result.created as string)
    expect(basename).toMatch(/^kobo\.db\.backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-\d+$/)
  })

  it('skips backup when a recent backup (<24h) already exists', async () => {
    await createDailyDbBackupIfNeeded(db, dbPath)
    const second = await createDailyDbBackupIfNeeded(db, dbPath)
    expect(second.created).toBeNull()
    expect(listBackupFiles()).toHaveLength(1)
  })

  it('creates a new backup when the most recent is older than 24h', async () => {
    const oldBackup = path.join(tmpDir, 'kobo.db.backup-2020-01-01T00-00-00-000Z-1')
    fs.writeFileSync(oldBackup, 'stale')
    const oldTime = new Date(Date.now() - (DAILY_MS + 60_000))
    fs.utimesSync(oldBackup, oldTime, oldTime)

    const result = await createDailyDbBackupIfNeeded(db, dbPath)
    expect(result.created).not.toBeNull()
    expect(listBackupFiles()).toHaveLength(2)
  })

  it('rotates backups keeping the N most recent', async () => {
    const now = Date.now()
    for (let i = 0; i < 10; i++) {
      const p = path.join(tmpDir, `kobo.db.backup-2024-${String(i + 1).padStart(2, '0')}-01T00-00-00-000Z-${i}`)
      fs.writeFileSync(p, `${i}`)
      const mtime = new Date(now - (i + 2) * DAILY_MS)
      fs.utimesSync(p, mtime, mtime)
    }

    const result = await createDailyDbBackupIfNeeded(db, dbPath, 7)
    expect(result.created).not.toBeNull()
    expect(result.deleted.length).toBe(4)
    expect(listBackupFiles()).toHaveLength(7)
  })

  it('ignores non-backup files in the directory', async () => {
    fs.writeFileSync(path.join(tmpDir, 'kobo.db-wal'), 'wal')
    fs.writeFileSync(path.join(tmpDir, 'kobo.db-shm'), 'shm')
    fs.writeFileSync(path.join(tmpDir, 'settings.json'), '{}')
    fs.writeFileSync(path.join(tmpDir, 'random.txt'), 'unrelated')

    const result = await createDailyDbBackupIfNeeded(db, dbPath)
    expect(result.created).not.toBeNull()
    expect(fs.existsSync(path.join(tmpDir, 'random.txt'))).toBe(true)
    expect(fs.existsSync(path.join(tmpDir, 'settings.json'))).toBe(true)
    expect(listBackupFiles()).toHaveLength(1)
  })

  it('backup file is a usable SQLite database containing the source data', async () => {
    const result = await createDailyDbBackupIfNeeded(db, dbPath)
    expect(result.created).not.toBeNull()

    const restored = new Database(result.created as string, { readonly: true })
    const row = restored.prepare('SELECT id FROM t').get() as { id: number }
    expect(row.id).toBe(1)
    restored.close()
  })

  it('never throws — returns null created on error', async () => {
    const badPath = path.join(tmpDir, 'subdir-does-not-exist', 'kobo.db')
    const result = await createDailyDbBackupIfNeeded(db, badPath)
    expect(result.created).toBeNull()
  })
})

describe('createPreMigrationBackup', () => {
  it('creates a backup file with the premigration prefix regardless of the daily throttle', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'kobo-premig-'))
    const dbPath = join(tmpDir, 'kobo.db')
    const db = new Database(dbPath)
    // Seed a daily backup that would normally throttle
    const now = Date.now()
    writeFileSync(join(tmpDir, `kobo.db.backup-${new Date(now).toISOString()}-0`), 'stub')

    const { createPreMigrationBackup } = await import('../server/services/db-backup-service.js')
    const result = await createPreMigrationBackup(db, dbPath, 'v10')
    expect(result.created).toMatch(/kobo\.db\.premigration-v10-/)
    expect(existsSync(result.created!)).toBe(true)

    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('does NOT rotate/delete previous premigration backups', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'kobo-premig-'))
    const dbPath = join(tmpDir, 'kobo.db')
    const db = new Database(dbPath)
    const existing = join(tmpDir, 'kobo.db.premigration-v9-2025-01-01T00-00-00-000Z-1')
    writeFileSync(existing, 'stub')

    const { createPreMigrationBackup } = await import('../server/services/db-backup-service.js')
    await createPreMigrationBackup(db, dbPath, 'v10')
    expect(existsSync(existing)).toBe(true)

    rmSync(tmpDir, { recursive: true, force: true })
  })
})
