import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope } from 'vue'
import { useGroupMessages } from '../composables/use-group-messages'
import { apiFetch } from '../utils/api'

vi.mock('../utils/api', () => ({ apiFetch: vi.fn() }))
const scopes: ReturnType<typeof effectScope>[] = []
function setup() {
  const scope = effectScope()
  scopes.push(scope)
  return scope.run(() => useGroupMessages())!
}
const completed = (id: string) => ({
  id,
  createdAt: '2026-10-10T10:00:00Z',
  complete: true,
  recipients: [{ workspaceId: 'one', name: 'One', delivery: 'immediate', state: 'sent' }],
})
beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  vi.resetAllMocks()
})
afterEach(() => {
  for (const scope of scopes.splice(0)) scope.stop()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('group message submission', () => {
  it('freezes the selected recipients and suppresses double-click dispatch', async () => {
    let resolve!: (value: unknown) => void
    vi.mocked(apiFetch).mockReturnValueOnce(
      new Promise((r) => {
        resolve = r
      }),
    )
    const state = setup()
    const ids = ['one']
    const sending = state.send(ids, 'Hello')
    ids.push('two')
    await state.send(['two'], 'Different')
    expect(apiFetch).toHaveBeenCalledTimes(1)
    const input = vi.mocked(apiFetch).mock.calls[0]![1]!.body as { requestId: string; workspaceIds: string[] }
    expect(input.workspaceIds).toEqual(['one'])
    resolve(completed(input.requestId))
    await sending
    expect(state.batch.value?.complete).toBe(true)
  })

  it('retries an ambiguous request with the same ID and frozen payload', async () => {
    vi.mocked(apiFetch).mockRejectedValueOnce(new Error('Connection lost'))
    const state = setup()
    await state.send(['one'], 'Hello')
    const original = vi.mocked(apiFetch).mock.calls[0]![1]!.body as { requestId: string }
    expect(state.error.value).toBe('Connection lost')
    vi.mocked(apiFetch).mockResolvedValueOnce(completed(original.requestId))
    await state.retry()
    expect(vi.mocked(apiFetch).mock.calls[1]![1]!.body).toEqual(original)
    expect(state.batch.value?.complete).toBe(true)
  })

  it('restores a receipt after reload without automatically sending again', async () => {
    vi.mocked(apiFetch).mockRejectedValueOnce(new Error('Connection lost'))
    const first = setup()
    await first.send(['one'], 'Hello')
    const original = vi.mocked(apiFetch).mock.calls[0]![1]!.body as { requestId: string }
    vi.mocked(apiFetch).mockClear()
    vi.mocked(apiFetch).mockResolvedValueOnce(completed(original.requestId))
    const restored = setup()
    await restored.refresh()
    expect(apiFetch).toHaveBeenCalledExactlyOnceWith(`/api/workspace-messages/${original.requestId}`)
    expect(restored.batch.value?.complete).toBe(true)
  })

  it('polls progress until completion and stops when the scope closes', async () => {
    vi.useFakeTimers()
    vi.mocked(apiFetch)
      .mockImplementationOnce(async (_url, options) => {
        const input = options!.body as { requestId: string }
        return { ...completed(input.requestId), complete: false }
      })
      .mockResolvedValueOnce(completed('done'))
    const state = setup()
    await state.send(['one'], 'Hello')
    await vi.advanceTimersByTimeAsync(1_500)
    expect(apiFetch).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(apiFetch).toHaveBeenCalledTimes(2)
  })

  it('does not erase the pending request when a status read fails', async () => {
    vi.mocked(apiFetch).mockRejectedValue(new Error('Offline'))
    const state = setup()
    await state.send(['one'], 'Hello')
    await state.refresh()
    expect(state.request.value?.content).toBe('Hello')
    expect(state.error.value).toBe('Offline')
  })
})

it('sends from HTTP network origins where randomUUID is unavailable', async () => {
  vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) })
  vi.mocked(apiFetch).mockImplementationOnce(async (_url, options) =>
    completed((options!.body as { requestId: string }).requestId),
  )
  const state = setup()
  await state.send(['one'], 'Hello')
  expect(state.request.value?.requestId).toMatch(/^[a-f0-9-]{16,}$/)
  expect(state.batch.value?.complete).toBe(true)
})

it('keeps receipt recovery independent across browser tabs', async () => {
  function storage() {
    const values = new Map<string, string>()
    return {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    }
  }
  const tabA = storage()
  const tabB = storage()
  vi.mocked(apiFetch).mockImplementation(async (_url, options) =>
    completed((options!.body as { requestId: string }).requestId),
  )
  vi.stubGlobal('sessionStorage', tabA)
  const first = setup()
  vi.stubGlobal('sessionStorage', tabB)
  const second = setup()
  await first.send(['one'], 'First tab')
  await second.send(['two'], 'Second tab')
  first.reset()
  const reloadedSecond = setup()
  expect(reloadedSecond.request.value?.content).toBe('Second tab')
  expect(reloadedSecond.request.value?.requestId).toBe(second.request.value?.requestId)
})
