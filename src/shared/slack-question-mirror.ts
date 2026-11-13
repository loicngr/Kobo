/** When Kōbō mirrors a workspace's blocking questions to its linked Slack channel. */
export const SLACK_QUESTION_MIRROR_MODES = ['never', 'slack-conversation', 'always'] as const
export type SlackQuestionMirror = (typeof SLACK_QUESTION_MIRROR_MODES)[number]
export const isSlackQuestionMirror = (value: unknown): value is SlackQuestionMirror =>
  (SLACK_QUESTION_MIRROR_MODES as readonly unknown[]).includes(value)
