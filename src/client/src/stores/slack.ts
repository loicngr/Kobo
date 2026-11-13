import { defineStore } from 'pinia'
import { apiFetch } from 'src/utils/api'
import type { SlackQuestionMirror } from '../../../shared/slack-question-mirror'

export type SlackErrorCode =
  | 'invalid_auth'
  | 'missing_scope'
  | 'not_in_channel'
  | 'rate_limited'
  | 'network'
  | 'unknown'

export interface SlackStatus {
  configured: boolean
  enabled: boolean
  connected: boolean
  botName?: string
  teamName?: string
  error?: SlackErrorCode
}

export interface SlackChannel {
  id: string
  name: string
  workspaceId: string | null
}

export const useSlackStore = defineStore('slack', {
  state: () => ({ status: null as SlackStatus | null }),
  actions: {
    async fetchStatus() {
      this.status = await apiFetch<SlackStatus>('/api/slack/status')
    },
    /** `null` removes the stored credentials. */
    async saveCredentials(value: { botToken: string; appToken: string } | null) {
      this.status = await apiFetch<SlackStatus>('/api/slack/credentials', { method: 'PUT', body: value ?? 'null' })
    },
    async fetchChannels(): Promise<SlackChannel[]> {
      return (await apiFetch<{ channels: SlackChannel[] }>('/api/slack/channels')).channels
    },
    async linkChannel(workspaceId: string, channelId: string | null): Promise<string | null> {
      const res = await apiFetch<{ slackChannelId: string | null }>(
        `/api/slack/workspaces/${encodeURIComponent(workspaceId)}/channel`,
        { method: 'PUT', body: { channelId } },
      )
      return res.slackChannelId
    },
    async setQuestionMirror(workspaceId: string, mode: SlackQuestionMirror): Promise<SlackQuestionMirror> {
      const res = await apiFetch<{ slackQuestionMirror: SlackQuestionMirror }>(
        `/api/slack/workspaces/${encodeURIComponent(workspaceId)}/question-mirror`,
        { method: 'PUT', body: { mode } },
      )
      return res.slackQuestionMirror
    },
  },
})
