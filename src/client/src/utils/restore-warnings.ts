import type { QNotifyCreateOptions, QVueGlobals } from 'quasar'
import { copyToClipboard } from 'src/utils/clipboard'
import { ERROR_NOTIFICATION_DEFAULTS } from 'src/utils/notification-timeout'

type Notifier = { notify: (options: QNotifyCreateOptions) => unknown }

// The clicking tab gets a warning twice (HTTP answer and global event, in either order).
const DEDUPE_WINDOW_MS = 10_000
const MAX_REMEMBERED = 200
const shownAt = new Map<string, number>()

/** True (and remembered) when this exact warning was not shown for the workspace in the last 10 s. */
function firstShowing(workspaceId: string, warning: string): boolean {
  const now = Date.now()
  for (const [key, at] of shownAt) {
    if (now - at >= DEDUPE_WINDOW_MS) shownAt.delete(key)
  }
  const key = `${workspaceId}\u0000${warning}`
  if (shownAt.has(key)) return false
  shownAt.set(key, now)
  if (shownAt.size > MAX_REMEMBERED) shownAt.delete(shownAt.keys().next().value as string)
  return true
}

export function _resetRestoreWarningMemoryForTest(): void {
  shownAt.clear()
}

/**
 * One warning toast per server-written sentence of a worktree restore (the Restore
 * button's answer and the automatic detection event share this). Anything that is
 * not an array of strings is ignored. The toast stays until dismissed: it is the
 * only place the operator sees what went wrong, with a copy action for the path.
 */
export function showRestoreWarnings(
  $q: Notifier,
  t: (key: string, params?: Record<string, string>) => string,
  warnings: unknown,
  workspace: { workspaceId?: string; workspaceName?: string } = {},
): void {
  if (!Array.isArray(warnings)) return
  for (const warning of warnings) {
    if (typeof warning !== 'string') continue
    if (workspace.workspaceId && !firstShowing(workspace.workspaceId, warning)) continue
    // The toast can appear in a tab where that workspace is not open: say which one.
    const shown = workspace.workspaceName ? `${workspace.workspaceName}: ${warning}` : warning
    $q.notify({
      ...ERROR_NOTIFICATION_DEFAULTS,
      type: 'warning',
      message: t('workspacePage.worktreeRestoreWarning', { message: shown }),
      position: 'top',
      multiLine: true,
      classes: 'workspace-delete-warning',
      actions: [
        {
          icon: 'content_copy',
          color: 'white',
          round: true,
          noDismiss: true,
          handler: () => {
            void copyToClipboard($q as unknown as QVueGlobals, t, warning)
          },
        },
      ],
    })
  }
}
