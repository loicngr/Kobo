import type { SlackIgnoreReason } from '../../../shared/slack-inbound-outcome.js'
import type { SlackFileRef } from './slack-message-store.js'

export interface InboundEvent {
  type: 'message' | 'app_mention'
  channel: string
  ts: string
  thread_ts?: string
  user?: string
  bot_id?: string
  subtype?: string
  text?: string
  files?: SlackFileRef[]
}

export interface InboundContext {
  botUserId: string
  allowedUserIds: readonly string[]
  workspaceId: string | undefined
  isTrackedThread(channelId: string, threadTs: string): boolean
}

export type InboundDecision =
  // `reason` only for a message addressed to Kōbō (bot mention or tracked thread): shown in Settings.
  | { action: 'ignore'; reason?: SlackIgnoreReason }
  | { action: 'notify-unlinked'; threadTs: string }
  | { action: 'deliver'; threadTs: string; text: string; fetchContext: boolean }

const IGNORE: InboundDecision = { action: 'ignore' }
const ignore = (reason: SlackIgnoreReason): InboundDecision => ({ action: 'ignore', reason })

export function classifyInbound(event: InboundEvent, ctx: InboundContext): InboundDecision {
  if (!event.user || event.user === ctx.botUserId || event.bot_id) return IGNORE
  if (event.subtype && event.subtype !== 'file_share' && event.subtype !== 'thread_broadcast') return IGNORE

  const threadTs = event.thread_ts ?? event.ts
  const tag = new RegExp(`<@${ctx.botUserId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\|[^>]*)?>`, 'g')
  const raw = event.text ?? ''
  const mentioned = new RegExp(tag.source).test(raw)
  const tracked = ctx.isTrackedThread(event.channel, threadTs)
  if (!mentioned && !tracked) return IGNORE
  // Addressed to Kōbō from here on. Deciding it costs one local read and no Slack call.
  if (!ctx.allowedUserIds.includes(event.user)) return ignore('not-allowed')
  if (ctx.workspaceId === undefined)
    return mentioned ? { action: 'notify-unlinked', threadTs } : ignore('channel-not-linked')

  // Separators left right after a leading mention ('@Kobo : hi') are not part of the message.
  const text = raw
    .replace(new RegExp(`^\\s*${tag.source}[ :,;]*`), '')
    .replace(tag, '')
    .trim()
  if (!text && !event.files?.length) return ignore('unsupported-message')
  const fetchContext = mentioned && event.thread_ts !== undefined && event.thread_ts !== event.ts && !tracked
  return { action: 'deliver', threadTs, text, fetchContext }
}
