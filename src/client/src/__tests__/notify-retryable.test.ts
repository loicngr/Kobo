import { beforeEach, describe, expect, it, vi } from 'vitest'

const createMock = vi.fn()
vi.mock('quasar', () => ({ Notify: { create: (...args: unknown[]) => createMock(...args) } }))

import { notifyRetryableError } from '../utils/notifications'

describe('notifyRetryableError', () => {
  beforeEach(() => createMock.mockClear())

  it('attaches a retry action that calls back', () => {
    const onRetry = vi.fn()
    notifyRetryableError('Rebase failed', { retryLabel: 'Retry', onRetry, dismissLabel: 'Dismiss' })

    expect(createMock).toHaveBeenCalledOnce()
    const config = createMock.mock.calls[0][0] as {
      type: string
      message: string
      timeout: number
      actions: Array<{ label: string; handler: () => void }>
    }
    expect(config.type).toBe('negative')
    expect(config.message).toBe('Rebase failed')
    const retry = config.actions.find((a) => a.label === 'Retry')
    expect(retry).toBeDefined()
    retry?.handler()
    expect(onRetry).toHaveBeenCalledOnce()
  })

  it('stays on screen long enough to be acted on', () => {
    notifyRetryableError('Push failed', { retryLabel: 'Retry', onRetry: vi.fn(), dismissLabel: 'Dismiss' })
    const config = createMock.mock.calls[0][0] as { timeout: number }
    // A six-second toast the user must click is a trap, not an affordance.
    expect(config.timeout).toBe(0)
  })

  it('adds an optional details action when a handler is supplied', () => {
    const onDetails = vi.fn()
    notifyRetryableError('Merge failed', {
      retryLabel: 'Retry',
      onRetry: vi.fn(),
      detailsLabel: 'Details',
      onDetails,
      dismissLabel: 'Dismiss',
    })
    const config = createMock.mock.calls[0][0] as { actions: Array<{ label: string; handler: () => void }> }
    const details = config.actions.find((a) => a.label === 'Details')
    expect(details).toBeDefined()
    details?.handler()
    expect(onDetails).toHaveBeenCalledOnce()
  })

  it('omits the details action when no handler is supplied', () => {
    notifyRetryableError('Pull failed', {
      retryLabel: 'Retry',
      onRetry: vi.fn(),
      detailsLabel: 'Details',
      dismissLabel: 'Dismiss',
    })
    const config = createMock.mock.calls[0][0] as { actions: Array<{ label: string }> }
    expect(config.actions.map((a) => a.label)).toEqual(['Retry', 'Dismiss'])
  })

  it('uses the caller-supplied dismiss label, never a hardcoded English one', () => {
    // This module has no i18n context: an internal fallback would be a string
    // that no locale file can translate.
    notifyRetryableError('Fetch failed', { retryLabel: 'Réessayer', onRetry: vi.fn(), dismissLabel: 'Ignorer' })
    const config = createMock.mock.calls[0][0] as { actions: Array<{ label: string }> }
    expect(config.actions.map((a) => a.label)).toEqual(['Réessayer', 'Ignorer'])
  })
})
