import { SocketModeClient } from '@slack/socket-mode'
import { type Logger, WebClient } from '@slack/web-api'
import type { SlackButton } from '../../../shared/slack-tools.js'
import type { SlackCredentials } from './slack-credentials.js'
import type { InboundEvent } from './slack-inbound.js'
import type { SlackFileRef } from './slack-message-store.js'
import type { QuestionControls } from './slack-questions.js'

export type SlackErrorCode =
  | 'invalid_auth'
  | 'missing_scope'
  | 'not_in_channel'
  | 'rate_limited'
  | 'network'
  | 'unknown'

/** Carries only a stable code: raw Slack messages can embed tokens and payloads. */
export class SlackApiError extends Error {
  constructor(readonly code: SlackErrorCode) {
    super(`Slack API error: ${code}`)
    this.name = 'SlackApiError'
  }
}

export interface SlackIdentity {
  botUserId: string
  botName: string
  teamName: string
}

/** A button click (`block_actions`). `index` is the button position Kōbō posted, never its label. */
export interface SlackClick {
  channel: string
  messageTs: string
  user: string
  actionTs: string
  index: number
}

/**
 * A click on a mirrored question's controls (`kobo_question_*`). `choices` are option positions:
 * the clicked button, or the boxes checked when Submit was clicked (possibly none).
 */
export interface SlackQuestionAction {
  channel: string
  messageTs: string
  user: string
  actionTs: string
  question: number
  choices: number[]
}

export interface SlackApi {
  connect(
    onEvent: (event: InboundEvent) => void,
    onConnection: (connected: boolean) => void,
    onClick?: (click: SlackClick) => void,
    onQuestion?: (action: SlackQuestionAction) => void,
  ): Promise<SlackIdentity>
  disconnect(): Promise<void>
  postMessage(channelId: string, text: string, threadTs?: string, buttons?: SlackButton[]): Promise<string>
  /** Posts a mirrored question with its controls and hint line. */
  postQuestion(
    channelId: string,
    text: string,
    threadTs: string | undefined,
    controls: QuestionControls,
  ): Promise<string>
  /** Replaces the buttons and the reply hint of a posted message with one context line. */
  replaceButtons(channelId: string, ts: string, text: string, line: string): Promise<void>
  addReaction(channelId: string, ts: string, name: string): Promise<void>
  removeReaction(channelId: string, ts: string, name: string): Promise<void>
  listChannels(): Promise<{ id: string; name: string }[]>
  threadReplies(channelId: string, threadTs: string, limit: number): Promise<InboundEvent[]>
  userName(userId: string): Promise<string>
  downloadFile(file: SlackFileRef): Promise<Buffer>
}

const AUTH_ERRORS = new Set(['invalid_auth', 'not_authed', 'account_inactive', 'token_revoked'])
const CHANNEL_ERRORS = new Set(['not_in_channel', 'channel_not_found'])
const MAX_REDIRECTS = 3
const START_TIMEOUT_MS = 20_000

// The Slack clients log through console by default and may echo request details.
const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  setLevel: () => undefined,
  getLevel: () => 'error' as ReturnType<Logger['getLevel']>,
  setName: () => undefined,
}

function slackCode(err: unknown): string | undefined {
  const data = (err as { data?: { error?: unknown } } | null)?.data
  return typeof data?.error === 'string' ? data.error : undefined
}

function toApiError(err: unknown): SlackApiError {
  if (err instanceof SlackApiError) return err
  const code = (err as { code?: unknown } | null)?.code
  const slack = slackCode(err)
  if (slack) {
    if (AUTH_ERRORS.has(slack)) return new SlackApiError('invalid_auth')
    if (slack === 'missing_scope') return new SlackApiError('missing_scope')
    if (CHANNEL_ERRORS.has(slack)) return new SlackApiError('not_in_channel')
    if (slack === 'ratelimited') return new SlackApiError('rate_limited')
    return new SlackApiError('unknown')
  }
  if (code === 'slack_webapi_rate_limited_error') return new SlackApiError('rate_limited')
  if (code === 'slack_webapi_request_error' || code === 'slack_webapi_http_error') return new SlackApiError('network')
  return new SlackApiError('unknown')
}

async function call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    throw toApiError(err)
  }
}

interface RawFile {
  id?: string
  name?: string
  mimetype?: string
  size?: number
  url_private_download?: string
  url_private?: string
}

interface RawMessage {
  type?: string
  channel?: string
  ts?: string
  thread_ts?: string
  user?: string
  bot_id?: string
  subtype?: string
  text?: string
  files?: RawFile[]
}

function mapFiles(files: RawFile[] | undefined): SlackFileRef[] | undefined {
  if (!files) return undefined
  const out: SlackFileRef[] = []
  for (const f of files) {
    const url = f.url_private_download ?? f.url_private
    if (!url) continue
    out.push({ id: f.id ?? '', name: f.name ?? '', mimetype: f.mimetype ?? '', size: f.size ?? 0, url })
  }
  return out
}

function toInbound(type: InboundEvent['type'], channel: string, m: RawMessage): InboundEvent {
  return {
    type,
    channel,
    ts: m.ts ?? '',
    thread_ts: m.thread_ts,
    user: m.user,
    bot_id: m.bot_id,
    subtype: m.subtype,
    text: m.text,
    files: mapFiles(m.files),
  }
}

const SECTION_LIMIT = 3000
const REPLY_HINT = 'You can also reply in this thread.'

/** Where to cut a chunk longer than the limit: never inside a surrogate pair or a <...> entity. */
function hardCut(rest: string): number {
  let cut = SECTION_LIMIT
  const last = rest.charCodeAt(cut - 1)
  if (last >= 0xd800 && last <= 0xdbff) cut--
  const open = rest.lastIndexOf('<', cut - 1)
  // An entity alone longer than the limit (open === 0) is cut as before.
  if (open > 0 && open > rest.lastIndexOf('>', cut - 1) && rest.indexOf('>', cut) !== -1) cut = open
  return cut
}

/** mrkdwn sections of at most 3000 characters, cut on a line boundary when one is available. */
function textSections(text: string) {
  const out: { type: 'section'; text: { type: 'mrkdwn'; text: string } }[] = []
  // Slack rejects a whitespace-only section (invalid_blocks), which would fail the whole post.
  const push = (chunk: string) => {
    if (chunk.trim()) out.push({ type: 'section', text: { type: 'mrkdwn', text: chunk } })
  }
  let rest = text
  while (rest.length > SECTION_LIMIT) {
    const nl = rest.lastIndexOf('\n', SECTION_LIMIT)
    const cut = nl > 0 ? nl : hardCut(rest)
    push(rest.slice(0, cut))
    rest = rest.slice(nl > 0 ? cut + 1 : cut)
  }
  push(rest)
  return out
}

const contextLine = (text: string) => ({ type: 'context', elements: [{ type: 'plain_text', text }] })

function buttonBlocks(text: string, buttons: SlackButton[]) {
  return [
    ...textSections(text),
    {
      type: 'actions',
      block_id: 'kobo_buttons',
      // The value is the position: the label is looked up in what Kōbō stored, never trusted from the payload.
      elements: buttons.map((b, i) => ({
        type: 'button',
        action_id: `kobo_button_${i}`,
        value: String(i),
        text: { type: 'plain_text', text: b.label },
        ...(b.style ? { style: b.style } : {}),
      })),
    },
    contextLine(REPLY_HINT),
  ]
}

function questionBlocks(text: string, c: QuestionControls) {
  const id = `kobo_question_${c.question}`
  const label = (text: string) => ({ type: 'plain_text', text })
  const elements =
    c.kind === 'buttons'
      ? c.labels.map((l, i) => ({ type: 'button', action_id: `${id}_${i}`, value: String(i), text: label(l) }))
      : c.kind === 'checkboxes'
        ? [
            {
              type: 'checkboxes',
              action_id: `${id}_checks`,
              options: c.labels.map((l, i) => ({ text: label(l), value: String(i) })),
            },
            { type: 'button', action_id: `${id}_submit`, value: 'submit', style: 'primary', text: label('Submit') },
          ]
        : []
  return [
    ...textSections(text),
    ...(elements.length ? [{ type: 'actions', block_id: id, elements }] : []),
    ...(c.hint ? [contextLine(c.hint)] : []),
  ]
}

interface RawInteractive {
  type?: string
  user?: { id?: string }
  channel?: { id?: string }
  message?: { ts?: string }
  actions?: { action_id?: string; value?: string; action_ts?: string }[]
  state?: { values?: Record<string, Record<string, { selected_options?: { value?: unknown }[] }>> }
}

const QUESTION_ACTION = /^kobo_question_(\d{1,2})_(\d|submit)$/

/** A checkbox toggle, a foreign or malformed action is null: acknowledged and ignored. */
function toQuestionAction(body: RawInteractive): SlackQuestionAction | null {
  const action = body.actions?.[0]
  const match = QUESTION_ACTION.exec(action?.action_id ?? '')
  const user = body.user?.id
  const channel = body.channel?.id
  const messageTs = body.message?.ts
  if (!match || !user || !channel || !messageTs || !SLACK_TS.test(action?.action_ts ?? '')) return null
  const question = Number(match[1])
  let choices: number[]
  if (match[2] === 'submit') {
    // The checked boxes are only in the message state carried by the Submit click.
    const checked = body.state?.values?.[`kobo_question_${question}`]?.[`kobo_question_${question}_checks`]
    const values = (checked?.selected_options ?? []).map((o) => o?.value)
    choices = [...new Set(values.filter((v): v is string => typeof v === 'string' && /^\d$/.test(v)).map(Number))]
    choices.sort((a, b) => a - b)
  } else {
    if (action?.value !== match[2]) return null
    choices = [Number(match[2])]
  }
  return { channel, messageTs, user, actionTs: action?.action_ts as string, question, choices }
}

const SLACK_TS = /^\d+\.\d+$/

function toClick(body: RawInteractive | undefined): SlackClick | null {
  if (body?.type !== 'block_actions') return null
  const action = body.actions?.[0]
  if (action?.action_id?.startsWith('kobo_question_')) return null
  const user = body.user?.id
  const channel = body.channel?.id
  const messageTs = body.message?.ts
  const value = action?.value ?? ''
  if (!user || !channel || !messageTs || !/^\d$/.test(value) || !SLACK_TS.test(action?.action_ts ?? '')) return null
  return { channel, messageTs, user, actionTs: action?.action_ts as string, index: Number(value) }
}

function isAllowedFileUrl(raw: string): URL | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'https:') return null
  const host = url.hostname.toLowerCase()
  return host === 'files.slack.com' || host.endsWith('.slack.com') ? url : null
}

export function createSlackApi(credentials: SlackCredentials): SlackApi {
  const web = new WebClient(credentials.botToken, {
    logger: silentLogger,
    // Defaults retry for ~30 min with no timeout: Slack must never block Kōbō when unreachable.
    timeout: 15_000,
    retryConfig: { retries: 2 },
    rejectRateLimitedCalls: true,
  })
  let socket: SocketModeClient | null = null
  const names = new Map<string, string>()

  return {
    async connect(onEvent, onConnection, onClick, onQuestion) {
      const auth = await call(() => web.auth.test())
      const previous = socket
      socket = null
      if (previous) await previous.disconnect().catch(() => undefined)
      const client = new SocketModeClient({
        appToken: credentials.appToken,
        logger: silentLogger,
        // The library's own reconnect rethrows from an async close listener (an unhandled rejection
        // that shuts Kōbō down once the token is revoked). A close now only emits `disconnected`,
        // and the service tick reconnects through a fresh connect().
        autoReconnectEnabled: false,
        // Its internal client otherwise retries apps.connections.open 100 times with no timeout.
        clientOptions: { timeout: 15_000, retryConfig: { retries: 2 } },
      })
      socket = client
      const listeners: [string, Parameters<SocketModeClient['on']>[1]][] = [
        ['connected', () => onConnection(true)],
        ['disconnected', () => onConnection(false)],
        ['error', () => onConnection(false)],
        // Catch-all listener: every envelope must be acked or Slack redelivers it.
        [
          'slack_event',
          async (args: { ack: () => Promise<void>; type?: string; body?: { event?: RawMessage } & RawInteractive }) => {
            try {
              await args.ack()
            } catch {
              return
            }
            if (args.type === 'interactive') {
              const click = toClick(args.body)
              const question = args.body?.type === 'block_actions' ? toQuestionAction(args.body) : null
              try {
                if (click && onClick) await onClick(click)
                else if (question && onQuestion) await onQuestion(question)
              } catch {
                // handler errors are the caller's concern
              }
              return
            }
            const ev = args.body?.event
            if (args.type !== 'events_api' || !ev?.channel) return
            // `app_mention` carries no files; the `message` event of the same mention is the one kept.
            if (ev.type !== 'message') return
            try {
              // A failing handler must not become an unhandled rejection that crashes the process.
              await onEvent(toInbound(ev.type, ev.channel, ev))
            } catch {
              // handler errors are the caller's concern
            }
          },
        ],
      ]
      for (const [event, fn] of listeners) client.on(event, fn)
      const started = client.start()
      started.catch(() => undefined) // an abandoned start may still settle after the deadline
      let deadline: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          started,
          new Promise<never>((_, reject) => {
            deadline = setTimeout(() => reject(new SlackApiError('network')), START_TIMEOUT_MS)
          }),
        ])
      } catch (err) {
        // Only ours: disconnect() resolves through the library's own close listener.
        for (const [event, fn] of listeners) client.off(event, fn)
        if (socket === client) socket = null
        await client.disconnect().catch(() => undefined)
        throw toApiError(err)
      } finally {
        clearTimeout(deadline)
      }
      return { botUserId: auth.user_id ?? '', botName: auth.user ?? '', teamName: auth.team ?? '' }
    },

    async disconnect() {
      const client = socket
      socket = null
      if (client) await client.disconnect()
    },

    async postMessage(channelId, text, threadTs, buttons) {
      const res = await call(() =>
        web.chat.postMessage({
          channel: channelId,
          text, // the notification fallback when blocks are present
          thread_ts: threadTs,
          ...(buttons?.length ? { blocks: buttonBlocks(text, buttons) } : {}),
        }),
      )
      return res.ts ?? ''
    },

    async postQuestion(channelId, text, threadTs, controls) {
      const res = await call(() =>
        web.chat.postMessage({ channel: channelId, text, thread_ts: threadTs, blocks: questionBlocks(text, controls) }),
      )
      return res.ts ?? ''
    },

    async replaceButtons(channelId, ts, text, line) {
      await call(() =>
        web.chat.update({ channel: channelId, ts, text, blocks: [...textSections(text), contextLine(line)] }),
      )
    },

    async addReaction(channelId, ts, name) {
      try {
        await web.reactions.add({ channel: channelId, timestamp: ts, name })
      } catch (err) {
        if (slackCode(err) !== 'already_reacted') throw toApiError(err)
      }
    },

    async removeReaction(channelId, ts, name) {
      try {
        await web.reactions.remove({ channel: channelId, timestamp: ts, name })
      } catch (err) {
        if (slackCode(err) !== 'no_reaction') throw toApiError(err)
      }
    },

    async listChannels() {
      const out: { id: string; name: string }[] = []
      let cursor: string | undefined
      do {
        const res = await call(() =>
          web.users.conversations({
            types: 'public_channel,private_channel',
            exclude_archived: true,
            limit: 200,
            cursor,
          }),
        )
        for (const c of res.channels ?? []) if (c.id) out.push({ id: c.id, name: c.name ?? c.id })
        cursor = res.response_metadata?.next_cursor || undefined
      } while (cursor)
      return out
    },

    async threadReplies(channelId, threadTs, limit) {
      const res = await call(() => web.conversations.replies({ channel: channelId, ts: threadTs, limit }))
      return (res.messages ?? []).slice(0, limit).map((m) => toInbound('message', channelId, m as RawMessage))
    },

    async userName(userId) {
      const cached = names.get(userId)
      if (cached) return cached
      let name = userId
      try {
        const res = await web.users.info({ user: userId })
        name = res.user?.profile?.display_name || res.user?.real_name || res.user?.name || userId
      } catch {
        // Name lookup is cosmetic: fall back to the id without caching.
        return userId
      }
      names.set(userId, name)
      return name
    },

    async downloadFile(file) {
      let current = isAllowedFileUrl(file.url)
      if (!current) throw new SlackApiError('network')
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        let res: Response
        try {
          res = await fetch(current, {
            headers: { Authorization: `Bearer ${credentials.botToken}` },
            redirect: 'manual',
            signal: AbortSignal.timeout(60_000),
          })
        } catch {
          throw new SlackApiError('network')
        }
        if (res.status >= 300 && res.status < 400) {
          // Re-validate every hop so the bearer token never reaches a foreign host.
          const location = res.headers.get('location')
          let next: URL | null = null
          try {
            next = location ? isAllowedFileUrl(new URL(location, current).href) : null
          } catch {
            next = null
          }
          if (!next) throw new SlackApiError('network')
          current = next
          continue
        }
        if (!res.ok) throw new SlackApiError('network')
        // An expired token often yields a 200 HTML login page instead of the file.
        if ((res.headers.get('content-type') ?? '').startsWith('text/html') && !file.mimetype.startsWith('text/html')) {
          throw new SlackApiError('invalid_auth')
        }
        try {
          return Buffer.from(await res.arrayBuffer())
        } catch {
          throw new SlackApiError('network')
        }
      }
      throw new SlackApiError('network')
    },
  }
}
