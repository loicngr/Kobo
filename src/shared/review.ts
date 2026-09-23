/** Configuration shared by the review form and its backend launcher. */
export interface ReviewConfiguration {
  engine: string
  model: string
  reasoningEffort: string
  agentPermissionMode: 'plan' | 'bypass' | 'strict' | 'interactive'
}

export interface StartReviewRequest extends Partial<ReviewConfiguration> {
  additionalInstructions?: string
  newSession?: boolean
  returnToSession?: boolean
}

export function reviewConfigurationChanged(a: ReviewConfiguration, b: ReviewConfiguration): boolean {
  return (
    a.engine !== b.engine ||
    a.model !== b.model ||
    a.reasoningEffort !== b.reasoningEffort ||
    a.agentPermissionMode !== b.agentPermissionMode
  )
}
