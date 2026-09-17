import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useWebSocketStore } from '../stores/websocket'
import { useWorkspaceStore } from '../stores/workspace'

beforeEach(() => setActivePinia(createPinia()))
afterEach(() => vi.unstubAllGlobals())
it('keeps the same delivery key across an uncertain HTTP retry', async () => {
  const store = useWorkspaceStore()
  const fetchMock = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(Response.json([]))
  vi.stubGlobal('fetch', fetchMock)
  await expect(store.queueAutoLoopMessage('w', 'instruction')).rejects.toThrow('offline')
  await store.queueAutoLoopMessage('w', 'instruction')
  const posts = fetchMock.mock.calls.filter(([, options]) => options?.method === 'POST')
  expect(posts).toHaveLength(2)
  expect(JSON.parse(posts[0][1].body).clientMessageId).toBe(JSON.parse(posts[1][1].body).clientMessageId)
})
it('migrates a grooming queue without sending to the old session', async () => {
  const store = useWorkspaceStore()
  const ws = useWebSocketStore()
  const send = vi.spyOn(ws, 'sendChatMessage').mockReturnValue(true)
  store.queueMessage('w', 'queued during grooming', 'old-session')
  store.autoLoopStates.w = {
    auto_loop: true,
    auto_loop_ready: true,
    no_progress_streak: 0,
    tasks_done: 0,
    tasks_total: 1,
    crons_count: 0,
  }
  const queue = vi.spyOn(store, 'queueAutoLoopMessage').mockResolvedValue()
  await store.flushQueuedMessage('w', 'old-session')
  expect(queue).toHaveBeenCalledWith('w', 'queued during grooming')
  expect(send).not.toHaveBeenCalled()
  expect(store.getQueuedMessage('w', 'old-session')).toBeUndefined()
})
it('retains a local queue until the server accepts it', async () => {
  const store = useWorkspaceStore()
  store.queueMessage('w', 'instruction', 'session')
  store.autoLoopStates.w = {
    auto_loop: true,
    auto_loop_ready: false,
    no_progress_streak: 0,
    tasks_done: 0,
    tasks_total: 1,
    crons_count: 0,
  }
  vi.spyOn(store, 'queueAutoLoopMessage').mockRejectedValue(new Error('offline'))
  await store.flushQueuedMessage('w', 'session')
  expect(store.getQueuedMessage('w', 'session')?.content).toBe('instruction')
})

it('uses the workspace intent before the loop snapshot is loaded', async () => {
  const store = useWorkspaceStore()
  store.workspaces = [{ id: 'w', autoLoop: true } as never]
  store.queueMessage('w', 'instruction', 'old')
  const queued = vi.spyOn(store, 'queueAutoLoopMessage').mockResolvedValue()
  const send = vi.spyOn(useWebSocketStore(), 'sendChatMessage').mockReturnValue(true)
  await store.flushQueuedMessage('w', 'old')
  expect(queued).toHaveBeenCalledWith('w', 'instruction')
  expect(send).not.toHaveBeenCalled()
})

it('does not let an older queue snapshot erase an unknown delivery received by a newer refresh', async () => {
  const store = useWorkspaceStore()
  let returnOldSnapshot!: (value: Response) => void
  const oldResponse = new Promise<Response>((resolve) => {
    returnOldSnapshot = resolve
  })
  const unknown = {
    id: 1,
    content: 'instruction',
    state: 'unknown',
    clientMessageId: 'key',
    sessionId: null,
    createdAt: '',
  }
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockReturnValueOnce(oldResponse)
      .mockResolvedValueOnce(Response.json([unknown])),
  )
  const oldRefresh = store.fetchAutoLoopMessages('w')
  await store.fetchAutoLoopMessages('w')
  expect(store.autoLoopMessages.w).toEqual([unknown])
  returnOldSnapshot(Response.json([]))
  await oldRefresh
  expect(store.autoLoopMessages.w).toEqual([unknown])
})
