/** The final reviewer always runs in a fresh read-only session. */
export interface AutoLoopReviewConfiguration {
  engine: string
  model: string
  reasoningEffort: string
  additionalInstructions: string
}

export interface AutoLoopFinalReviewStatus {
  configuration: AutoLoopReviewConfiguration | null
  state: 'disabled' | 'pending' | 'reviewing' | 'fixing' | 'completed' | 'blocked'
  cycle: number
  findingsCount: number | null
  reason: string | null
  reviewSessionId: string | null
  originalSessionId: string | null
}

export interface AutoLoopReviewFinding {
  severity: 'critical' | 'important' | 'minor'
  file: string
  line?: number
  description: string
  recommendation: string
}
export interface AutoLoopReviewVerdict {
  summary: string
  findings: AutoLoopReviewFinding[]
}
