import type { QNotifyCreateOptions } from 'quasar'

/** Recognize Git's rejection reasons, not the generic fast-forward help footer. */
export function pushFailureMessageKey(error: unknown): 'git.pushRejectedHistory' | 'git.pushRejectedLease' | null {
  const message = error instanceof Error ? error.message : String(error)
  if (/\(stale info\)/i.test(message)) return 'git.pushRejectedLease'
  if (
    /\[rejected\][^\n]*(?:non-fast-forward|fetch first)/i.test(message) ||
    /updates were rejected because the tip of your current branch is behind/i.test(message) ||
    /updates were rejected because the remote contains work that you do not have locally/i.test(message)
  )
    return 'git.pushRejectedHistory'
  return null
}

export function pushFailureNotification(
  error: unknown,
  translate: (key: string) => string,
  confirmForcePush: () => void,
  showDetails: (message: string) => void,
): QNotifyCreateOptions {
  const key = pushFailureMessageKey(error)
  return {
    type: key ? 'warning' : 'negative',
    message: translate(key ?? 'git.pushFailed'),
    position: 'top',
    timeout: 0,
    closeBtn: translate('common.close'),
    multiLine: true,
    actions: [
      ...(key === 'git.pushRejectedHistory' ? [{ label: translate('git.forcePush'), handler: confirmForcePush }] : []),
      {
        label: translate('common.details'),
        handler: () => showDetails(error instanceof Error ? error.message : String(error)),
      },
    ],
  }
}
