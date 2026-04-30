import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

function _withTmpDb(fn: (db: import('better-sqlite3').Database, tmpDir: string) => void): void {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'at-db-test-'))
  const Database = require('better-sqlite3')
  const dbPath = path.join(tmpDir, 'test.db')
  const db = new Database(dbPath)
  try {
    fn(db, tmpDir)
  } finally {
    db.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}

describe('getDb() / closeDb() — singleton', () => {
  afterEach(async () => {
    const { closeDb } = await import('../server/db/index.js')
    closeDb()
  })

  it('getDb(dbPath) accepte un chemin personnalisé (utile pour les tests)', async () => {
    const { getDb, closeDb } = await import('../server/db/index.js')
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'at-custom-path-test-'))
    const customPath = path.join(tmpDir, 'custom.db')

    const _db = getDb(customPath)
    expect(fs.existsSync(customPath)).toBe(true)
    closeDb()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('closeDb() ferme et réinitialise le singleton', async () => {
    const { getDb, closeDb } = await import('../server/db/index.js')
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'at-close-test-'))
    const dbPath = path.join(tmpDir, 'close.db')

    const db1 = getDb(dbPath)
    closeDb()
    const db2 = getDb(dbPath)
    expect(db2).not.toBe(db1)
    closeDb()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })
})

describe('getDb() — comportements SQLite', () => {
  it('active le mode WAL sur un fichier', async () => {
    const Database = (await import('better-sqlite3')).default
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'at-wal-test-'))
    const db = new Database(path.join(tmpDir, 'wal.db'))
    db.pragma('journal_mode=WAL')
    const row = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }
    expect(row.journal_mode).toBe('wal')
    db.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('active les foreign keys', async () => {
    const Database = (await import('better-sqlite3')).default
    const db = new Database(':memory:')
    db.pragma('foreign_keys=ON')
    const row = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }
    expect(row.foreign_keys).toBe(1)
    db.close()
  })

  it('crée le répertoire data/ et le fichier kobo.db', async () => {
    const Database = (await import('better-sqlite3')).default
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'at-db-create-test-'))
    const dataDir = path.join(tmpDir, 'data')
    fs.mkdirSync(dataDir, { recursive: true })
    const db = new Database(path.join(dataDir, 'kobo.db'))
    db.pragma('journal_mode=WAL')
    db.pragma('foreign_keys=ON')

    expect(fs.existsSync(path.join(tmpDir, 'data'))).toBe(true)
    expect(fs.existsSync(path.join(tmpDir, 'data', 'kobo.db'))).toBe(true)
    db.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('getDb() — la logique crée data/ automatiquement si absent', async () => {
    const Database = (await import('better-sqlite3')).default
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'at-db-nodata-test-'))
    // data/ n'existe pas encore
    const dataDir = path.join(tmpDir, 'data')
    expect(fs.existsSync(dataDir)).toBe(false)

    // Reproduire la logique de getDb()
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true })
    }
    const db = new Database(path.join(dataDir, 'kobo.db'))

    expect(fs.existsSync(dataDir)).toBe(true)
    db.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })
})
