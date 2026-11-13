import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initSchema } from '../server/db/schema.js'
import type { SlackMessageRow } from '../server/services/slack/slack-message-store.js'

let tmpDir: string
let store: typeof import('../server/services/slack/slack-message-store.js')
let getDb: typeof import('../server/db/index.js').getDb

beforeEach(async () => {
  const { closeDb } = await import('../server/db/index.js')
  closeDb()
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kobo-slack-store-'))
  const dbPath = path.join(tmpDir, 'test.db')
  const db = new Database(dbPath)
  db.pragma('journal_mode=WAL')
  db.pragma('foreign_keys=ON')
  initSchema(db)
  db.close()
  ;({ getDb } = await import('../server/db/index.js'))
  getDb(dbPath)
  store = await import('../server/services/slack/slack-message-store.js')
  for (const id of ['wsA', 'wsB'])
    getDb()
      .prepare(
        "INSERT INTO workspaces(id,name,project_path,source_branch,working_branch,created_at,updated_at) VALUES (?,?,'/tmp','main',?,'now','now')",
      )
      .run(id, id, `b-${id}`)
})

afterEach(async () => {
  const { closeDb } = await import('../server/db/index.js')
  closeDb()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function msg(over: Partial<Omit<SlackMessageRow, 'createdAt'>> = {}): Omit<SlackMessageRow, 'createdAt'> {
  return {
    channelId: 'C1',
    ts: '1731500000.000100',
    threadTs: '1731500000.000100',
    workspaceId: 'wsA',
    userId: 'U1',
    userName: 'alice',
    text: 'hi',
    direction: 'in',
    state: 'queued',
    files: [],
    ...over,
  }
}

describe('slack message store', () => {
  it('insertSlackMessage returns true then false for the same (channel, ts)', () => {
    expect(store.insertSlackMessage(msg())).toBe(true)
    expect(store.insertSlackMessage(msg({ text: 'other' }))).toBe(false)
  })

  it('maps files to and from JSON', () => {
    const files = [{ id: 'F1', name: 'a.png', mimetype: 'image/png', size: 3, url: 'https://x/a.png' }]
    store.insertSlackMessage(msg({ files }))
    expect(store.nextQueuedSlackMessage('wsA')?.files).toEqual(files)
  })

  it('isTrackedThread follows the state rules', () => {
    for (const state of ['context', 'rejected', 'unknown'] as const)
      store.insertSlackMessage(msg({ ts: `1.${state}`, threadTs: 'T', state }))
    expect(store.isTrackedThread('C1', 'T')).toBe(false)
    store.insertSlackMessage(msg({ ts: '2.1', threadTs: 'T', state: 'queued' }))
    expect(store.isTrackedThread('C1', 'T')).toBe(true)
    store.insertSlackMessage(msg({ ts: '3.1', threadTs: 'T2', direction: 'out', state: 'sent', userId: null }))
    expect(store.isTrackedThread('C1', 'T2')).toBe(true)
  })

  it('nextQueuedSlackMessage returns the oldest queued row of that workspace only', () => {
    store.insertSlackMessage(msg({ ts: '5.1', threadTs: '5.1' }))
    store.insertSlackMessage(msg({ ts: '3.1', threadTs: '3.1' }))
    store.insertSlackMessage(msg({ ts: '1.1', threadTs: '1.1', workspaceId: 'wsB', channelId: 'C2' }))
    expect(store.nextQueuedSlackMessage('wsA')?.ts).toBe('3.1')
    expect(store.countQueuedSlackMessages('wsA')).toBe(2)
  })

  it('listSlackThread returns the newest page oldest first and pages with before', () => {
    for (const ts of ['1.1', '2.1', '3.1']) store.insertSlackMessage(msg({ ts, threadTs: 'T', state: 'delivered' }))
    expect(store.listSlackThread('C1', 'T', { limit: 2 }).map((r) => r.ts)).toEqual(['2.1', '3.1'])
    expect(store.listSlackThread('C1', 'T', { limit: 2, before: '2.1' }).map((r) => r.ts)).toEqual(['1.1'])
    expect(store.countThreadMessagesBefore('C1', 'T', '3.1')).toBe(2)
  })

  it('reconcileSlackMessages turns dispatching into unknown and leaves queued', () => {
    store.insertSlackMessage(msg({ ts: '1.1', state: 'dispatching' }))
    store.insertSlackMessage(msg({ ts: '2.1', state: 'queued' }))
    expect(store.reconcileSlackMessages().map((r) => r.ts)).toEqual(['1.1'])
    expect(store.nextQueuedSlackMessage('wsA')?.ts).toBe('2.1')
    store.setSlackMessageState('C1', '2.1', 'delivered')
    expect(store.countQueuedSlackMessages('wsA')).toBe(0)
  })

  it('expireQueuedSlackMessages rejects old queued rows', () => {
    store.insertSlackMessage(msg({ ts: '1.1' }))
    expect(store.expireQueuedSlackMessages('2999-01-01T00:00:00.000Z').map((r) => r.ts)).toEqual(['1.1'])
    expect(store.countQueuedSlackMessages('wsA')).toBe(0)
  })

  it('links channels exclusively and clears history on unlink', () => {
    expect(store.setWorkspaceSlackChannel('wsA', 'C1')).toEqual([])
    expect(store.getWorkspaceIdForSlackChannel('C1')).toBe('wsA')
    expect(() => store.setWorkspaceSlackChannel('wsB', 'C1')).toThrow(
      'Slack channel is already linked to another workspace',
    )
    store.insertSlackMessage(msg({ ts: '1.1', threadTs: 'T' }))
    expect(store.setWorkspaceSlackChannel('wsA', 'C1')).toEqual([])
    expect(store.countQueuedSlackMessages('wsA')).toBe(1)
    const dropped = store.setWorkspaceSlackChannel('wsA', null)
    expect(dropped.map((r) => r.ts)).toEqual(['1.1'])
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM slack_messages WHERE workspace_id='wsA'").get()).toEqual({ n: 0 })
    expect(store.setWorkspaceSlackChannel('wsB', 'C1')).toEqual([])
    expect(store.isTrackedThread('C1', 'T')).toBe(false)
  })

  it('maps corrupt files JSON to an empty list instead of throwing', () => {
    store.insertSlackMessage(msg())
    getDb().prepare("UPDATE slack_messages SET files = 'not json'").run()
    expect(store.nextQueuedSlackMessage('wsA')?.files).toEqual([])
    getDb().prepare("UPDATE slack_messages SET files = '{}'").run()
    expect(store.nextQueuedSlackMessage('wsA')?.files).toEqual([])
  })

  it('lists workspaces that have queued messages', () => {
    store.insertSlackMessage(msg())
    store.insertSlackMessage(msg({ ts: '2', channelId: 'C2', workspaceId: 'wsB', state: 'delivered' }))
    expect(store.listWorkspacesWithQueuedSlackMessages()).toEqual(['wsA'])
  })

  it('claims a row for dispatch only while queued, owned and still linked', () => {
    getDb().prepare("UPDATE workspaces SET slack_channel_id = 'C1' WHERE id = 'wsA'").run()
    store.insertSlackMessage(msg())
    expect(store.claimSlackMessageForDispatch('C1', msg().ts, 'wsB')).toBe(false)
    expect(store.claimSlackMessageForDispatch('C1', msg().ts, 'wsA')).toBe(true)
    expect(store.getSlackMessageState('C1', msg().ts)).toBe('dispatching')
    expect(store.claimSlackMessageForDispatch('C1', msg().ts, 'wsA')).toBe(false)
    store.insertSlackMessage(msg({ ts: '2' }))
    store.setSlackMessageState('C1', '2', 'rejected')
    expect(store.claimSlackMessageForDispatch('C1', '2', 'wsA')).toBe(false)
    store.insertSlackMessage(msg({ ts: '3' }))
    getDb().prepare("UPDATE workspaces SET slack_channel_id = NULL WHERE id = 'wsA'").run()
    expect(store.claimSlackMessageForDispatch('C1', '3', 'wsA')).toBe(false)
    expect(store.getSlackMessageState('C1', '3')).toBe('queued')
    expect(store.getSlackMessageState('C1', 'missing')).toBeUndefined()
  })

  it('marks delivered only from dispatching', () => {
    store.insertSlackMessage(msg({ state: 'rejected' }))
    expect(store.markSlackMessageDelivered('C1', msg().ts)).toBe(false)
    expect(store.getSlackMessageState('C1', msg().ts)).toBe('rejected')
    store.setSlackMessageState('C1', msg().ts, 'dispatching')
    expect(store.markSlackMessageDelivered('C1', msg().ts)).toBe(true)
    expect(store.getSlackMessageState('C1', msg().ts)).toBe('delivered')
  })

  it('promotes a context row to the real message, never another state', () => {
    store.insertSlackMessage(msg({ state: 'context', text: 'raw <@UBOT> text', files: [] }))
    const real = msg({
      text: 'text',
      files: [{ id: 'F', name: 'a.png', mimetype: 'image/png', size: 1, url: 'https://x' }],
    })
    expect(store.promoteSlackContextMessage({ ...real, state: 'queued' })).toBe(true)
    const row = store.nextQueuedSlackMessage('wsA')!
    expect([row.state, row.text, row.files[0]?.url]).toEqual(['queued', 'text', 'https://x'])
    expect(store.promoteSlackContextMessage({ ...real, state: 'queued' })).toBe(false)
    expect(store.promoteSlackContextMessage({ ...real, workspaceId: 'wsB', ts: '9', state: 'queued' })).toBe(false)
  })

  it('A2: countThreadMessagesBefore counts only rows the read tool shows', () => {
    const states = ['context', 'delivered', 'queued', 'dispatching', 'rejected', 'unknown'] as const
    for (const [i, state] of states.entries()) store.insertSlackMessage(msg({ ts: `1.${i}`, threadTs: 'T', state }))
    store.insertSlackMessage(msg({ ts: '1.6', threadTs: 'T', direction: 'out', state: 'sent' }))
    expect(store.countThreadMessagesBefore('C1', 'T', '9')).toBe(3)
    expect(store.countThreadMessagesBefore('C1', 'T', '9')).toBe(store.listSlackThread('C1', 'T', { limit: 50 }).length)
  })

  describe('buttons', () => {
    const bot = (over: Partial<Omit<SlackMessageRow, 'createdAt'>> = {}) =>
      msg({ ts: '2.0', threadTs: '1.0', direction: 'out', state: 'sent', userId: 'UBOT', buttons: ['A', 'B'], ...over })
    const click = (over: Partial<Omit<SlackMessageRow, 'createdAt'>> = {}) =>
      msg({ ts: '3.0-U1', threadTs: '1.0', text: 'Clicked: A', clickOf: '2.0', ...over })

    beforeEach(() => {
      getDb().prepare("UPDATE workspaces SET slack_channel_id = 'C1' WHERE id = 'wsA'").run()
    })

    it('stores and reads back a bot message with buttons, and a plain message without them', () => {
      store.insertSlackMessage(bot({ multiple: true }))
      store.insertSlackMessage(msg({ ts: '2.5', direction: 'out', state: 'sent' }))
      expect(store.getSlackButtonMessage('C1', '2.0')).toMatchObject({
        buttons: ['A', 'B'],
        multiple: true,
        threadTs: '1.0',
      })
      expect(store.getSlackButtonMessage('C1', '2.5')).toBeUndefined()
      expect(store.getSlackButtonMessage('C1', 'missing')).toBeUndefined()
      expect(store.isTrackedThread('C1', '1.0')).toBe(true)
    })

    it('single answer: the first click wins by compare-and-set and later clicks lose', () => {
      store.insertSlackMessage(bot())
      expect(store.recordSlackClick(click(), '2.0', true)).toBe(true)
      expect(store.recordSlackClick(click(), '2.0', true)).toBe(false)
      expect(store.recordSlackClick(click({ ts: '3.1-U2' }), '2.0', true)).toBe(false)
      expect(store.getSlackButtonMessage('C1', '2.0')?.answered).toBe(true)
      expect(store.isTrackedThread('C1', '1.0')).toBe(true)
      const row = store.nextQueuedSlackMessage('wsA')!
      expect([row.ts, row.clickOf, row.multiple, row.text]).toEqual(['3.0-U1', '2.0', false, 'Clicked: A'])
    })

    it('a rejected single-answer click does not answer the message; its redelivery stays silent', () => {
      store.insertSlackMessage(bot())
      expect(store.recordSlackClick(click({ state: 'rejected' }), '2.0', false)).toBe(true)
      expect(store.recordSlackClick(click({ state: 'rejected' }), '2.0', false)).toBe(false)
      expect(store.getSlackButtonMessage('C1', '2.0')?.answered).toBe(false)
      // The same click key cannot answer it later either: the insert is rolled back with the claim.
      expect(store.recordSlackClick(click(), '2.0', true)).toBe(false)
      expect(store.getSlackButtonMessage('C1', '2.0')?.answered).toBe(false)
      expect(store.recordSlackClick(click({ ts: '3.2-U1' }), '2.0', true)).toBe(true)
    })

    it('multiple answers: every distinct click is stored once, the message is never answered', () => {
      store.insertSlackMessage(bot({ multiple: true }))
      expect(store.recordSlackClick(click({ multiple: true }), '2.0', true)).toBe(true)
      expect(store.recordSlackClick(click({ multiple: true }), '2.0', true)).toBe(false)
      expect(store.recordSlackClick(click({ ts: '3.1-U1', multiple: true }), '2.0', true)).toBe(true)
      expect(store.getSlackButtonMessage('C1', '2.0')?.answered).toBe(false)
      expect(store.countQueuedSlackMessages('wsA')).toBe(2)
    })

    it('refuses a click on an unknown, foreign or unlinked message', () => {
      store.insertSlackMessage(bot())
      store.insertSlackMessage(msg({ ts: '2.5', direction: 'out', state: 'sent' }))
      expect(store.recordSlackClick(click({ clickOf: '2.5' }), '2.5', true)).toBe(false)
      expect(store.recordSlackClick(click({ workspaceId: 'wsB' }), '2.0', true)).toBe(false)
      getDb().prepare("UPDATE workspaces SET slack_channel_id = NULL WHERE id = 'wsA'").run()
      expect(store.recordSlackClick(click(), '2.0', true)).toBe(false)
      expect(store.countQueuedSlackMessages('wsA')).toBe(0)
    })

    it('a delivered click is counted and listed, a queued or rejected one is not', () => {
      store.insertSlackMessage(bot())
      store.recordSlackClick(click({ state: 'rejected' }), '2.0', false)
      store.recordSlackClick(click({ ts: '3.1-U1' }), '2.0', true)
      expect(store.countThreadMessagesBefore('C1', '1.0', '9')).toBe(1)
      store.setSlackMessageState('C1', '3.1-U1', 'delivered')
      expect(store.countThreadMessagesBefore('C1', '1.0', '9')).toBe(2)
      expect(store.listSlackThread('C1', '1.0', { limit: 10 }).map((r) => r.text)).toEqual(['hi', 'Clicked: A'])
    })
  })

  it('cascades on workspace deletion', () => {
    store.insertSlackMessage(msg())
    getDb().prepare("DELETE FROM workspaces WHERE id='wsA'").run()
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM slack_messages').get()).toEqual({ n: 0 })
  })
})
