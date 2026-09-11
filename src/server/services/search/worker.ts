import { parentPort, workerData } from 'node:worker_threads'
import Database from 'better-sqlite3'
import { SearchIndexer, type SearchOptions } from './indexer.js'

const port = parentPort!
const db = new Database(workerData.dbPath)
db.pragma('journal_mode=WAL')
db.pragma('foreign_keys=ON')
db.pragma('busy_timeout=5000')
const indexer = new SearchIndexer(db)
const cancelled = new Set<number>()
const requests = new Set<number>()
let queue = Promise.resolve()
let stopped = false
let timer: NodeJS.Timeout | undefined

function report(): void {
  port.postMessage({ status: indexer.status() })
}
function pump(): void {
  if (stopped) return
  queue = queue
    .then(() => {
      if (stopped) return
      indexer.tick()
      report()
    })
    .catch((err) => {
      // A writer may outlast busy_timeout. The rolled-back batch remains queued
      // in SQLite; retry it on the next pump instead of poisoning this worker.
      if (err?.code === 'SQLITE_BUSY' || err?.code?.startsWith('SQLITE_BUSY_')) return
      stopped = true
      port.postMessage({ status: { state: 'error', processed: 0, total: 0, error: String(err) } })
    })
    .finally(() => {
      if (!stopped) timer = setTimeout(pump, indexer.status().state === 'building' ? 10 : 200)
    })
}
port.on(
  'message',
  (message: { id: number; query?: string; options?: SearchOptions; cancel?: boolean; stop?: boolean }) => {
    if (message.cancel) {
      if (requests.has(message.id)) cancelled.add(message.id)
      return
    }
    if (message.stop) {
      stopped = true
      clearTimeout(timer)
      void queue.finally(() => {
        db.close()
        port.close()
      })
      return
    }
    requests.add(message.id)
    queue = queue
      .then(async () => {
        if (stopped) throw new Error('Search index unavailable')
        if (cancelled.has(message.id)) return
        indexer.tick()
        const results = await indexer.search(message.query ?? '', message.options, () => cancelled.has(message.id))
        report()
        port.postMessage({ id: message.id, results })
      })
      .catch((err) => {
        port.postMessage({ id: message.id, error: err instanceof Error ? err.message : String(err) })
      })
      .finally(() => {
        cancelled.delete(message.id)
        requests.delete(message.id)
      })
  },
)
pump()
