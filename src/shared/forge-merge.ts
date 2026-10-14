/** Explicit PR merge strategies. Availability is declared by each forge provider. */
export const MERGE_METHODS = ['merge', 'squash', 'rebase'] as const
export type MergeMethod = (typeof MERGE_METHODS)[number]

export function isMergeMethod(value: unknown): value is MergeMethod {
  return typeof value === 'string' && MERGE_METHODS.some((method) => method === value)
}
