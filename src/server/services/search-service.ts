import { Worker } from 'node:worker_threads'
import { getDb } from '../db/index.js'
import type { SearchIndexStatus, SearchOptions, SearchResult } from './search/indexer.js'

export type { SearchIndexStatus, SearchOptions, SearchResult } from './search/indexer.js'

interface PendingSearch {
  resolve: (results: SearchResult[]) => void
  reject: (error: Error) => void
  cleanup: () => void
}
let active:
  | { worker: Worker; dbPath: string; pending: Map<number, PendingSearch>; status: SearchIndexStatus }
  | undefined
let requestId = 0

/** Start lazily for service consumers, eagerly at server boot. Never opens another home directory. */
export function startSearchIndex(): void {
  const dbPath = getDb().name
  if (active?.dbPath === dbPath) return
  if (active) void stopSearchIndex()
  const development = import.meta.url.endsWith('.ts')
  const entry = new URL(`./search/worker.${development ? 'ts' : 'js'}`, import.meta.url)
  const worker = development
    ? new Worker(
        `const { workerData } = require('node:worker_threads'); import('tsx/esm/api').then(({ tsImport }) => tsImport(workerData.entry, workerData.parent));`,
        {
          eval: true,
          workerData: { dbPath, entry: entry.href, parent: import.meta.url },
        },
      )
    : new Worker(entry, { workerData: { dbPath } })
  const state = {
    worker,
    dbPath,
    pending: new Map<number, PendingSearch>(),
    status: { state: 'building', processed: 0, total: 0 } as SearchIndexStatus,
  }
  active = state
  worker.unref()
  const fail = (error: Error) => {
    state.status = { ...state.status, state: 'error', error: error.message }
    for (const pending of state.pending.values()) {
      pending.cleanup()
      pending.reject(error)
    }
    state.pending.clear()
  }
  worker.on('error', fail)
  worker.on('exit', (code) => {
    if (active === state) fail(new Error(`Search worker stopped (${code})`))
  })
  worker.on(
    'message',
    (message: { status?: SearchIndexStatus; id?: number; results?: SearchResult[]; error?: string }) => {
      if (message.status) state.status = message.status
      if (message.id !== undefined) {
        const pending = state.pending.get(message.id)
        if (!pending) return
        state.pending.delete(message.id)
        pending.cleanup()
        if (message.error) pending.reject(new Error(message.error))
        else pending.resolve(message.results ?? [])
      }
    },
  )
}

export function getSearchIndexStatus(): SearchIndexStatus {
  startSearchIndex()
  return { ...active!.status }
}

export async function searchEvents(
  query: string,
  options: SearchOptions = {},
  signal?: AbortSignal,
): Promise<SearchResult[]> {
  if (!query.trim()) return []
  if (signal?.aborted) throw new Error('Search cancelled')
  startSearchIndex()
  const state = active!
  if (state.status.state === 'error') throw new Error(state.status.error ?? 'Search index unavailable')
  const id = ++requestId
  return new Promise((resolve, reject) => {
    const cancel = (message: string) => {
      state.pending.delete(id)
      cleanup()
      state.worker.postMessage({ id, cancel: true })
      reject(new Error(message))
    }
    const aborted = () => cancel('Search cancelled')
    const timeout = setTimeout(() => cancel('Search timed out'), 10_000)
    const cleanup = () => {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', aborted)
    }
    state.pending.set(id, { resolve, reject, cleanup })
    signal?.addEventListener('abort', aborted, { once: true })
    state.worker.postMessage({ id, query, options })
  })
}

export async function stopSearchIndex(): Promise<void> {
  const state = active
  if (!state) return
  active = undefined
  for (const pending of state.pending.values()) {
    pending.cleanup()
    pending.reject(new Error('Search index stopped'))
  }
  state.pending.clear()
  if (state.worker.threadId === -1) return
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      void state.worker.terminate()
    }, 5_000)
    state.worker.once('exit', () => {
      clearTimeout(timeout)
      resolve()
    })
    state.worker.postMessage({ stop: true })
  })
}
