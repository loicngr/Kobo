import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initSchema } from '../server/db/schema.js'
import type { PendingItem } from '../server/services/agent/orchestrator.js'
import type { SlackApi, SlackQuestionAction } from '../server/services/slack/slack-api.js'
import type { InboundEvent } from '../server/services/slack/slack-inbound.js'
import { makeGlobalSettings } from './helpers/fixtures.js'

const orch = vi.hoisted(() => ({
  pending: new Map<string, unknown[]>(),
  parallel: new Set<string>(),
  listeners: new Set<(id: string) => void>(),
}))

function registerMocks() {
  vi.doMock('../server/services/workspace-message-service.js', () => ({ deliverWorkspaceMessage: vi.fn() }))
  vi.doMock('../server/services/slack/slack-credentials.js', () => ({
    getSlackCredentials: vi.fn(() => ({ botToken: 'xoxb-t', appToken: 'xapp-t' })),
    saveSlackCredentials: vi.fn(),
  }))
  vi.doMock('../server/services/settings-service.js', async (orig) => ({
    ...(await orig<typeof import('../server/services/settings-service.js')>()),
    getGlobalSettings: vi.fn(),
  }))
  vi.doMock('../server/services/websocket-service.js', async (orig) => ({
    ...(await orig<typeof import('../server/services/websocket-service.js')>()),
    broadcastAll: vi.fn(),
  }))
  vi.doMock('../server/services/agent/orchestrator.js', () => ({
    getPendingInputs: vi.fn((id: string) => orch.pending.get(id) ?? []),
    isParallelReviewSession: vi.fn((_id: string, sessionId: string) => orch.parallel.has(sessionId)),
    onPendingInputsChanged: vi.fn((listener: (id: string) => void) => {
      orch.listeners.add(listener)
      return () => orch.listeners.delete(listener)
    }),
    // Like the orchestrator: the head is removed and listeners are notified on success.
    answerPendingQuestion: vi.fn(async (id: string) => {
      orch.pending.set(id, (orch.pending.get(id) ?? []).slice(1))
      for (const l of orch.listeners) l(id)
    }),
  }))
}

type Call = { fn: string; args: unknown[] }

function fakeApi(over: Partial<Record<keyof SlackApi, (...args: never[]) => unknown>> = {}) {
  const calls: Call[] = []
  let n = 0
  const nextTs = () => `1731600000.${String(++n).padStart(6, '0')}`
  const impl: Record<keyof SlackApi, (...args: never[]) => unknown> = {
    connect: async () => ({ botUserId: 'UBOT', botName: 'kobo', teamName: 'acme' }),
    disconnect: async () => undefined,
    postMessage: async () => nextTs(),
    postQuestion: async () => nextTs(),
    replaceButtons: async () => undefined,
    addReaction: async () => undefined,
    removeReaction: async () => undefined,
    listChannels: async () => [{ id: 'C1', name: 'general' }],
    threadReplies: async () => [],
    userName: async (id: string) => (id === 'U1' ? 'alice' : id),
    downloadFile: async () => Buffer.from(''),
    ...over,
  }
  const api = {} as Record<string, unknown>
  for (const [fn, f] of Object.entries(impl))
    api[fn] = async (...args: unknown[]) => {
      calls.push({ fn, args })
      return (f as (...a: unknown[]) => unknown)(...args)
    }
  return { api: api as unknown as SlackApi, calls }
}

const TEXT = {
  orReply: 'Or reply in this thread with your own answer.',
  reply: 'Reply in this thread with your answer.',
  secret: 'The agent asks for a value that must be entered in Kōbō.',
  notAccepted: 'This answer was not accepted. Answer in Kōbō.',
  failed: 'Kōbō could not submit this answer. Answer in Kōbō.',
  elsewhere: 'No longer pending - handled in Kōbō.',
  restarted: 'No longer pending - Kōbō restarted.',
}
const THREAD = '1731500000.000100'

let tmpDir: string
let svc: typeof import('../server/services/slack/slack-service.js')
let getDb: typeof import('../server/db/index.js').getDb
let deliver: ReturnType<typeof vi.fn>
let answer: ReturnType<typeof vi.fn>
let broadcastAll: ReturnType<typeof vi.fn>
let settings = makeGlobalSettings({ slackEnabled: true, slackAllowedUserIds: ['U1'] })

function wsRow(id: string, channel: string | null, mode = 'always') {
  getDb()
    .prepare(
      `INSERT INTO workspaces(id,name,project_path,source_branch,working_branch,worktree_path,slack_channel_id,slack_question_mirror,created_at,updated_at)
       VALUES (?,?,'/tmp','main',?,'/tmp',?,?,'now','now')`,
    )
    .run(id, id, `b-${id}`, channel, mode)
}

let eventId = 0
function userMessage(sessionId: string, source?: unknown, workspaceId = 'wsA') {
  getDb()
    .prepare('INSERT INTO ws_events(id, workspace_id, type, payload, session_id, created_at) VALUES (?,?,?,?,?,?)')
    .run(
      `e${++eventId}`,
      workspaceId,
      'user:message',
      JSON.stringify({ content: 'hi', sender: 'user', ...(source ? { source } : {}) }),
      sessionId,
      new Date(Date.now() + eventId).toISOString(),
    )
}
const slackSource = (threadTs = THREAD, channelId = 'C1') => ({
  kind: 'slack',
  userName: 'alice',
  userId: 'U1',
  channelId,
  threadTs,
})

function question(questions: unknown[], toolCallId = 't1', sessionId = 's1'): PendingItem {
  return { kind: 'question', agentSessionId: sessionId, toolCallId, toolName: 'AskUserQuestion', input: { questions } }
}
const claudeSingle = {
  question: 'Pick a color?',
  header: 'Color',
  options: [{ label: 'Red', description: 'warm' }, { label: 'Blue' }],
  multiSelect: false,
}
const claudeMulti = {
  question: 'Pick toppings?',
  header: 'Toppings',
  options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }],
  multiSelect: true,
}

async function idle() {
  await svc._waitForSlackIdle()
}

async function change(items: unknown[], workspaceId = 'wsA') {
  orch.pending.set(workspaceId, items)
  for (const l of orch.listeners) l(workspaceId)
  await idle()
}

const ofFn = (calls: Call[], fn: string) => calls.filter((c) => c.fn === fn).map((c) => c.args)

function click(messageTs: string, choices: number[], over: Partial<SlackQuestionAction> = {}): SlackQuestionAction {
  return { channel: 'C1', messageTs, user: 'U1', actionTs: '1731600500.000001', question: 0, choices, ...over }
}

function reply(text: string, ts = '1731600900.000001'): InboundEvent {
  return { type: 'message', channel: 'C1', ts, thread_ts: THREAD, user: 'U1', text }
}

const questionRow = () =>
  getDb().prepare('SELECT state, question_index, message_ts FROM slack_questions').get() as
    | { state: string; question_index: number; message_ts: string }
    | undefined

beforeEach(async () => {
  vi.resetModules()
  orch.pending.clear()
  orch.parallel.clear()
  orch.listeners.clear()
  registerMocks()
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kobo-slack-q-'))
  const dbPath = path.join(tmpDir, 'test.db')
  const db = new Database(dbPath)
  db.pragma('foreign_keys=ON')
  initSchema(db)
  db.close()
  ;({ getDb } = await import('../server/db/index.js'))
  getDb(dbPath)
  settings = makeGlobalSettings({ slackEnabled: true, slackAllowedUserIds: ['U1'] })
  const settingsModule = await import('../server/services/settings-service.js')
  vi.mocked(settingsModule.getGlobalSettings).mockImplementation(() => settings)
  deliver = vi.mocked((await import('../server/services/workspace-message-service.js')).deliverWorkspaceMessage)
  deliver.mockImplementation(async (_ws, msg, hooks) => {
    hooks?.beforeDispatch?.()
    hooks?.persist?.({ content: msg.content, sender: 'user', source: msg.source }, 's1')
    return { sessionId: 's1' }
  })
  answer = vi.mocked((await import('../server/services/agent/orchestrator.js')).answerPendingQuestion)
  broadcastAll = vi.mocked((await import('../server/services/websocket-service.js')).broadcastAll)
  svc = await import('../server/services/slack/slack-service.js')
  wsRow('wsA', 'C1')
})

afterEach(async () => {
  await svc.stopSlack()
  const { closeDb } = await import('../server/db/index.js')
  closeDb()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('when questions are mirrored', () => {
  it('mode never posts nothing', async () => {
    getDb().prepare("UPDATE workspaces SET slack_question_mirror = 'never'").run()
    userMessage('s1', slackSource())
    const { api, calls } = fakeApi()
    await svc.startSlack(() => api)
    await change([question([claudeSingle])])
    await svc.runSlackTick()
    await idle()
    expect(ofFn(calls, 'postQuestion')).toEqual([])
    expect(ofFn(calls, 'postMessage')).toEqual([])
  })

  it('slack-conversation posts in the thread of the last Slack user message', async () => {
    getDb().prepare("UPDATE workspaces SET slack_question_mirror = 'slack-conversation'").run()
    userMessage('s1', slackSource())
    const { api, calls } = fakeApi()
    await svc.startSlack(() => api)
    await change([question([claudeSingle])])
    expect(ofFn(calls, 'postQuestion')).toEqual([
      [
        'C1',
        '*Color*\nPick a color?\n- Red - warm\n- Blue',
        THREAD,
        { question: 0, kind: 'buttons', labels: ['Red', 'Blue'], hint: TEXT.orReply },
      ],
    ])
  })

  it('slack-conversation posts nothing when the last user message came from the UI or another channel', async () => {
    getDb().prepare("UPDATE workspaces SET slack_question_mirror = 'slack-conversation'").run()
    userMessage('s1', slackSource())
    userMessage('s1')
    userMessage('s2', slackSource(THREAD, 'C9'))
    const { api, calls } = fakeApi()
    await svc.startSlack(() => api)
    await change([question([claudeSingle])])
    await change([question([claudeSingle], 't2', 's2')])
    expect(ofFn(calls, 'postQuestion')).toEqual([])
  })

  it('always without a Slack thread posts a new top-level message that becomes the thread', async () => {
    const { api, calls } = fakeApi()
    await svc.startSlack(() => api)
    await change([question([claudeSingle])])
    expect(ofFn(calls, 'postQuestion')[0]![2]).toBeUndefined()
    const row = getDb().prepare('SELECT thread_ts, message_ts, state FROM slack_questions').get()
    expect(row).toEqual({ thread_ts: '1731600000.000001', message_ts: '1731600000.000001', state: 'open' })
  })

  it('never mirrors a parallel-review item, a non-head item, or an archived workspace', async () => {
    orch.parallel.add('review')
    const { api, calls } = fakeApi()
    await svc.startSlack(() => api)
    await change([question([claudeSingle], 'r1', 'review')])
    getDb().prepare("UPDATE workspaces SET archived_at = 'now'").run()
    await change([question([claudeSingle])])
    expect(ofFn(calls, 'postQuestion')).toEqual([])
  })

  it('a question that appeared while disconnected is mirrored by the tick after reconnection', async () => {
    let attempts = 0
    const { api, calls } = fakeApi({
      connect: async () => {
        if (++attempts === 1) throw new Error('down')
        return { botUserId: 'UBOT', botName: 'kobo', teamName: 'acme' }
      },
    })
    await svc.startSlack(() => api)
    await change([question([claudeSingle])])
    expect(ofFn(calls, 'postQuestion')).toEqual([])
    await svc.runSlackTick()
    await idle()
    await svc.runSlackTick()
    await idle()
    expect(ofFn(calls, 'postQuestion')).toHaveLength(1)
  })

  function session(id: string) {
    getDb().prepare("INSERT INTO agent_sessions(id, workspace_id, started_at) VALUES (?, 'wsA', 'now')").run(id)
  }
  function reviewReturn(reviewSessionId: string) {
    session(reviewSessionId)
    session('orig')
    getDb()
      .prepare(
        `INSERT INTO pending_review_returns(workspace_id, review_session_id, original_session_id, original_configuration, review_configuration, created_at)
         VALUES ('wsA', ?, 'orig', '{}', '{}', 'now')`,
      )
      .run(reviewSessionId)
  }

  it('never mirrors the reviewer of a pending sequential review return', async () => {
    reviewReturn('rev')
    const { api, calls } = fakeApi()
    await svc.startSlack(() => api)
    await change([question([claudeSingle], 'r1', 'rev')])
    expect(ofFn(calls, 'postQuestion')).toEqual([])
  })

  it('never mirrors an active auto-loop final reviewer (launched with its review return)', async () => {
    reviewReturn('final')
    getDb()
      .prepare(
        `INSERT INTO auto_loop_final_reviews(workspace_id, configuration, state, review_session_id, original_session_id, token, updated_at)
         VALUES ('wsA', '{}', 'reviewing', 'final', 'orig', 'tok', 'now')`,
      )
      .run()
    const { api, calls } = fakeApi()
    await svc.startSlack(() => api)
    await change([question([claudeSingle], 'f1', 'final')])
    expect(ofFn(calls, 'postQuestion')).toEqual([])
  })

  it('never mirrors a live launch carrying the review-only marker', async () => {
    const { createInternalMcpCapability } = await import('../server/services/internal-mcp-capability-service.js')
    createInternalMcpCapability({
      workspaceId: 'wsA',
      sessionId: 'vibe-review',
      readOnly: true,
      restricted: true,
      env: { KOBO_REVIEW_ONLY: '1' },
    })
    const { api, calls } = fakeApi()
    await svc.startSlack(() => api)
    await change([question([claudeSingle], 'v1', 'vibe-review')])
    expect(ofFn(calls, 'postQuestion')).toEqual([])
  })

  it('still mirrors the ordinary primary session while another session is a reviewer', async () => {
    reviewReturn('rev')
    const { api, calls } = fakeApi()
    await svc.startSlack(() => api)
    await change([question([claudeSingle])])
    expect(ofFn(calls, 'postQuestion')).toHaveLength(1)
  })

  it('the same head is never posted twice', async () => {
    const { api, calls } = fakeApi()
    await svc.startSlack(() => api)
    const item = question([claudeSingle])
    await Promise.all([change([item]), change([item])])
    await svc.runSlackTick()
    await idle()
    await change([item])
    expect(ofFn(calls, 'postQuestion')).toHaveLength(1)
  })
})

describe('rendering per engine', () => {
  async function rendered(q: unknown) {
    const { api, calls } = fakeApi()
    await svc.startSlack(() => api)
    await change([question([q])])
    return { questions: ofFn(calls, 'postQuestion'), messages: ofFn(calls, 'postMessage') }
  }

  it('Claude multiple choice: checkboxes plus Submit and the free-text hint', async () => {
    const { questions } = await rendered(claudeMulti)
    expect(questions[0]![3]).toEqual({ question: 0, kind: 'checkboxes', labels: ['A', 'B', 'C'], hint: TEXT.orReply })
  })

  it('Codex with isOther false: buttons and no hint', async () => {
    const { questions } = await rendered({
      id: 'env',
      question: 'Which env?',
      header: 'Env',
      options: [{ label: 'dev', description: '' }, { label: 'prod' }],
      isOther: false,
      isSecret: false,
    })
    expect(questions[0]![3]).toEqual({ question: 0, kind: 'buttons', labels: ['dev', 'prod'] })
  })

  it('Codex without options: no controls and the reply hint', async () => {
    const { questions } = await rendered({ id: 'why', question: 'Why?', header: '', options: [], isOther: false })
    expect(questions[0]![1]).toBe('Why?')
    expect(questions[0]![3]).toEqual({ question: 0, kind: 'none', labels: [], hint: TEXT.reply })
  })

  it('Vibe free-text field: no controls and the reply hint', async () => {
    const { questions } = await rendered({
      id: 'name',
      question: 'Your name?',
      options: [],
      required: true,
      freeText: true,
      multiSelect: false,
      isOther: false,
      minLength: 0,
      maxLength: 50,
    })
    expect(questions[0]![3]).toEqual({ question: 0, kind: 'none', labels: [], hint: TEXT.reply })
  })

  it('11 options: no controls, answer by text; labels longer than 75 are truncated', async () => {
    const options = Array.from({ length: 11 }, (_, i) => ({ label: `opt${i}` }))
    expect((await rendered({ ...claudeSingle, options })).questions[0]![3]).toMatchObject({ kind: 'none' })
    await svc.stopSlack()
    const long = { ...claudeSingle, options: [{ label: 'x'.repeat(90) }, { label: 'y' }] }
    orch.pending.clear()
    getDb().exec('DELETE FROM slack_questions')
    const { questions } = await rendered(long)
    expect((questions[0]![3] as { labels: string[] }).labels[0]).toHaveLength(75)
  })

  it('a long label is shortened without splitting a surrogate pair', async () => {
    const { questionControls } = await import('../server/services/slack/slack-questions.js')
    const label = `${'x'.repeat(74)}\u{1F600}tail` // units 75 and 76 are one emoji
    const [short] = questionControls(
      { key: 'k', question: 'Q?', options: [{ label }, { label: 'b' }], multiple: false, freeText: true },
      0,
    ).labels
    expect(short).toBe('x'.repeat(74))
    expect(
      questionControls({ key: 'k', question: 'Q?', options: [{ label: 'ok' }], multiple: false, freeText: true }, 0)
        .labels,
    ).toEqual(['ok'])
  })

  it('a secret question: one notice and nothing else', async () => {
    const { questions, messages } = await rendered({
      id: 'token',
      question: 'Token?',
      options: [],
      isOther: true,
      isSecret: true,
    })
    expect(questions).toEqual([])
    expect(messages).toEqual([['C1', TEXT.secret, undefined]])
  })
})

describe('answering from Slack', () => {
  async function mirrored(items: unknown[], sourceThread = true) {
    if (sourceThread) userMessage('s1', slackSource())
    const fake = fakeApi()
    await svc.startSlack(() => fake.api)
    await change(items)
    const ts = ofFn(fake.calls, 'postQuestion')[0]?.[0] ? questionRow()!.message_ts : ''
    return { ...fake, ts }
  }
  const source = { kind: 'slack', userName: 'alice', userId: 'U1', channelId: 'C1', threadTs: THREAD }

  it('a single-choice click answers once, keyed by the question text for Claude', async () => {
    const { calls, ts } = await mirrored([question([claudeSingle])])
    await svc.handleSlackQuestionAction(click(ts, [1]))
    expect(answer).toHaveBeenCalledTimes(1)
    expect(answer).toHaveBeenCalledWith('wsA', { 'Pick a color?': 'Blue' }, 't1', {
      sessionId: 's1',
      selections: {},
      source,
    })
    expect(ofFn(calls, 'replaceButtons')).toContainEqual([
      'C1',
      ts,
      '*Color*\nPick a color?\n- Red - warm\n- Blue',
      'Answered: Blue - alice',
    ])
    expect(questionRow()!.state).toBe('answered')
  })

  it('a Codex click is keyed by id', async () => {
    const { ts } = await mirrored([
      question([{ id: 'env', question: 'Which env?', options: [{ label: 'dev' }, { label: 'prod' }], isOther: false }]),
    ])
    await svc.handleSlackQuestionAction(click(ts, [0]))
    expect(answer.mock.calls[0]![1]).toEqual({ env: 'dev' })
  })

  it('a multiple-choice Submit with two boxes joins the labels and passes the selections', async () => {
    const { ts } = await mirrored([question([claudeMulti])])
    await svc.handleSlackQuestionAction(click(ts, []))
    expect(answer).not.toHaveBeenCalled()
    await svc.handleSlackQuestionAction(click(ts, [0, 2]))
    expect(answer).toHaveBeenCalledWith('wsA', { 'Pick toppings?': 'A, C' }, 't1', {
      sessionId: 's1',
      selections: { 'Pick toppings?': ['A', 'C'] },
      source,
    })
  })

  it('a text reply in the thread is the free-text answer, gets eyes and never reaches the chat path', async () => {
    const { calls, ts } = await mirrored([question([claudeMulti])])
    await svc.handleSlackEvent(reply('Olives'))
    await idle()
    expect(answer).toHaveBeenCalledWith('wsA', { 'Pick toppings?': 'Olives' }, 't1', {
      sessionId: 's1',
      selections: { 'Pick toppings?': ['Olives'] },
      source,
    })
    expect(deliver).not.toHaveBeenCalled()
    expect(ofFn(calls, 'addReaction')).toContainEqual(['C1', '1731600900.000001', 'eyes'])
    expect(ofFn(calls, 'replaceButtons')).toContainEqual([
      'C1',
      ts,
      expect.any(String),
      'Answered in the thread - alice',
    ])
    // A redelivered event neither answers again nor becomes a chat message.
    await svc.handleSlackEvent(reply('Olives'))
    await idle()
    expect(answer).toHaveBeenCalledTimes(1)
    expect(deliver).not.toHaveBeenCalled()
  })

  it('a text reply when free text is not allowed stays an ordinary inbound message', async () => {
    await mirrored([
      question([{ id: 'env', question: 'Which env?', options: [{ label: 'dev' }, { label: 'prod' }], isOther: false }]),
    ])
    await svc.handleSlackEvent(reply('staging'))
    await idle()
    expect(answer).not.toHaveBeenCalled()
    expect(deliver).toHaveBeenCalledTimes(1)
  })

  it('two questions of one tool call are asked one after the other and submitted together', async () => {
    const { calls, ts } = await mirrored([question([claudeSingle, claudeMulti])])
    expect(ofFn(calls, 'postQuestion')).toHaveLength(1)
    await svc.handleSlackQuestionAction(click(ts, [0]))
    expect(answer).not.toHaveBeenCalled()
    const second = ofFn(calls, 'postQuestion')[1]!
    expect(second[2]).toBe(THREAD)
    expect(second[3]).toMatchObject({ question: 1, kind: 'checkboxes' })
    // The first message's controls are gone: a late click there is ignored.
    await svc.handleSlackQuestionAction(click(ts, [1]))
    const nextTs = questionRow()!.message_ts
    await svc.handleSlackQuestionAction(click(nextTs, [1], { question: 1 }))
    expect(answer).toHaveBeenCalledTimes(1)
    expect(answer.mock.calls[0]![1]).toEqual({ 'Pick a color?': 'Red', 'Pick toppings?': 'B' })
    expect(answer.mock.calls[0]![3]).toMatchObject({ selections: { 'Pick toppings?': ['B'] } })
  })

  /** A fake whose second postQuestion stays open until `release()`. */
  function gatedSecondPost() {
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    let started!: () => void
    const secondStarted = new Promise<void>((r) => {
      started = r
    })
    let posts = 0
    const fake = fakeApi({
      postQuestion: async () => {
        const n = ++posts
        if (n === 2) {
          started()
          await gate
        }
        return `1731600100.00000${n}`
      },
    })
    return { ...fake, release: () => release(), secondStarted }
  }
  const tick = () => new Promise((r) => setTimeout(r, 0))

  it('a reply while the next question is being posted is not taken as that question’s answer', async () => {
    userMessage('s1', slackSource())
    const { api, calls, release, secondStarted } = gatedSecondPost()
    await svc.startSlack(() => api)
    await change([question([claudeSingle, claudeMulti])])
    const ts1 = questionRow()!.message_ts
    const clicking = svc.handleSlackQuestionAction(click(ts1, [0]))
    await secondStarted
    await svc.handleSlackEvent(reply('Blue please'))
    expect(answer).not.toHaveBeenCalled()
    expect(questionRow()).toMatchObject({ state: 'open', question_index: 1, message_ts: null })
    expect(deliver).toHaveBeenCalledTimes(1) // the ordinary inbound path
    release()
    await clicking
    await idle()
    const ts2 = questionRow()!.message_ts
    expect(ts2).toBe('1731600100.000002')
    // Redeliveries of what answered Q1, and of the reply, stay harmless once Q2 is shown.
    await svc.handleSlackQuestionAction(click(ts1, [0]))
    await svc.handleSlackEvent(reply('Blue please'))
    await idle()
    expect(answer).not.toHaveBeenCalled()
    expect(deliver).toHaveBeenCalledTimes(1)
    await svc.handleSlackQuestionAction(click(ts2, [1], { question: 1 }))
    expect(answer).toHaveBeenCalledTimes(1)
    expect(answer.mock.calls[0]![1]).toEqual({ 'Pick a color?': 'Red', 'Pick toppings?': 'B' })
    expect(ofFn(calls, 'replaceButtons').filter((args) => args[1] === ts1)).toEqual([
      ['C1', ts1, expect.any(String), 'Answered: Red - alice'],
    ])
  })

  it('a failed post of the next question closes the row without a current message; a later tick leaves it', async () => {
    userMessage('s1', slackSource())
    let posts = 0
    const { api, calls } = fakeApi({
      postQuestion: async () => {
        if (++posts === 2) throw new Error('down')
        return '1731600100.000001'
      },
    })
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await svc.startSlack(() => api)
    await change([question([claudeSingle, claudeMulti])])
    await svc.handleSlackQuestionAction(click('1731600100.000001', [0]))
    await idle()
    expect(questionRow()).toMatchObject({ state: 'closed', message_ts: null })
    expect(ofFn(calls, 'postMessage').map((args) => args[1])).toEqual([TEXT.failed])
    await svc.runSlackTick()
    await idle()
    expect(ofFn(calls, 'postQuestion')).toHaveLength(2)
    expect(answer).not.toHaveBeenCalled()
    warned.mockRestore()
  })

  it('when the head goes away while the next question is posted, that message loses its controls', async () => {
    userMessage('s1', slackSource())
    const { api, calls, release, secondStarted } = gatedSecondPost()
    await svc.startSlack(() => api)
    await change([question([claudeSingle, claudeMulti])])
    const ts1 = questionRow()!.message_ts
    const clicking = svc.handleSlackQuestionAction(click(ts1, [0]))
    await secondStarted
    orch.pending.set('wsA', [])
    for (const l of orch.listeners) l('wsA')
    await tick()
    release()
    await clicking
    await idle()
    expect(questionRow()!.state).toBe('closed')
    expect(ofFn(calls, 'replaceButtons').map((args) => [args[1], args[3]])).toEqual([
      [ts1, 'Answered: Red - alice'],
      ['1731600100.000002', TEXT.elsewhere],
    ])
  })

  it('the display name is resolved before the head check, so an answer given in Kōbō meanwhile wins', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const { api } = fakeApi({
      userName: async () => {
        await gate
        return 'alice'
      },
    })
    await svc.startSlack(() => api)
    await change([question([claudeSingle])])
    const clicking = svc.handleSlackQuestionAction(click(questionRow()!.message_ts, [0]))
    orch.pending.set('wsA', []) // answered in Kōbō; the mirror pass has not run yet
    release()
    await clicking
    expect(answer).not.toHaveBeenCalled()
  })

  it('a submission that lost to an answer given in Kōbō ends with the handled-elsewhere line', async () => {
    answer.mockRejectedValueOnce(new Error("Pending question changed: expected toolCallId 't1', current head is 't9'"))
    const done: string[] = []
    const { api, calls } = fakeApi({
      replaceButtons: async (_channel: string, _ts: string, _text: string, line: string) => {
        if (line.startsWith('Answered')) await new Promise((r) => setTimeout(r, 20))
        done.push(line)
      },
    })
    await svc.startSlack(() => api)
    await change([question([claudeSingle])])
    const ts = questionRow()!.message_ts
    await svc.handleSlackQuestionAction(click(ts, [0]))
    await idle()
    expect(done).toEqual(['Answered: Red - alice', TEXT.elsewhere])
    expect(ofFn(calls, 'replaceButtons').every((args) => args[1] === ts)).toBe(true)
    expect(ofFn(calls, 'postMessage')).toEqual([])
  })

  it('a text answer whose submission is gone loses its eyes reaction and keeps its stored row', async () => {
    answer.mockRejectedValueOnce(new Error("Pending question session 's1' is no longer active"))
    const { calls } = await mirrored([question([claudeMulti])])
    await svc.handleSlackEvent(reply('Olives'))
    await idle()
    expect(ofFn(calls, 'removeReaction')).toEqual([['C1', '1731600900.000001', 'eyes']])
    expect(getDb().prepare("SELECT state FROM slack_messages WHERE ts = '1731600900.000001'").get()).toEqual({
      state: 'delivered',
    })
  })

  it('a reply goes to the newest open question of its thread, not to a stale row in the same thread', async () => {
    // The stale row is older and stored first; it is reopened after the mirror pass would close it.
    getDb()
      .prepare(
        `INSERT INTO slack_questions (workspace_id, session_id, tool_call_id, kind, channel_id, thread_ts, message_ts, message_text, state, created_at, updated_at)
         VALUES ('wsA', 's0', 't0', 'question', 'C1', ?, '1731500002.000001', 'Old?', 'closed', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z')`,
      )
      .run(THREAD)
    await mirrored([question([claudeMulti])])
    getDb().prepare("UPDATE slack_questions SET state = 'open' WHERE tool_call_id = 't0'").run()
    await svc.handleSlackEvent(reply('Olives'))
    await idle()
    expect(answer).toHaveBeenCalledTimes(1)
    expect(deliver).not.toHaveBeenCalled()
  })

  it('two racing clicks give one answer', async () => {
    const { ts } = await mirrored([question([claudeSingle])])
    await Promise.all([svc.handleSlackQuestionAction(click(ts, [0])), svc.handleSlackQuestionAction(click(ts, [1]))])
    expect(answer).toHaveBeenCalledTimes(1)
  })

  it('a user outside the allow-list causes nothing', async () => {
    const { calls, ts } = await mirrored([question([claudeSingle])])
    const before = calls.length
    await svc.handleSlackQuestionAction(click(ts, [0], { user: 'U2' }))
    await svc.handleSlackEvent({ ...reply('Green'), user: 'U2' })
    await idle()
    expect(answer).not.toHaveBeenCalled()
    expect(calls.length).toBe(before)
    expect(questionRow()!.state).toBe('open')
  })

  it.each([
    [
      'a validation error',
      async () => {
        const { PendingUserInputValidationError } = await import('../server/services/agent/engines/types.js')
        return new PendingUserInputValidationError()
      },
      TEXT.notAccepted,
    ],
    ['a question answered elsewhere', async () => new Error("Pending question changed: expected 'x'"), null],
    ['an ended session', async () => new Error("Pending question session 's1' is no longer active"), null],
    ['any other failure', async () => new Error('boom xoxb-secret'), TEXT.failed],
  ])('%s closes the row with the documented notice and is never retried', async (_label, make, text) => {
    const error = await make()
    answer.mockRejectedValueOnce(error)
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { calls, ts } = await mirrored([question([claudeSingle])])
    await svc.handleSlackQuestionAction(click(ts, [0]))
    await svc.handleSlackQuestionAction(click(ts, [1]))
    await svc.runSlackTick()
    await idle()
    expect(answer).toHaveBeenCalledTimes(1)
    expect(questionRow()!.state).toBe('closed')
    const notices = ofFn(calls, 'postMessage').map((args) => args[1])
    expect(notices).toEqual(text ? [text] : [])
    if (text === TEXT.failed) {
      expect(logged).toHaveBeenCalledWith('[slack] question answer could not be submitted: Error')
      expect(JSON.stringify(logged.mock.calls)).not.toContain('secret')
    }
    logged.mockRestore()
  })
})

describe('resolution elsewhere and restart', () => {
  it('a mirrored question no longer at the head is closed, its controls replaced, and later clicks ignored', async () => {
    const { api, calls } = fakeApi()
    await svc.startSlack(() => api)
    await change([question([claudeSingle])])
    const ts = questionRow()!.message_ts
    await change([])
    expect(ofFn(calls, 'replaceButtons')).toEqual([['C1', ts, expect.any(String), TEXT.elsewhere]])
    expect(questionRow()!.state).toBe('closed')
    await svc.handleSlackQuestionAction(click(ts, [0]))
    expect(answer).not.toHaveBeenCalled()
  })

  it('switching the mode to never closes open rows and broadcasts the new mode', async () => {
    const { api, calls } = fakeApi()
    await svc.startSlack(() => api)
    await change([question([claudeSingle])])
    await svc.setSlackQuestionMirror('wsA', 'never')
    await idle()
    expect(broadcastAll).toHaveBeenCalledWith('workspace:slack-question-mirror-updated', {
      workspaceId: 'wsA',
      slackQuestionMirror: 'never',
    })
    expect(ofFn(calls, 'replaceButtons').map((args) => args[3])).toEqual([TEXT.elsewhere])
    await expect(svc.setSlackQuestionMirror('missing', 'always')).rejects.toThrow("Workspace 'missing' not found")
  })

  it('an open row left by a previous process is closed at start and its message says so', async () => {
    getDb()
      .prepare(
        `INSERT INTO slack_questions (workspace_id, session_id, tool_call_id, kind, channel_id, thread_ts, message_ts, message_text, state, created_at, updated_at)
         VALUES ('wsA', 's1', 't1', 'question', 'C1', ?, '1731500001.000001', 'Pick?', 'open', 'now', 'now')`,
      )
      .run(THREAD)
    const { api, calls } = fakeApi()
    await svc.startSlack(() => api)
    await idle()
    expect(ofFn(calls, 'replaceButtons')).toEqual([['C1', '1731500001.000001', 'Pick?', TEXT.restarted]])
    expect(questionRow()!.state).toBe('closed')
  })
})

describe('permission requests', () => {
  it('post one notice naming the tool, never its input, and are not repeated', async () => {
    userMessage('s1', slackSource())
    const { api, calls } = fakeApi()
    await svc.startSlack(() => api)
    const item: PendingItem = {
      kind: 'permission',
      agentSessionId: 's1',
      toolCallId: 'p1',
      toolName: 'Bash',
      toolInput: { command: 'cat hidden-input-value' },
    }
    await change([item])
    await svc.runSlackTick()
    await idle()
    await change([item])
    expect(ofFn(calls, 'postMessage')).toEqual([
      ['C1', 'The agent is waiting for an approval in Kōbō (tool: Bash).', THREAD],
    ])
    expect(ofFn(calls, 'postQuestion')).toEqual([])
    expect(JSON.stringify(calls)).not.toContain('hidden-input-value')
    await change([])
    expect(ofFn(calls, 'replaceButtons')).toEqual([])
  })
})
