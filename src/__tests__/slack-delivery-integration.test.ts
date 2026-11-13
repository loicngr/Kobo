import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initSchema } from '../server/db/schema.js'
import type { SlackApi } from '../server/services/slack/slack-api.js'
import type { InboundEvent } from '../server/services/slack/slack-inbound.js'

/**
 * The Slack service through the REAL workspace-message-service, chat receipt, workspace service,
 * auto-loop instruction queue and attachment storage. Only the agent orchestrator boundary is mocked.
 */
const orchestrator = vi.hoisted(() => ({ sendMessage: vi.fn() }))

function registerMocks() {
  // Explicit, not spread from importOriginal: the circular orchestrator <-> auto-loop import would
  // otherwise bind auto-loop to the real orchestrator.
  vi.doMock('../server/services/agent/orchestrator.js', () => ({
    sendMessage: orchestrator.sendMessage,
    isAgentUnavailableError: (message: string) => message.startsWith('No agent running'),
    startAgent: vi.fn(() => {
      throw new Error('startAgent must not be reached')
    }),
    assertImmediateMessageSupported: vi.fn(),
    isParallelReviewSession: vi.fn(() => false),
    isShuttingDown: vi.fn(() => false),
    // A running agent: an auto-loop instruction stays queued for its next iteration.
    hasController: vi.fn(() => true),
    runningAgentCount: vi.fn(() => 1),
    onPendingInputsChanged: vi.fn(() => () => undefined),
    getPendingInputs: vi.fn(() => []),
    answerPendingQuestion: vi.fn(),
  }))
  vi.doMock('../server/services/slack/slack-credentials.js', () => ({
    getSlackCredentials: vi.fn(() => ({ botToken: 'xoxb-t', appToken: 'xapp-t' })),
    saveSlackCredentials: vi.fn(),
  }))
}

// 1x1 transparent PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
)

function fakeApi(): { api: SlackApi; reactions: string[][] } {
  const reactions: string[][] = []
  const api: SlackApi = {
    connect: async () => ({ botUserId: 'UBOT', botName: 'kobo', teamName: 'acme' }),
    disconnect: async () => undefined,
    postMessage: async () => '1731600000.000001',
    postQuestion: async () => '1731600000.000002',
    replaceButtons: async () => undefined,
    addReaction: async (channel, ts, name) => {
      reactions.push([channel, ts, name])
    },
    removeReaction: async () => undefined,
    listChannels: async () => [{ id: 'C1', name: 'general' }],
    threadReplies: async () => [],
    userName: async () => 'alice',
    downloadFile: async () => PNG,
  }
  return { api, reactions }
}

const mention = (over: Partial<InboundEvent> = {}): InboundEvent => ({
  type: 'message',
  channel: 'C1',
  ts: '1731500000.000100',
  user: 'U0ALICE',
  text: '<@UBOT> hello there',
  ...over,
})

let tmpDir: string
let worktree: string
let svc: typeof import('../server/services/slack/slack-service.js')
let getDb: typeof import('../server/db/index.js').getDb

const slackState = () =>
  (getDb().prepare('SELECT state FROM slack_messages WHERE ts = ?').get('1731500000.000100') as { state: string }).state
const userEvents = () =>
  (getDb().prepare("SELECT payload FROM ws_events WHERE type = 'user:message'").all() as { payload: string }[]).map(
    (r) => JSON.parse(r.payload) as { content: string; source?: { kind: string; userName: string } },
  )

beforeEach(async () => {
  vi.resetModules()
  registerMocks()
  orchestrator.sendMessage.mockReset()
  orchestrator.sendMessage.mockImplementation(async (_ws, _content, _session, beforeDispatch?: () => void) => {
    beforeDispatch?.()
  })
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kobo-slack-int-'))
  worktree = path.join(tmpDir, 'worktree')
  fs.mkdirSync(worktree)
  const dbPath = path.join(tmpDir, 'test.db')
  const db = new Database(dbPath)
  db.pragma('journal_mode=WAL')
  db.pragma('foreign_keys=ON')
  initSchema(db)
  db.close()
  ;({ getDb } = await import('../server/db/index.js'))
  getDb(dbPath)
  // Real settings: auto-loop admission reads them too.
  const settings = await import('../server/services/settings-service.js')
  settings._setSettingsPath(path.join(tmpDir, 'settings.json'))
  settings.updateGlobalSettings({ slackEnabled: true, slackAllowedUserIds: ['U0ALICE'] })
  getDb()
    .prepare(
      `INSERT INTO workspaces(id,name,project_path,source_branch,working_branch,worktree_path,status,slack_channel_id,created_at,updated_at)
       VALUES ('wsA','wsA',?,'main','b-wsA',?,'executing','C1','now','now')`,
    )
    .run(tmpDir, worktree)
  svc = await import('../server/services/slack/slack-service.js')
})

afterEach(async () => {
  await svc.stopSlack()
  const { closeDb } = await import('../server/db/index.js')
  closeDb()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('slack delivery through the real workspace message path', () => {
  it('delivers a mention once, persists the Slack-sourced user:message and ends delivered', async () => {
    const { api, reactions } = fakeApi()
    await svc.startSlack(() => api)
    await svc.handleSlackEvent(mention())
    await svc.handleSlackEvent(mention()) // redelivery
    expect(orchestrator.sendMessage).toHaveBeenCalledTimes(1)
    expect(String(orchestrator.sendMessage.mock.calls[0]![1])).toMatch(
      /^\[Slack #general \| from alice .*\]\nhello there$/,
    )
    const events = userEvents()
    expect(events).toHaveLength(1)
    expect(events[0]!.source).toMatchObject({ kind: 'slack', userName: 'alice' })
    expect(slackState()).toBe('delivered')
    expect(reactions).toContainEqual(['C1', '1731500000.000100', 'eyes'])
  })

  it('hands an auto-loop workspace the message as a next-iteration instruction', async () => {
    getDb().prepare("UPDATE workspaces SET auto_loop = 1, auto_loop_ready = 1 WHERE id = 'wsA'").run()
    const { api } = fakeApi()
    await svc.startSlack(() => api)
    await svc.handleSlackEvent(mention())
    expect(orchestrator.sendMessage).not.toHaveBeenCalled()
    const { listLoopMessages } = await import('../server/services/auto-loop-message-service.js')
    const queued = listLoopMessages('wsA')
    expect(queued).toHaveLength(1)
    expect(queued[0]).toMatchObject({ state: 'pending' })
    expect(queued[0]!.content).toMatch(/\nhello there$/)
    expect(slackState()).toBe('delivered')
    expect(userEvents()).toHaveLength(1)
  })

  it('passes a supported attachment through the metadata filter and the real validateMcpAttachments', async () => {
    const { api } = fakeApi()
    await svc.startSlack(() => api)
    await svc.handleSlackEvent(
      mention({
        subtype: 'file_share',
        files: [
          { id: 'F1', name: 'shot.png', mimetype: 'image/png', size: PNG.length, url: 'https://files.slack.com/a' },
        ],
      }),
    )
    expect(orchestrator.sendMessage).toHaveBeenCalledTimes(1)
    const content = String(orchestrator.sendMessage.mock.calls[0]![1])
    expect(content).not.toContain('ignored files')
    // The real attachment path stored the bytes in the worktree and referenced them in the prompt.
    const ref = content.match(/\[image: ([^\]]+)\]/)
    expect(ref).not.toBeNull()
    expect(fs.readFileSync(path.join(worktree, ref![1]!))).toEqual(PNG)
    expect(slackState()).toBe('delivered')
  })
})
