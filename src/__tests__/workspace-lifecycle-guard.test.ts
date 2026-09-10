import { describe, expect, it } from 'vitest'
import {
  deferUntilWorkspaceAvailable,
  isWorkspaceLifecycleBusy,
  withWorkspaceLifecycleGuard,
} from '../server/utils/workspace-lifecycle-guard.js'

describe('workspace lifecycle exclusion', () => {
  it('rejects overlapping operations on the same workspace, but allows another workspace', async () => {
    let release!: () => void
    const pending = withWorkspaceLifecycleGuard(
      'first',
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
    )
    expect(isWorkspaceLifecycleBusy('first')).toBe(true)
    await expect(withWorkspaceLifecycleGuard('first', async () => 'deleted')).rejects.toMatchObject({
      code: 'workspace-busy',
    })
    await expect(withWorkspaceLifecycleGuard('second', async () => 'restored')).resolves.toBe('restored')
    release()
    await pending
    expect(isWorkspaceLifecycleBusy('first')).toBe(false)
  })

  it('releases the guard after failure', async () => {
    await expect(
      withWorkspaceLifecycleGuard('failed', async () => {
        throw new Error('git failed')
      }),
    ).rejects.toThrow('git failed')
    await expect(withWorkspaceLifecycleGuard('failed', async () => 'retried')).resolves.toBe('retried')
  })
})

it('reconsiders a deferred operation after the guard releases, once per callback', async () => {
  let calls = 0
  const retry = () => {
    calls++
  }
  await withWorkspaceLifecycleGuard('busy', async () => {
    expect(deferUntilWorkspaceAvailable('busy', retry)).toBe(true)
    expect(deferUntilWorkspaceAvailable('busy', retry)).toBe(true)
    expect(calls).toBe(0)
  })
  await Promise.resolve()
  expect(calls).toBe(1)
  expect(deferUntilWorkspaceAvailable('busy', retry)).toBe(false)
})
