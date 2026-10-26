import { expect, it, vi } from 'vitest'
import { cleanupLiveFixture } from './live/cleanup-live-fixture.js'

it('attempts every cleanup, restores the environment and retains files after an unconfirmed stop', async () => {
  const primary = new Error('Original smoke failure')
  const stopping = new Error('Native shutdown unconfirmed')
  const closing = new Error('Provider close failed')
  const first = vi.fn().mockRejectedValue(stopping)
  const second = vi.fn().mockResolvedValue(undefined)
  const provider = vi.fn().mockRejectedValue(closing)
  const database = vi.fn()
  const restore = vi.fn()
  const remove = vi.fn()
  const error = await cleanupLiveFixture(
    { stop: [first, second], close: [provider, database], restore, remove, directory: '/tmp/synthetic-native' },
    [primary],
  ).catch((error: unknown) => error)
  expect(second).toHaveBeenCalledOnce()
  expect(provider).toHaveBeenCalledOnce()
  expect(database).toHaveBeenCalledOnce()
  expect(restore).toHaveBeenCalledOnce()
  expect(remove).not.toHaveBeenCalled()
  expect(error).toBeInstanceOf(AggregateError)
  expect((error as AggregateError).errors).toEqual([primary, stopping, closing])
  expect((error as Error).message).toContain('retained at /tmp/synthetic-native')
})

it('removes the fixture only after confirmed stops and preserves an original smoke failure', async () => {
  const original = new Error('Assertion failed')
  const remove = vi.fn()
  const error = await cleanupLiveFixture(
    { stop: [async () => {}], close: [], restore: () => {}, remove, directory: '/tmp/synthetic-native' },
    [original],
  ).catch((error: unknown) => error)
  expect(remove).toHaveBeenCalledOnce()
  expect(error).toBeInstanceOf(AggregateError)
  expect((error as AggregateError).errors).toEqual([original])
})
