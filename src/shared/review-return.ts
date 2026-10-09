/** Safe client status: never includes prompts, credentials or runtime capabilities. */
export interface ReviewReturnStatus {
  reviewSessionId: string
  originalSessionId: string
  phase: 'reviewing' | 'ready' | 'dispatching' | 'unknown' | 'blocked'
  error: string | null
}
