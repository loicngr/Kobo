import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initSchema } from '../server/db/schema.js'

// Fresh on-disk DB per test, with the singleton pinned to it via getDb(dbPath).
let tmpDir: string
let dbPath: string

async function resetDb() {
  const { closeDb } = await import('../server/db/index.js')
  closeDb()
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'at-cht-hist-test-'))
  dbPath = path.join(tmpDir, 'test.db')
  const db = new Database(dbPath)
  db.pragma('journal_mode=WAL')
  db.pragma('foreign_keys=ON')
  initSchema(db)
  db.close()
}

beforeEach(async () => {
  await resetDb()
  const { getDb } = await import('../server/db/index.js')
  getDb(dbPath)
})

afterEach(async () => {
  const { closeDb } = await import('../server/db/index.js')
  closeDb()
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

async function seedWorkspace(suffix: string) {
  const { createWorkspace } = await import('../server/services/workspace-service.js')
  return createWorkspace({
    name: `ws-${suffix}`,
    projectPath: '/tmp/p',
    sourceBranch: 'main',
    workingBranch: `feat-${suffix}`,
  })
}

describe('chat-history-service', () => {
  it('returns [] for a workspace with no history', async () => {
    const ws = await seedWorkspace('w1')
    const { listChatHistory } = await import('../server/services/chat-history-service.js')
    expect(listChatHistory(ws.id)).toEqual([])
  })

  it('push then list returns the message, most recent first', async () => {
    const ws = await seedWorkspace('w1')
    const { listChatHistory, pushChatHistory } = await import('../server/services/chat-history-service.js')
    pushChatHistory(ws.id, 'first')
    pushChatHistory(ws.id, 'second')
    expect(listChatHistory(ws.id)).toEqual(['second', 'first'])
  })

  it('dedupes against the most recent entry only', async () => {
    const ws = await seedWorkspace('w1')
    const { listChatHistory, pushChatHistory } = await import('../server/services/chat-history-service.js')
    pushChatHistory(ws.id, 'hello')
    pushChatHistory(ws.id, 'hello') // dedup — no-op
    pushChatHistory(ws.id, 'world')
    pushChatHistory(ws.id, 'hello') // not adjacent to previous 'hello' → inserted
    expect(listChatHistory(ws.id)).toEqual(['hello', 'world', 'hello'])
  })

  it('trims to the 200 most recent entries on insert', async () => {
    const ws = await seedWorkspace('w1')
    const { listChatHistory, pushChatHistory } = await import('../server/services/chat-history-service.js')
    for (let i = 0; i < 250; i++) pushChatHistory(ws.id, `m${i}`)
    const history = listChatHistory(ws.id)
    expect(history).toHaveLength(200)
    expect(history[0]).toBe('m249')
    expect(history[199]).toBe('m50')
  })

  it('scopes history per workspace (no cross-leak)', async () => {
    const a = await seedWorkspace('a')
    const b = await seedWorkspace('b')
    const { listChatHistory, pushChatHistory } = await import('../server/services/chat-history-service.js')
    pushChatHistory(a.id, 'a-only')
    pushChatHistory(b.id, 'b-only')
    expect(listChatHistory(a.id)).toEqual(['a-only'])
    expect(listChatHistory(b.id)).toEqual(['b-only'])
  })

  it('cascade-deletes history when the workspace is deleted', async () => {
    const ws = await seedWorkspace('w1')
    const { listChatHistory, pushChatHistory } = await import('../server/services/chat-history-service.js')
    const { deleteWorkspace } = await import('../server/services/workspace-service.js')
    pushChatHistory(ws.id, 'x')
    pushChatHistory(ws.id, 'y')
    expect(listChatHistory(ws.id)).toHaveLength(2)
    deleteWorkspace(ws.id)
    expect(listChatHistory(ws.id)).toEqual([])
  })

  it('ignores empty / whitespace-only messages', async () => {
    const ws = await seedWorkspace('w1')
    const { listChatHistory, pushChatHistory } = await import('../server/services/chat-history-service.js')
    pushChatHistory(ws.id, '')
    pushChatHistory(ws.id, '   ')
    expect(listChatHistory(ws.id)).toEqual([])
  })
})
