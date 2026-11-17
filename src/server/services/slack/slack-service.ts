import { constants as fsConstants } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  attachmentFormat,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS,
  MAX_ATTACHMENTS_BYTES,
} from '../../../shared/attachments.js'
import type { McpAttachment } from '../../../shared/mcp-attachments.js'
import type { SlackIgnoreReason, SlackInboundOutcome } from '../../../shared/slack-inbound-outcome.js'
import type { SlackQuestionMirror } from '../../../shared/slack-question-mirror.js'
import { neutraliseSlackMentions as neutralise, type SlackButton } from '../../../shared/slack-tools.js'
import type { MessageSource } from '../../../shared/workspace-message-types.js'
import { getDb } from '../../db/index.js'
import { resolvePathInside } from '../../utils/safe-path.js'
import { withWorkspaceLifecycleGuard } from '../../utils/workspace-lifecycle-guard.js'
import {
  answerPendingQuestion,
  getPendingInputs,
  isParallelReviewSession,
  onPendingInputsChanged,
  type PendingItem,
} from '../agent/orchestrator.js'
import { hasReviewOnlyCapability } from '../internal-mcp-capability-service.js'
import { getReviewReturn } from '../review-return-service.js'
import { getGlobalSettings } from '../settings-service.js'
import { broadcastAll, broadcastPersistedEvent, persistWorkspaceEvent } from '../websocket-service.js'
import { deliverWorkspaceMessage } from '../workspace-message-service.js'
import { getWorkspace } from '../workspace-service.js'
import {
  createSlackApi,
  type SlackApi,
  SlackApiError,
  type SlackClick,
  type SlackErrorCode,
  type SlackIdentity,
  type SlackQuestionAction,
} from './slack-api.js'
import { getSlackCredentials } from './slack-credentials.js'
import { classifyInbound, type InboundEvent } from './slack-inbound.js'
import {
  claimSlackMessageForDispatch,
  closeSlackButtonMessage,
  countQueuedSlackMessages,
  countThreadMessagesBefore,
  expireQueuedSlackMessages,
  getSlackButtonMessage,
  getSlackMessageState,
  getWorkspaceIdForSlackChannel,
  insertSlackMessage,
  isTrackedThread,
  listSlackThread,
  listWorkspacesWithQueuedSlackMessages,
  markSlackMessageDelivered,
  nextQueuedSlackMessage,
  promoteSlackContextMessage,
  reconcileSlackMessages,
  recordSlackClick,
  reopenSlackButtonMessage,
  type SlackFileRef,
  type SlackMessageRow,
  setSlackMessageState,
  setWorkspaceSlackChannel,
} from './slack-message-store.js'
import {
  claimSlackQuestionAnswer,
  closeSlackQuestion,
  closeStaleSlackQuestions,
  dropSlackQuestionReservation,
  getOpenSlackQuestionInThread,
  getSlackQuestion,
  getSlackQuestionByMessage,
  lastUserMessageSource,
  listOpenSlackQuestions,
  listSlackQuestionWorkspaces,
  publishSlackQuestion,
  reserveSlackQuestion,
  type SlackQuestionRow,
  setWorkspaceSlackQuestionMirror,
  showNextSlackQuestion,
} from './slack-question-store.js'
import {
  answerFailure,
  buildAnswers,
  type CollectedAnswer,
  MAX_QUESTION_CONTROLS,
  type MirroredQuestion,
  QUESTION_TEXT,
  questionControls,
  questionText,
  readQuestions,
} from './slack-questions.js'

export interface SlackStatus {
  configured: boolean
  enabled: boolean
  connected: boolean
  botName?: string
  teamName?: string
  error?: SlackErrorCode
  /** Enabled with nobody allowed: every message and click is ignored. */
  allowListEmpty: boolean
  /** The most recent addressed inbound message or click seen by this process. No id, name, channel or text. */
  lastInbound?: SlackInboundOutcome
}

const NOTICE = {
  unlinked: 'This channel is not linked to a Kōbō workspace.',
  archived: 'This workspace is archived in Kōbō. Restore it to send messages.',
  autoLoop: 'Attachments cannot be delivered while the workspace runs in auto-loop.',
  full: 'Too many messages are waiting for this workspace. Try again later.',
  expired: 'This message waited more than 24 hours and was not delivered.',
  uncertain: 'Kōbō restarted while delivering this message. Delivery is uncertain and it was not retried.',
  unlinkedQueued: 'This channel was unlinked from its Kōbō workspace before this message was delivered.',
}
const MAX_QUEUED = 50
const CONTEXT_LIMIT = 100
const TICK_MS = 15_000
const EXPIRY_MS = 24 * 60 * 60 * 1000
const HOURGLASS = 'hourglass_flowing_sand'
const UNLINKED_NOTICE_MEMORY = 500
const DOWNLOAD_ATTEMPTS = 3

let createApiFn: typeof createSlackApi = createSlackApi
let api: SlackApi | null = null
let identity: SlackIdentity | null = null
let connected = false
let connecting: Promise<void> | null = null
let lastError: SlackErrorCode | undefined
let stopping = false
let reconciled = false
let generation = 0
let timer: ReturnType<typeof setInterval> | null = null
let lifecycle: Promise<void> = Promise.resolve()
let lastFastReconnect = 0
/** Aborted when a stop begins; renewed by each start. */
let stopSignal = new AbortController()
const active = new Set<Promise<unknown>>()
const drains = new Map<string, Promise<void>>()
const hourglassed = new Set<string>()
const channelNames = new Map<string, string>()
// Slack may redeliver an event; nothing is stored for an unlinked channel.
const notifiedUnlinked = new Set<string>()
/** Consecutive download failures per queued row (`channel:ts`) and file id. */
const downloadFailures = new Map<string, Map<string, number>>()
const rowKey = (row: { channelId: string; ts: string }) => `${row.channelId}:${row.ts}`
/** One question-mirror pass per workspace at a time; a change during a pass schedules one more. */
const mirrorRuns = new Map<string, { again: boolean }>()
let unsubscribePending: (() => void) | null = null
let lastInbound: SlackInboundOutcome | undefined
/** Private: the stored row `lastInbound` describes, so its later transitions update it. Never exposed. */
let lastInboundRow: string | undefined
function saw(outcome: SlackInboundOutcome['outcome'], reason?: SlackIgnoreReason, row?: ReactableRow): void {
  lastInbound = { at: new Date().toISOString(), outcome, ...(reason ? { reason } : {}) }
  lastInboundRow = row ? rowKey(row) : undefined
}
/** A stored row left the queue: `lastInbound` follows it while it still describes that row, keeping its time. */
function settled(row: ReactableRow, outcome: SlackInboundOutcome['outcome']): void {
  if (lastInbound && lastInboundRow === rowKey(row)) lastInbound = { ...lastInbound, outcome }
}
/** The reaction that replaces `eyes` once the agent has finished; other statuses keep `eyes`. */
const FINAL_REACTION: Record<string, string> = {
  idle: 'white_check_mark',
  completed: 'white_check_mark',
  error: 'warning',
  quota: 'warning',
}
// shortcut: in-memory only, a restart leaves eyes on messages being worked on; persist if that matters.
/** Delivered inbound rows still carrying `eyes`, per workspace, with their delivery time. */
const MAX_WORKING = 200
const working = new Map<string, { channelId: string; ts: string; at: number }[]>()

/** Logs carry only a code or an error name: Slack payloads, tokens and URLs never reach them. */
function errorCode(err: unknown): string {
  if (err instanceof SlackApiError) return err.code
  return err instanceof Error ? err.name : 'unknown'
}

function track<T>(p: Promise<T>): Promise<T> {
  active.add(p)
  void p.finally(() => active.delete(p)).catch(() => undefined)
  return p
}

function serialize(fn: () => Promise<void>): Promise<void> {
  lifecycle = lifecycle.then(fn).catch((err) => console.error(`[slack] lifecycle failed: ${errorCode(err)}`))
  return lifecycle
}

/** Reactions and notices never change delivery state. */
async function bestEffort(label: string, fn: (a: SlackApi) => Promise<unknown>): Promise<void> {
  const a = api
  if (!a) return
  try {
    await fn(a)
  } catch (err) {
    console.warn(`[slack] ${label} failed: ${errorCode(err)}`)
  }
}
const notice = (channelId: string, threadTs: string, text: string) =>
  bestEffort('notice', (a) => a.postMessage(channelId, text, threadTs))
const react = (channelId: string, ts: string, name: string) =>
  bestEffort('reaction', (a) => a.addReaction(channelId, ts, name))
const unreact = (channelId: string, ts: string, name: string) =>
  bestEffort('reaction', (a) => a.removeReaction(channelId, ts, name))

async function safeUserName(a: SlackApi, userId: string): Promise<string> {
  try {
    return await a.userName(userId)
  } catch {
    return userId
  }
}

async function channelName(a: SlackApi, channelId: string): Promise<string> {
  if (!channelNames.has(channelId)) {
    try {
      for (const c of await a.listChannels()) channelNames.set(c.id, c.name)
    } catch (err) {
      console.warn(`[slack] channel lookup failed: ${errorCode(err)}`)
    }
  }
  return channelNames.get(channelId) ?? channelId
}

function connect(): Promise<void> {
  const a = api
  if (connecting || !a) return connecting ?? Promise.resolve()
  connecting = (async () => {
    try {
      const id = await a.connect(
        (event) => void handleSlackEvent(event),
        (up) => {
          if (api !== a) return
          connected = up
          // Slack refreshes the socket every few hours; reconnect now instead of at the next tick.
          // The time guard avoids a tight loop when the socket drops right after its handshake.
          if (!up && !stopping && Date.now() - lastFastReconnect >= TICK_MS) {
            lastFastReconnect = Date.now()
            void track(connect())
          }
        },
        (click) => void handleSlackClick(click),
        (action) => void handleSlackQuestionAction(action),
      )
      if (api !== a) return
      identity = id
      connected = true
      lastError = undefined
    } catch (err) {
      if (api !== a) return
      connected = false
      lastError = err instanceof SlackApiError ? err.code : 'unknown'
      console.warn(`[slack] connection failed: ${lastError}`)
    } finally {
      connecting = null
    }
  })()
  return connecting
}

async function doStart(createApi: typeof createSlackApi, gen: number): Promise<void> {
  createApiFn = createApi
  if (gen !== generation || api) return
  const credentials = getSlackCredentials()
  if (!getGlobalSettings().slackEnabled || !credentials) return
  stopping = false
  stopSignal = new AbortController()
  api = createApi(credentials)
  if (!reconciled) {
    // Only rows left by a previous process can be dispatching before the first start.
    reconciled = true
    for (const row of reconcileSlackMessages()) await notice(row.channelId, row.threadTs, NOTICE.uncertain)
    // Pending inputs are memory-only: a question still shown belongs to a previous process.
    for (const row of closeStaleSlackQuestions()) await replaceControls(row, QUESTION_TEXT.restarted)
  }
  unsubscribePending ??= onPendingInputsChanged((workspaceId) => void scheduleQuestionMirror(workspaceId))
  await connect()
  timer = setInterval(() => void track(runSlackTick()), TICK_MS)
  timer.unref?.()
}

async function doStop(): Promise<void> {
  stopping = true
  if (timer) clearInterval(timer)
  timer = null
  unsubscribePending?.()
  unsubscribePending = null
  while (active.size) await Promise.allSettled([...active])
  const a = api
  api = null
  identity = null
  connected = false
  lastError = undefined
  channelNames.clear()
  // The next start may use another app or channel: never swap reactions on messages of this one.
  working.clear()
  if (a) await a.disconnect().catch((err) => console.warn(`[slack] disconnect failed: ${errorCode(err)}`))
}

export function startSlack(createApi: typeof createSlackApi = createSlackApi): Promise<void> {
  const gen = generation
  return serialize(() => doStart(createApi, gen))
}

export function stopSlack(): Promise<void> {
  generation++
  stopping = true
  stopSignal.abort()
  return serialize(doStop)
}

export function restartSlack(): Promise<void> {
  const gen = ++generation
  stopping = true
  stopSignal.abort()
  return serialize(async () => {
    await doStop()
    await doStart(createApiFn, gen)
  })
}

export function getSlackStatus(): SlackStatus {
  const settings = getGlobalSettings()
  const enabled = settings.slackEnabled === true
  return {
    configured: getSlackCredentials() !== null,
    enabled,
    connected,
    ...(connected && identity ? { botName: identity.botName, teamName: identity.teamName } : {}),
    ...(!connected && lastError ? { error: lastError } : {}),
    allowListEmpty: enabled && !settings.slackAllowedUserIds?.length,
    ...(lastInbound ? { lastInbound } : {}),
  }
}

export function handleSlackEvent(event: InboundEvent): Promise<void> {
  const a = api
  const bot = identity
  if (stopping || !a || !bot) return Promise.resolve()
  return track(
    processEvent(event, a, bot).catch((err) => console.error(`[slack] event handling failed: ${errorCode(err)}`)),
  )
}

async function processEvent(event: InboundEvent, a: SlackApi, bot: SlackIdentity): Promise<void> {
  const settings = getGlobalSettings()
  if (!settings.slackEnabled) return
  const workspaceId = getWorkspaceIdForSlackChannel(event.channel)
  const decision = classifyInbound(event, {
    botUserId: bot.botUserId,
    allowedUserIds: settings.slackAllowedUserIds,
    workspaceId,
    isTrackedThread,
  })
  if (decision.action === 'ignore') {
    // Only messages addressed to Kōbō carry a reason: chatter, edits, joins, other bots and the bot's own posts
    // must not hide the outcome of the last message sent to it.
    if (decision.reason) saw('ignored', decision.reason)
    return
  }
  if (decision.action === 'notify-unlinked') {
    saw('ignored', 'channel-not-linked')
    return notifyUnlinked(event, decision.threadTs)
  }
  const userId = event.user as string // classifyInbound only delivers authored messages
  const userName = await safeUserName(a, userId)
  const ws = workspaceId ? getWorkspace(workspaceId) : null
  if (!ws) {
    saw('ignored', 'channel-not-linked')
    return notifyUnlinked(event, decision.threadTs)
  }
  const files = event.files ?? []
  if (
    !ws.archivedAt &&
    !ws.worktreePurgedAt &&
    decision.text &&
    (await takeTextAnswer(event, decision, ws.id, userName))
  )
    return saw('delivered')
  const reason =
    ws.archivedAt || ws.worktreePurgedAt
      ? NOTICE.archived
      : ws.autoLoop && files.length
        ? NOTICE.autoLoop
        : countQueuedSlackMessages(ws.id) >= MAX_QUEUED
          ? NOTICE.full
          : null
  const row = {
    channelId: event.channel,
    ts: event.ts,
    threadTs: decision.threadTs,
    workspaceId: ws.id,
    userId,
    userName,
    text: decision.text,
    direction: 'in' as const,
    files,
  }
  if (reason) {
    // A redelivered event for an already-stored message stays fully silent.
    if (store({ ...row, state: 'rejected' })) {
      saw('rejected')
      await notice(row.channelId, row.threadTs, reason)
    }
    return
  }
  const context = decision.fetchContext ? await fetchContext(a, row) : []
  // One synchronous segment: no drain can see the queued row before its context rows exist.
  // (channel, ts) is the single dedupe point between redeliveries.
  if (!store({ ...row, state: 'queued' })) return
  for (const contextRow of context) insertSlackMessage(contextRow)
  saw('queued', undefined, row)
  await drainSlackQueue(ws.id)
  if (getSlackMessageState(row.channelId, row.ts) === 'queued') await hourglass(row)
}

/** A click travels the same queue and delivery path as a Slack message. Never rejects. */
export function handleSlackClick(click: SlackClick): Promise<void> {
  const a = api
  if (stopping || !a || !identity) return Promise.resolve()
  return track(processClick(click, a).catch((err) => console.error(`[slack] click handling failed: ${errorCode(err)}`)))
}

async function processClick(click: SlackClick, a: SlackApi): Promise<void> {
  const settings = getGlobalSettings()
  // Silent for everyone else: nothing stored, nothing posted, no API call.
  if (!settings.slackEnabled) return
  // In memory only: no API call and no database write for someone outside the allow-list.
  if (!settings.slackAllowedUserIds.includes(click.user)) return saw('ignored', 'not-allowed')
  // Resolved before the look-up: no await between the open check and recordSlackClick.
  const userName = await safeUserName(a, click.user)
  const workspaceId = getWorkspaceIdForSlackChannel(click.channel)
  const message = workspaceId ? getSlackButtonMessage(click.channel, click.messageTs) : undefined
  // The label comes from what Kōbō stored, never from the payload.
  const label = message?.workspaceId === workspaceId ? message?.buttons[click.index] : undefined
  if (!workspaceId) return saw('ignored', 'channel-not-linked')
  if (!message || label === undefined || message.answered) return saw('ignored', 'unsupported-message')
  const ws = getWorkspace(message.workspaceId)
  if (!ws) return saw('ignored', 'channel-not-linked')
  const reason =
    ws.archivedAt || ws.worktreePurgedAt
      ? NOTICE.archived
      : countQueuedSlackMessages(ws.id) >= MAX_QUEUED
        ? NOTICE.full
        : null
  const row = {
    channelId: click.channel,
    // Unique per click, sorted after the bot message, and never a real Slack ts (those have no '-').
    ts: `${click.actionTs}-${click.user}`,
    threadTs: message.threadTs,
    workspaceId: ws.id,
    userId: click.user,
    userName,
    text: `Clicked: ${label}`,
    direction: 'in' as const,
    files: [],
    clickOf: message.ts,
    multiple: message.multiple,
  }
  // One synchronous call: the single-answer compare-and-set and the row insert cannot interleave.
  if (!recordSlackClick({ ...row, state: reason ? 'rejected' : 'queued' }, message.ts, !reason))
    return saw('ignored', 'unsupported-message')
  if (reason) {
    saw('rejected')
    return notice(row.channelId, row.threadTs, reason)
  }
  saw('queued', undefined, row)
  if (!message.multiple)
    // Best effort and tracked, but never awaited: a slow Slack API must not delay delivery.
    void track(
      bestEffort('update', (b) =>
        b.replaceButtons(row.channelId, message.ts, message.text, `Answered: ${label} - ${userName}`),
      ),
    )
  await drainSlackQueue(ws.id)
}

/** A context row may hold this ts when a later message's thread fetch ran first. */
const store = (row: Omit<SlackMessageRow, 'createdAt'>) => insertSlackMessage(row) || promoteSlackContextMessage(row)

async function notifyUnlinked(event: InboundEvent, threadTs: string): Promise<void> {
  const key = `${event.channel}:${event.ts}`
  if (notifiedUnlinked.has(key)) return
  notifiedUnlinked.add(key)
  if (notifiedUnlinked.size > UNLINKED_NOTICE_MEMORY) notifiedUnlinked.delete(notifiedUnlinked.values().next().value!)
  await notice(event.channel, threadTs, NOTICE.unlinked)
}

/** Earlier thread messages as context rows; a failed fetch only means no context. */
async function fetchContext(
  a: SlackApi,
  row: { channelId: string; ts: string; threadTs: string; workspaceId: string },
): Promise<Omit<SlackMessageRow, 'createdAt'>[]> {
  let replies: InboundEvent[]
  try {
    replies = await a.threadReplies(row.channelId, row.threadTs, CONTEXT_LIMIT)
  } catch (err) {
    console.warn(`[slack] thread context failed: ${errorCode(err)}`)
    return []
  }
  const out: Omit<SlackMessageRow, 'createdAt'>[] = []
  for (const reply of replies) {
    if (!reply.ts || reply.ts >= row.ts) continue
    out.push({
      channelId: row.channelId,
      ts: reply.ts,
      threadTs: row.threadTs,
      workspaceId: row.workspaceId,
      userId: reply.user ?? null,
      userName: reply.user ? await safeUserName(a, reply.user) : null,
      text: reply.text ?? '',
      direction: 'in',
      state: 'context',
      // Context files are never downloaded: keep their names only.
      files: (reply.files ?? []).map((f) => ({ ...f, url: '' })),
    })
  }
  return out
}

export function drainSlackQueue(workspaceId: string): Promise<void> {
  const running = drains.get(workspaceId)
  if (running) return running
  if (stopping || !api) return Promise.resolve()
  const drain = (async () => {
    await Promise.resolve() // register the lock before the loop can finish
    try {
      for (;;) {
        const a = api
        if (stopping || !a) return
        const row = nextQueuedSlackMessage(workspaceId)
        if (!row) return
        // A refused message blocks the rest so arrival order is preserved.
        if ((await deliverRow(a, row)) === 'blocked') return
      }
    } catch (err) {
      console.error(`[slack] queue drain failed: ${errorCode(err)}`)
    } finally {
      drains.delete(workspaceId) // the lock guarantees this entry is ours
    }
  })()
  drains.set(workspaceId, drain)
  return track(drain)
}

const validName = (name: string) =>
  !!name.trim() && name.length <= 255 && !/[/\\\0]/.test(name) && name !== '.' && name !== '..'

/** Decided from metadata only, so a skipped file is never downloaded. */
function splitFiles(files: SlackFileRef[]): { accepted: SlackFileRef[]; skipped: string[] } {
  const accepted: SlackFileRef[] = []
  const skipped: string[] = []
  let total = 0
  for (const file of files) {
    const size = Number(file.size)
    const ok =
      accepted.length < MAX_ATTACHMENTS &&
      size > 0 &&
      size <= MAX_ATTACHMENT_BYTES &&
      total + size <= MAX_ATTACHMENTS_BYTES &&
      validName(file.name) &&
      file.mimetype.length <= 200 &&
      attachmentFormat({ name: file.name, type: file.mimetype }) !== null
    if (ok) {
      accepted.push(file)
      total += size
    } else skipped.push(file.name || file.id)
  }
  return { accepted, skipped }
}

/** A click row is not a real Slack message: no reaction is ever attempted on it. */
type ReactableRow = { channelId: string; ts: string; clickOf?: string }

async function hourglass(row: ReactableRow): Promise<void> {
  if (row.clickOf !== undefined) return
  const key = rowKey(row)
  if (hourglassed.has(key)) return
  hourglassed.add(key)
  await react(row.channelId, row.ts, HOURGLASS)
}

/** Drops the in-memory state of a row that is no longer queued. */
function forget(row: { channelId: string; ts: string }): void {
  hourglassed.delete(rowKey(row))
  downloadFailures.delete(rowKey(row))
}

/** The row ended without delivery (rejected, unknown, expired, unlinked). */
async function leftQueue(row: ReactableRow, outcome: 'rejected' | 'uncertain' = 'rejected'): Promise<void> {
  forget(row)
  settled(row, outcome)
  if (row.clickOf === undefined) await unreact(row.channelId, row.ts, HOURGLASS)
}

async function block(row: SlackMessageRow): Promise<'blocked'> {
  await hourglass(row)
  return 'blocked'
}

async function reject(row: SlackMessageRow, text: string): Promise<'done'> {
  setSlackMessageState(row.channelId, row.ts, 'rejected')
  await leftQueue(row)
  await notice(row.channelId, row.threadTs, text)
  return 'done'
}

/** Slack-supplied names must not break the one-line agent header. */
const headerValue = (value: string) =>
  value
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
    .replace(/[|\]]/g, '/') // nor mimic its separators
    .trim()
    .slice(0, 100)

async function deliverRow(a: SlackApi, row: SlackMessageRow): Promise<'done' | 'blocked'> {
  // Removed from the allow-list while queued: rejected in silence, like any unlisted author.
  if (!getGlobalSettings().slackAllowedUserIds.includes(row.userId ?? '')) {
    setSlackMessageState(row.channelId, row.ts, 'rejected')
    await leftQueue(row)
    return 'done'
  }
  // The tick may not have run yet after a long stop.
  if (Date.parse(row.createdAt) < Date.now() - EXPIRY_MS) return reject(row, NOTICE.expired)
  if (getWorkspaceIdForSlackChannel(row.channelId) !== row.workspaceId) return reject(row, NOTICE.unlinkedQueued)
  const ws = getWorkspace(row.workspaceId)
  if (!ws || ws.archivedAt || ws.worktreePurgedAt) return reject(row, NOTICE.archived)
  // Auto-loop may have been enabled while the message waited; it would otherwise block the queue.
  if (ws.autoLoop && row.files.length) return reject(row, NOTICE.autoLoop)

  const { accepted, skipped } = splitFiles(row.files)
  // Immediate delivery refuses these statuses: do not download the files again on every retry.
  if (accepted.length && (ws.status === 'compacting' || ws.status === 'awaiting-user')) return block(row)
  const attachments: McpAttachment[] = []
  let total = 0
  for (const file of accepted) {
    let data: Buffer
    const failures = downloadFailures.get(rowKey(row)) ?? new Map<string, number>()
    try {
      data = await a.downloadFile(file)
      failures.delete(file.id)
    } catch (err) {
      console.warn(`[slack] file download failed: ${errorCode(err)}`)
      const attempts = (failures.get(file.id) ?? 0) + 1
      failures.set(file.id, attempts)
      downloadFailures.set(rowKey(row), failures)
      if (attempts < DOWNLOAD_ATTEMPTS) return block(row)
      skipped.push(file.name) // give up on this file, not on the message
      continue
    }
    // Slack metadata can be wrong: re-check the real size before handing bytes on.
    if (!data.length || data.length > MAX_ATTACHMENT_BYTES || total + data.length > MAX_ATTACHMENTS_BYTES) {
      skipped.push(file.name)
      continue
    }
    total += data.length
    attachments.push({ name: file.name, mime_type: file.mimetype, data_base64: data.toString('base64') })
  }

  const earlier = countThreadMessagesBefore(row.channelId, row.threadTs, row.ts)
  const userName = row.userName ?? row.userId ?? 'unknown'
  const segments = [
    `Slack #${headerValue(await channelName(a, row.channelId))}`,
    `from ${headerValue(userName)}`,
    `thread ${row.threadTs}`,
  ]
  if (row.clickOf !== undefined) segments.push('button')
  if (earlier) segments.push(`${earlier} earlier stored messages`)
  segments.push(`reply with slack_post_message thread_ts="${row.threadTs}"`)
  if (skipped.length) segments.push(`ignored files: ${skipped.map(headerValue).join(', ')}`)

  const db = getDb()
  let dispatched = false
  let delivered = false
  let lost = false
  try {
    await deliverWorkspaceMessage(
      row.workspaceId,
      {
        content: `[${segments.join(' | ')}]\n${row.text}`,
        source: {
          kind: 'slack',
          userName,
          userId: row.userId ?? '',
          channelId: row.channelId,
          threadTs: row.threadTs,
        },
        ...(attachments.length ? { attachments } : {}),
        delivery: ws.autoLoop ? 'next_iteration' : 'immediate',
        clientMessageId: `slack:${row.channelId}:${row.ts}`,
      },
      {
        beforeDispatch() {
          // The closed-engine fallback may cross this boundary again for the same message.
          if (dispatched) return
          // Compare-and-set: the row may have been rejected, expired or unlinked while the agent
          // was starting. Throwing here rejects the delivery before the engine receives anything.
          if (!claimSlackMessageForDispatch(row.channelId, row.ts, row.workspaceId)) {
            lost = true
            throw new Error('Slack message is no longer queued')
          }
          dispatched = true
        },
        persist(payload, sessionId) {
          const event = db.transaction(() => {
            // The engine already has the message, so the chat event is kept even if the row was
            // deleted by an unlink meanwhile; the state only moves from dispatching.
            const persisted = persistWorkspaceEvent(row.workspaceId, 'user:message', payload, sessionId)
            markSlackMessageDelivered(row.channelId, row.ts)
            return persisted
          })()
          delivered = true
          broadcastPersistedEvent(event)
        },
      },
    )
  } catch {
    // A notification failure cannot invalidate an already committed receipt.
    if (!delivered) {
      // Whoever rejected, expired or unlinked the row has already notified the author.
      if (lost) {
        forget(row)
        return 'done'
      }
      if (!dispatched) return block(row)
      // Possibly delivered: never retried automatically.
      setSlackMessageState(row.channelId, row.ts, 'unknown')
      await leftQueue(row, 'uncertain')
      await notice(row.channelId, row.threadTs, NOTICE.uncertain)
      return 'done'
    }
  }
  if (!delivered) {
    // An auto-loop instruction accepted by an earlier attempt returns without a new receipt.
    if (!dispatched && !claimSlackMessageForDispatch(row.channelId, row.ts, row.workspaceId)) {
      forget(row)
      return 'done'
    }
    markSlackMessageDelivered(row.channelId, row.ts)
  }
  forget(row)
  settled(row, 'delivered')
  if (row.clickOf === undefined) {
    const list = working.get(row.workspaceId) ?? []
    list.push({ channelId: row.channelId, ts: row.ts, at: Date.now() })
    if (list.length > MAX_WORKING) list.shift() // the oldest simply keeps eyes
    working.set(row.workspaceId, list)
    await unreact(row.channelId, row.ts, HOURGLASS)
    await react(row.channelId, row.ts, 'eyes')
  } else if (row.multiple) await react(row.channelId, row.clickOf, 'eyes') // idempotent on the bot message
  if (skipped.length)
    await notice(row.channelId, row.threadTs, `Ignored files (unsupported type or too large): ${skipped.join(', ')}`)
  return 'done'
}

/** One queue-timer pass; exported for tests. Never rejects. */
export async function runSlackTick(): Promise<void> {
  try {
    if (stopping || !api) return
    // Tracked so stopSlack waits for it and then closes the socket it may open.
    if (!connected && getGlobalSettings().slackEnabled) void track(connect())
    for (const row of expireQueuedSlackMessages(new Date(Date.now() - EXPIRY_MS).toISOString())) {
      await leftQueue(row)
      await notice(row.channelId, row.threadTs, NOTICE.expired)
    }
    if (stopping) return
    await Promise.all(listWorkspacesWithQueuedSlackMessages().map((id) => drainSlackQueue(id)))
    if (stopping) return
    await Promise.all(listSlackQuestionWorkspaces().map((id) => scheduleQuestionMirror(id)))
    if (stopping) return
    await settleWorkingReactions()
  } catch (err) {
    console.error(`[slack] queue timer failed: ${errorCode(err)}`)
  }
}

/** Swaps `eyes` for the final reaction once the workspace is no longer busy. Best effort, never retried. */
async function settleWorkingReactions(): Promise<void> {
  // A row delivered within the last tick may have restarted an idle agent that is not busy yet.
  const cutoff = Date.now() - TICK_MS
  for (const workspaceId of [...working.keys()]) {
    if (stopping) return
    // Read and take the rows in one synchronous step: a concurrent tick, a new delivery or an unlink
    // during the awaits below then sees the current list, never a stale copy.
    const list = working.get(workspaceId)
    if (!list) continue
    const ws = getWorkspace(workspaceId)
    if (!ws) {
      working.delete(workspaceId)
      continue
    }
    const final = FINAL_REACTION[ws.status]
    if (!final) continue
    const done = list.filter((r) => r.at <= cutoff)
    if (!done.length) continue
    const rest = list.filter((r) => r.at > cutoff)
    if (rest.length) working.set(workspaceId, rest)
    else working.delete(workspaceId)
    for (const r of done) {
      // Rows not swapped yet keep eyes, like after a restart.
      if (stopping) return
      await unreact(r.channelId, r.ts, 'eyes')
      await react(r.channelId, r.ts, final)
    }
  }
}

export async function listSlackChannels(): Promise<{ id: string; name: string; workspaceId: string | null }[]> {
  const a = api
  if (!a || !connected) throw new Error('Slack is not connected')
  const channels = await a.listChannels()
  for (const c of channels) channelNames.set(c.id, c.name)
  return channels.map((c) => ({ id: c.id, name: c.name, workspaceId: getWorkspaceIdForSlackChannel(c.id) ?? null }))
}

export async function linkSlackChannel(workspaceId: string, channelId: string | null): Promise<void> {
  const dropped = await withWorkspaceLifecycleGuard(workspaceId, async () =>
    setWorkspaceSlackChannel(workspaceId, channelId),
  )
  broadcastAll('workspace:slack-channel-updated', { workspaceId, slackChannelId: channelId })
  working.delete(workspaceId)
  for (const row of dropped) {
    await leftQueue(row)
    await notice(row.channelId, row.threadTs, NOTICE.unlinkedQueued)
  }
  // A question shown in the previous channel is closed by the next pass.
  void scheduleQuestionMirror(workspaceId)
}

export async function setSlackQuestionMirror(workspaceId: string, mode: SlackQuestionMirror): Promise<void> {
  await withWorkspaceLifecycleGuard(workspaceId, async () => setWorkspaceSlackQuestionMirror(workspaceId, mode))
  broadcastAll('workspace:slack-question-mirror-updated', { workspaceId, slackQuestionMirror: mode })
  void scheduleQuestionMirror(workspaceId)
}

function linkedChannel(workspaceId: string): { channelId: string; a: SlackApi; bot: SlackIdentity } {
  const channelId = getWorkspace(workspaceId)?.slackChannelId
  const a = api
  const bot = identity
  if (stopping || !getGlobalSettings().slackEnabled || !a || !bot || !connected || !channelId)
    throw new Error('Slack is not available for this workspace')
  return { channelId, a, bot }
}

/** Settles with `p`, or rejects as soon as a stop begins; an abandoned `p` keeps a no-op catch. */
function untilStopped<T>(p: Promise<T>): Promise<T> {
  p.catch(() => undefined)
  const signal = stopSignal.signal
  return new Promise<T>((resolve, reject) => {
    const onStop = () => reject(new Error('Slack is stopping'))
    if (signal.aborted) return onStop()
    signal.addEventListener('abort', onStop, { once: true })
    p.then(resolve, reject).finally(() => signal.removeEventListener('abort', onStop))
  })
}

/** A fixed, agent-facing error about files sent to Slack; never carries Slack error text. */
export class SlackFileError extends Error {}

const SLACK_FILE_BYTES = 20 * 1024 * 1024
const SLACK_FILES_BYTES = 50 * 1024 * 1024
const READ_CHUNK = 1024 * 1024
const NO_FOLLOW = fsConstants.O_NOFOLLOW ?? 0
const NON_BLOCK = fsConstants.O_NONBLOCK ?? 0

/** Reads worktree files for upload; a path escaping the worktree ('..' or a symlink) is "not found". */
async function readWorktreeFiles(workspaceId: string, paths: string[]): Promise<{ name: string; data: Buffer }[]> {
  const root = getWorkspace(workspaceId)?.worktreePath
  const out: { name: string; data: Buffer }[] = []
  let total = 0
  for (const p of paths) {
    const notFound = () => new SlackFileError(`Slack file not found in the worktree: ${p}`)
    const tooLarge = () => new SlackFileError(`Slack file is too large: ${p}`)
    if (!root) throw notFound()
    const limit = Math.min(SLACK_FILE_BYTES, SLACK_FILES_BYTES - total)
    let fh: fs.FileHandle
    try {
      // The resolved leaf is opened with O_NOFOLLOW (a leaf swapped for a symlink fails), O_NONBLOCK keeps
      // a FIFO from blocking. A parent swapped for a symlink before the open is caught just below.
      fh = await fs.open(resolvePathInside(root, p), fsConstants.O_RDONLY | NO_FOLLOW | NON_BLOCK)
    } catch {
      throw notFound()
    }
    const chunks: Buffer[] = []
    let size = 0
    try {
      const stat = await fh.stat().catch(() => null)
      if (!stat?.isFile()) throw notFound()
      // Guarantee: the opened file is the very file (same device and inode) that the path resolves to,
      // inside the worktree, after the open. A hard link inside the worktree counts as a worktree file.
      const resolved = await Promise.resolve()
        .then(() => fs.stat(resolvePathInside(root, p)))
        .catch(() => null)
      if (resolved?.dev !== stat.dev || resolved.ino !== stat.ino) throw notFound()
      if (stat.size > limit) throw tooLarge()
      // Never more than limit + 1 bytes, whatever the stat said: the file may grow meanwhile.
      for (;;) {
        const chunk = Buffer.alloc(Math.min(READ_CHUNK, limit + 1 - size))
        const { bytesRead } = await fh.read(chunk, 0, chunk.length, null).catch(() => {
          throw notFound()
        })
        if (!bytesRead) break
        chunks.push(chunk.subarray(0, bytesRead))
        size += bytesRead
        if (size > limit) throw tooLarge()
      }
    } finally {
      await fh.close().catch(() => undefined)
    }
    if (!size) throw new SlackFileError(`Slack file is empty: ${p}`)
    total += size
    out.push({ name: path.basename(p), data: Buffer.concat(chunks, size) })
  }
  return out
}

export function postSlackFromAgent(
  workspaceId: string,
  text: string,
  threadTs?: string,
  options?: { buttons: SlackButton[]; multiple: boolean } | { files: string[] },
): Promise<{ ts: string; files?: number }> {
  return track(
    (async () => {
      const { channelId, a, bot } = linkedChannel(workspaceId)
      if (threadTs !== undefined && !isTrackedThread(channelId, threadTs)) throw new Error('Unknown Slack thread')
      // Read before posting: a refused file leaves nothing posted.
      const files = options && 'files' in options ? await readWorktreeFiles(workspaceId, options.files) : undefined
      // The link may have changed during the read: post nothing to a channel the workspace no longer holds.
      // Still the same channel and the same client (a restart during the read swaps it).
      const unchanged = () => {
        try {
          const now = linkedChannel(workspaceId)
          return now.channelId === channelId && now.a === a
        } catch {
          return false
        }
      }
      if (files) {
        if (!unchanged()) throw new Error('Slack is not available for this workspace')
        if (threadTs !== undefined && !isTrackedThread(channelId, threadTs)) throw new Error('Unknown Slack thread')
      }
      const clean = neutralise(text)
      const buttons =
        options && 'buttons' in options ? options.buttons.map((b) => ({ ...b, label: neutralise(b.label) })) : undefined
      const ts = buttons
        ? await a.postMessage(channelId, clean, threadTs, buttons)
        : await a.postMessage(channelId, clean, threadTs)
      // The agent must not post the text again when only what follows failed.
      const posted = `; the text is posted (ts ${ts}), do not post it again`
      try {
        insertSlackMessage({
          channelId,
          ts,
          threadTs: threadTs ?? ts,
          workspaceId,
          userId: bot.botUserId,
          userName: bot.botName,
          text: clean,
          direction: 'out',
          state: 'sent',
          files: [],
          ...(buttons && options && 'multiple' in options
            ? { buttons: buttons.map((b) => b.label), multiple: options.multiple === true }
            : {}),
        })
      } catch (err) {
        console.warn(`[slack] record failed: ${errorCode(err)}`)
        throw new SlackFileError(`Slack message was posted but could not be recorded${posted}`)
      }
      if (!files) return { ts }
      // The text stays posted whatever happens next; nothing is retried.
      let sent = 0
      const failed = () =>
        new SlackFileError(`Slack file upload failed after ${sent} of ${files.length} files${posted}`)
      for (const file of files) {
        // An unlink, re-link or restart since the text was posted: the files must not go to that channel.
        if (!unchanged()) throw failed()
        try {
          // A stop abandons the file in flight at once: Slack never holds up stop, restart or shutdown.
          await untilStopped(a.uploadFile(channelId, threadTs ?? ts, file.name, file.data))
        } catch (err) {
          console.warn(`[slack] file upload failed: ${errorCode(err)}`)
          if (err instanceof SlackApiError && err.code === 'missing_scope')
            throw new SlackFileError(`The Slack app lacks the files:write permission${posted}`)
          throw failed()
        }
        sent++
      }
      return { ts, files: sent }
    })(),
  )
}

/**
 * Closes the buttons of a message this workspace posted; false when a click or an earlier close won.
 * The outcome reflects Slack: when the update fails the close is undone and the call fails, so it can be retried.
 */
export function closeSlackButtons(workspaceId: string, messageTs: string, note?: string): Promise<{ closed: boolean }> {
  return track(
    (async () => {
      const { channelId, a } = linkedChannel(workspaceId)
      const message = getSlackButtonMessage(channelId, messageTs)
      if (message?.workspaceId !== workspaceId) throw new Error('Unknown Slack message')
      // Synchronous from the look-up to here: the compare-and-set decides the single winner.
      const at = new Date().toISOString()
      const rejected = closeSlackButtonMessage(channelId, messageTs, workspaceId, at)
      if (!rejected) return { closed: false }
      try {
        await a.replaceButtons(
          channelId,
          messageTs,
          message.text,
          note === undefined ? 'Answered in the thread.' : neutralise(note),
        )
      } catch (err) {
        console.warn(`[slack] update failed: ${errorCode(err)}`)
        reopenSlackButtonMessage(channelId, messageTs, workspaceId, at, rejected)
        // The requeued clicks are delivered as if the close never happened.
        if (rejected.length) void drainSlackQueue(workspaceId)
        throw new Error('Slack request failed')
      }
      // The clicks the close rejected left the queue.
      for (const ts of rejected) settled({ channelId, ts }, 'rejected')
      return { closed: true }
    })(),
  )
}

export function readSlackThread(
  workspaceId: string,
  threadTs: string,
  opts: { limit: number; before?: string },
): SlackMessageRow[] {
  // Local history: readable while Slack is disabled or disconnected.
  const channelId = getWorkspace(workspaceId)?.slackChannelId
  if (!channelId) throw new Error('Slack is not available for this workspace')
  if (!isTrackedThread(channelId, threadTs)) throw new Error('Unknown Slack thread')
  // Stored file URLs are bot-token download targets; never hand them to tool results.
  return listSlackThread(channelId, threadTs, opts).map((r) => ({
    ...r,
    files: r.files.map((f) => ({ ...f, url: '' })),
  }))
}

// ── Mirrored blocking questions ──────────────────────────────────────────────

/** @internal test-only: resolves once no tracked Slack work is in flight. */
export async function _waitForSlackIdle(): Promise<void> {
  while (active.size) await Promise.allSettled([...active])
}

/** Replaces the controls (and hint) of the question message currently shown by `row`. */
async function replaceControls(row: SlackQuestionRow, line: string): Promise<void> {
  const ts = row.messageTs
  if (row.kind !== 'question' || !ts) return
  await bestEffort('update', (a) => a.replaceButtons(row.channelId, ts, row.messageText, line))
}

/** The question message joins the stored thread, so replies in it are seen like any tracked thread. */
function recordBotMessage(channelId: string, ts: string, threadTs: string, workspaceId: string, text: string): void {
  insertSlackMessage({
    channelId,
    ts,
    threadTs,
    workspaceId,
    userId: identity?.botUserId ?? null,
    userName: identity?.botName ?? null,
    text,
    direction: 'out',
    state: 'sent',
    files: [],
  })
}

/**
 * A reviewer Kōbō tracks: a parallel review, the reviewer of a pending review return (every auto-loop
 * final review is launched with one), or a live launch with the review-only marker.
 */
function isReviewer(workspaceId: string, sessionId: string): boolean {
  if (isParallelReviewSession(workspaceId, sessionId) || hasReviewOnlyCapability(workspaceId, sessionId)) return true
  try {
    return getReviewReturn(workspaceId, sessionId) !== null
  } catch {
    return true // an unreadable return keeps its reviewer restricted, as in the orchestrator
  }
}

/** Head of the primary session's queue only: reviewers' inputs are never mirrored. */
function primaryHead(workspaceId: string): PendingItem | undefined {
  const head = getPendingInputs(workspaceId)[0]
  return head && !isReviewer(workspaceId, head.agentSessionId) ? head : undefined
}

function scheduleQuestionMirror(workspaceId: string): Promise<void> {
  const run = mirrorRuns.get(workspaceId)
  if (run) {
    run.again = true
    return Promise.resolve()
  }
  if (stopping || !api) return Promise.resolve()
  const entry = { again: true }
  mirrorRuns.set(workspaceId, entry)
  return track(
    (async () => {
      await Promise.resolve() // never run inside the orchestrator's notification
      try {
        while (entry.again && !stopping) {
          entry.again = false
          await syncQuestions(workspaceId)
        }
      } catch (err) {
        console.error(`[slack] question mirror failed: ${errorCode(err)}`)
      } finally {
        mirrorRuns.delete(workspaceId)
      }
    })(),
  )
}

/** Closes rows that are no longer the pending head, then mirrors the head when the setting allows it. */
async function syncQuestions(workspaceId: string): Promise<void> {
  const a = api
  if (stopping || !a || !connected || !getGlobalSettings().slackEnabled) return
  const ws = getWorkspace(workspaceId)
  const channelId =
    ws && !ws.archivedAt && !ws.worktreePurgedAt && ws.slackQuestionMirror !== 'never' ? ws.slackChannelId : null
  const head = channelId ? primaryHead(workspaceId) : undefined
  for (const row of listOpenSlackQuestions(workspaceId)) {
    const current =
      head && row.channelId === channelId && row.sessionId === head.agentSessionId && row.toolCallId === head.toolCallId
    if (!current && closeSlackQuestion(row, 'open', 'closed'))
      void track(replaceControls(row, QUESTION_TEXT.handledElsewhere))
  }
  if (!ws || !channelId || !head) return
  const key = { workspaceId, sessionId: head.agentSessionId, toolCallId: head.toolCallId }
  if (getSlackQuestion(key)) return
  const source = lastUserMessageSource(workspaceId, head.agentSessionId)
  const threadTs = source?.kind === 'slack' && source.channelId === channelId ? source.threadTs : undefined
  if (ws.slackQuestionMirror === 'slack-conversation' && !threadTs) return
  await mirrorHead(a, key, head, channelId, threadTs)
}

async function mirrorHead(
  a: SlackApi,
  key: { workspaceId: string; sessionId: string; toolCallId: string },
  head: PendingItem,
  channelId: string,
  threadTs: string | undefined,
): Promise<void> {
  let first: MirroredQuestion | undefined
  let text: string
  let kind: 'question' | 'permission' | 'secret'
  if (head.kind === 'permission') {
    // The tool input is never posted: it can carry paths, commands or secrets.
    kind = 'permission'
    text = neutralise(QUESTION_TEXT.permission(head.toolName))
  } else {
    const questions = readQuestions(head.input)
    if (!questions) return
    kind = questions === 'secret' ? 'secret' : 'question'
    first = questions === 'secret' ? undefined : questions[0]
    text = first ? neutralise(questionText(first)) : QUESTION_TEXT.secret
  }
  if (!reserveSlackQuestion(key, kind, channelId, threadTs ?? null)) return
  let ts: string
  try {
    ts = first
      ? await a.postQuestion(channelId, text, threadTs, questionControls(first, 0))
      : await a.postMessage(channelId, text, threadTs)
  } catch (err) {
    // Nothing is shown: the next pass may post it again.
    dropSlackQuestionReservation(key)
    console.warn(`[slack] question mirror post failed: ${errorCode(err)}`)
    return
  }
  const thread = threadTs ?? ts
  if (publishSlackQuestion(key, thread, ts, text, first ? 'open' : 'notified'))
    recordBotMessage(channelId, ts, thread, key.workspaceId, text)
}

/** The pending question a row still shows, or undefined when it is no longer answerable from Slack. */
function currentQuestion(row: SlackQuestionRow): { questions: MirroredQuestion[]; q: MirroredQuestion } | undefined {
  const ws = getWorkspace(row.workspaceId)
  if (!ws || ws.archivedAt || ws.worktreePurgedAt || ws.slackChannelId !== row.channelId) return undefined
  const head = primaryHead(row.workspaceId)
  if (head?.kind !== 'question' || head.toolCallId !== row.toolCallId || head.agentSessionId !== row.sessionId)
    return undefined
  const questions = readQuestions(head.input)
  const q = Array.isArray(questions) ? questions[row.questionIndex] : undefined
  return q && Array.isArray(questions) ? { questions, q } : undefined
}

/** A click on question controls. Never goes through the chat queue. Never rejects. */
export function handleSlackQuestionAction(action: SlackQuestionAction): Promise<void> {
  const a = api
  if (stopping || !a || !identity) return Promise.resolve()
  return track(
    processQuestionAction(action, a).catch((err) =>
      console.error(`[slack] question click handling failed: ${errorCode(err)}`),
    ),
  )
}

async function processQuestionAction(action: SlackQuestionAction, a: SlackApi): Promise<void> {
  const settings = getGlobalSettings()
  // Silent for everyone else: nothing stored, nothing posted, controls untouched.
  if (!settings.slackEnabled) return
  if (!settings.slackAllowedUserIds.includes(action.user)) return saw('ignored', 'not-allowed')
  // Resolved first: no await may sit between the head check and the compare-and-set.
  const by = await safeUserName(a, action.user)
  const row = getSlackQuestionByMessage(action.channel, action.messageTs)
  if (row?.state !== 'open' || row.questionIndex !== action.question) return
  const current = currentQuestion(row)
  if (!current) return
  const { questions, q } = current
  if (q.options.length > MAX_QUESTION_CONTROLS) return
  // Labels come from the pending input, never from the payload.
  const values = action.choices.map((i) => q.options[i]?.label)
  if (!values.length || values.some((v) => v === undefined) || (!q.multiple && values.length !== 1)) return
  const answer: CollectedAnswer = { values: values as string[], text: false, by }
  if (!claimSlackQuestionAnswer(row, answer, row.questionIndex === questions.length - 1)) return
  saw('delivered')
  await answered(row, questions, answer, action.user)
}

const LOST_ANSWER = Symbol('lost answer')

/**
 * A reply in the thread of an open question that accepts free text is its answer. The message row
 * insert and the answer compare-and-set run in one transaction, so (channel, ts) stays the single
 * dedupe point: a redelivered reply can neither answer twice nor also be queued as a chat message.
 */
async function takeTextAnswer(
  event: InboundEvent,
  decision: { threadTs: string; text: string },
  workspaceId: string,
  userName: string,
): Promise<boolean> {
  const row = getOpenSlackQuestionInThread(workspaceId, event.channel, decision.threadTs)
  const current = row && currentQuestion(row)
  if (!row || !current?.q.freeText) return false
  const answer: CollectedAnswer = { values: [decision.text], text: true, by: userName, ts: event.ts }
  const last = row.questionIndex === current.questions.length - 1
  let outcome: 'won' | 'duplicate' | 'lost'
  try {
    outcome = getDb().transaction(() => {
      const stored = store({
        channelId: event.channel,
        ts: event.ts,
        threadTs: decision.threadTs,
        workspaceId,
        userId: event.user ?? null,
        userName,
        text: decision.text,
        direction: 'in',
        state: 'delivered',
        files: [],
      })
      if (!stored) return 'duplicate' as const
      if (!claimSlackQuestionAnswer(row, answer, last)) throw LOST_ANSWER // rolls the message row back
      return 'won' as const
    })()
  } catch (err) {
    if (err !== LOST_ANSWER) throw err
    outcome = 'lost'
  }
  if (outcome === 'lost') return false
  if (outcome === 'won') {
    await react(event.channel, event.ts, 'eyes')
    await answered(row, current.questions, answer, event.user as string)
  }
  return true
}

/** Takes the `eyes` reaction back from text answers that never reached the agent. Best effort. */
async function unreactTextAnswers(channelId: string, collected: CollectedAnswer[]): Promise<void> {
  for (const c of collected) if (c.text && c.ts) await unreact(channelId, c.ts, 'eyes')
}

/** After a won compare-and-set: show the answer, then ask the next question or submit them all once. */
async function answered(
  row: SlackQuestionRow,
  questions: MirroredQuestion[],
  answer: CollectedAnswer,
  userId: string,
): Promise<void> {
  const line = answer.text
    ? `Answered in the thread - ${answer.by}`
    : `Answered: ${answer.values.join(', ')} - ${answer.by}`
  const shown = track(replaceControls(row, line))
  const threadTs = row.threadTs ?? row.messageTs ?? ''
  const collected = [...row.answers, answer]
  const next = row.questionIndex + 1
  if (next < questions.length) {
    const q = questions[next] as MirroredQuestion
    const text = neutralise(questionText(q))
    try {
      const a = api
      if (!a) throw new Error('Slack is not available')
      const ts = await a.postQuestion(row.channelId, text, threadTs, questionControls(q, next))
      if (showNextSlackQuestion(row, next, ts, text))
        recordBotMessage(row.channelId, ts, threadTs, row.workspaceId, text)
      // The row was closed while posting (no longer pending): no row points to these controls.
      else
        void track(
          bestEffort('update', (b) => b.replaceButtons(row.channelId, ts, text, QUESTION_TEXT.handledElsewhere)),
        )
    } catch (err) {
      console.warn(`[slack] next question post failed: ${errorCode(err)}`)
      if (closeSlackQuestion(row, 'open', 'closed')) {
        await notice(row.channelId, threadTs, QUESTION_TEXT.failed)
        await unreactTextAnswers(row.channelId, collected)
      }
    }
    return
  }
  const { answers, selections } = buildAnswers(questions, collected)
  const source: MessageSource = { kind: 'slack', userName: answer.by, userId, channelId: row.channelId, threadTs }
  try {
    // Submitted once by the single winner of the last compare-and-set; never retried.
    await answerPendingQuestion(row.workspaceId, answers, row.toolCallId, {
      sessionId: row.sessionId,
      selections,
      source,
    })
    closeSlackQuestion(row, 'submitting', 'answered')
  } catch (err) {
    closeSlackQuestion(row, 'submitting', 'closed')
    const outcome = answerFailure(err)
    // The stored reply rows stay (dedupe keys); only the reaction stops claiming a hand-over.
    await unreactTextAnswers(row.channelId, collected)
    // After the "Answered" update, so that line cannot overwrite this one.
    if (outcome === 'gone') void track(shown.then(() => replaceControls(row, QUESTION_TEXT.handledElsewhere)))
    else if (outcome === 'invalid') await notice(row.channelId, threadTs, QUESTION_TEXT.notAccepted)
    else if (outcome === 'failed') {
      console.error(`[slack] question answer could not be submitted: ${err instanceof Error ? err.name : 'unknown'}`)
      await notice(row.channelId, threadTs, QUESTION_TEXT.failed)
    }
  }
}
