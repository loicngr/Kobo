/** Why an inbound Slack message or click addressed to Kōbō was ignored. Shared with the client. */
export type SlackIgnoreReason = 'not-allowed' | 'channel-not-linked' | 'unsupported-message'

/** The most recent addressed inbound Slack message or click seen by this process. No id, name, channel or text. */
export interface SlackInboundOutcome {
  at: string
  outcome: 'delivered' | 'queued' | 'rejected' | 'uncertain' | 'ignored'
  reason?: SlackIgnoreReason
}
