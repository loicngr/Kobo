import { Worker } from 'node:worker_threads'
import { getDb } from '../db/index.js'
import type { RetentionConfig, RetentionResult } from './ws-events-retention-service.js'

export interface RetentionPreview {
  deletable: number
  total: number
}

type WorkerResult = RetentionResult | RetentionPreview
interface PendingRequest {
  key: string
  promise: Promise<WorkerResult>
  resolve: (result: WorkerResult) => void
  reject: (error: Error) => void
}
interface RetentionWorker {
  worker: Worker
  dbPath: string
  pending: Map<number, PendingRequest>
  stopping?: Promise<void>
}
let active: RetentionWorker | undefined
let requestId = 0

function start(): RetentionWorker {
  const dbPath = getDb().name
  if (active) {
    if (active.stopping) throw new Error('Retention worker stopped')
    if (active.dbPath !== dbPath) throw new Error('Stop the retention worker before replacing its database')
    return active
  }
  if (!dbPath || dbPath === ':memory:') throw new Error('Retention worker requires a file-backed database')
  const development = import.meta.url.endsWith('.ts')
  const entry = new URL(`./retention/worker.${development ? 'ts' : 'js'}`, import.meta.url)
  const worker = development
    ? new Worker(
        `const { workerData } = require('node:worker_threads'); import('tsx/esm/api').then(({ tsImport }) => tsImport(workerData.entry, workerData.parent));`,
        { eval: true, workerData: { dbPath, entry: entry.href, parent: import.meta.url } },
      )
    : new Worker(entry, { workerData: { dbPath } })
  const state: RetentionWorker = { worker, dbPath, pending: new Map() }
  active = state
  worker.unref()
  const fail = (error: Error) => {
    for (const request of state.pending.values()) request.reject(error)
    state.pending.clear()
  }
  worker.on('error', fail)
  worker.on('exit', (code) => {
    fail(new Error(`Retention worker stopped (${code})`))
    if (active === state) active = undefined
  })
  worker.on('message', (message: { id: number; result?: WorkerResult; error?: string }) => {
    const pending = state.pending.get(message.id)
    if (!pending) return
    state.pending.delete(message.id)
    if (message.error) pending.reject(new Error(message.error))
    else if (message.result) pending.resolve(message.result)
    else pending.reject(new Error('Retention worker returned no result'))
    if (!state.pending.size && !state.stopping) worker.unref()
  })
  return state
}

function request(config: RetentionConfig, nowMs: number, preview: boolean): Promise<WorkerResult> {
  let state: RetentionWorker
  try {
    state = start()
  } catch (error) {
    return Promise.reject(error)
  }
  // Coalesce the same policy around the first request's snapshot time; distinct
  // configurations remain serialized in
  // the same worker, so two maintenance passes never compete for write locks.
  const key = JSON.stringify([preview, config.retentionDays, config.keepPerWorkspace])
  for (const pending of state.pending.values()) if (pending.key === key) return pending.promise
  const id = ++requestId
  let resolve!: PendingRequest['resolve']
  let reject!: PendingRequest['reject']
  const promise = new Promise<WorkerResult>((res, rej) => {
    resolve = res
    reject = rej
  })
  state.pending.set(id, { key, promise, resolve, reject })
  state.worker.ref()
  state.worker.postMessage({ id, config, nowMs, preview })
  return promise
}

/** Daily/boot maintenance runs off the HTTP thread and never VACUUMs live data. */
export function runWsEventsRetention(config: RetentionConfig, nowMs: number = Date.now()): Promise<RetentionResult> {
  if (config.retentionDays <= 0) {
    return Promise.resolve({
      deleted: 0,
      sessionsRecomputed: 0,
      vacuumed: false,
      freePagesBefore: 0,
      freePagesAfter: 0,
    })
  }
  return request(config, nowMs, false) as Promise<RetentionResult>
}

/** The confirmation preview is also off the live event loop. */
export function previewWsEventsRetention(
  config: RetentionConfig,
  nowMs: number = Date.now(),
): Promise<RetentionPreview> {
  return request(config, nowMs, true) as Promise<RetentionPreview>
}

/** Stop after the current bounded transaction, repair affected metrics and
 * confirm worker exit before the server closes its main SQLite connection. */
export function stopWsEventsRetention(): Promise<void> {
  const state = active
  if (!state) return Promise.resolve()
  if (state.stopping) return state.stopping
  for (const pending of state.pending.values()) pending.reject(new Error('Retention worker stopped'))
  state.pending.clear()
  state.worker.ref()
  state.stopping = new Promise<void>((resolve) => {
    state.worker.once('exit', () => resolve())
    state.worker.postMessage({ stop: true })
  })
  return state.stopping
}
