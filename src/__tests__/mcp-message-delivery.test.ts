import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { closeDb, getDb } from '../server/db/index.js'
import { runMigrations } from '../server/db/migrations.js'
import { reconcileMessageRequests } from '../server/services/mcp-message-request-service.js'
import * as mistralOptions from '../server/services/mistral-options-service.js'
import { executeWorkspaceDialogueTool } from '../server/services/workspace-dialogue-service.js'

vi.mock('../server/services/agent/orchestrator.js', () => ({
  assertImmediateMessageSupported: vi.fn(),
  sendMessage: vi.fn(async () => {}),
  startAgent: vi.fn(),
  isShuttingDown: vi.fn(() => false),
  isAgentUnavailableError: (s: string) => s.startsWith('No agent running'),
  getPendingInputs: vi.fn(() => []),
  answerPendingQuestion: vi.fn(),
}))
vi.mock('../server/services/auto-loop-service.js', () => ({
  getStatus: vi.fn(() => ({ auto_loop: false })),
  disable: vi.fn(),
}))

import { assertImmediateMessageSupported, sendMessage, startAgent } from '../server/services/agent/orchestrator.js'

let directory: string
const args = { workspace_id: 'ws', content: 'hello', session_id: 's', idempotency_key: 'one-intent' }
const send = (input: Record<string, unknown> = args) => executeWorkspaceDialogueTool('send_workspace_message', input)
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(sendMessage).mockImplementation(async (_ws, _content, _session, beforeDispatch) => {
    beforeDispatch?.()
  })
  closeDb()
  directory = mkdtempSync(join(tmpdir(), 'kobo-mcp-delivery-'))
  const db = getDb(join(directory, 'test.db'))
  runMigrations(db)
  db.exec(
    "INSERT INTO workspaces(id,name,project_path,source_branch,working_branch,status,created_at,updated_at) VALUES ('ws','test','/tmp','main','work','executing','now','now')",
  )
})
afterEach(() => {
  vi.restoreAllMocks()
  closeDb()
  rmSync(directory, { recursive: true, force: true })
})
it('delivers one concurrent request and replays its durable event without another send', async () => {
  let finish!: () => void
  vi.mocked(sendMessage).mockImplementationOnce(async (_ws, _content, _session, beforeDispatch) => {
    beforeDispatch?.()
    await new Promise<void>((resolve) => {
      finish = resolve
    })
  })
  const pending = send()
  expect(await send()).toMatchObject({ accepted: false, code: 'in_progress' })
  finish()
  const accepted = await pending
  expect(accepted).toMatchObject({
    accepted: true,
    sessionId: 's',
    eventId: expect.any(String),
    requestId: expect.any(String),
  })
  expect(await send()).toEqual({ ...(accepted as object), replayed: true })
  expect(sendMessage).toHaveBeenCalledTimes(1)
  expect(getDb().prepare("SELECT COUNT(*) AS n FROM ws_events WHERE type='user:message'").get()).toEqual({ n: 1 })
  getDb().exec("UPDATE workspaces SET archived_at='now'; DELETE FROM ws_events")
  reconcileMessageRequests(getDb())
  expect(await send()).toEqual({ ...(accepted as object), replayed: true })
  expect(sendMessage).toHaveBeenCalledTimes(1)
})
it('refuses a reused key with changed content before delivery', async () => {
  await send()
  expect(await send({ ...args, content: 'different' })).toMatchObject({ accepted: false, code: 'idempotency_conflict' })
  expect(sendMessage).toHaveBeenCalledTimes(1)
})
it('records a definitive refusal before dispatch', async () => {
  getDb().exec("UPDATE workspaces SET status='compacting'")
  expect(await send()).toMatchObject({ accepted: false, code: 'delivery_rejected' })
  getDb().exec("UPDATE workspaces SET status='executing'")
  expect(await send()).toMatchObject({ accepted: false, code: 'delivery_rejected' })
  expect(sendMessage).not.toHaveBeenCalled()
})
it('never retries an ambiguous engine delivery failure', async () => {
  vi.mocked(sendMessage).mockImplementationOnce(async (_ws, _content, _session, beforeDispatch) => {
    beforeDispatch?.()
    throw new Error('Connection lost after delivery')
  })
  expect(await send()).toMatchObject({ accepted: false, code: 'delivery_unknown' })
  expect(await send()).toMatchObject({ accepted: false, code: 'delivery_unknown' })
  expect(sendMessage).toHaveBeenCalledTimes(1)
  expect(startAgent).not.toHaveBeenCalled()
})
it('rolls back a failed receipt commit and preserves uncertainty', async () => {
  getDb().exec(
    "CREATE TRIGGER reject_receipt BEFORE UPDATE ON mcp_message_requests WHEN NEW.state='accepted' BEGIN SELECT RAISE(ABORT, 'disk failure'); END",
  )
  expect(await send()).toMatchObject({ accepted: false, code: 'delivery_unknown' })
  expect(getDb().prepare("SELECT COUNT(*) AS n FROM ws_events WHERE type='user:message'").get()).toEqual({ n: 0 })
  expect(await send()).toMatchObject({ accepted: false, code: 'delivery_unknown' })
  expect(sendMessage).toHaveBeenCalledTimes(1)
})

it('persists source and returns it when polling the conversation', async () => {
  const source = { kind: 'mcp' as const, clientName: 'External tester', transport: 'stdio' as const }
  await executeWorkspaceDialogueTool('send_workspace_message', args, source)
  const history = await executeWorkspaceDialogueTool('read_workspace_messages', { workspace_id: 'ws' })
  expect(history).toMatchObject({ messages: [{ source, clientMessageId: expect.any(String), text: 'hello' }] })
})

it('records a session refusal before the engine dispatch boundary as rejected', async () => {
  vi.mocked(sendMessage).mockRejectedValueOnce(new Error('Session is not active'))
  expect(await send()).toMatchObject({ accepted: false, code: 'delivery_rejected' })
  expect(await send()).toMatchObject({ accepted: false, code: 'delivery_rejected' })
  expect(sendMessage).toHaveBeenCalledTimes(1)
})

it('keeps the same reservation when an unavailable engine requires the normal resume fallback', async () => {
  vi.mocked(sendMessage).mockImplementationOnce(async (_ws, _content, _session, beforeDispatch) => {
    beforeDispatch?.()
    throw new Error('No agent running')
  })
  vi.mocked(startAgent).mockImplementationOnce(
    (_ws, _cwd, _prompt, _model, _resume, _mode, _session, _effort, beforeDispatch) => {
      beforeDispatch?.()
      return { agentSessionId: 'resumed' } as never
    },
  )
  expect(await send()).toMatchObject({ accepted: true })
  expect(await send()).toMatchObject({ accepted: true, replayed: true })
  expect(startAgent).toHaveBeenCalledTimes(1)
})

const note = {
  name: 'note.md',
  mime_type: 'text/markdown',
  data_base64: Buffer.from('Task details').toString('base64'),
}
const picture = {
  name: 'screen.png',
  mime_type: 'image/png',
  data_base64: Buffer.from('png-content').toString('base64'),
}
function prepareWorktree() {
  const worktree = join(directory, 'worktree')
  mkdirSync(worktree)
  getDb().prepare('UPDATE workspaces SET worktree_path=?').run(worktree)
  return worktree
}
it('saves images and documents, delivers references and persists them in chat', async () => {
  const worktree = prepareWorktree()
  const result = await send({ ...args, attachments: [note, picture] })
  expect(result).toMatchObject({ accepted: true })
  const content = vi.mocked(sendMessage).mock.calls[0]![1]
  const file = /\[file: (.*?)\]/.exec(content)![1]!
  const image = /\[image: (.*?)\]/.exec(content)![1]!
  expect(readFileSync(join(worktree, file), 'utf8')).toBe('Task details')
  expect(readFileSync(join(worktree, image), 'utf8')).toBe('png-content')
  const history = await executeWorkspaceDialogueTool('read_workspace_messages', { workspace_id: 'ws' })
  expect(history).toMatchObject({ messages: [{ text: content }] })
  expect(JSON.stringify(history)).not.toContain(note.data_base64)
})
it('replays attached messages without writing or dispatching twice and rejects changed attachments', async () => {
  const worktree = prepareWorktree()
  const input = { ...args, attachments: [note] }
  await send(input)
  expect(await send(input)).toMatchObject({ accepted: true, replayed: true })
  expect(
    await send({ ...input, attachments: [{ ...note, data_base64: Buffer.from('changed').toString('base64') }] }),
  ).toMatchObject({ code: 'idempotency_conflict' })
  expect(readdirSync(join(worktree, '.ai/attachments'))).toHaveLength(1)
  expect(sendMessage).toHaveBeenCalledTimes(1)
})
it('accepts an attachment-only message without an idempotency key', async () => {
  prepareWorktree()
  expect(
    await executeWorkspaceDialogueTool('send_workspace_message', { workspace_id: 'ws', attachments: [note] }),
  ).toMatchObject({ accepted: true })
  expect(vi.mocked(sendMessage).mock.calls[0]![1]).toContain('[file:')
})
it('does not save attachments for archived or compacting workspaces', async () => {
  const worktree = prepareWorktree()
  getDb().exec("UPDATE workspaces SET status='compacting'")
  expect(await send({ ...args, attachments: [note] })).toMatchObject({ code: 'delivery_rejected' })
  expect(existsSync(join(worktree, '.ai'))).toBe(false)
})
it('removes attachments rejected before dispatch but retains them after ambiguous delivery', async () => {
  const worktree = prepareWorktree()
  vi.mocked(sendMessage).mockRejectedValueOnce(new Error('Session is not active'))
  expect(await send({ ...args, attachments: [note] })).toMatchObject({ code: 'delivery_rejected' })
  expect(readdirSync(join(worktree, '.ai/attachments'))).toHaveLength(0)
  vi.mocked(sendMessage).mockImplementationOnce(async (_ws, _content, _session, beforeDispatch) => {
    beforeDispatch?.()
    throw new Error('Connection lost')
  })
  expect(await send({ ...args, idempotency_key: 'second', attachments: [note] })).toMatchObject({
    code: 'delivery_unknown',
  })
  expect(readdirSync(join(worktree, '.ai/attachments'))).toHaveLength(1)
})

it.each(['worktree', 'status'])('revalidates attachment ownership at dispatch after a %s change', async (change) => {
  prepareWorktree()
  let nativeDispatches = 0
  vi.mocked(sendMessage).mockImplementationOnce(async (_ws, _content, _session, beforeDispatch) => {
    // Simulate the controller waiting for engine startup while metadata changes.
    await Promise.resolve()
    if (change === 'worktree') getDb().prepare('UPDATE workspaces SET worktree_path=?').run(join(directory, 'renamed'))
    else getDb().exec("UPDATE workspaces SET status='awaiting-user'")
    beforeDispatch?.()
    nativeDispatches++
  })
  expect(await send({ ...args, attachments: [note] })).toMatchObject({ code: 'delivery_rejected' })
  expect(nativeDispatches).toBe(0)
})

it('keeps a busy Mistral attachment refusal definitive across idempotent retries', async () => {
  const preflight = vi.spyOn(mistralOptions, 'preflightMistralConfiguration').mockResolvedValue(undefined)
  getDb()
    .prepare("UPDATE workspaces SET engine='mistral-vibe', model='explicit-native', worktree_path=? WHERE id='ws'")
    .run(directory)
  vi.mocked(assertImmediateMessageSupported).mockImplementationOnce(() => {
    throw new Error('Mistral Vibe live message delivery is unsupported')
  })
  const input = { ...args, attachments: [{ name: 'file.txt', mime_type: 'text/plain', data_base64: 'YQ==' }] }
  expect(await send(input)).toMatchObject({ accepted: false, code: 'delivery_rejected' })
  expect(await send(input)).toMatchObject({ accepted: false, code: 'delivery_rejected' })
  expect(preflight).not.toHaveBeenCalled()
  expect(sendMessage).not.toHaveBeenCalled()
  expect(startAgent).not.toHaveBeenCalled()
  expect(getDb().prepare("SELECT COUNT(*) AS n FROM ws_events WHERE type='user:message'").get()).toEqual({ n: 0 })
  expect(readdirSync(directory).some((name) => name.includes('attachment'))).toBe(false)
})
