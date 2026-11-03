export const MAX_TAG_LENGTH = 50
export const MAX_WORKSPACE_TAGS = 50

/** Incremental edits must reject invalid input instead of silently losing tags. */
export function validateWorkspaceTagList(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_WORKSPACE_TAGS)
    throw new TypeError(`tags must contain 1–${MAX_WORKSPACE_TAGS} strings`)
  if (value.some((tag) => typeof tag !== 'string' || !tag.trim() || tag.trim().length > MAX_TAG_LENGTH))
    throw new TypeError(`Each tag must contain 1–${MAX_TAG_LENGTH} characters after trimming`)
  return [...new Set(value.map((tag: string) => tag.trim()))]
}
