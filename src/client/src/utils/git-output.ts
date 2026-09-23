/**
 * Git failures come in two very different shapes.
 *
 * `fatal: not a git repository` is one short line — a toast is right for it.
 * A merge conflict or a rejected pre-push hook is twenty lines the user needs
 * to READ, COPY and act on; throwing that into a six-second toast that
 * dismisses itself, cannot be selected and is never translated is the current
 * behaviour at twenty-four call sites in GitPanel.vue.
 */

export const GIT_OUTPUT_INLINE_MAX_LINES = 2
export const GIT_OUTPUT_INLINE_MAX_CHARS = 200

export function needsScrollableOutput(message: string): boolean {
  const trimmed = message.trim()
  if (trimmed.length === 0) return false
  if (trimmed.length > GIT_OUTPUT_INLINE_MAX_CHARS) return true
  return trimmed.split('\n').length > GIT_OUTPUT_INLINE_MAX_LINES
}
