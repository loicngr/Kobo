import { describe, expect, it, vi } from 'vitest'
import { pushFailureMessageKey, pushFailureNotification } from '../utils/git-push-error'

describe('pushFailureMessageKey', () => {
  it('keeps the explanation visible and only opens force confirmation on explicit action', () => {
    const confirm = vi.fn()
    const details = vi.fn()
    const error = new Error('[rejected] (non-fast-forward)')
    const notification = pushFailureNotification(error, (key) => key, confirm, details)
    expect(notification).toMatchObject({ timeout: 0, closeBtn: 'common.close', type: 'warning' })
    expect(notification.message).toBe('git.pushRejectedHistory')
    expect(confirm).not.toHaveBeenCalled()
    expect(details).not.toHaveBeenCalled()
    notification.actions?.find((action) => action.label === 'git.forcePush')?.handler?.()
    expect(confirm).toHaveBeenCalledOnce()
    notification.actions?.find((action) => action.label === 'common.details')?.handler?.()
    expect(details).toHaveBeenCalledWith(error.message)
  })

  it.each(['[rejected] (stale info)', 'Permission denied (publickey).'])(
    'offers details but no force action for %s',
    (message) => {
      const notification = pushFailureNotification(new Error(message), (key) => key, vi.fn(), vi.fn())
      expect(notification.actions?.map((action) => action.label)).toEqual(['common.details'])
      expect(notification.timeout).toBe(0)
    },
  )
  it.each([
    'Updates were rejected because the tip of your current branch is behind its remote counterpart.',
    '! refs/heads/main:refs/heads/main [rejected] (non-fast-forward)',
    '! refs/heads/main:refs/heads/main [rejected] (fetch first)',
  ])('explains divergent history: %s', (message) => {
    expect(pushFailureMessageKey(new Error(message))).toBe('git.pushRejectedHistory')
  })

  it('does not suggest forcing again when the lease protects unseen remote changes', () => {
    expect(pushFailureMessageKey(new Error('[rejected] (stale info)'))).toBe('git.pushRejectedLease')
  })

  it.each([
    'Permission denied (publickey).',
    '[remote rejected] (protected branch hook declined)',
    "See the 'Note about fast-forwards' in 'git push --help' for details.",
  ])('does not misclassify unrelated failures: %s', (message) => {
    expect(pushFailureMessageKey(new Error(message))).toBeNull()
  })
})
